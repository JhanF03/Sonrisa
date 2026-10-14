/**
 * Pagos en línea (Wompi): anticipos recibidos, intentos y alertas que
 * requieren atención (pago tardío sin cupo, pago doble, anulaciones…).
 */
import { api } from '../../core/api.js';
import { html, readForm, setContent } from '../../core/dom.js';
import { formatMoney, formatShortDate, formatTime, formatUtcAsLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, refreshIcons, toast } from '../../core/ui.js';
import { clinicOffset } from '../session.js';

interface OnlinePaymentRow {
  id: string;
  reference: string;
  amount_in_cents: number;
  environment: 'sandbox' | 'production';
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'EXPIRED';
  outcome: string | null;
  needs_attention: number;
  attention_resolved_at: string | null;
  wompi_transaction_id: string | null;
  payment_method_type: string | null;
  receipt_number: number | null;
  created_at: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  service_name: string;
  appointment_start: string;
}

const STATUS_INFO: Record<OnlinePaymentRow['status'], { label: string; tone: string }> = {
  PENDING: { label: 'Pendiente', tone: 'badge-neutral' },
  APPROVED: { label: 'Aprobado', tone: 'badge-success' },
  DECLINED: { label: 'Rechazado', tone: 'badge-danger' },
  VOIDED: { label: 'Anulado', tone: 'badge-danger' },
  ERROR: { label: 'Error', tone: 'badge-danger' },
  EXPIRED: { label: 'Vencido', tone: 'badge-neutral' },
};

/** Qué pasó y qué debe hacer recepción. */
const OUTCOME_HELP: Record<string, string> = {
  cita_confirmada: 'Cita confirmada automáticamente.',
  sin_cupo: 'Pagó después de vencer la reserva y el horario ya estaba tomado. El dinero quedó como saldo a favor: llama al paciente para reagendar o devolver.',
  pago_duplicado: 'El paciente pagó dos veces la misma cita. El segundo pago quedó como saldo a favor: acuerda con el paciente si se devuelve o se abona a otro servicio.',
  anulado_en_wompi: 'Wompi anuló la transacción. El recibo se anuló automáticamente: revisa con el paciente y confirma si la cita sigue en pie.',
  monto_no_coincide: 'Wompi reportó un monto o moneda distinto al esperado. No se registró ningún recibo: revisa la transacción en tu panel de Wompi.',
};

let showOnlyAttention = false;

export async function renderOnlinePaymentsView(container: HTMLElement): Promise<void> {
  setContent(container, loadingState('Cargando pagos en línea…'));
  const rows = await api.get<OnlinePaymentRow[]>('/api/online-payments', { attention: showOnlyAttention ? 'true' : 'false', limit: 200 });
  const attentionCount = rows.filter((row) => row.needs_attention === 1).length;
  const approvedTotal = rows.filter((row) => row.status === 'APPROVED').reduce((total, row) => total + row.amount_in_cents / 100, 0);
  const offset = clinicOffset();

  setContent(
    container,
    html`<div class="kpi-grid">
      <div class="card kpi"><span class="kpi-icon">${icon('credit-card')}</span><div><div class="kpi-value money">${formatMoney(approvedTotal)}</div><div class="kpi-label">Anticipos aprobados (lista actual)</div></div></div>
      <div class="card kpi"><span class="kpi-icon ${attentionCount ? 'is-danger' : ''}">${icon('triangle-alert')}</span><div><div class="kpi-value">${attentionCount}</div><div class="kpi-label">Requieren atención</div></div></div>
    </div>
    <section class="card">
      <div class="card-header">
        <div class="tabs" role="tablist">
          <button class="tab ${showOnlyAttention ? '' : 'is-active'}" data-filter="all">${icon('list-checks')} Todos</button>
          <button class="tab ${showOnlyAttention ? 'is-active' : ''}" data-filter="attention">${icon('triangle-alert')} Requieren atención</button>
        </div>
        <a class="button button-ghost button-small" href="#/configuracion/pagos">${icon('settings')} Configurar Wompi</a>
      </div>
      ${rows.length === 0
        ? emptyState('credit-card', showOnlyAttention ? 'Sin alertas' : 'Aún no hay pagos en línea', showOnlyAttention ? 'Todo en orden.' : 'Aquí verás los anticipos que tus pacientes paguen al reservar.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Paciente</th><th>Cita</th><th class="align-right">Valor</th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows.map((row) => html`<tr>
            <td class="nowrap">${formatUtcAsLocal(row.created_at, offset)}<br /><small class="subtle">${row.reference}${row.environment === 'sandbox' ? ' · pruebas' : ''}</small></td>
            <td><a class="row-link" href="#/pacientes/${row.patient_id}">${row.patient_name}</a><br /><small class="subtle">${row.patient_phone}</small></td>
            <td>${row.service_name}<br /><small class="subtle">${formatShortDate(row.appointment_start.slice(0, 10))} · ${formatTime(row.appointment_start)}</small></td>
            <td class="align-right money">${formatMoney(row.amount_in_cents / 100)}${row.receipt_number ? html`<br /><small class="subtle">Recibo N.º ${row.receipt_number}</small>` : ''}</td>
            <td><span class="badge ${STATUS_INFO[row.status].tone}">${STATUS_INFO[row.status].label}</span>
              ${row.outcome && row.outcome !== 'cita_confirmada' ? html`<br /><small class="subtle" style="display: inline-block; max-width: 320px">${OUTCOME_HELP[row.outcome] ?? row.outcome}</small>` : ''}</td>
            <td class="align-right">${row.needs_attention === 1
              ? html`<button class="button button-secondary button-small" data-resolve="${row.id}">${icon('check')} Marcar atendida</button>`
              : row.attention_resolved_at ? html`<span class="subtle">${icon('check')} Atendida</span>` : ''}</td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(container);

  container.onclick = (event) => {
    const target = event.target as HTMLElement;
    const filter = target.closest<HTMLElement>('[data-filter]')?.dataset.filter;
    if (filter) {
      showOnlyAttention = filter === 'attention';
      void renderOnlinePaymentsView(container);
      return;
    }
    const resolveId = target.closest<HTMLElement>('[data-resolve]')?.dataset.resolve;
    if (resolveId) {
      openFormModal({
        title: 'Marcar alerta como atendida',
        iconName: 'check',
        submitLabel: 'Guardar',
        fields: html`<label class="field"><span>¿Qué se hizo?</span><textarea name="note" required maxlength="300" rows="3" placeholder="Ej: se llamó al paciente y se reagendó para el martes"></textarea></label>`,
        onSubmit: async (form) => {
          const { note } = readForm(form);
          if (!note) throw new Error('Escribe qué se hizo (queda en la auditoría).');
          await api.post(`/api/online-payments/${resolveId}/resolve`, { note });
          toast('Alerta atendida.', 'success');
          await renderOnlinePaymentsView(container);
        },
      });
    }
  };
}
