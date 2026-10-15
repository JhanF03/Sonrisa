/**
 * Página pública para que el paciente confirme, reprograme o cancele su cita
 * con el enlace firmado (/c/:slug/cita/:token).
 */
import { applyFavicon } from '../core/favicon.js';
import { api } from '../core/api.js';
import { html, safeUrl, setContent } from '../core/dom.js';
import { addDays, formatLongDate, formatShortDate, formatTime, STATUS_LABELS, todayLocal } from '../core/format.js';
import { applyBrandColor, icon, loadingState, refreshIcons, toast, withErrorToast } from '../core/ui.js';
import { publicLayout, type PublicSlot } from './booking.js';

interface ManageData {
  clinic: { name: string; slug: string; brandColor: string; logoUrl: string | null; favicon?: string | null; phone: string | null; address: string | null; city: string | null };
  appointment: { startAt: string; endAt: string; status: string; serviceName: string; professionalName: string; patientFirstName: string; holdReason: string | null };
  verification?: { code: string; whatsappUrl: string | null } | null;
  paymentUrl?: string | null;
}

export async function renderManagePage(root: HTMLElement, token: string): Promise<void> {
  setContent(root, loadingState('Cargando tu cita…'));
  const basePath = `/api/public/appointments/${encodeURIComponent(token)}`;
  let data: ManageData;
  try {
    data = await api.get<ManageData>(basePath);
  } catch {
    setContent(root, html`<main class="public-page"><div class="card success-panel" style="margin-top: 40px">${icon('calendar-x')}<h1>Enlace no válido</h1><p class="muted">Este enlace no existe o fue modificado. Comunícate con el consultorio.</p></div></main>`);
    refreshIcons(root);
    return;
  }
  applyBrandColor(data.clinic.brandColor);
  applyFavicon(data.clinic.favicon);
  document.title = `Mi cita · ${data.clinic.name}`;

  let isRescheduling = false;
  let selectedDay: string | undefined;

  const draw = async () => {
    const { appointment } = data;
    const awaitsPatient = appointment.holdReason === 'pago' || appointment.holdReason === 'verificacion';
    const isActive = (appointment.status === 'pendiente' || appointment.status === 'confirmada') && !awaitsPatient;
    let rescheduleMarkup = html``;

    if (isRescheduling) {
      const from = todayLocal();
      const slots = await api.get<PublicSlot[]>(`${basePath}/availability`, { from, to: addDays(from, 21) });
      const days = [...new Set(slots.map((slot) => slot.start.slice(0, 10)))];
      selectedDay ??= days[0];
      rescheduleMarkup = html`<section class="card card-padded" style="margin-top: 12px; display: grid; gap: 12px">
        <strong>${icon('calendar-clock')} Elige el nuevo horario</strong>
        ${days.length === 0
          ? html`<p class="muted">No hay horarios disponibles. Comunícate con el consultorio.</p>`
          : html`<div class="day-strip">${days.map((day) => {
              const [weekday, dayNumber, month] = formatShortDate(day).split(' ');
              return html`<button class="day-chip ${day === selectedDay ? 'is-selected' : ''}" data-day="${day}"><small>${weekday}</small><strong>${dayNumber}</strong><small>${month}</small></button>`;
            })}</div>
            <div class="slot-grid">${slots.filter((slot) => slot.start.startsWith(selectedDay ?? '')).map((slot) => html`<button class="slot" data-new-start="${slot.start}">${formatTime(slot.start)}</button>`)}</div>`}
      </section>`;
    }

    setContent(
      root,
      publicLayout(
        data.clinic,
        html`<section class="card success-panel" style="margin-top: 16px">
          ${icon(appointment.status === 'cancelada' ? 'calendar-x' : appointment.status === 'confirmada' ? 'circle-check-big' : 'calendar-clock')}
          <h2>Hola ${appointment.patientFirstName}, esta es tu cita</h2>
          <p><strong>${appointment.serviceName}</strong> con ${appointment.professionalName}<br />
            <span class="first-cap">${formatLongDate(appointment.startAt.slice(0, 10))}</span> a las ${formatTime(appointment.startAt)}</p>
          <span class="badge badge-${appointment.status}">${STATUS_LABELS[appointment.status] ?? appointment.status}</span>
          ${isActive
            ? html`<div class="button-row" style="justify-content: center">
                ${appointment.status === 'pendiente' ? html`<button class="button button-primary" data-action="confirm">${icon('check')} Confirmar asistencia</button>` : ''}
                <button class="button button-secondary" data-action="reschedule">${icon('calendar-clock')} Reprogramar</button>
                <button class="button button-ghost" data-action="cancel">${icon('calendar-x')} Cancelar cita</button>
                <a class="button button-ghost" href="${basePath}/calendar.ics">${icon('calendar-plus')} Agregar a calendario</a>
              </div>`
            : appointment.holdReason === 'pago' && data.paymentUrl
              ? html`<p class="muted">Tu reserva está esperando el pago del anticipo.</p><a class="button button-primary" href="${safeUrl(data.paymentUrl)}">${icon('credit-card')} Completar el pago</a>`
              : appointment.holdReason === 'verificacion' && data.verification
                ? html`<p>Confirma enviando el código <strong>${data.verification.code}</strong> por WhatsApp al consultorio.</p>
                    ${data.verification.whatsappUrl ? html`<a class="button button-whatsapp" target="_blank" rel="noopener" href="${safeUrl(data.verification.whatsappUrl, ['https:'])}">${icon('message-circle')} Enviar código</a>` : ''}`
                : html`<p class="muted">Esta cita ya no se puede modificar. Si necesitas ayuda, comunícate con el consultorio.</p>`}
        </section>
        ${rescheduleMarkup}`,
      ),
    );
    refreshIcons(root);
  };

  root.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'confirm') {
      const result = await withErrorToast(() => api.post<Pick<ManageData, 'appointment'>>(`${basePath}/confirm`));
      if (result) {
        data.appointment = result.appointment;
        toast('¡Gracias! Tu asistencia quedó confirmada.', 'success');
        await draw();
      }
    }
    if (action === 'cancel' && window.confirm('¿Seguro que quieres cancelar tu cita?')) {
      const result = await withErrorToast(() => api.post<Pick<ManageData, 'appointment'>>(`${basePath}/cancel`));
      if (result) {
        data.appointment = result.appointment;
        toast('Tu cita fue cancelada.', 'info');
        await draw();
      }
    }
    if (action === 'reschedule') {
      isRescheduling = true;
      await withErrorToast(draw);
    }
    const dayButton = target.closest<HTMLElement>('[data-day]');
    if (dayButton) {
      selectedDay = dayButton.dataset.day;
      await draw();
    }
    const newStart = target.closest<HTMLElement>('[data-new-start]')?.dataset.newStart;
    if (newStart) {
      const result = await withErrorToast(() => api.post<Pick<ManageData, 'appointment'>>(`${basePath}/reschedule`, { startAt: newStart }));
      if (result) {
        data.appointment = result.appointment;
        isRescheduling = false;
        toast('Tu cita fue reprogramada.', 'success');
        await draw();
      }
    }
  };

  await draw();
}
