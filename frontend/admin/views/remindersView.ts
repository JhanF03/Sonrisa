/**
 * Recordatorios por WhatsApp (costo cero): confirmación de citas,
 * verificación de reservas en línea, reactivación de pacientes y lista de espera.
 */
import { api } from '../../core/api.js';
import { html, readForm, safeUrl, setContent } from '../../core/dom.js';
import { addDays, formatLongDate, formatShortDate, formatTime, todayLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, refreshIcons, toast, whatsappButton, withErrorToast } from '../../core/ui.js';
import { attachPatientPicker, patientPickerMarkup, statusBadge, type ServiceItem } from '../components.js';
import { can, clinicOffset, session } from '../session.js';
import type { AppointmentItem } from './agendaView.js';

type Tab = 'confirmar' | 'verificar' | 'reactivar' | 'espera';

interface ReminderItem extends AppointmentItem {
  manageUrl: string;
  whatsappMessage: string;
  whatsappUrl: string | null;
}

let activeTab: Tab = 'confirmar';
let reminderDate = '';

export async function renderRemindersView(container: HTMLElement): Promise<void> {
  reminderDate ||= addDays(todayLocal(clinicOffset()), 1);
  const tabs: Array<[Tab, string, string, boolean]> = [
    ['confirmar', 'bell-ring', 'Confirmar citas', can('recordatorios.gestionar')],
    ['verificar', 'shield-check', 'Por verificar', can('agenda.verificar')],
    ['reactivar', 'refresh-cw', 'Reactivar pacientes', can('recordatorios.gestionar')],
    ['espera', 'hourglass', 'Lista de espera', can('recordatorios.gestionar')],
  ];
  const visibleTabs = tabs.filter(([, , , allowed]) => allowed);
  if (!visibleTabs.some(([tab]) => tab === activeTab)) activeTab = visibleTabs[0]?.[0] ?? 'confirmar';

  setContent(
    container,
    html`<div class="tabs" role="tablist">${visibleTabs.map(([tab, iconName, label]) => html`<button class="tab ${tab === activeTab ? 'is-active' : ''}" data-tab="${tab}" role="tab">${icon(iconName)} ${label}</button>`)}</div>
    <div data-tab-content>${loadingState()}</div>`,
  );
  refreshIcons(container);

  const content = container.querySelector('[data-tab-content]') as HTMLElement;
  container.onclick = async (event) => {
    const tabButton = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (tabButton) {
      activeTab = tabButton.dataset.tab as Tab;
      await renderRemindersView(container);
    }
  };

  const reload = () => renderRemindersView(container);
  if (activeTab === 'confirmar') await renderConfirmations(content, reload);
  if (activeTab === 'verificar') await renderVerifications(content, reload);
  if (activeTab === 'reactivar') await renderReactivation(content);
  if (activeTab === 'espera') await renderWaitlist(content, reload);
  refreshIcons(content);
}

async function renderConfirmations(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const { appointments } = await api.get<{ date: string; appointments: ReminderItem[] }>('/api/reminders', { date: reminderDate });
  const pendingCount = appointments.filter((appointment) => !appointment.reminder_sent_at && appointment.status === 'pendiente').length;

  setContent(
    content,
    html`<section class="card">
      <div class="card-header">
        <div class="toolbar">
          <label class="field" style="flex-direction: row; align-items: center; gap: 8px"><span>${icon('calendar')} Citas del</span><input type="date" name="reminderDate" value="${reminderDate}" class="input" style="width: auto" /></label>
          <span class="muted">${formatLongDate(reminderDate)}</span>
        </div>
        <span class="badge ${pendingCount ? 'badge-warning' : 'badge-success'}">${pendingCount ? `${pendingCount} por avisar` : 'Todo avisado'}</span>
      </div>
      <div class="card-padded subtle">${icon('info')} Cada botón abre WhatsApp con el mensaje listo (puedes editar la plantilla en Configuración → WhatsApp). Cuando el paciente toca el enlace y confirma, la cita cambia sola a "Confirmada".</div>
      ${appointments.length === 0
        ? emptyState('calendar-x', 'No hay citas activas ese día', 'Elige otra fecha.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Hora</th><th>Paciente</th><th>Servicio</th><th>Estado</th><th></th></tr></thead>
          <tbody>${appointments.map((appointment) => html`<tr>
            <td class="nowrap">${formatTime(appointment.start_at)}</td>
            <td><strong>${appointment.patient_name}</strong><br /><small class="subtle">${appointment.patient_phone}</small></td>
            <td>${appointment.service_name}<br /><small class="subtle">${appointment.professional_name}</small></td>
            <td>${statusBadge(appointment.status)}
              ${appointment.hold_reason === 'confirmacion' && appointment.hold_expires_at
                ? html`<br /><small class="badge badge-warning" data-tooltip="Si no confirma antes, el horario se libera automáticamente">${icon('hourglass')} Confirmar antes de ${formatUtcShort(appointment.hold_expires_at)}</small>`
                : ''}
              ${appointment.reminder_sent_at ? html`<br /><small class="subtle">${icon('check')} avisado</small>` : ''}</td>
            <td class="align-right">${appointment.whatsappUrl
              ? html`<a class="button button-whatsapp button-small" target="_blank" rel="noopener" href="${safeUrl(appointment.whatsappUrl, ['https:'])}" data-reminder-id="${appointment.id}">${icon('message-circle')} ${appointment.reminder_sent_at ? 'Reenviar' : 'Enviar'}</a>`
              : html`<span class="button button-small is-disabled" data-tooltip="El teléfono no es un celular. Llama al paciente y confirma en la agenda." tabindex="0">${icon('phone')} Llamar</span>`}</td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'reminderDate' && input.value) {
      reminderDate = input.value;
      void reload();
    }
  };
  content.onclick = (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-reminder-id]');
    if (link?.dataset.reminderId) {
      void withErrorToast(() => api.post(`/api/appointments/${link.dataset.reminderId}/reminder-sent`)).then(() => {
        window.setTimeout(() => void reload(), 800);
      });
    }
  };
}

/** Fecha/hora UTC mostrada en hora del consultorio, formato corto. */
function formatUtcShort(utcIso: string): string {
  const local = new Date(new Date(utcIso).getTime() + clinicOffset() * 60_000).toISOString();
  return `${formatShortDate(local.slice(0, 10))} ${formatTime(local.slice(0, 16))}`;
}

function minutesLeft(utcIso: string): number {
  return Math.max(0, Math.round((new Date(utcIso).getTime() - Date.now()) / 60_000));
}

async function renderVerifications(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const pending = await api.get<Array<AppointmentItem & { hold_expires_at: string; verification_code: string }>>('/api/verifications');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('shield-check')} Reservas en línea por verificar</h3><span class="badge ${pending.length ? 'badge-warning' : 'badge-success'}">${pending.length} pendientes</span></div>
      <div class="card-padded subtle">${icon('info')} El paciente te escribe por WhatsApp con un código de 6 dígitos. Comprueba que el mensaje venga del <strong>mismo celular</strong> de la reserva, escribe el código y la cita queda confirmada. Si no llega a tiempo, el horario se libera solo.</div>
      ${pending.length === 0
        ? emptyState('shield-check', 'Nada por verificar', 'Aquí aparecen las reservas en línea que esperan el mensaje de WhatsApp del paciente.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Paciente</th><th>Cita</th><th>Vence en</th><th>Código recibido</th></tr></thead>
          <tbody>${pending.map((appointment) => html`<tr>
            <td><strong>${appointment.patient_name}</strong><br /><small class="subtle">${icon('phone')} ${appointment.patient_phone}</small></td>
            <td>${formatShortDate(appointment.start_at.slice(0, 10))} · ${formatTime(appointment.start_at)}<br /><small class="subtle">${appointment.service_name}</small></td>
            <td><span class="badge ${minutesLeft(appointment.hold_expires_at) < 15 ? 'badge-danger' : 'badge-warning'}">${icon('hourglass')} ${minutesLeft(appointment.hold_expires_at)} min</span></td>
            <td><form class="button-row" data-verify-form="${appointment.id}">
              <input class="input" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="000000" aria-label="Código de 6 dígitos" style="width: 110px" required />
              <button class="button button-primary button-small" type="submit">${icon('check')} Verificar</button>
            </form></td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onsubmit = async (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-verify-form]');
    if (!form) return;
    event.preventDefault();
    const { code } = readForm(form);
    const result = await withErrorToast(() => api.post(`/api/appointments/${form.dataset.verifyForm}/verify`, { code }));
    if (result) {
      toast('Reserva verificada y confirmada.', 'success');
      await reload();
    }
  };
}

interface ReactivationCandidate {
  patient_id: string;
  full_name: string;
  phone: string;
  last_visit: string;
}

async function renderReactivation(content: HTMLElement): Promise<void> {
  const candidates = await api.get<ReactivationCandidate[]>('/api/reactivation');
  const clinicName = session().clinic.name;
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('refresh-cw')} Pacientes que no vuelven</h3><span class="badge badge-info">${candidates.length} pacientes</span></div>
      <div class="card-padded subtle">${icon('info')} Pacientes sin visita en los meses configurados y sin cita futura. Un mensaje oportuno se convierte en una nueva cita.</div>
      ${candidates.length === 0
        ? emptyState('smile', 'Todos tus pacientes están al día', 'Aquí aparecerán quienes lleven tiempo sin venir.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Paciente</th><th>Última visita</th><th></th></tr></thead>
          <tbody>${candidates.map((candidate) => html`<tr>
            <td><a class="row-link" href="#/pacientes/${candidate.patient_id}">${candidate.full_name}</a><br /><small class="subtle">${candidate.phone}</small></td>
            <td>${formatShortDate(candidate.last_visit.slice(0, 10))}</td>
            <td class="align-right">${whatsappButton(
              candidate.phone,
              `Hola ${candidate.full_name.split(' ')[0]} 😊 En ${clinicName} notamos que ya es momento de tu control y limpieza. ¿Te agendamos una cita esta semana? Responde este mensaje y te ayudamos.`,
              { label: 'Invitar', variant: 'small' },
            )}</td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
}

interface WaitlistItem {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  service_name: string | null;
  professional_name: string | null;
  notes: string | null;
  created_at: string;
}

async function renderWaitlist(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const entries = await api.get<WaitlistItem[]>('/api/waitlist');
  const clinicName = session().clinic.name;
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('hourglass')} Lista de espera</h3>
        <button class="button button-primary" data-action="add">${icon('plus')} Agregar</button></div>
      <div class="card-padded subtle">${icon('info')} Cuando se cancele una cita, avisa por WhatsApp a quien está esperando un espacio.</div>
      ${entries.length === 0
        ? emptyState('hourglass', 'Nadie en espera', 'Agrega pacientes que quieren una cita antes.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Paciente</th><th>Busca</th><th>Notas</th><th></th></tr></thead>
          <tbody>${entries.map((entry) => html`<tr>
            <td><strong>${entry.patient_name}</strong><br /><small class="subtle">${entry.patient_phone}</small></td>
            <td>${entry.service_name ?? 'Cualquier servicio'}${entry.professional_name ? html`<br /><small class="subtle">con ${entry.professional_name}</small>` : ''}</td>
            <td>${entry.notes ?? '—'}</td>
            <td class="align-right nowrap">
              ${whatsappButton(entry.patient_phone, `Hola ${entry.patient_name.split(' ')[0]}, se liberó un espacio en ${clinicName}. ¿Te gustaría tomarlo? Responde y te confirmamos la hora.`, { label: 'Avisar', variant: 'small' })}
              <button class="icon-button" data-resolve="${entry.id}" data-tooltip="Marcar como resuelto" aria-label="Resuelto">${icon('check')}</button>
            </td></tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const resolveId = target.closest<HTMLElement>('[data-resolve]')?.dataset.resolve;
    if (resolveId) {
      if (await withErrorToast(() => api.post(`/api/waitlist/${resolveId}/resolve`))) {
        toast('Marcado como resuelto.', 'success');
        await reload();
      }
    }
    if (target.closest('[data-action="add"]')) {
      const services = (await api.get<ServiceItem[]>('/api/services')).filter((service) => service.is_active === 1);
      const modal = openFormModal({
        title: 'Agregar a lista de espera',
        iconName: 'hourglass',
        submitLabel: 'Agregar',
        fields: html`${patientPickerMarkup()}
          <label class="field"><span>Servicio</span><select name="serviceId"><option value="">Cualquiera</option>${services.map((service) => html`<option value="${service.id}">${service.name}</option>`)}</select></label>
          <label class="field"><span>Notas</span><input name="notes" maxlength="300" placeholder="Ej: prefiere la tarde" /></label>`,
        onSubmit: async (form) => {
          const values = readForm(form);
          if (!values.patientId) throw new Error('Selecciona el paciente.');
          await api.post('/api/waitlist', { patientId: values.patientId, serviceId: values.serviceId || null, notes: values.notes || null });
          toast('Agregado a la lista de espera.', 'success');
          await reload();
        },
      });
      attachPatientPicker(modal.body);
    }
  };
}
