/**
 * Indicadores del mes: citas, inasistencias, confirmaciones, recaudo y cartera.
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { formatMoney, formatMonthLabel, formatPercent, todayLocal } from '../../core/format.js';
import { icon, loadingState, refreshIcons } from '../../core/ui.js';
import { clinicOffset } from '../session.js';

interface MonthlyIndicators {
  month: string;
  appointments: { total: number; attended: number; noShow: number; cancelled: number; online: number; confirmed: number };
  noShowRate: number | null;
  confirmationRate: number | null;
  revenueFromRemindedAppointments: number;
  collected: number;
  newPatients: number;
  outstandingBalance: number;
}

let selectedMonth = '';

export async function renderReportsView(container: HTMLElement): Promise<void> {
  selectedMonth ||= todayLocal(clinicOffset()).slice(0, 7);
  setContent(container, loadingState('Calculando indicadores…'));
  const data = await api.get<MonthlyIndicators>('/api/reports/monthly', { month: selectedMonth });

  const kpi = (iconName: string, value: string, label: string, tooltip: string, tone = '') =>
    html`<div class="card kpi" data-tooltip="${tooltip}"><span class="kpi-icon ${tone}">${icon(iconName)}</span><div><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div></div>`;

  const statusRows: Array<[string, number, string]> = [
    ['Atendidas', data.appointments.attended, 'var(--success)'],
    ['No asistió', data.appointments.noShow, 'var(--danger)'],
    ['Canceladas', data.appointments.cancelled, 'var(--text-subtle)'],
    ['Pendientes / confirmadas', data.appointments.total - data.appointments.attended - data.appointments.noShow - data.appointments.cancelled, 'var(--info)'],
  ];
  const maxValue = Math.max(1, ...statusRows.map(([, value]) => value));

  setContent(
    container,
    html`<div class="toolbar">
      <label class="field" style="flex-direction: row; align-items: center; gap: 8px"><span>${icon('calendar')} Mes</span>
        <input class="input" type="month" name="month" value="${selectedMonth}" style="width: auto" /></label>
      <span class="agenda-date">${formatMonthLabel(selectedMonth)}</span>
    </div>
    <div class="kpi-grid">
      ${kpi('calendar-days', String(data.appointments.total), 'Citas del mes', 'Todas las citas agendadas para el mes, incluidas canceladas')}
      ${kpi('user-x', formatPercent(data.noShowRate), 'Inasistencia', 'Porcentaje de pacientes que no llegaron, sobre citas ya cerradas', 'is-danger')}
      ${kpi('check-check', formatPercent(data.confirmationRate), 'Confirmación', 'Citas confirmadas (por WhatsApp o en recepción) sobre citas activas', 'is-info')}
      ${kpi('sparkles', formatMoney(data.revenueFromRemindedAppointments), 'Ingresos con recordatorio', 'Valor de citas atendidas a las que se les envió recordatorio por WhatsApp')}
      ${kpi('wallet', formatMoney(data.collected), 'Recaudado', 'Total de recibos de caja activos del mes')}
      ${kpi('hand-coins', formatMoney(data.outstandingBalance), 'Cartera pendiente', 'Saldo que deben los pacientes hoy', 'is-warning')}
      ${kpi('user-plus', String(data.newPatients), 'Pacientes nuevos', 'Pacientes creados este mes')}
      ${kpi('external-link', String(data.appointments.online), 'Reservas en línea', 'Citas que los pacientes reservaron solos', 'is-info')}
    </div>
    <section class="card card-padded">
      <h3 style="margin-bottom: 12px">Citas por estado</h3>
      <div style="display: grid; gap: 10px">
        ${statusRows.map(([label, value, color]) => html`<div style="display: grid; grid-template-columns: 180px 1fr 50px; gap: 10px; align-items: center">
          <span class="muted">${label}</span>
          <div style="height: 12px; border-radius: 6px; background: var(--surface-sunken); overflow: hidden"><div style="height: 100%; width: ${Math.round((value / maxValue) * 100)}%; background: ${color}; border-radius: 6px"></div></div>
          <strong>${value}</strong></div>`)}
      </div>
    </section>`,
  );
  refreshIcons(container);

  container.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'month' && input.value) {
      selectedMonth = input.value;
      void renderReportsView(container);
    }
  };
}
