/**
 * Configuración de cobro: datos del dueño, autogestión (registro y demos) y Wompi propio.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent } from '../../core/dom.js';
import { icon, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { type PlatformSettings } from '../types.js';
import { renderMailAndLegalSettings } from './mailLegalSettings.js';

export async function renderSettingsView(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const settings = await api.get<PlatformSettings>('/api/platform/settings');
  setContent(
    content,
    html`<section class="card card-padded">
      <form class="form" novalidate>
        <h3>${icon('wallet')} Cómo te pagan tus clientes</h3>
        <p class="subtle">Esto lo ve el consultorio cuando su suscripción está por vencer o suspendida.</p>
        <div class="form-grid">
          <label class="field"><span>Tu nombre</span><input name="ownerName" maxlength="120" value="${settings.ownerName}" /></label>
          <label class="field"><span>Tu WhatsApp (para comprobantes)</span><input name="ownerWhatsapp" maxlength="30" value="${settings.ownerWhatsapp}" placeholder="300 123 4567" /></label>
          <label class="field full"><span>Instrucciones de pago</span><textarea name="paymentInstructions" rows="4" maxlength="2000" placeholder="Nequi 300 123 4567 a nombre de …&#10;Bancolombia ahorros 123-456789-00">${settings.paymentInstructions}</textarea></label>
        </div>
        <h3>${icon('rocket')} Autogestión: registro y demos <span class="hint" data-tooltip="Los interesados entran a /registro, ven tus planes, crean una demo con datos o su consultorio con prueba gratis, y pagan con tu Wompi. Los precios se editan en la pestaña Planes.">${icon('info')}</span></h3>
        <div class="form-grid">
          <label class="checkbox"><input type="checkbox" name="selfSignupEnabled" value="1" ${settings.selfSignupEnabled ? 'checked' : ''} /> <span><strong>Registro en línea</strong><br /><small class="subtle">Cualquiera crea su consultorio con prueba gratis.</small></span></label>
          <label class="checkbox"><input type="checkbox" name="selfDemoEnabled" value="1" ${settings.selfDemoEnabled ? 'checked' : ''} /> <span><strong>Demo con datos en línea</strong><br /><small class="subtle">Se crea sola y se borra al vencer.</small></span></label>
          <label class="field"><span>Días de prueba gratis <span class="hint" data-tooltip="Para consultorios nuevos (registro en línea o creados por ti).">${icon('info')}</span></span><input name="defaultTrialDays" type="number" min="0" max="365" value="${settings.defaultTrialDays}" /></label>
          <label class="field"><span>Días de gracia <span class="hint" data-tooltip="Después del vencimiento, días en que aún puede entrar con aviso antes de suspenderse.">${icon('info')}</span></span><input name="defaultGraceDays" type="number" min="0" max="60" value="${settings.defaultGraceDays}" /></label>
          <label class="field"><span>Duración de la demo (días) <span class="hint" data-tooltip="Se le recuerda al interesado cada día. Al crear su consultorio, la demo sigue 24 horas más y luego se borra.">${icon('info')}</span></span><input name="demoDays" type="number" min="1" max="60" value="${settings.demoDays}" /></label>
          <label class="field"><span>Máximo de demos activas <span class="hint" data-tooltip="Protege la base de datos gratuita: si se llega al tope, se invita a usar la prueba gratis.">${icon('info')}</span></span><input name="maxSelfDemos" type="number" min="0" max="500" value="${settings.maxSelfDemos}" /></label>
        </div>
        <h3>${icon('credit-card')} Pago en línea con tu Wompi <span class="badge ${settings.wompiConfigured ? 'badge-success' : 'badge-neutral'}">${settings.wompiConfigured ? 'Activo' : 'Inactivo'}</span></h3>
        <p class="subtle">Con esto, tus clientes pagan desde el panel y el acceso se reactiva solo. En Wompi → Desarrolladores, configura la URL de eventos:<br /><code>${settings.webhookUrl}</code></p>
        <div class="form-grid">
          <label class="field"><span>Ambiente</span><select name="wompiEnvironment">
            <option value="" ${!settings.wompiEnvironment ? 'selected' : ''}>Desactivado</option>
            <option value="sandbox" ${settings.wompiEnvironment === 'sandbox' ? 'selected' : ''}>Pruebas (sandbox)</option>
            <option value="production" ${settings.wompiEnvironment === 'production' ? 'selected' : ''}>Producción</option></select></label>
          <label class="field"><span>Llave pública</span><input name="wompiPublicKey" maxlength="300" value="${settings.wompiPublicKey}" autocomplete="off" /></label>
          <label class="field"><span>Secreto de integridad</span><input name="wompiIntegritySecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedIntegritySecret ? `Guardado (${settings.maskedIntegritySecret})` : ''}" /></label>
          <label class="field"><span>Secreto de eventos</span><input name="wompiEventsSecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedEventsSecret ? `Guardado (${settings.maskedEventsSecret})` : ''}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <div class="button-row">
          <button class="button button-primary" type="submit">${icon('check')} Guardar</button>
          ${settings.wompiConfigured ? html`<button class="button button-secondary" type="button" data-action="test-wompi">${icon('plug-zap')} Probar Wompi</button>` : ''}
        </div>
      </form>
    </section>
    <div data-mail-legal></div>`,
  );
  await renderMailAndLegalSettings($('[data-mail-legal]', content));
  refreshIcons(content);
  const form = content.querySelector('form') as HTMLFormElement;
  content.onclick = async (event) => {
    if (!(event.target as HTMLElement).closest('[data-action="test-wompi"]')) return;
    const result = await withErrorToast(() => api.post<{ message: string }>('/api/platform/settings/test-wompi'));
    if (result) toast(result.message, 'success');
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    const values = readForm(form);
    try {
      await api.put('/api/platform/settings', {
        ownerName: emptyToNull(values.ownerName),
        ownerWhatsapp: emptyToNull(values.ownerWhatsapp),
        paymentInstructions: emptyToNull(values.paymentInstructions),
        demoDays: Number(values.demoDays || 5),
        maxSelfDemos: Number(values.maxSelfDemos || 0),
        selfSignupEnabled: values.selfSignupEnabled === '1',
        selfDemoEnabled: values.selfDemoEnabled === '1',
        defaultTrialDays: Number(values.defaultTrialDays || 0),
        defaultGraceDays: Number(values.defaultGraceDays || 0),
        wompiEnvironment: values.wompiEnvironment || null,
        wompiPublicKey: emptyToNull(values.wompiPublicKey),
        wompiIntegritySecret: emptyToNull(values.wompiIntegritySecret),
        wompiEventsSecret: emptyToNull(values.wompiEventsSecret),
      });
      toast('Configuración guardada.', 'success');
      await reload();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    }
  });
}

