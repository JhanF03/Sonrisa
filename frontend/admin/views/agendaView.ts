/**
 * Agenda diaria por profesional: ver, crear, confirmar, atender,
 * reprogramar y cancelar citas; crear bloqueos.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { addDays, formatLongDate, formatMoney, formatTime, todayLocal, weekdayOf } from '../../core/format.js';
import { askReason, emptyState, icon, loadingState, openFormModal, openModal, refreshIcons, toast, whatsappButton, withErrorToast } from '../../core/ui.js';
import {
  attachPatientPicker,
  openNewPatientModal,
  patientPickerMarkup,
  statusBadge,
  type PatientSummary,
  type ProfessionalItem,
  type ServiceItem,
} from '../components.js';
import { can, clinicOffset, session } from '../session.js';

export interface AppointmentItem {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  professional_id: string;
  professional_name: string;
  professional_color: string;
  service_id: string;
  service_name: string;
  start_at: string;
  end_at: string;
  status: string;
  source: string;
  price: number;
  notes: string | null;
  recurrence_group_id: string | null;
  reminder_sent_at: string | null;
  hold_reason: 'pago' | 'verificacion' | 'confirmacion' | null;
  hold_expires_at: string | null;
  verification_code: string | null;
  prepayment_amount: number;
}

/** Una retención vencida ya no ocupa el horario: se oculta como si estuviera cancelada. */
export function isEffectivelyCancelled(appointment: AppointmentItem): boolean {
  if (appointment.status === 'cancelada') return true;
  return Boolean(appointment.hold_reason && appointment.hold_expires_at && appointment.hold_expires_at <= new Date().toISOString());
}

const HOLD_LABELS: Record<string, { label: string; tone: string; iconName: string }> = {
  pago: { label: 'Esperando pago', tone: 'badge-warning', iconName: 'circle-dollar-sign' },
  verificacion: { label: 'Por verificar', tone: 'badge-info', iconName: 'shield-check' },
  confirmacion: { label: 'Debe confirmar', tone: 'badge-neutral', iconName: 'hourglass' },
};

export function holdBadge(appointment: AppointmentItem) {
  if (!appointment.hold_reason || isEffectivelyCancelled(appointment)) return html``;
  const info = HOLD_LABELS[appointment.hold_reason];
  return html`<span class="badge ${info.tone}">${icon(info.iconName)} ${info.label}</span>`;
}

interface ScheduleBlock {
  professional_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

interface TimeBlock {
  id: string;
  professional_id: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
}

interface Slot {
  start: string;
  end: string;
  professionalId: string;
  professionalName: string;
}

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 20;
const CELL_MINUTES = 15;
const ROW_HEIGHT_PX = 20;

let selectedDate = '';
let viewContainer: HTMLElement;

export async function renderAgendaView(container: HTMLElement): Promise<void> {
  viewContainer = container;
  selectedDate ||= todayLocal(clinicOffset());
  await drawAgenda();
}

async function drawAgenda(): Promise<void> {
  setContent(viewContainer, loadingState('Cargando agenda…'));

  const [allProfessionals, appointments, timeBlocks, holidays] = await Promise.all([
    api.get<ProfessionalItem[]>('/api/professionals'),
    api.get<AppointmentItem[]>('/api/appointments', { from: selectedDate, to: selectedDate }),
    api.get<TimeBlock[]>('/api/time-blocks', { from: selectedDate, to: selectedDate }),
    api.get<string[]>(`/api/holidays/${selectedDate.slice(0, 4)}`),
  ]);

  // Con "ver solo su agenda", solo se muestra la columna propia.
  const ownProfessionalId = session().user.professionalId;
  const professionals = allProfessionals.filter(
    (professional) => professional.is_active === 1 && (can('agenda.ver_todas') || professional.id === ownProfessionalId),
  );
  const schedules = (
    await Promise.all(professionals.map((professional) => api.get<ScheduleBlock[]>(`/api/professionals/${professional.id}/schedule`)))
  ).flat();

  const isHoliday = holidays.includes(selectedDate);
  const activeAppointments = appointments.filter((appointment) => !isEffectivelyCancelled(appointment));

  setContent(
    viewContainer,
    html`<section class="card">
      <div class="card-header">
        <div class="agenda-toolbar">
          <button class="icon-button" data-action="previous-day" aria-label="Día anterior" data-tooltip="Día anterior">${icon('chevron-left')}</button>
          <button class="button button-secondary button-small" data-action="today" data-tooltip="Ir a hoy">Hoy</button>
          <button class="icon-button" data-action="next-day" aria-label="Día siguiente" data-tooltip="Día siguiente">${icon('chevron-right')}</button>
          <input class="input" type="date" value="${selectedDate}" data-action="pick-date" aria-label="Elegir fecha" style="width: auto" />
          <span class="agenda-date">${formatLongDate(selectedDate)}</span>
          ${isHoliday ? html`<span class="badge badge-warning">${icon('calendar-x')} Festivo</span>` : ''}
        </div>
        <div class="button-row">
          ${can('agenda.bloquear') ? html`<button class="button button-secondary" data-action="new-block" data-tooltip="Bloquear un horario (vacaciones, reuniones)">${icon('ban')} Bloquear</button>` : ''}
          ${can('agenda.crear') ? html`<button class="button button-primary" data-action="new-appointment">${icon('calendar-plus')} Nueva cita</button>` : ''}
        </div>
      </div>
      <div class="card-padded" style="padding-bottom: 8px">
        <div class="agenda-legend">
          <span><i style="background: var(--surface)"></i>Pendiente</span>
          <span><i style="background: var(--info-soft)"></i>Confirmada</span>
          <span><i style="background: var(--success-soft)"></i>Atendida</span>
          <span><i style="background: var(--danger-soft)"></i>No asistió</span>
          <span class="subtle">${activeAppointments.length} citas · clic en un espacio libre para agendar</span>
        </div>
      </div>
      ${professionals.length === 0
        ? emptyState('stethoscope', 'No hay profesionales para mostrar', 'Crea profesionales y sus horarios en Configuración, o pide que vinculen tu usuario a tu perfil profesional.')
        : renderGrid(professionals, appointments, schedules, timeBlocks)}
    </section>`,
  );
  refreshIcons(viewContainer);
  bindAgendaEvents(professionals, appointments);
}

function minutesFromDayStart(localDateTime: string): number {
  const [hours, minutes] = localDateTime.slice(11, 16).split(':').map(Number);
  return (hours - DAY_START_HOUR) * 60 + minutes;
}

function renderGrid(professionals: ProfessionalItem[], appointments: AppointmentItem[], schedules: ScheduleBlock[], timeBlocks: TimeBlock[]): SafeHtml {
  const weekday = weekdayOf(selectedDate);
  const cellCount = ((DAY_END_HOUR - DAY_START_HOUR) * 60) / CELL_MINUTES;
  const hourLabels = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_unused, index) => `${String(DAY_START_HOUR + index).padStart(2, '0')}:00`);

  const columns = professionals.map((professional) => {
    const dayBlocks = schedules.filter((block) => block.professional_id === professional.id && block.weekday === weekday);
    const cells = Array.from({ length: cellCount }, (_unused, index) => {
      const totalMinutes = DAY_START_HOUR * 60 + index * CELL_MINUTES;
      const time = `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
      const isOpen = dayBlocks.some((block) => time >= block.start_time && time < block.end_time);
      return html`<button type="button" class="agenda-cell ${isOpen ? '' : 'is-closed'}" data-cell-time="${time}" data-professional-id="${professional.id}"
        aria-label="${isOpen ? `Agendar a las ${time} con ${professional.full_name}` : `${time} fuera de horario`}" ${isOpen && can('agenda.crear') ? '' : 'tabindex="-1"'}></button>`;
    });

    const blockMarkup = timeBlocks
      .filter((block) => block.professional_id === null || block.professional_id === professional.id)
      .map((block) => {
        const start = Math.max(0, minutesFromDayStart(block.start_at.slice(0, 10) < selectedDate ? `${selectedDate}T07:00` : block.start_at));
        const end = Math.min((DAY_END_HOUR - DAY_START_HOUR) * 60, minutesFromDayStart(block.end_at.slice(0, 10) > selectedDate ? `${selectedDate}T20:00` : block.end_at));
        if (end <= start) return '';
        return html`<div class="agenda-block" style="top: ${(start / CELL_MINUTES) * ROW_HEIGHT_PX}px; height: ${((end - start) / CELL_MINUTES) * ROW_HEIGHT_PX}px">
          ${icon('ban')}&nbsp;${block.reason ?? 'Bloqueado'}</div>`;
      });

    const eventMarkup = appointments
      .filter((appointment) => appointment.professional_id === professional.id && !isEffectivelyCancelled(appointment))
      .map((appointment) => {
        const start = minutesFromDayStart(appointment.start_at);
        const duration = minutesFromDayStart(appointment.end_at) - start;
        return html`<button type="button" class="agenda-event status-${appointment.status} ${appointment.hold_reason ? `hold-${appointment.hold_reason}` : ''}" data-appointment-id="${appointment.id}"
          style="--event-color: ${professional.color}; top: ${(start / CELL_MINUTES) * ROW_HEIGHT_PX + 1}px; height: ${(duration / CELL_MINUTES) * ROW_HEIGHT_PX - 2}px">
          <strong>${appointment.patient_name}</strong>
          <span class="meta">${appointment.hold_reason === 'pago' ? '💳 ' : appointment.hold_reason === 'verificacion' ? '🔐 ' : ''}${formatTime(appointment.start_at)} · ${appointment.service_name}${appointment.source === 'online' ? ' · en línea' : ''}</span>
        </button>`;
      });

    return html`<div class="agenda-column">
      <div class="agenda-column-header"><span class="dot" style="background: ${professional.color}"></span>${professional.full_name}</div>
      <div class="agenda-cells">${cells}${blockMarkup}${eventMarkup}</div>
    </div>`;
  });

  return html`<div class="agenda-scroll">
    <div class="agenda-grid" style="grid-template-columns: 78px repeat(${professionals.length}, minmax(200px, 1fr))">
      <div class="agenda-times">${hourLabels.map((label) => html`<div class="agenda-time">${formatTime(label)}</div>`)}</div>
      ${columns}
    </div>
  </div>`;
}

function bindAgendaEvents(professionals: ProfessionalItem[], appointments: AppointmentItem[]): void {
  viewContainer.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;

    if (action === 'previous-day') return changeDate(addDays(selectedDate, -1));
    if (action === 'next-day') return changeDate(addDays(selectedDate, 1));
    if (action === 'today') return changeDate(todayLocal(clinicOffset()));
    if (action === 'new-appointment') return openNewAppointmentModal({ date: selectedDate });
    if (action === 'new-block') return openNewBlockModal(professionals);

    const eventButton = target.closest<HTMLElement>('[data-appointment-id]');
    if (eventButton) {
      const appointment = appointments.find((candidate) => candidate.id === eventButton.dataset.appointmentId);
      if (appointment) openAppointmentDetail(appointment, professionals);
      return;
    }

    const cell = target.closest<HTMLElement>('.agenda-cell:not(.is-closed)');
    if (cell && can('agenda.crear')) {
      openNewAppointmentModal({ date: selectedDate, time: cell.dataset.cellTime, professionalId: cell.dataset.professionalId });
    }
  };
  viewContainer.onchange = (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-action="pick-date"]');
    if (input?.value) void changeDate(input.value);
  };
}

async function changeDate(date: string): Promise<void> {
  selectedDate = date;
  await drawAgenda();
}

// ─── Nueva cita ─────────────────────────────────────────────────────────────

export async function openNewAppointmentModal(prefill: { date: string; time?: string; professionalId?: string; patient?: PatientSummary }): Promise<void> {
  const [services, professionals] = await Promise.all([
    api.get<ServiceItem[]>('/api/services'),
    api.get<ProfessionalItem[]>('/api/professionals'),
  ]);
  const activeServices = services.filter((service) => service.is_active === 1);
  const activeProfessionals = professionals.filter((professional) => professional.is_active === 1);

  const modal = openFormModal({
    title: 'Nueva cita',
    iconName: 'calendar-plus',
    submitLabel: 'Agendar cita',
    size: 'wide',
    fields: html`
      ${patientPickerMarkup()}
      <div><button type="button" class="button button-ghost button-small" data-action="create-patient">${icon('user-plus')} Paciente nuevo</button></div>
      <div class="form-grid">
        <label class="field"><span>${icon('stethoscope')} Servicio</span>
          <select name="serviceId" required>${activeServices.map((service) => html`<option value="${service.id}">${service.name} · ${service.duration_minutes} min · ${formatMoney(service.price)}</option>`)}</select></label>
        <label class="field"><span>${icon('user')} Profesional</span>
          <select name="professionalId" required>${activeProfessionals.map((professional) => html`<option value="${professional.id}" ${professional.id === prefill.professionalId ? 'selected' : ''}>${professional.full_name}</option>`)}</select></label>
        <label class="field"><span>${icon('calendar')} Fecha</span><input type="date" name="date" value="${prefill.date}" required /></label>
        <label class="field"><span>${icon('clock')} Hora <span class="hint" data-tooltip="Elige un horario libre abajo o escribe una hora manual (para casos especiales).">${icon('info')}</span></span>
          <input type="time" name="time" step="300" value="${prefill.time ?? ''}" required /></label>
        <div class="field full"><span>Horarios libres</span><div class="slot-grid" data-slots>${loadingState('Buscando horarios…')}</div></div>
        <label class="checkbox full"><input type="checkbox" name="repeat" /> <span>${icon('repeat')} Repetir (ej. controles de ortodoncia)</span></label>
        <label class="field" data-recurrence hidden><span>Número de citas</span><input type="number" name="occurrences" min="2" max="24" value="6" /></label>
        <label class="field" data-recurrence hidden><span>Cada cuántas semanas</span><input type="number" name="intervalWeeks" min="1" max="12" value="4" /></label>
        <label class="field full"><span>Notas (opcional)</span><input name="notes" maxlength="500" placeholder="Solo información administrativa" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      if (!values.patientId) throw new Error('Selecciona o crea el paciente.');
      if (!values.time) throw new Error('Elige la hora de la cita.');
      const isRecurring = (form.elements.namedItem('repeat') as HTMLInputElement).checked;
      const result = await api.post<{ created: AppointmentItem[]; conflicts: string[] }>('/api/appointments', {
        patientId: values.patientId,
        serviceId: values.serviceId,
        professionalId: values.professionalId,
        startAt: `${values.date}T${values.time}`,
        notes: emptyToNull(values.notes),
        recurrence: isRecurring ? { occurrences: Number(values.occurrences), intervalWeeks: Number(values.intervalWeeks) } : null,
      });
      toast(
        result.conflicts.length
          ? `Se agendaron ${result.created.length} citas. ${result.conflicts.length} chocaban con otras y no se crearon.`
          : result.created.length > 1 ? `Se agendaron ${result.created.length} citas.` : 'Cita agendada.',
        result.conflicts.length ? 'info' : 'success',
      );
      if (viewContainer?.isConnected && document.querySelector('.agenda-grid')) {
        selectedDate = values.date;
        await drawAgenda();
      }
    },
  });

  const form = modal.body.querySelector('form') as HTMLFormElement;
  attachPatientPicker(modal.body, undefined, prefill.patient);
  const slotsElement = $('[data-slots]', form);
  const timeInput = form.elements.namedItem('time') as HTMLInputElement;

  const loadSlots = async () => {
    const values = readForm(form);
    if (!values.serviceId || !values.date) return;
    setContent(slotsElement, loadingState('Buscando horarios…'));
    try {
      const slots = await api.get<Slot[]>('/api/availability', {
        from: values.date, to: values.date, serviceId: values.serviceId, professionalId: values.professionalId,
      });
      setContent(
        slotsElement,
        slots.length
          ? html`${slots.map((slot) => html`<button type="button" class="slot ${slot.start.slice(11) === timeInput.value ? 'is-selected' : ''}" data-slot-time="${slot.start.slice(11)}">${formatTime(slot.start)}</button>`)}`
          : html`<p class="muted">No hay horarios libres ese día. Puedes escribir una hora manual.</p>`,
      );
    } catch (error) {
      setContent(slotsElement, html`<p class="form-error">${error instanceof Error ? error.message : 'Error'}</p>`);
    }
  };

  form.addEventListener('change', (event) => {
    const name = (event.target as HTMLInputElement).name;
    if (['serviceId', 'professionalId', 'date'].includes(name)) void loadSlots();
    if (name === 'repeat') {
      form.querySelectorAll<HTMLElement>('[data-recurrence]').forEach((element) => {
        element.hidden = !(event.target as HTMLInputElement).checked;
      });
    }
  });
  form.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const slotButton = target.closest<HTMLElement>('[data-slot-time]');
    if (slotButton) {
      timeInput.value = slotButton.dataset.slotTime ?? '';
      slotsElement.querySelectorAll('.slot').forEach((slot) => slot.classList.toggle('is-selected', slot === slotButton));
    }
    if (target.closest('[data-action="create-patient"]')) {
      openNewPatientModal((patient) => attachPatientPicker(modal.body, undefined, patient));
    }
  });
  await loadSlots();
}

// ─── Detalle de cita ────────────────────────────────────────────────────────

function openAppointmentDetail(appointment: AppointmentItem, professionals: ProfessionalItem[]): void {
  const isActive = appointment.status === 'pendiente' || appointment.status === 'confirmada';
  const awaitsPatient = appointment.hold_reason === 'pago' || appointment.hold_reason === 'verificacion';
  const holdExpiry = appointment.hold_expires_at ? new Date(appointment.hold_expires_at) : null;
  const holdExpiryLabel = holdExpiry
    ? formatTime(new Date(holdExpiry.getTime() + clinicOffset() * 60_000).toISOString().slice(0, 16))
    : '';
  const modal = openModal({
    title: appointment.patient_name,
    iconName: 'calendar-clock',
    content: html`<dl class="detail-list">
        <dt>Estado</dt><dd>${statusBadge(appointment.status)} ${holdBadge(appointment)}${appointment.source === 'online' ? html` <span class="badge badge-info">Reservó en línea</span>` : ''}</dd>
        ${appointment.hold_reason === 'pago' ? html`<dt>Anticipo</dt><dd>${formatMoney(appointment.prepayment_amount)} por Wompi · si no paga antes de las ${holdExpiryLabel}, el horario se libera.</dd>` : ''}
        ${appointment.hold_reason === 'verificacion' ? html`<dt>Verificación</dt><dd>Espera el WhatsApp del paciente con su código (vence a las ${holdExpiryLabel}).</dd>` : ''}
        ${appointment.hold_reason === 'confirmacion' ? html`<dt>Confirmación</dt><dd>Si el paciente no confirma antes de las ${holdExpiryLabel} del día límite, el horario se libera.</dd>` : ''}
        <dt>Hora</dt><dd>${formatLongDate(appointment.start_at.slice(0, 10))} · ${formatTime(appointment.start_at)} – ${formatTime(appointment.end_at)}</dd>
        <dt>Servicio</dt><dd>${appointment.service_name} · ${formatMoney(appointment.price)}</dd>
        <dt>Profesional</dt><dd>${appointment.professional_name}</dd>
        <dt>Celular</dt><dd>${appointment.patient_phone}</dd>
        ${appointment.notes ? html`<dt>Notas</dt><dd>${appointment.notes}</dd>` : ''}
        ${appointment.recurrence_group_id ? html`<dt>Serie</dt><dd>${icon('repeat')} Hace parte de citas recurrentes</dd>` : ''}
      </dl>
      <div class="button-row" style="margin-top: 18px">
        ${can('agenda.verificar') && appointment.hold_reason === 'verificacion'
          ? html`<form class="button-row" data-verify-form><input class="input" name="code" inputmode="numeric" maxlength="6" placeholder="Código" style="width: 110px" aria-label="Código de verificación" />
              <button class="button button-primary" type="submit">${icon('shield-check')} Verificar</button></form>`
          : ''}
        ${can('agenda.cambiar_estado') && appointment.status === 'pendiente'
          ? html`<button class="button button-secondary" data-status="confirmada" ${awaitsPatient ? html`data-tooltip="Úsalo solo si el paciente ya pagó o confirmó por otro medio"` : ''}>${icon('check')} ${appointment.hold_reason === 'pago' ? 'Confirmar sin pago en línea' : 'Confirmada'}</button>`
          : ''}
        ${can('agenda.cambiar_estado') && ['pendiente', 'confirmada', 'no_asistio'].includes(appointment.status) ? html`<button class="button button-primary" data-status="atendida" data-tooltip="Marca la cita como atendida y crea la cuenta por cobrar">${icon('check-check')} Atendida</button>` : ''}
        ${can('agenda.cambiar_estado') && isActive ? html`<button class="button button-secondary" data-status="no_asistio">${icon('user-x')} No asistió</button>` : ''}
        ${can('agenda.editar') && isActive && !awaitsPatient ? html`<button class="button button-secondary" data-action="reschedule">${icon('calendar-clock')} Reprogramar</button>` : ''}
        ${can('agenda.cancelar') && isActive ? html`<button class="button button-ghost" data-action="cancel">${icon('calendar-x')} Cancelar cita</button>` : ''}
        ${whatsappButton(appointment.patient_phone, `Hola ${appointment.patient_name.split(' ')[0]}, te escribimos de ${session().clinic.name}.`)}
        ${can('pacientes.ver') ? html`<a class="button button-ghost" href="#/pacientes/${appointment.patient_id}" data-close-modal>${icon('user')} Ver paciente</a>` : ''}
      </div>`,
  });

  modal.dialog.addEventListener('submit', async (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-verify-form]');
    if (!form) return;
    event.preventDefault();
    const code = (new FormData(form).get('code') as string).trim();
    const verified = await withErrorToast(() => api.post(`/api/appointments/${appointment.id}/verify`, { code }));
    if (verified) {
      toast('Reserva verificada y confirmada.', 'success');
      modal.close();
      await drawAgenda();
    }
  });

  modal.dialog.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const statusButton = target.closest<HTMLElement>('[data-status]');
    if (statusButton) {
      const updated = await withErrorToast(() => api.post(`/api/appointments/${appointment.id}/status`, { status: statusButton.dataset.status }));
      if (updated) {
        toast(statusButton.dataset.status === 'atendida' ? 'Cita atendida. Se creó la cuenta por cobrar.' : 'Estado actualizado.', 'success');
        modal.close();
        await drawAgenda();
      }
    }
    if (target.closest('[data-action="cancel"]')) {
      modal.close();
      askReason({
        title: 'Cancelar cita',
        message: `${appointment.patient_name} · ${formatTime(appointment.start_at)}. El espacio quedará libre para otro paciente.`,
        confirmLabel: 'Cancelar cita',
        onConfirm: async (reason) => {
          await api.post(`/api/appointments/${appointment.id}/cancel`, { reason });
          toast('Cita cancelada. Revisa la lista de espera para ofrecer el espacio.', 'success');
          await drawAgenda();
        },
      });
    }
    if (target.closest('[data-action="reschedule"]')) {
      modal.close();
      openRescheduleModal(appointment, professionals);
    }
  });
}

function openRescheduleModal(appointment: AppointmentItem, professionals: ProfessionalItem[]): void {
  const modal = openFormModal({
    title: 'Reprogramar cita',
    iconName: 'calendar-clock',
    submitLabel: 'Reprogramar',
    fields: html`<p class="muted">${appointment.patient_name} · ${appointment.service_name}</p>
      <div class="form-grid">
        <label class="field"><span>Profesional</span><select name="professionalId">${professionals.filter((professional) => professional.is_active === 1).map((professional) => html`<option value="${professional.id}" ${professional.id === appointment.professional_id ? 'selected' : ''}>${professional.full_name}</option>`)}</select></label>
        <label class="field"><span>Nueva fecha</span><input type="date" name="date" value="${appointment.start_at.slice(0, 10)}" required /></label>
        <label class="field"><span>Nueva hora</span><input type="time" name="time" step="300" required /></label>
        <div class="field full"><span>Horarios libres</span><div class="slot-grid" data-slots></div></div>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      await api.put(`/api/appointments/${appointment.id}/reschedule`, { startAt: `${values.date}T${values.time}`, professionalId: values.professionalId });
      toast('Cita reprogramada. Vuelve a confirmarla con el paciente.', 'success');
      await drawAgenda();
    },
  });
  const form = modal.body.querySelector('form') as HTMLFormElement;
  const slotsElement = $('[data-slots]', form);
  const loadSlots = async () => {
    const values = readForm(form);
    const slots = await api.get<Slot[]>('/api/availability', { from: values.date, to: values.date, serviceId: appointment.service_id, professionalId: values.professionalId });
    setContent(slotsElement, slots.length ? html`${slots.map((slot) => html`<button type="button" class="slot" data-slot-time="${slot.start.slice(11)}">${formatTime(slot.start)}</button>`)}` : html`<p class="muted">Sin horarios libres ese día.</p>`);
  };
  form.addEventListener('change', () => void withErrorToast(loadSlots));
  form.addEventListener('click', (event) => {
    const slotButton = (event.target as HTMLElement).closest<HTMLElement>('[data-slot-time]');
    if (!slotButton) return;
    (form.elements.namedItem('time') as HTMLInputElement).value = slotButton.dataset.slotTime ?? '';
    slotsElement.querySelectorAll('.slot').forEach((slot) => slot.classList.toggle('is-selected', slot === slotButton));
  });
  void withErrorToast(loadSlots);
}

// ─── Bloqueos ───────────────────────────────────────────────────────────────

export function openNewBlockModal(professionals: ProfessionalItem[], onDone?: () => Promise<void>): void {
  openFormModal({
    title: 'Bloquear horario',
    iconName: 'ban',
    submitLabel: 'Crear bloqueo',
    fields: html`<p class="muted">Nadie podrá agendar en este rango (ni en línea ni desde el panel).</p>
      <div class="form-grid">
        <label class="field full"><span>Profesional</span><select name="professionalId"><option value="">Todo el consultorio</option>${professionals.map((professional) => html`<option value="${professional.id}">${professional.full_name}</option>`)}</select></label>
        <label class="field"><span>Desde</span><input type="datetime-local" name="startAt" required value="${selectedDate || todayLocal(clinicOffset())}T08:00" /></label>
        <label class="field"><span>Hasta</span><input type="datetime-local" name="endAt" required value="${selectedDate || todayLocal(clinicOffset())}T12:00" /></label>
        <label class="field full"><span>Motivo</span><input name="reason" maxlength="200" placeholder="Vacaciones, capacitación…" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const result = await api.post<{ affectedAppointments: number }>('/api/time-blocks', {
        professionalId: emptyToNull(values.professionalId),
        startAt: values.startAt.slice(0, 16),
        endAt: values.endAt.slice(0, 16),
        reason: emptyToNull(values.reason),
      });
      if (result.affectedAppointments > 0) {
        toast(`Horario bloqueado. Ojo: ${result.affectedAppointments} cita(s) ya agendada(s) en ese rango siguen activas; reprográmalas.`, 'info');
      } else {
        toast('Horario bloqueado.', 'success');
      }
      if (onDone) await onDone();
      else if (document.querySelector('.agenda-grid')) await drawAgenda();
    },
  });
}
