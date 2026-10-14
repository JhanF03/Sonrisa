/**
 * Cartera: quién debe, cuánto y desde cuándo (edades de cartera),
 * con recordatorio de cobro por WhatsApp.
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { formatMoney, todayLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, refreshIcons, whatsappButton, withErrorToast } from '../../core/ui.js';
import { moneyCell } from '../components.js';
import { clinicOffset, session } from '../session.js';

interface AgingRow {
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  current: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
  oldestDays: number;
}

export async function renderReceivablesView(container: HTMLElement): Promise<void> {
  setContent(container, loadingState('Calculando cartera…'));
  const rows = await api.get<AgingRow[]>('/api/receivables/aging');
  const totals = rows.reduce(
    (accumulator, row) => ({
      current: accumulator.current + row.current,
      days31to60: accumulator.days31to60 + row.days31to60,
      days61to90: accumulator.days61to90 + row.days61to90,
      over90: accumulator.over90 + row.over90,
      total: accumulator.total + row.total,
    }),
    { current: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 },
  );
  const clinicName = session().clinic.name;

  setContent(
    container,
    html`<div class="kpi-grid">
      <div class="card kpi"><span class="kpi-icon">${icon('hand-coins')}</span><div><div class="kpi-value money">${formatMoney(totals.total)}</div><div class="kpi-label">Cartera total · ${rows.length} pacientes</div></div></div>
      <div class="card kpi"><span class="kpi-icon is-info">${icon('clock')}</span><div><div class="kpi-value money">${formatMoney(totals.current)}</div><div class="kpi-label">0 a 30 días</div></div></div>
      <div class="card kpi"><span class="kpi-icon is-warning">${icon('hourglass')}</span><div><div class="kpi-value money">${formatMoney(totals.days31to60 + totals.days61to90)}</div><div class="kpi-label">31 a 90 días</div></div></div>
      <div class="card kpi"><span class="kpi-icon is-danger">${icon('triangle-alert')}</span><div><div class="kpi-value money">${formatMoney(totals.over90)}</div><div class="kpi-label">Más de 90 días</div></div></div>
    </div>
    <section class="card">
      <div class="card-header"><h3>${icon('hand-coins')} Edades de cartera</h3>
        ${rows.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}</div>
      ${rows.length === 0
        ? emptyState('circle-check-big', '¡Nadie debe!', 'Cuando haya saldos pendientes aparecerán aquí, ordenados por valor.')
        : html`<div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Paciente</th><th class="align-right">0–30</th><th class="align-right">31–60</th><th class="align-right">61–90</th><th class="align-right">+90</th><th class="align-right">Total</th><th></th></tr></thead>
            <tbody>${rows.map((row) => html`<tr>
              <td><a class="row-link" href="#/pacientes/${row.patient_id}">${row.patient_name}</a><br /><small class="subtle">Hace ${row.oldestDays} días la deuda más antigua</small></td>
              <td class="align-right">${row.current ? moneyCell(row.current) : '—'}</td>
              <td class="align-right">${row.days31to60 ? moneyCell(row.days31to60) : '—'}</td>
              <td class="align-right">${row.days61to90 ? moneyCell(row.days61to90) : '—'}</td>
              <td class="align-right">${row.over90 ? html`<span class="badge badge-danger money">${formatMoney(row.over90)}</span>` : '—'}</td>
              <td class="align-right"><strong>${moneyCell(row.total)}</strong></td>
              <td class="align-right">${whatsappButton(
                row.patient_phone,
                `Hola ${row.patient_name.split(' ')[0]}, te saludamos de ${clinicName}. Te recordamos amablemente que tienes un saldo pendiente de ${formatMoney(row.total)}. Puedes pagarlo en tu próxima visita o por transferencia. ¡Gracias!`,
                { label: 'Cobrar', variant: 'small', tooltip: 'Recordatorio de pago amable por WhatsApp' },
              )}</td>
            </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(container);

  container.onclick = async (event) => {
    if ((event.target as HTMLElement).closest('[data-action="export"]')) {
      await withErrorToast(() =>
        downloadExcel(`cartera-${todayLocal(clinicOffset())}`, 'Cartera', rows, [
          { header: 'Paciente', width: 32, value: (row) => row.patient_name },
          { header: 'Celular', width: 16, value: (row) => row.patient_phone },
          { header: '0-30 días', width: 14, value: (row) => row.current, isMoney: true },
          { header: '31-60 días', width: 14, value: (row) => row.days31to60, isMoney: true },
          { header: '61-90 días', width: 14, value: (row) => row.days61to90, isMoney: true },
          { header: 'Más de 90', width: 14, value: (row) => row.over90, isMoney: true },
          { header: 'Total', width: 14, value: (row) => row.total, isMoney: true },
        ]),
      );
    }
  };
}
