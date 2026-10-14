/**
 * Caja: pagos del día, cierre por medio de pago, recibos y anulaciones.
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { addDays, formatLongDate, formatMoney, formatUtcAsLocal, PAYMENT_METHOD_LABELS, todayLocal } from '../../core/format.js';
import { askReason, emptyState, icon, loadingState, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { moneyCell, openPaymentModal, openReceiptModal, type PaymentItem } from '../components.js';
import { can, clinicOffset } from '../session.js';

interface CashClosing {
  date: string;
  totalsByMethod: Record<string, number>;
  total: number;
  receiptCount: number;
  voidedPayments: PaymentItem[];
  payments: PaymentItem[];
}

let selectedDate = '';

export async function renderCashView(container: HTMLElement): Promise<void> {
  selectedDate ||= todayLocal(clinicOffset());
  setContent(container, loadingState('Cargando caja…'));

  const canSeeClosing = can('caja.cierre.ver');
  const canSeePayments = can('caja.recaudo.ver');
  const [closing, payments] = await Promise.all([
    canSeeClosing ? api.get<CashClosing>('/api/cash-closing', { date: selectedDate }) : Promise.resolve(null),
    canSeePayments ? api.get<PaymentItem[]>('/api/payments', { from: selectedDate, to: selectedDate }) : Promise.resolve([] as PaymentItem[]),
  ]);
  const offset = clinicOffset();

  setContent(
    container,
    html`<section class="card">
      <div class="card-header">
        <div class="agenda-toolbar">
          <button class="icon-button" data-action="previous" aria-label="Día anterior">${icon('chevron-left')}</button>
          <button class="button button-secondary button-small" data-action="today">Hoy</button>
          <button class="icon-button" data-action="next" aria-label="Día siguiente">${icon('chevron-right')}</button>
          <input class="input" type="date" value="${selectedDate}" data-action="pick-date" style="width: auto" aria-label="Fecha" />
          <span class="agenda-date">${formatLongDate(selectedDate)}</span>
        </div>
        <div class="button-row">
          ${canSeePayments && payments.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${can('caja.recaudo.crear') ? html`<button class="button button-primary" data-action="new-payment">${icon('circle-dollar-sign')} Registrar pago</button>` : ''}
        </div>
      </div>
      ${closing
        ? html`<div class="card-padded"><div class="kpi-grid">
            <div class="card kpi"><span class="kpi-icon">${icon('wallet')}</span><div><div class="kpi-value money">${formatMoney(closing.total)}</div><div class="kpi-label">Total recaudado · ${closing.receiptCount} recibos</div></div></div>
            ${Object.entries(closing.totalsByMethod)
              .filter(([, value]) => value > 0)
              .map(([method, value]) => html`<div class="card kpi"><span class="kpi-icon is-info">${icon('coins')}</span><div><div class="kpi-value money">${formatMoney(value)}</div><div class="kpi-label">${PAYMENT_METHOD_LABELS[method] ?? method}</div></div></div>`)}
            ${closing.voidedPayments.length ? html`<div class="card kpi"><span class="kpi-icon is-danger">${icon('ban')}</span><div><div class="kpi-value">${closing.voidedPayments.length}</div><div class="kpi-label">Recibos anulados</div></div></div>` : ''}
          </div></div>`
        : ''}
    </section>

    ${canSeePayments
      ? html`<section class="card">
          <div class="card-header"><h3>${icon('receipt')} Recibos del día</h3></div>
          ${payments.length === 0
            ? emptyState('receipt', 'Sin pagos este día', 'Los pagos que registres aparecerán aquí con su recibo.')
            : html`<div class="table-wrapper"><table class="data-table">
                <thead><tr><th>Recibo</th><th>Hora</th><th>Paciente</th><th>Medio</th><th>Registró</th><th class="align-right">Valor</th><th></th></tr></thead>
                <tbody>${payments.map((payment) => html`<tr class="${payment.status === 'anulado' ? 'is-voided' : ''}">
                  <td>N.º ${payment.receipt_number}</td>
                  <td class="nowrap">${formatUtcAsLocal(payment.created_at, offset).split(' · ')[1]}</td>
                  <td><a class="row-link" href="#/pacientes/${payment.patient_id}">${payment.patient_name}</a></td>
                  <td>${PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}${payment.reference ? html`<br /><small class="subtle">Ref. ${payment.reference}</small>` : ''}</td>
                  <td>${payment.created_by_name ?? '—'}</td>
                  <td class="align-right">${moneyCell(payment.amount)}</td>
                  <td class="align-right keep nowrap">
                    <button class="icon-button" data-receipt="${payment.id}" aria-label="Ver recibo" data-tooltip="Ver e imprimir recibo">${icon('printer')}</button>
                    ${payment.status === 'activo' && can('caja.recaudo.anular') ? html`<button class="icon-button is-danger" data-void="${payment.id}" aria-label="Anular" data-tooltip="Anular recibo">${icon('ban')}</button>` : ''}
                  </td></tr>`)}
                </tbody></table></div>`}
        </section>`
      : ''}`,
  );
  refreshIcons(container);

  const reload = () => renderCashView(container);
  container.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'previous') { selectedDate = addDays(selectedDate, -1); await reload(); }
    if (action === 'next') { selectedDate = addDays(selectedDate, 1); await reload(); }
    if (action === 'today') { selectedDate = todayLocal(offset); await reload(); }
    if (action === 'new-payment') openPaymentModal({ onDone: () => void reload() });
    if (action === 'export') {
      await withErrorToast(() =>
        downloadExcel(`caja-${selectedDate}`, 'Caja', payments, [
          { header: 'Recibo', width: 10, value: (payment) => payment.receipt_number },
          { header: 'Fecha y hora', width: 22, value: (payment) => formatUtcAsLocal(payment.created_at, offset) },
          { header: 'Paciente', width: 30, value: (payment) => payment.patient_name },
          { header: 'Medio', width: 14, value: (payment) => PAYMENT_METHOD_LABELS[payment.method] ?? payment.method },
          { header: 'Referencia', width: 18, value: (payment) => payment.reference },
          { header: 'Estado', width: 10, value: (payment) => payment.status },
          { header: 'Valor', width: 14, value: (payment) => payment.amount, isMoney: true },
        ]),
      );
    }
    const receiptId = target.closest<HTMLElement>('[data-receipt]')?.dataset.receipt;
    if (receiptId) await withErrorToast(() => openReceiptModal(receiptId));
    const voidId = target.closest<HTMLElement>('[data-void]')?.dataset.void;
    if (voidId) {
      askReason({
        title: 'Anular recibo',
        message: 'El recibo seguirá visible como anulado y la deuda que cubría vuelve a quedar pendiente.',
        confirmLabel: 'Anular recibo',
        onConfirm: async (reason) => {
          await api.post(`/api/payments/${voidId}/void`, { reason });
          toast('Recibo anulado.', 'success');
          await reload();
        },
      });
    }
  };
  container.onchange = (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-action="pick-date"]');
    if (input?.value) {
      selectedDate = input.value;
      void reload();
    }
  };
}

