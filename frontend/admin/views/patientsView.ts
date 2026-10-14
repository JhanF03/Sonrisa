/**
 * Pacientes: directorio con saldo y próxima cita, ficha con historial,
 * estado de cuenta (cargos, abonos, anticipos) y acciones de caja.
 */
import { api } from '../../core/api.js';
import { debounce, html, readForm, setContent } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { formatLongDate, formatMoney, formatShortDate, formatTime, formatUtcAsLocal, PAYMENT_METHOD_LABELS, todayLocal } from '../../core/format.js';
import { askReason, emptyState, icon, loadingState, openFormModal, refreshIcons, toast, whatsappButton, withErrorToast } from '../../core/ui.js';
import {
  moneyCell,
  openNewPatientModal,
  openPaymentModal,
  openReceiptModal,
  patientFormFields,
  patientPayload,
  statusBadge,
  type PatientSummary,
  type PaymentItem,
  type ServiceItem,
} from '../components.js';
import { can, clinicOffset, session } from '../session.js';
import { openNewAppointmentModal, type AppointmentItem } from './agendaView.js';

interface PatientDetail extends PatientSummary {
  birth_date: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  admin_notes: string | null;
  consent_at: string | null;
  consent_version: string | null;
  consent_channel: string | null;
}

interface ChargeItem {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  paid: number;
  balance: number;
  status: 'activo' | 'anulado';
  void_reason: string | null;
  created_at: string;
}

interface Statement {
  charges: ChargeItem[];
  payments: PaymentItem[];
  totals: { charged: number; paid: number; balance: number; pendingDebt: number; availableCredit: number };
}

// ─── Lista ──────────────────────────────────────────────────────────────────

export async function renderPatientsView(container: HTMLElement, params: string[]): Promise<void> {
  if (params[0]) return renderPatientDetailView(container, params[0]);

  setContent(
    container,
    html`<section class="card">
      <div class="card-header">
        <div class="toolbar">
          <label class="search-input">${icon('search')}<input type="search" data-search placeholder="Buscar por nombre, documento o celular" aria-label="Buscar pacientes" /></label>
        </div>
        <div class="button-row">
          ${can('pacientes.exportar') ? html`<button class="button button-secondary" data-action="export" data-tooltip="Descarga todos los pacientes en Excel">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${can('pacientes.crear') ? html`<button class="button button-primary" data-action="new">${icon('user-plus')} Nuevo paciente</button>` : ''}
        </div>
      </div>
      <div data-results>${loadingState()}</div>
    </section>`,
  );
  refreshIcons(container);

  const resultsElement = container.querySelector('[data-results]') as HTMLElement;
  const showMoney = can('cartera.ver');

  const load = async (query = '') => {
    const patients = await api.get<PatientSummary[]>('/api/patients', { q: query, limit: 100 });
    setContent(
      resultsElement,
      patients.length === 0
        ? emptyState('users', query ? 'Sin coincidencias' : 'Aún no hay pacientes', query ? 'Prueba con otro nombre o documento.' : 'Crea el primero o espera las reservas en línea.')
        : html`<div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Paciente</th><th>Documento</th><th>Celular</th><th>Próxima cita</th><th>Última visita</th>${showMoney ? html`<th class="align-right">Saldo</th>` : ''}</tr></thead>
            <tbody>${patients.map(
              (patient) => html`<tr>
                <td><a class="row-link" href="#/pacientes/${patient.id}">${patient.full_name}</a></td>
                <td class="nowrap">${patient.document_type} ${patient.document_number}</td>
                <td class="nowrap">${patient.phone}</td>
                <td class="nowrap">${patient.next_appointment ? `${formatShortDate(patient.next_appointment.slice(0, 10))} ${formatTime(patient.next_appointment)}` : html`<span class="subtle">—</span>`}</td>
                <td class="nowrap">${patient.last_visit ? formatShortDate(patient.last_visit.slice(0, 10)) : html`<span class="subtle">—</span>`}</td>
                ${showMoney ? html`<td class="align-right">${balanceBadge(patient.balance)}</td>` : ''}
              </tr>`,
            )}</tbody></table></div>`,
    );
  };

  container.querySelector('[data-search]')?.addEventListener(
    'input',
    debounce((event: Event) => void withErrorToast(() => load((event.target as HTMLInputElement).value.trim())), 300),
  );
  container.onclick = async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'new') openNewPatientModal((patient) => (window.location.hash = `#/pacientes/${patient.id}`));
    if (action === 'export') await withErrorToast(exportPatients);
  };
  await load();
}

function balanceBadge(balance: number) {
  if (balance > 0) return html`<span class="badge badge-danger money" data-tooltip="Debe">${formatMoney(balance)}</span>`;
  if (balance < 0) return html`<span class="badge badge-success money" data-tooltip="Saldo a favor (anticipo)">${formatMoney(-balance)} a favor</span>`;
  return html`<span class="subtle">Al día</span>`;
}

async function exportPatients(): Promise<void> {
  const patients = await api.get<PatientSummary[]>('/api/patients/export');
  await downloadExcel(`pacientes-${todayLocal(clinicOffset())}`, 'Pacientes', patients, [
    { header: 'Nombre', width: 32, value: (patient) => patient.full_name },
    { header: 'Tipo doc.', width: 9, value: (patient) => patient.document_type },
    { header: 'Documento', width: 16, value: (patient) => patient.document_number },
    { header: 'Celular', width: 16, value: (patient) => patient.phone },
    { header: 'Correo', width: 28, value: (patient) => patient.email },
    { header: 'Última visita', width: 14, value: (patient) => patient.last_visit?.slice(0, 10) ?? '' },
    { header: 'Próxima cita', width: 18, value: (patient) => patient.next_appointment?.replace('T', ' ') ?? '' },
    { header: 'Saldo', width: 14, value: (patient) => patient.balance, isMoney: true },
  ]);
  toast(`Se exportaron ${patients.length} pacientes.`, 'success');
}

// ─── Ficha del paciente ─────────────────────────────────────────────────────

export async function renderPatientDetailView(container: HTMLElement, patientId: string): Promise<void> {
  setContent(container, loadingState('Cargando paciente…'));
  const canSeeStatement = can('cartera.ver', 'caja.recaudo.ver');
  const [{ patient, appointments }, statement] = await Promise.all([
    api.get<{ patient: PatientDetail; appointments: AppointmentItem[] }>(`/api/patients/${patientId}`),
    canSeeStatement ? api.get<Statement>(`/api/patients/${patientId}/statement`) : Promise.resolve(null),
  ]);
  const reload = () => renderPatientDetailView(container, patientId);
  const offset = clinicOffset();

  setContent(
    container,
    html`<div class="button-row"><a class="button button-ghost button-small" href="#/pacientes">${icon('chevron-left')} Pacientes</a></div>
    <div class="grid-2">
      <section class="card">
        <div class="card-header">
          <h3>${icon('user')} ${patient.full_name}</h3>
          <div class="button-row">
            ${whatsappButton(patient.phone, `Hola ${patient.full_name.split(' ')[0]}, te escribimos de ${session().clinic.name}.`, { variant: 'icon', tooltip: 'Escribir por WhatsApp' })}
            ${can('pacientes.editar') ? html`<button class="icon-button" data-action="edit" data-tooltip="Editar datos" aria-label="Editar">${icon('pencil')}</button>` : ''}
          </div>
        </div>
        <div class="card-padded">
          <dl class="detail-list">
            <dt>Documento</dt><dd>${patient.document_type} ${patient.document_number}</dd>
            <dt>Celular</dt><dd>${patient.phone}</dd>
            <dt>Correo</dt><dd>${patient.email ?? '—'}</dd>
            ${patient.birth_date ? html`<dt>Nacimiento</dt><dd>${formatLongDate(patient.birth_date)}</dd>` : ''}
            ${patient.guardian_name ? html`<dt>Acudiente</dt><dd>${patient.guardian_name}</dd>` : ''}
            ${patient.admin_notes ? html`<dt>Notas</dt><dd>${patient.admin_notes}</dd>` : ''}
            <dt>Autorización de datos</dt><dd>${patient.consent_at
              ? html`<span class="badge badge-success">${icon('shield-check')} ${patient.consent_channel === 'en_linea' ? 'En línea' : 'Presencial'} · ${formatUtcAsLocal(patient.consent_at, offset)}</span>`
              : html`<span class="badge badge-warning">Sin registrar</span>`}</dd>
          </dl>
        </div>
      </section>
      ${statement
        ? html`<section class="card">
            <div class="card-header"><h3>${icon('wallet')} Estado de cuenta</h3>
              <div class="button-row">
                ${can('caja.recaudo.crear') ? html`<button class="button button-primary button-small" data-action="pay">${icon('circle-dollar-sign')} Registrar pago</button>` : ''}
                ${can('cartera.cargo.crear') ? html`<button class="button button-secondary button-small" data-action="charge" data-tooltip="Agregar un cobro: un servicio, plan de tratamiento o ajuste">${icon('plus')} Cargo</button>` : ''}
              </div>
            </div>
            <div class="card-padded">
              <div class="grid-3">
                <div><div class="kpi-label">Debe</div><div class="kpi-value money">${formatMoney(statement.totals.pendingDebt)}</div></div>
                <div><div class="kpi-label">Saldo a favor <span class="hint" data-tooltip="Anticipos o pagos que aún no se han aplicado a un cargo">${icon('info')}</span></div><div class="kpi-value money">${formatMoney(statement.totals.availableCredit)}</div></div>
                <div><div class="kpi-label">Total pagado</div><div class="kpi-value money">${formatMoney(statement.totals.paid)}</div></div>
              </div>
              ${statement.totals.pendingDebt > 0 && statement.totals.availableCredit > 0 && can('caja.recaudo.crear')
                ? html`<button class="button button-secondary button-small" style="margin-top: 12px" data-action="apply-credit">${icon('coins')} Cruzar saldo a favor con lo que debe</button>`
                : ''}
            </div>
          </section>`
        : html`<section class="card card-padded">${emptyState('lock', 'Sin acceso a la cartera', 'Tu rol no permite ver pagos ni saldos.')}</section>`}
    </div>

    <section class="card">
      <div class="card-header"><h3>${icon('calendar-days')} Citas</h3>
        ${can('agenda.crear') ? html`<button class="button button-secondary button-small" data-action="new-appointment">${icon('calendar-plus')} Agendar</button>` : ''}</div>
      ${appointments.length === 0
        ? emptyState('calendar', 'Sin citas', 'Este paciente aún no tiene citas.')
        : html`<div class="table-wrapper"><table class="data-table"><thead><tr><th>Fecha</th><th>Servicio</th><th>Profesional</th><th>Estado</th></tr></thead><tbody>
            ${appointments.map((appointment) => html`<tr><td class="nowrap">${formatShortDate(appointment.start_at.slice(0, 10))} · ${formatTime(appointment.start_at)}</td><td>${appointment.service_name}</td><td>${appointment.professional_name}</td><td>${statusBadge(appointment.status)}</td></tr>`)}
          </tbody></table></div>`}
    </section>

    ${statement
      ? html`<div class="grid-2">
        <section class="card">
          <div class="card-header"><h3>${icon('clipboard-list')} Cargos</h3></div>
          ${statement.charges.length === 0
            ? emptyState('clipboard-list', 'Sin cargos', 'Se crean al marcar una cita como atendida o manualmente.')
            : html`<div class="table-wrapper"><table class="data-table"><thead><tr><th>Concepto</th><th class="align-right">Valor</th><th class="align-right">Pendiente</th><th></th></tr></thead><tbody>
              ${statement.charges.map((charge) => html`<tr class="${charge.status === 'anulado' ? 'is-voided' : ''}" ${charge.void_reason ? html`title="Anulado: ${charge.void_reason}"` : ''}>
                <td>${charge.description}${charge.quantity > 1 ? ` × ${charge.quantity}` : ''}<br /><small class="subtle">${formatUtcAsLocal(charge.created_at, offset)}</small></td>
                <td class="align-right">${moneyCell(charge.amount)}</td>
                <td class="align-right">${charge.status === 'activo' ? (charge.balance > 0 ? html`<span class="badge badge-danger money">${formatMoney(charge.balance)}</span>` : html`<span class="badge badge-success">Pagado</span>`) : html`<span class="keep badge badge-neutral">Anulado</span>`}</td>
                <td class="align-right">${charge.status === 'activo' && can('cartera.cargo.anular') ? html`<button class="icon-button is-danger" data-void-charge="${charge.id}" data-tooltip="Anular cargo" aria-label="Anular cargo">${icon('ban')}</button>` : ''}</td>
              </tr>`)}
            </tbody></table></div>`}
        </section>
        <section class="card">
          <div class="card-header"><h3>${icon('receipt')} Pagos</h3></div>
          ${statement.payments.length === 0
            ? emptyState('receipt', 'Sin pagos', 'Aquí verás abonos y anticipos con su recibo.')
            : html`<div class="table-wrapper"><table class="data-table"><thead><tr><th>Recibo</th><th>Medio</th><th class="align-right">Valor</th><th></th></tr></thead><tbody>
              ${statement.payments.map((payment) => html`<tr class="${payment.status === 'anulado' ? 'is-voided' : ''}">
                <td>N.º ${payment.receipt_number}<br /><small class="subtle">${formatUtcAsLocal(payment.created_at, offset)}</small></td>
                <td>${PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}${payment.available > 0 ? html`<br /><span class="badge badge-success">${formatMoney(payment.available)} a favor</span>` : ''}</td>
                <td class="align-right">${moneyCell(payment.amount)}</td>
                <td class="align-right keep nowrap">
                  <button class="icon-button" data-receipt="${payment.id}" data-tooltip="Ver e imprimir recibo" aria-label="Ver recibo">${icon('printer')}</button>
                  ${payment.status === 'activo' && can('caja.recaudo.anular') ? html`<button class="icon-button is-danger" data-void-payment="${payment.id}" data-tooltip="Anular recibo" aria-label="Anular recibo">${icon('ban')}</button>` : ''}
                </td>
              </tr>`)}
            </tbody></table></div>`}
        </section>
      </div>`
      : ''}`,
  );
  refreshIcons(container);

  container.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'edit') openEditPatientModal(patient, reload);
    if (action === 'pay') openPaymentModal({ patient, onDone: () => void reload() });
    if (action === 'charge') await openChargeModal(patient.id, reload);
    if (action === 'new-appointment') await openNewAppointmentModal({ date: todayLocal(offset), patient });
    if (action === 'apply-credit') {
      const result = await withErrorToast(() => api.post(`/api/patients/${patient.id}/apply-credit`));
      if (result) {
        toast('Saldo a favor aplicado.', 'success');
        await reload();
      }
    }

    const receiptButton = target.closest<HTMLElement>('[data-receipt]');
    if (receiptButton?.dataset.receipt) await withErrorToast(() => openReceiptModal(receiptButton.dataset.receipt as string));

    const voidPaymentId = target.closest<HTMLElement>('[data-void-payment]')?.dataset.voidPayment;
    if (voidPaymentId) {
      askReason({
        title: 'Anular recibo',
        message: 'El dinero deja de contar y lo que cubría vuelve a quedar pendiente. Queda registrado en la auditoría.',
        confirmLabel: 'Anular recibo',
        onConfirm: async (reason) => {
          await api.post(`/api/payments/${voidPaymentId}/void`, { reason });
          toast('Recibo anulado.', 'success');
          await reload();
        },
      });
    }

    const voidChargeId = target.closest<HTMLElement>('[data-void-charge]')?.dataset.voidCharge;
    if (voidChargeId) {
      askReason({
        title: 'Anular cargo',
        message: 'Si el cargo tenía abonos, ese dinero queda como saldo a favor del paciente.',
        confirmLabel: 'Anular cargo',
        onConfirm: async (reason) => {
          await api.post(`/api/charges/${voidChargeId}/void`, { reason });
          toast('Cargo anulado.', 'success');
          await reload();
        },
      });
    }
  };
}

function openEditPatientModal(patient: PatientDetail, onDone: () => Promise<void>): void {
  openFormModal({
    title: 'Editar paciente',
    iconName: 'pencil',
    submitLabel: 'Guardar cambios',
    size: 'wide',
    fields: patientFormFields(patient),
    onSubmit: async (form) => {
      await api.put(`/api/patients/${patient.id}`, patientPayload(form));
      toast('Datos actualizados.', 'success');
      await onDone();
    },
  });
}

async function openChargeModal(patientId: string, onDone: () => Promise<void>): Promise<void> {
  const services = (await api.get<ServiceItem[]>('/api/services')).filter((service) => service.is_active === 1);
  openFormModal({
    title: 'Agregar cargo',
    iconName: 'clipboard-list',
    submitLabel: 'Agregar cargo',
    fields: html`<p class="muted">Úsalo para planes de tratamiento (ej. ortodoncia por cuotas) o servicios no agendados.</p>
      <div class="form-grid">
        <label class="field full"><span>Servicio</span><select name="serviceId"><option value="">Otro concepto (escribir abajo)</option>${services.map((service) => html`<option value="${service.id}" data-price="${service.price}">${service.name} · ${formatMoney(service.price)}</option>`)}</select></label>
        <label class="field full"><span>Descripción (opcional si eliges servicio)</span><input name="description" maxlength="200" /></label>
        <label class="field"><span>Cantidad</span><input type="number" name="quantity" min="1" max="100" value="1" /></label>
        <label class="field"><span>Valor unitario (opcional si eliges servicio)</span><input type="number" name="unitPrice" min="1" step="1" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      await api.post('/api/charges', {
        patientId,
        serviceId: values.serviceId || null,
        description: values.description || null,
        quantity: Number(values.quantity || 1),
        unitPrice: values.unitPrice ? Number(values.unitPrice) : null,
      });
      toast('Cargo agregado.', 'success');
      await onDone();
    },
  });
}
