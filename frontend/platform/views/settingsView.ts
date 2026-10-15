/**
 * Configuración del panel del dueño, por grupos (submenú lateral):
 *   #/configuracion/cobro        cómo te pagan (transferencia, WhatsApp)
 *   #/configuracion/autogestion  registro en línea, demos, prueba y gracia
 *   #/configuracion/wompi        pago en línea con tu Wompi
 *   #/configuracion/correo       correo automático con tu Gmail
 *   #/configuracion/legal        datos legales y tributarios
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { pickSection, sectionLayout, type SectionNavItem } from '../../core/sectionNav.js';
import { copyToClipboard, icon, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { type LegalSettings, type MailSettings, type PlatformSettings } from '../types.js';
import { renderLegalSection, renderMailSection } from './mailLegalSettings.js';

type SectionId = 'cobro' | 'autogestion' | 'wompi' | 'correo' | 'legal';

/** Lo que se envía al guardar: se parte de lo guardado y cada grupo cambia lo suyo. */
function basePayload(settings: PlatformSettings) {
  return {
    ownerName: emptyToNull(settings.ownerName),
    ownerWhatsapp: emptyToNull(settings.ownerWhatsapp),
    paymentInstructions: emptyToNull(settings.paymentInstructions),
    defaultMonthlyPrice: settings.defaultMonthlyPrice,
    defaultGraceDays: settings.defaultGraceDays,
    defaultTrialDays: settings.defaultTrialDays,
    demoDays: settings.demoDays,
    maxSelfDemos: settings.maxSelfDemos,
    selfSignupEnabled: settings.selfSignupEnabled,
    selfDemoEnabled: settings.selfDemoEnabled,
    wompiEnvironment: settings.wompiEnvironment,
    wompiPublicKey: emptyToNull(settings.wompiPublicKey),
    // null = conservar los secretos guardados.
    wompiIntegritySecret: null as string | null,
    wompiEventsSecret: null as string | null,
  };
}

/** Formulario con su botón Guardar y el error en el mismo lugar. */
function bindForm(form: HTMLFormElement, save: (values: Record<string, string>) => Promise<void>): void {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (button) button.disabled = true;
    try {
      await save(readForm(form));
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    } finally {
      if (button) button.disabled = false;
    }
  });
}

const formFooter = (label = 'Guardar cambios', extra: SafeHtml = html``) => html`<p class="form-error" role="alert" hidden></p>
  <div class="button-row"><button class="button button-primary" type="submit">${icon('check')} ${label}</button>${extra}</div>`;

export async function renderSettingsView(content: HTMLElement, reload: () => Promise<void>, params: string[] = []): Promise<void> {
  const [settings, mail, legal] = await Promise.all([
    api.get<PlatformSettings>('/api/platform/settings'),
    api.get<MailSettings>('/api/platform/settings/mail'),
    api.get<LegalSettings>('/api/platform/settings/legal'),
  ]);
  const legalComplete = Boolean(legal.providerName && legal.providerId && legal.contactEmail);
  const sections: Array<SectionNavItem & { id: SectionId }> = [
    { id: 'cobro', label: 'Cómo te pagan', iconName: 'wallet', hint: 'Transferencia y WhatsApp',
      description: 'Lo ve el consultorio cuando su plan está por vencer o suspendido.', status: settings.paymentInstructions || settings.wompiConfigured ? 'ok' : 'pendiente' },
    { id: 'autogestion', label: 'Registro y demos', iconName: 'rocket', hint: 'Prueba gratis, gracia y demos',
      description: 'Los interesados entran a /registro, ven tus planes, crean una demo o su consultorio con prueba gratis y pagan solos. Los precios se editan en Planes.' },
    { id: 'wompi', label: 'Pago en línea', iconName: 'credit-card', hint: 'Tu cuenta de Wompi',
      description: 'Tus clientes pagan desde su panel y el acceso se reactiva solo.', status: settings.wompiConfigured ? 'ok' : 'pendiente' },
    { id: 'correo', label: 'Correo automático', iconName: 'mail', hint: 'Tu Gmail',
      description: 'Bienvenidas, comprobantes de pago, recordatorios y recuperación de contraseña, sin que intervengas.', status: mail.configured ? 'ok' : 'pendiente' },
    { id: 'legal', label: 'Datos legales', iconName: 'scale', hint: 'Términos, datos e IVA',
      description: 'Se publican en los términos, la política de datos, el pie de /registro, Mi plan y los comprobantes.', status: legalComplete ? 'ok' : 'pendiente' },
  ];
  const active = pickSection(sections, params[0]) as (typeof sections)[number];
  setContent(content, sectionLayout({ items: sections, active, baseHref: '#/configuracion', label: 'Grupos de configuración' }));
  refreshIcons(content);
  const panel = $('[data-section-content]', content);

  const saveSettings = async (overrides: Partial<ReturnType<typeof basePayload>>, message: string) => {
    await api.put('/api/platform/settings', { ...basePayload(settings), ...overrides });
    toast(message, 'success');
    await reload();
  };

  switch (active.id) {
    case 'cobro':
      return renderPaymentSection(panel, settings, saveSettings);
    case 'autogestion':
      return renderSelfServiceSection(panel, settings, saveSettings);
    case 'wompi':
      return renderWompiSection(panel, settings, saveSettings);
    case 'correo':
      return renderMailSection(panel, mail, reload);
    case 'legal':
      return renderLegalSection(panel, legal, reload);
  }
}

type SaveSettings = (overrides: Partial<ReturnType<typeof basePayload>>, message: string) => Promise<void>;

function renderPaymentSection(panel: HTMLElement, settings: PlatformSettings, save: SaveSettings): void {
  setContent(
    panel,
    html`<section class="card card-padded"><form class="form" novalidate>
      <div class="form-grid">
        <label class="field"><span>Tu nombre</span><input name="ownerName" maxlength="120" value="${settings.ownerName}" /></label>
        <label class="field"><span>Tu WhatsApp <span class="hint" data-tooltip="Para que te envíen el comprobante de una transferencia.">${icon('info')}</span></span><input name="ownerWhatsapp" maxlength="30" value="${settings.ownerWhatsapp}" placeholder="300 123 4567" /></label>
        <label class="field full"><span>Instrucciones de pago por transferencia</span><textarea name="paymentInstructions" rows="5" maxlength="2000" placeholder="Nequi 300 123 4567 a nombre de …&#10;Bancolombia ahorros 123-456789-00">${settings.paymentInstructions}</textarea></label>
      </div>
      ${formFooter()}
    </form></section>`,
  );
  refreshIcons(panel);
  bindForm(panel.querySelector('form') as HTMLFormElement, (values) =>
    save({ ownerName: emptyToNull(values.ownerName), ownerWhatsapp: emptyToNull(values.ownerWhatsapp), paymentInstructions: emptyToNull(values.paymentInstructions) }, 'Datos de cobro guardados.'),
  );
}

function renderSelfServiceSection(panel: HTMLElement, settings: PlatformSettings, save: SaveSettings): void {
  setContent(
    panel,
    html`<section class="card card-padded"><form class="form" novalidate>
      <h3>${icon('user-check')} Qué pueden hacer solos los interesados</h3>
      <div class="form-grid">
        <label class="checkbox"><input type="checkbox" name="selfSignupEnabled" value="1" ${settings.selfSignupEnabled ? 'checked' : ''} /> <span><strong>Registro en línea</strong><br /><small class="subtle">Cualquiera crea su consultorio con prueba gratis.</small></span></label>
        <label class="checkbox"><input type="checkbox" name="selfDemoEnabled" value="1" ${settings.selfDemoEnabled ? 'checked' : ''} /> <span><strong>Demo con datos en línea</strong><br /><small class="subtle">Se crea sola y se borra al vencer.</small></span></label>
      </div>
      <h3>${icon('calendar-clock')} Tiempos</h3>
      <div class="form-grid">
        <label class="field"><span>Días de prueba gratis <span class="hint" data-tooltip="Para consultorios nuevos (registro en línea o creados por ti).">${icon('info')}</span></span><input name="defaultTrialDays" type="number" min="0" max="365" value="${settings.defaultTrialDays}" /></label>
        <label class="field"><span>Días de gracia <span class="hint" data-tooltip="Después del vencimiento, días en que aún puede entrar con aviso antes de suspenderse.">${icon('info')}</span></span><input name="defaultGraceDays" type="number" min="0" max="60" value="${settings.defaultGraceDays}" /></label>
        <label class="field"><span>Duración de la demo (días) <span class="hint" data-tooltip="Se le recuerda al interesado cada día. Al crear su consultorio, la demo sigue 24 horas más y luego se borra.">${icon('info')}</span></span><input name="demoDays" type="number" min="1" max="60" value="${settings.demoDays}" /></label>
        <label class="field"><span>Máximo de demos activas <span class="hint" data-tooltip="Protege la base de datos gratuita: si se llega al tope, se invita a usar la prueba gratis.">${icon('info')}</span></span><input name="maxSelfDemos" type="number" min="0" max="500" value="${settings.maxSelfDemos}" /></label>
      </div>
      ${formFooter()}
    </form></section>`,
  );
  refreshIcons(panel);
  bindForm(panel.querySelector('form') as HTMLFormElement, (values) =>
    save(
      {
        selfSignupEnabled: values.selfSignupEnabled === '1',
        selfDemoEnabled: values.selfDemoEnabled === '1',
        defaultTrialDays: Number(values.defaultTrialDays || 0),
        defaultGraceDays: Number(values.defaultGraceDays || 0),
        demoDays: Number(values.demoDays || 5),
        maxSelfDemos: Number(values.maxSelfDemos || 0),
      },
      'Registro y demos guardados.',
    ),
  );
}

function renderWompiSection(panel: HTMLElement, settings: PlatformSettings, save: SaveSettings): void {
  setContent(
    panel,
    html`<section class="card card-padded"><form class="form" novalidate>
      <h3>${icon('key-round')} Llaves <span class="badge ${settings.wompiConfigured ? 'badge-success' : 'badge-neutral'}">${settings.wompiConfigured ? 'Activo' : 'Inactivo'}</span></h3>
      <div class="form-grid">
        <label class="field"><span>Ambiente</span><select name="wompiEnvironment">
          <option value="" ${!settings.wompiEnvironment ? 'selected' : ''}>Desactivado</option>
          <option value="sandbox" ${settings.wompiEnvironment === 'sandbox' ? 'selected' : ''}>Pruebas (sandbox)</option>
          <option value="production" ${settings.wompiEnvironment === 'production' ? 'selected' : ''}>Producción</option></select></label>
        <label class="field"><span>Llave pública</span><input name="wompiPublicKey" maxlength="300" value="${settings.wompiPublicKey}" autocomplete="off" /></label>
        <label class="field"><span>Secreto de integridad <span class="hint" data-tooltip="Se guarda cifrado. Déjalo vacío para conservar el actual.">${icon('info')}</span></span><input name="wompiIntegritySecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedIntegritySecret ? `Guardado (${settings.maskedIntegritySecret})` : ''}" /></label>
        <label class="field"><span>Secreto de eventos <span class="hint" data-tooltip="Se guarda cifrado. Déjalo vacío para conservar el actual.">${icon('info')}</span></span><input name="wompiEventsSecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedEventsSecret ? `Guardado (${settings.maskedEventsSecret})` : ''}" /></label>
      </div>
      ${formFooter('Guardar llaves', settings.wompiConfigured ? html`<button class="button button-secondary" type="button" data-action="test-wompi">${icon('plug-zap')} Probar Wompi</button>` : html``)}
    </form></section>
    <section class="card card-padded">
      <h3>${icon('webhook')} URL de eventos</h3>
      <p class="subtle">En Wompi → Desarrolladores → URL de eventos, pega esta dirección. Así Wompi avisa cada pago aprobado y el acceso se reactiva solo.</p>
      <div class="copy-field"><code>${settings.webhookUrl}</code><button class="icon-button" type="button" data-action="copy-webhook" aria-label="Copiar" data-tooltip="Copiar">${icon('copy')}</button></div>
    </section>`,
  );
  refreshIcons(panel);
  panel.onclick = async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="copy-webhook"]')) {
      await copyToClipboard(settings.webhookUrl, 'URL copiada.');
    }
    if (target.closest('[data-action="test-wompi"]')) {
      const result = await withErrorToast(() => api.post<{ message: string }>('/api/platform/settings/test-wompi'));
      if (result) toast(result.message, 'success');
    }
  };
  bindForm(panel.querySelector('form') as HTMLFormElement, (values) =>
    save(
      {
        wompiEnvironment: (values.wompiEnvironment || null) as PlatformSettings['wompiEnvironment'],
        wompiPublicKey: emptyToNull(values.wompiPublicKey),
        wompiIntegritySecret: emptyToNull(values.wompiIntegritySecret),
        wompiEventsSecret: emptyToNull(values.wompiEventsSecret),
      },
      'Wompi guardado.',
    ),
  );
}
