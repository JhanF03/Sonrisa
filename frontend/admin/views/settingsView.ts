/**
 * Configuración por grupos (submenú lateral): consultorio, reglas de reserva en línea
 * (anti-fantasma), WhatsApp, pagos en línea (Wompi), profesionales y bloqueos.
 * Cada grupo se muestra solo si el usuario tiene el permiso correspondiente.
 */
import { pickSection, sectionLayout, type SectionNavItem } from '../../core/sectionNav.js';
import { api } from '../../core/api.js';
import { applyFavicon, bindFaviconFields, faviconField } from '../../core/favicon.js';
import { $, emptyToNull, html, readForm, safeUrl, setContent } from '../../core/dom.js';
import { addDays, formatShortDate, formatTime, formatUtcAsLocal, todayLocal, whatsappLink } from '../../core/format.js';
import { copyToClipboard, emptyState, icon, loadingState, openFormModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import {
  DEFAULT_REMINDER_TEMPLATE,
  REMINDER_PLACEHOLDERS,
  renderTemplate,
  spanishDate,
  spanishTime,
  validateReminderTemplate,
} from '../../../src/shared/messageTemplate.js';
import type { ProfessionalItem } from '../components.js';
import { can, clinicOffset, session } from '../session.js';
import { openNewBlockModal } from './agendaView.js';

interface ClinicSettings {
  name: string;
  slug: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  brand_color: string;
  logo_url: string | null;
  favicon: string | null;
  slot_interval_minutes: number;
  min_booking_notice_hours: number;
  booking_window_days: number;
  reactivation_months: number;
  online_booking_enabled: number;
  close_on_holidays: number;
  whatsapp_number: string | null;
  whatsapp_reminder_template: string | null;
  online_verification_mode: 'ninguna' | 'whatsapp';
  verification_window_minutes: number;
  max_pending_online_per_patient: number;
  auto_release_hours: number;
  payment_window_minutes: number;
}

interface GatewayView {
  configured: boolean;
  environment: 'sandbox' | 'production' | null;
  publicKey: string | null;
  integritySecretMasked: string | null;
  eventsSecretMasked: string | null;
  isEnabled: boolean;
  policyText: string | null;
  webhookUrl: string | null;
  lastVerifiedAt: string | null;
  lastEventAt: string | null;
}

interface ScheduleBlock {
  weekday: number;
  start_time: string;
  end_time: string;
}

interface UserOption {
  id: string;
  fullName: string;
}

interface TimeBlock {
  id: string;
  professional_name: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
}

type SettingsTab = 'consultorio' | 'reservas' | 'whatsapp' | 'pagos' | 'profesionales' | 'bloqueos';

const TABS: Array<SectionNavItem & { id: SettingsTab; permission: string }> = [
  { id: 'consultorio', label: 'Consultorio', iconName: 'building-2', permission: 'configuracion.consultorio',
    hint: 'Datos, logo, horario de citas', description: 'Nombre, contacto, imagen y cómo se reparte la agenda en el día.' },
  { id: 'reservas', label: 'Reservas en línea', iconName: 'shield', permission: 'configuracion.consultorio',
    hint: 'Reglas contra reservas falsas', description: 'Verificación del paciente, límites de citas pendientes y liberación automática de horarios.' },
  { id: 'whatsapp', label: 'WhatsApp', iconName: 'message-circle', permission: 'configuracion.consultorio',
    hint: 'Número y mensaje del recordatorio', description: 'El número del consultorio y el texto que reciben los pacientes al recordarles su cita.' },
  { id: 'pagos', label: 'Pagos en línea', iconName: 'credit-card', permission: 'pagos.configurar',
    hint: 'Tu cuenta de Wompi', description: 'Conecta tu Wompi para cobrar anticipos al reservar. El dinero llega directo a tu cuenta.' },
  { id: 'profesionales', label: 'Profesionales', iconName: 'stethoscope', permission: 'configuracion.profesionales',
    hint: 'Quién atiende y en qué horario', description: 'Cada profesional tiene su columna en la agenda y su horario semanal.' },
  { id: 'bloqueos', label: 'Bloqueos', iconName: 'ban', permission: 'agenda.bloquear',
    hint: 'Vacaciones, permisos, cierres', description: 'Horarios en los que no se pueden agendar citas.' },
];

const WEEKDAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export async function renderSettingsView(container: HTMLElement, params: string[] = []): Promise<void> {
  const allowedTabs = TABS.filter((tab) => can(tab.permission));
  const activeTab = pickSection(allowedTabs, params[0]);
  if (!activeTab) return;

  setContent(container, sectionLayout({ items: allowedTabs, active: activeTab, baseHref: '#/configuracion', label: 'Grupos de configuración' }));
  refreshIcons(container);
  const content = $('[data-section-content]', container);
  setContent(content, loadingState());
  const reload = () => renderSettingsView(container, [activeTab.id]);

  // Cada grupo maneja sus propios eventos (se reemplazan al cambiar de grupo).
  content.onclick = null;
  content.onsubmit = null;
  content.oninput = null;
  content.onchange = null;

  switch (activeTab.id) {
    case 'consultorio':
      return renderClinicTab(content);
    case 'reservas':
      return renderBookingRulesTab(content, reload);
    case 'whatsapp':
      return renderWhatsappTab(content, reload);
    case 'pagos':
      return renderPaymentsTab(content, reload);
    case 'profesionales':
      return renderProfessionalsTab(content, reload);
    case 'bloqueos':
      return renderBlocksTab(content, reload);
  }
}

// ─── Consultorio ────────────────────────────────────────────────────────────

async function renderClinicTab(content: HTMLElement): Promise<void> {
  const clinic = await api.get<ClinicSettings>('/api/settings/clinic');
  const bookingUrl = `${window.location.origin}/c/${clinic.slug}`;

  setContent(
    content,
    html`<section class="card card-padded">
      <div class="toolbar">
        <span class="kpi-icon">${icon('link')}</span>
        <div><strong>Enlace de reservas en línea</strong><div class="subtle">Compártelo en WhatsApp, Instagram y Google Maps.</div></div>
        <span class="spacer"></span>
        <code class="subtle">${bookingUrl}</code>
        <button class="button button-secondary button-small" data-action="copy-link">${icon('copy')} Copiar</button>
        <a class="button button-secondary button-small" href="${bookingUrl}" target="_blank" rel="noopener">${icon('external-link')} Abrir</a>
      </div>
    </section>
    <section class="card">
      <div class="card-header"><h3>${icon('building-2')} Datos y agenda del consultorio</h3></div>
      <form class="form card-padded" data-form="clinic">
        <div class="form-grid">
          <label class="field"><span>Nombre</span><input name="name" required maxlength="120" value="${clinic.name}" /></label>
          <label class="field"><span>${icon('phone')} Teléfono</span><input name="phone" maxlength="30" value="${clinic.phone ?? ''}" /></label>
          <label class="field"><span>${icon('map-pin')} Dirección</span><input name="address" maxlength="200" value="${clinic.address ?? ''}" /></label>
          <label class="field"><span>Ciudad</span><input name="city" maxlength="80" value="${clinic.city ?? ''}" /></label>
          <label class="field"><span>${icon('palette')} Color de marca</span><input name="brandColor" type="color" value="${clinic.brand_color}" /></label>
          <label class="field"><span>Logo (URL https, opcional)</span><input name="logoUrl" type="url" maxlength="500" value="${clinic.logo_url ?? ''}" placeholder="https://…" /></label>
          ${faviconField(clinic.favicon)}
          <label class="field"><span>Intervalo de horarios <span class="hint" data-tooltip="Cada cuánto se ofrecen horarios (ej. 8:00, 8:30, 9:00…)">${icon('info')}</span></span>
            <select name="slotIntervalMinutes">${[10, 15, 20, 30, 45, 60].map((minutes) => html`<option value="${minutes}" ${clinic.slot_interval_minutes === minutes ? 'selected' : ''}>${minutes} minutos</option>`)}</select></label>
          <label class="field"><span>Anticipación mínima (horas) <span class="hint" data-tooltip="Los pacientes no podrán reservar en línea con menos tiempo que este">${icon('info')}</span></span>
            <input name="minBookingNoticeHours" type="number" min="0" max="168" value="${clinic.min_booking_notice_hours}" /></label>
          <label class="field"><span>Reservas hasta (días adelante)</span><input name="bookingWindowDays" type="number" min="1" max="180" value="${clinic.booking_window_days}" /></label>
          <label class="field"><span>Reactivar pacientes tras (meses)</span><input name="reactivationMonths" type="number" min="1" max="36" value="${clinic.reactivation_months}" /></label>
          <label class="checkbox"><input type="checkbox" name="onlineBookingEnabled" ${clinic.online_booking_enabled ? 'checked' : ''} /><span>Reserva en línea activa</span></label>
          <label class="checkbox"><input type="checkbox" name="closeOnHolidays" ${clinic.close_on_holidays ? 'checked' : ''} /><span>Cerrar en festivos de Colombia</span></label>
        </div>
        <div class="modal-actions"><button class="button button-primary" type="submit">${icon('check')} Guardar cambios</button></div>
      </form>
    </section>`,
  );
  refreshIcons(content);

  content.onclick = async (event) => {
    if ((event.target as HTMLElement).closest('[data-action="copy-link"]')) await copyToClipboard(bookingUrl, 'Enlace copiado.');
  };
  // El ícono se guarda apenas se elige (no espera al botón Guardar).
  bindFaviconFields(content, async (favicon) => {
    const saved = await withErrorToast(() => api.put('/api/settings/favicon', { favicon }));
    if (!saved) return;
    if (favicon) applyFavicon(favicon);
    toast(favicon ? 'Ícono de la pestaña actualizado.' : 'Ícono quitado: se usará el de Agenda Sonrisa al recargar.', 'success');
  });
  content.addEventListener('favicon-error', (event) => toast((event as CustomEvent<string>).detail, 'error'));
  content.onsubmit = async (event) => {
    const form = event.target as HTMLFormElement;
    event.preventDefault();
    const values = readForm(form);
    const checkbox = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
    const saved = await withErrorToast(() =>
      api.put('/api/settings/clinic', {
        name: values.name,
        phone: emptyToNull(values.phone),
        address: emptyToNull(values.address),
        city: emptyToNull(values.city),
        brandColor: values.brandColor,
        logoUrl: emptyToNull(values.logoUrl),
        slotIntervalMinutes: Number(values.slotIntervalMinutes),
        minBookingNoticeHours: Number(values.minBookingNoticeHours),
        bookingWindowDays: Number(values.bookingWindowDays),
        reactivationMonths: Number(values.reactivationMonths),
        onlineBookingEnabled: checkbox('onlineBookingEnabled'),
        closeOnHolidays: checkbox('closeOnHolidays'),
      }),
    );
    if (saved) toast('Configuración guardada. Recarga para ver el nuevo color.', 'success');
  };
}

// ─── Reservas en línea (anti-fantasma) ──────────────────────────────────────

async function renderBookingRulesTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const clinic = await api.get<ClinicSettings>('/api/settings/clinic');
  const hasWhatsapp = Boolean(clinic.whatsapp_number);

  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('shield')} Protección contra reservas falsas</h3></div>
      <form class="form card-padded" data-form="rules">
        <div class="field"><span>${icon('shield-check')} Verificación de reservas en línea</span>
          <label class="checkbox"><input type="radio" name="onlineVerificationMode" value="ninguna" ${clinic.online_verification_mode === 'ninguna' ? 'checked' : ''} />
            <span><strong>Sin verificación</strong> <span class="subtle">· la reserva queda pendiente y se confirma con el recordatorio.</span></span></label>
          <label class="checkbox"><input type="radio" name="onlineVerificationMode" value="whatsapp" ${clinic.online_verification_mode === 'whatsapp' ? 'checked' : ''} ${hasWhatsapp ? '' : 'disabled'} />
            <span><strong>Verificar por WhatsApp</strong> <span class="badge badge-success">Recomendado</span><br />
              <span class="subtle">Al reservar, el paciente te escribe por WhatsApp con un código de 6 dígitos desde su celular. Si no lo hace a tiempo, el horario se libera solo. ${hasWhatsapp ? '' : html`<strong>Primero configura el número en el grupo <a href="#/configuracion/whatsapp">WhatsApp</a>.</strong>`}</span></span></label>
        </div>
        <div class="form-grid">
          <label class="field"><span>${icon('hourglass')} Tiempo para verificar (minutos)</span>
            <input name="verificationWindowMinutes" type="number" min="10" max="1440" value="${clinic.verification_window_minutes}" required />
            <small class="field-hint">Entre 10 minutos y 24 horas. Sugerido: 60.</small></label>
          <label class="field"><span>${icon('users')} Reservas en línea activas por persona</span>
            <input name="maxPendingOnlinePerPatient" type="number" min="1" max="20" value="${clinic.max_pending_online_per_patient}" required />
            <small class="field-hint">Cuenta por documento y por celular. Evita que alguien llene la agenda. Sugerido: 2.</small></label>
          <label class="field"><span>${icon('calendar-x')} Liberar si no confirma (horas antes)</span>
            <input name="autoReleaseHours" type="number" min="0" max="72" value="${clinic.auto_release_hours}" required />
            <small class="field-hint">0 = desactivado. Ej: 12 → si el paciente no confirma con el enlace del recordatorio 12 h antes, el horario se libera. Úsalo con cuidado: envía siempre los recordatorios.</small></label>
          <label class="field"><span>${icon('credit-card')} Tiempo para pagar el anticipo (minutos)</span>
            <input name="paymentWindowMinutes" type="number" min="20" max="120" value="${clinic.payment_window_minutes}" required />
            <small class="field-hint">Solo para servicios con anticipo. Si no paga a tiempo, el horario se libera. Sugerido: 30.</small></label>
        </div>
        <div class="modal-actions"><button class="button button-primary" type="submit">${icon('check')} Guardar reglas</button></div>
      </form>
    </section>
    <section class="card card-padded">
      <h3 style="margin-bottom: 8px">${icon('lock')} Cero dobles reservas</h3>
      <p class="muted">No requiere configuración. Cada reserva se guarda con una instrucción atómica que verifica el horario en el mismo instante, y la base de datos rechaza cualquier cruce aunque dos personas reserven al mismo tiempo. Las reservas que esperan pago o verificación ocupan el horario hasta que vencen.</p>
    </section>`,
  );
  refreshIcons(content);

  content.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const values = readForm(form);
    const saved = await withErrorToast(() =>
      api.put('/api/settings/booking-rules', {
        onlineVerificationMode: values.onlineVerificationMode,
        verificationWindowMinutes: Number(values.verificationWindowMinutes),
        maxPendingOnlinePerPatient: Number(values.maxPendingOnlinePerPatient),
        autoReleaseHours: Number(values.autoReleaseHours),
        paymentWindowMinutes: Number(values.paymentWindowMinutes),
      }),
    );
    if (saved) {
      toast('Reglas de reserva guardadas.', 'success');
      await reload();
    }
  };
}

// ─── WhatsApp ───────────────────────────────────────────────────────────────

function sampleTemplateValues() {
  const sampleDate = addDays(todayLocal(clinicOffset()), 1);
  return {
    nombre: 'Laura',
    consultorio: session().clinic.name,
    fecha: spanishDate(sampleDate),
    hora: spanishTime('09:30'),
    profesional: 'Dra. Ana María Torres',
    servicio: 'Limpieza y profilaxis',
    enlace: `${window.location.origin}/c/${session().clinic.slug}/cita/ejemplo`,
  };
}

async function renderWhatsappTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const clinic = await api.get<ClinicSettings>('/api/settings/clinic');
  const template = clinic.whatsapp_reminder_template ?? DEFAULT_REMINDER_TEMPLATE;

  setContent(
    content,
    html`<div class="grid-2">
      <section class="card">
        <div class="card-header"><h3>${icon('message-circle')} WhatsApp del consultorio</h3></div>
        <form class="form card-padded" data-form="whatsapp">
          <label class="field"><span>${icon('phone')} Celular con WhatsApp (o WhatsApp Business)</span>
            <input name="whatsappNumber" type="tel" maxlength="20" value="${clinic.whatsapp_number ?? ''}" placeholder="300 123 4567" />
            <small class="field-hint">Los pacientes escriben aquí para verificar sus reservas y desde la página de reservas.</small></label>
          <label class="field"><span>${icon('message-square-text')} Plantilla del recordatorio</span>
            <textarea name="reminderTemplate" rows="7" maxlength="700" data-template>${template}</textarea></label>
          <div class="button-row" data-placeholders>${Object.entries(REMINDER_PLACEHOLDERS).map(
            ([name, description]) => html`<button type="button" class="badge badge-neutral" data-insert="{${name}}" data-tooltip="${description}">{${name}}</button>`,
          )}</div>
          <p class="form-error" data-template-errors hidden></p>
          <div class="modal-actions">
            <button type="button" class="button button-ghost" data-action="restore">${icon('undo-2')} Restaurar plantilla</button>
            <button class="button button-primary" type="submit">${icon('check')} Guardar</button>
          </div>
        </form>
      </section>
      <section class="card">
        <div class="card-header"><h3>${icon('eye')} Vista previa</h3>
          <a class="button button-whatsapp button-small" data-action="test" target="_blank" rel="noopener" href="#">${icon('send')} Probar en mi WhatsApp</a></div>
        <div class="card-padded">
          <div class="whatsapp-preview" data-preview></div>
          <p class="subtle" style="margin-top: 12px">${icon('info')} "Probar" abre WhatsApp hacia el número del consultorio con el mensaje de ejemplo, para que veas cómo le llegará al paciente.</p>
        </div>
      </section>
    </div>
    <section class="card card-padded">
      <h3 style="margin-bottom: 8px">${icon('circle-help')} Cómo se envían los mensajes (costo cero)</h3>
      <ol class="muted" style="margin: 0; padding-left: 20px; display: grid; gap: 4px">
        <li>Instala <strong>WhatsApp Business</strong> (gratis) en el celular del consultorio, o abre <strong>WhatsApp Web</strong> en el computador de recepción.</li>
        <li>Cada tarde entra a <strong>Recordatorios</strong> y toca "Enviar" en cada paciente de mañana: se abre el chat con el mensaje listo y solo presionas enviar.</li>
        <li>El mensaje incluye un enlace personal y firmado: cuando el paciente confirma, la cita cambia sola a "Confirmada".</li>
        <li>Los teléfonos fijos no reciben WhatsApp: el sistema lo detecta y te sugiere llamar.</li>
      </ol>
    </section>`,
  );
  refreshIcons(content);

  const form = $('[data-form="whatsapp"]', content) as HTMLFormElement;
  const templateInput = $('[data-template]', form) as HTMLTextAreaElement;
  const numberInput = form.elements.namedItem('whatsappNumber') as HTMLInputElement;
  const preview = $('[data-preview]', content);
  const errorsElement = $('[data-template-errors]', form);
  const testLink = $('[data-action="test"]', content) as HTMLAnchorElement;

  const refreshPreview = () => {
    const message = renderTemplate(templateInput.value, sampleTemplateValues());
    preview.textContent = message;
    const errors = validateReminderTemplate(templateInput.value);
    errorsElement.textContent = errors.join(' ');
    errorsElement.hidden = errors.length === 0;
    const link = whatsappLink(numberInput.value, message);
    testLink.href = link ? safeUrl(link, ['https:']) : '#';
    testLink.classList.toggle('is-disabled', !link);
  };
  refreshPreview();

  content.oninput = refreshPreview;
  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    const placeholder = target.closest<HTMLElement>('[data-insert]')?.dataset.insert;
    if (placeholder) {
      const position = templateInput.selectionStart ?? templateInput.value.length;
      templateInput.setRangeText(placeholder, position, templateInput.selectionEnd ?? position, 'end');
      templateInput.focus();
      refreshPreview();
    }
    if (target.closest('[data-action="restore"]')) {
      templateInput.value = DEFAULT_REMINDER_TEMPLATE;
      refreshPreview();
    }
    if (target.closest('[data-action="test"]') && testLink.classList.contains('is-disabled')) {
      event.preventDefault();
      toast('Escribe primero un celular válido del consultorio.', 'error');
    }
  };
  content.onsubmit = async (event) => {
    event.preventDefault();
    if (validateReminderTemplate(templateInput.value).length > 0) return refreshPreview();
    const saved = await withErrorToast(() =>
      api.put('/api/settings/whatsapp', {
        whatsappNumber: emptyToNull(numberInput.value),
        reminderTemplate: templateInput.value.trim() === DEFAULT_REMINDER_TEMPLATE ? null : templateInput.value,
      }),
    );
    if (saved) {
      toast('WhatsApp guardado.', 'success');
      await reload();
    }
  };
}

// ─── Pagos en línea (Wompi) ─────────────────────────────────────────────────

async function renderPaymentsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const gateway = await api.get<GatewayView>('/api/settings/payments');
  const offset = clinicOffset();
  const statusCard = !gateway.configured
    ? html`<span class="badge badge-neutral">${icon('plug-zap')} Sin configurar</span>`
    : !gateway.isEnabled
      ? html`<span class="badge badge-warning">${icon('ban')} Configurado pero desactivado</span>`
      : gateway.environment === 'sandbox'
        ? html`<span class="badge badge-info">${icon('circle-check-big')} Activo en PRUEBAS (Sandbox): no se cobra dinero real</span>`
        : html`<span class="badge badge-success">${icon('circle-check-big')} Activo en PRODUCCIÓN: cobros reales</span>`;
  const environment = gateway.environment ?? 'sandbox';

  setContent(
    content,
    html`<section class="card card-padded">
      <div class="toolbar">
        <span class="kpi-icon">${icon('credit-card')}</span>
        <div><strong>Pago anticipado con Wompi</strong><div class="subtle">Asegura las citas de servicios costosos: el paciente paga una parte al reservar y el dinero llega directo a la cuenta Wompi del consultorio.</div></div>
        <span class="spacer"></span>${statusCard}
      </div>
      ${gateway.configured
        ? html`<p class="subtle" style="margin-top: 10px">
            ${gateway.lastVerifiedAt ? html`${icon('check')} Conexión verificada: ${formatUtcAsLocal(gateway.lastVerifiedAt, offset)} · ` : html`${icon('triangle-alert')} Conexión aún no verificada · `}
            ${gateway.lastEventAt ? html`${icon('webhook')} Último evento de Wompi: ${formatUtcAsLocal(gateway.lastEventAt, offset)}` : html`${icon('webhook')} Aún no llegan eventos de Wompi`}</p>`
        : ''}
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-header"><h3>${icon('key-round')} Llaves de tu cuenta Wompi</h3></div>
        <form class="form card-padded" data-form="gateway">
          <div class="field"><span>Ambiente</span>
            <div class="button-row">
              <label class="checkbox"><input type="radio" name="environment" value="sandbox" ${environment === 'sandbox' ? 'checked' : ''} /><span><strong>Pruebas (Sandbox)</strong></span></label>
              <label class="checkbox"><input type="radio" name="environment" value="production" ${environment === 'production' ? 'checked' : ''} /><span><strong>Producción</strong></span></label>
            </div>
            <small class="field-hint" data-prefix-hint></small></div>
          <label class="field"><span>Llave pública</span><input name="publicKey" required autocomplete="off" spellcheck="false" value="${gateway.publicKey ?? ''}" /></label>
          <label class="field"><span>Secreto de integridad</span><input name="integritySecret" type="password" autocomplete="new-password" spellcheck="false"
            placeholder="${gateway.integritySecretMasked ? `Guardado (${gateway.integritySecretMasked}). Déjalo vacío para conservarlo.` : 'Pégalo aquí'}" /></label>
          <label class="field"><span>Secreto de eventos</span><input name="eventsSecret" type="password" autocomplete="new-password" spellcheck="false"
            placeholder="${gateway.eventsSecretMasked ? `Guardado (${gateway.eventsSecretMasked}). Déjalo vacío para conservarlo.` : 'Pégalo aquí'}" /></label>
          <label class="field"><span>Política del anticipo (la ve el paciente antes de pagar)</span>
            <textarea name="policyText" rows="3" maxlength="500" placeholder="Ej: El anticipo se descuenta del valor del tratamiento. Si cancelas con más de 24 horas, queda como saldo a favor.">${gateway.policyText ?? ''}</textarea></label>
          <label class="checkbox"><input type="checkbox" name="isEnabled" ${gateway.isEnabled || !gateway.configured ? 'checked' : ''} /><span>Cobrar anticipos en línea</span></label>
          <p class="subtle">${icon('lock')} Los secretos se guardan cifrados y nunca se vuelven a mostrar. La llave privada de Wompi <strong>no</strong> se necesita.</p>
          <div class="modal-actions">
            ${gateway.configured ? html`<button type="button" class="button button-secondary" data-action="test-connection">${icon('plug-zap')} Probar conexión</button>` : ''}
            <button class="button button-primary" type="submit">${icon('check')} Guardar</button>
          </div>
        </form>
      </section>

      <section class="card">
        <div class="card-header"><h3>${icon('list-checks')} Paso a paso</h3></div>
        <div class="card-padded">
          <ol class="setup-steps">
            <li>Ingresa a tu panel de comercio de <strong>Wompi</strong> (si no tienes cuenta, créala gratis como comercio).</li>
            <li>En la sección <strong>Desarrolladores</strong> copia la <strong>llave pública</strong> y, en "Secretos para integración técnica", el <strong>secreto de integridad</strong> y el <strong>secreto de eventos</strong>. Empieza con las de <strong>Sandbox</strong>.</li>
            <li>Pégalos aquí y guarda.</li>
            <li>Copia esta <strong>URL de eventos</strong> y pégala en Wompi (Desarrolladores → URL de eventos) del mismo ambiente:
              ${gateway.webhookUrl
                ? html`<div class="copy-field"><code>${gateway.webhookUrl}</code><button type="button" class="icon-button" data-action="copy-webhook" aria-label="Copiar URL de eventos" data-tooltip="Copiar">${icon('copy')}</button></div>`
                : html`<div class="subtle">(Aparece después de guardar.)</div>`}</li>
            <li>Toca <strong>Probar conexión</strong>.</li>
            <li>En <strong>Servicios</strong>, elige qué servicios exigen anticipo y cuánto (porcentaje o valor fijo).</li>
            <li>Haz una reserva de prueba: en Sandbox usa la tarjeta <code>4242 4242 4242 4242</code> (aprobada) o <code>4111 1111 1111 1111</code> (rechazada), con cualquier fecha futura y CVC de 3 dígitos.</li>
            <li>Cuando todo funcione, cambia a <strong>Producción</strong> con las llaves de producción y actualiza la URL de eventos en Wompi.</li>
          </ol>
        </div>
      </section>
    </div>`,
  );
  refreshIcons(content);

  const form = $('[data-form="gateway"]', content) as HTMLFormElement;
  const prefixHint = $('[data-prefix-hint]', form);
  const updatePrefixHint = () => {
    const selected = (form.querySelector('input[name="environment"]:checked') as HTMLInputElement | null)?.value ?? 'sandbox';
    prefixHint.textContent =
      selected === 'sandbox'
        ? 'Las llaves de pruebas empiezan por pub_test_, test_integrity_ y test_events_.'
        : 'Las llaves de producción empiezan por pub_prod_, prod_integrity_ y prod_events_. Si cambias de ambiente, pega también los dos secretos nuevos.';
  };
  updatePrefixHint();

  content.onchange = updatePrefixHint;
  content.onclick = async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="copy-webhook"]') && gateway.webhookUrl) await copyToClipboard(gateway.webhookUrl, 'URL de eventos copiada.');
    if (target.closest('[data-action="test-connection"]')) {
      const result = await withErrorToast(() => api.post<{ merchantName: string }>('/api/settings/payments/test'));
      if (result) {
        toast(`Conexión correcta con Wompi: ${result.merchantName}.`, 'success');
        await reload();
      }
    }
  };
  content.onsubmit = async (event) => {
    event.preventDefault();
    const values = readForm(form);
    const saved = await withErrorToast(() =>
      api.put('/api/settings/payments', {
        environment: values.environment,
        publicKey: values.publicKey,
        integritySecret: emptyToNull(values.integritySecret),
        eventsSecret: emptyToNull(values.eventsSecret),
        isEnabled: (form.elements.namedItem('isEnabled') as HTMLInputElement).checked,
        policyText: emptyToNull(values.policyText),
      }),
    );
    if (saved) {
      toast('Configuración de Wompi guardada. Ahora copia la URL de eventos en Wompi y prueba la conexión.', 'success');
      await reload();
    }
  };
}

// ─── Profesionales ──────────────────────────────────────────────────────────

async function renderProfessionalsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const professionals = await api.get<ProfessionalItem[]>('/api/professionals');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('stethoscope')} Profesionales y horarios</h3>
        <button class="button button-primary" data-action="new-professional">${icon('user-plus')} Nuevo profesional</button></div>
      ${professionals.length === 0
        ? emptyState('stethoscope', 'Sin profesionales', 'Crea al menos uno y define su horario para habilitar la agenda.')
        : html`<div class="table-wrapper"><table class="data-table"><thead><tr><th>Profesional</th><th>Especialidad</th><th>Usuario vinculado</th><th>Estado</th><th></th></tr></thead><tbody>
          ${professionals.map((professional) => html`<tr>
            <td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${professional.color}"></span> <strong>${professional.full_name}</strong></td>
            <td>${professional.specialty ?? '—'}</td>
            <td>${professional.user_id ? html`<span class="badge badge-info">${icon('user-check')} Vinculado</span>` : html`<span class="subtle">—</span>`}</td>
            <td>${professional.is_active ? html`<span class="badge badge-success">Activo</span>` : html`<span class="badge badge-neutral">Inactivo</span>`}</td>
            <td class="align-right nowrap">
              <button class="button button-secondary button-small" data-schedule="${professional.id}">${icon('clock')} Horario</button>
              <button class="icon-button" data-edit-professional="${professional.id}" aria-label="Editar" data-tooltip="Editar">${icon('pencil')}</button>
            </td></tr>`)}
        </tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onclick = async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="new-professional"]')) await openProfessionalModal(null, reload);
    const editId = target.closest<HTMLElement>('[data-edit-professional]')?.dataset.editProfessional;
    const professionalToEdit = professionals.find((professional) => professional.id === editId);
    if (professionalToEdit) await openProfessionalModal(professionalToEdit, reload);
    const scheduleId = target.closest<HTMLElement>('[data-schedule]')?.dataset.schedule;
    const professionalForSchedule = professionals.find((professional) => professional.id === scheduleId);
    if (professionalForSchedule) await openScheduleModal(professionalForSchedule);
  };
}

// ─── Bloqueos ───────────────────────────────────────────────────────────────

async function renderBlocksTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const offset = clinicOffset();
  const [blocks, professionals] = await Promise.all([
    api.get<TimeBlock[]>('/api/time-blocks', { from: todayLocal(offset), to: addDays(todayLocal(offset), 90) }),
    api.get<ProfessionalItem[]>('/api/professionals'),
  ]);
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('ban')} Bloqueos próximos</h3>
        <button class="button button-secondary" data-action="new-block">${icon('plus')} Bloquear horario</button></div>
      ${blocks.length === 0
        ? emptyState('calendar', 'Sin bloqueos', 'Usa bloqueos para vacaciones, capacitaciones o mantenimiento.')
        : html`<div class="table-wrapper"><table class="data-table"><thead><tr><th>Desde</th><th>Hasta</th><th>Profesional</th><th>Motivo</th><th></th></tr></thead><tbody>
          ${blocks.map((block) => html`<tr>
            <td>${formatShortDate(block.start_at.slice(0, 10))} ${formatTime(block.start_at)}</td>
            <td>${formatShortDate(block.end_at.slice(0, 10))} ${formatTime(block.end_at)}</td>
            <td>${block.professional_name ?? 'Todo el consultorio'}</td>
            <td>${block.reason ?? '—'}</td>
            <td class="align-right"><button class="icon-button is-danger" data-delete-block="${block.id}" aria-label="Eliminar" data-tooltip="Eliminar bloqueo">${icon('trash-2')}</button></td>
          </tr>`)}
        </tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onclick = async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="new-block"]')) openNewBlockModal(professionals.filter((professional) => professional.is_active === 1), reload);
    const blockId = target.closest<HTMLElement>('[data-delete-block]')?.dataset.deleteBlock;
    if (blockId && (await withErrorToast(() => api.delete(`/api/time-blocks/${blockId}`)))) {
      toast('Bloqueo eliminado.', 'success');
      await reload();
    }
  };
}

// ─── Modales de profesionales y horarios ────────────────────────────────────

async function openProfessionalModal(professional: ProfessionalItem | null, onDone: () => Promise<void>): Promise<void> {
  const users = can('usuarios.gestionar') ? await api.get<UserOption[]>('/api/users').catch(() => []) : [];
  openFormModal({
    title: professional ? 'Editar profesional' : 'Nuevo profesional',
    iconName: 'stethoscope',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
      <label class="field full"><span>Nombre</span><input name="fullName" required maxlength="120" value="${professional?.full_name ?? ''}" placeholder="Dra. Ana María Torres" /></label>
      <label class="field"><span>Especialidad</span><input name="specialty" maxlength="120" value="${professional?.specialty ?? ''}" /></label>
      <label class="field"><span>Color en la agenda</span><input name="color" type="color" value="${professional?.color ?? '#4f6d8a'}" /></label>
      ${users.length
        ? html`<label class="field full"><span>Usuario vinculado <span class="hint" data-tooltip="Permite que este profesional vea su propia agenda al ingresar">${icon('info')}</span></span>
            <select name="userId"><option value="">Sin vincular</option>${users.map((user) => html`<option value="${user.id}" ${professional?.user_id === user.id ? 'selected' : ''}>${user.fullName}</option>`)}</select></label>`
        : ''}
      <label class="checkbox"><input type="checkbox" name="isActive" ${professional === null || professional.is_active ? 'checked' : ''} /><span>Activo</span></label>
    </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const payload = {
        fullName: values.fullName,
        specialty: emptyToNull(values.specialty),
        color: values.color,
        userId: users.length ? emptyToNull(values.userId) : professional?.user_id ?? null,
        isActive: (form.elements.namedItem('isActive') as HTMLInputElement).checked,
      };
      if (professional) await api.put(`/api/professionals/${professional.id}`, payload);
      else await api.post('/api/professionals', payload);
      toast('Profesional guardado.', 'success');
      await onDone();
    },
  });
}

async function openScheduleModal(professional: ProfessionalItem): Promise<void> {
  const currentBlocks = await api.get<ScheduleBlock[]>(`/api/professionals/${professional.id}/schedule`);
  const rowMarkup = (block: ScheduleBlock) => html`<div class="button-row" data-block-row>
    <select name="weekday" class="input" style="width: auto">${WEEKDAY_NAMES.map((name, index) => html`<option value="${index}" ${block.weekday === index ? 'selected' : ''}>${name}</option>`)}</select>
    <input type="time" name="startTime" class="input" style="width: auto" value="${block.start_time}" required />
    <span class="muted">a</span>
    <input type="time" name="endTime" class="input" style="width: auto" value="${block.end_time}" required />
    <button type="button" class="icon-button is-danger" data-remove-row aria-label="Quitar franja">${icon('trash-2')}</button>
  </div>`;

  const modal = openFormModal({
    title: `Horario de ${professional.full_name}`,
    iconName: 'clock',
    submitLabel: 'Guardar horario',
    size: 'wide',
    fields: html`<p class="muted">Agrega una franja por cada bloque de atención. Para la hora de almuerzo crea dos franjas el mismo día (ej. 8:00–12:00 y 14:00–18:00).</p>
      <div data-rows style="display: grid; gap: 8px">${currentBlocks.map(rowMarkup)}</div>
      <div class="button-row">
        <button type="button" class="button button-secondary button-small" data-add-row>${icon('plus')} Agregar franja</button>
        <button type="button" class="button button-ghost button-small" data-template>${icon('sparkles')} Lunes a viernes 8–12 y 14–18, sábado 8–12</button>
      </div>`,
    onSubmit: async (form) => {
      const blocks = [...form.querySelectorAll<HTMLElement>('[data-block-row]')].map((row) => ({
        weekday: Number((row.querySelector('[name="weekday"]') as HTMLSelectElement).value),
        startTime: (row.querySelector('[name="startTime"]') as HTMLInputElement).value,
        endTime: (row.querySelector('[name="endTime"]') as HTMLInputElement).value,
      }));
      await api.put(`/api/professionals/${professional.id}/schedule`, { blocks });
      toast('Horario guardado.', 'success');
    },
  });

  const rowsElement = modal.body.querySelector('[data-rows]') as HTMLElement;
  const setRows = (blocks: ScheduleBlock[]) => {
    setContent(rowsElement, html`${blocks.map(rowMarkup)}`);
    refreshIcons(rowsElement);
  };
  modal.body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-remove-row]')) target.closest('[data-block-row]')?.remove();
    if (target.closest('[data-add-row]')) {
      rowsElement.insertAdjacentHTML('beforeend', rowMarkup({ weekday: 1, start_time: '08:00', end_time: '12:00' }).value);
      refreshIcons(rowsElement);
    }
    if (target.closest('[data-template]')) {
      const template: ScheduleBlock[] = [];
      for (let weekday = 1; weekday <= 5; weekday++) {
        template.push({ weekday, start_time: '08:00', end_time: '12:00' }, { weekday, start_time: '14:00', end_time: '18:00' });
      }
      template.push({ weekday: 6, start_time: '08:00', end_time: '12:00' });
      setRows(template);
    }
  });
}
