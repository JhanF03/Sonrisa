/**
 * Componentes compartidos del panel: selector de pacientes, formularios de
 * paciente y pago, recibo imprimible e insignias de estado.
 */
import { api } from '../core/api.js';
import { $, debounce, emptyToNull, html, readForm, setContent, type SafeHtml } from '../core/dom.js';
import { DOCUMENT_TYPES, formatLongDate, formatMoney, PAYMENT_METHOD_LABELS, STATUS_LABELS } from '../core/format.js';
import { icon, openFormModal, openModal, refreshIcons, toast } from '../core/ui.js';
import { can } from './session.js';

export interface PatientSummary {
  id: string;
  full_name: string;
  document_type: string;
  document_number: string;
  phone: string;
  email: string | null;
  balance: number;
  next_appointment: string | null;
  last_visit: string | null;
}

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: string | null;
  price: number;
  duration_minutes: number;
  tax_rate_bps: number;
  is_bookable_online: number;
  is_active: number;
  prepayment_mode: 'ninguno' | 'porcentaje' | 'valor';
  prepayment_value: number;
}

/** Igual que en el servidor (catalogService.computePrepaymentAmount). */
export function prepaymentAmountOf(service: Pick<ServiceItem, 'price' | 'prepayment_mode' | 'prepayment_value'>): number {
  if (service.price <= 0) return 0;
  if (service.prepayment_mode === 'porcentaje') return Math.round((service.price * service.prepayment_value) / 100);
  if (service.prepayment_mode === 'valor') return Math.min(service.prepayment_value, service.price);
  return 0;
}

export interface ProfessionalItem {
  id: string;
  full_name: string;
  specialty: string | null;
  color: string;
  user_id: string | null;
  is_active: number;
}

export interface PaymentItem {
  id: string;
  patient_id: string;
  patient_name: string;
  receipt_number: number;
  amount: number;
  allocated: number;
  available: number;
  method: string;
  reference: string | null;
  notes: string | null;
  status: 'activo' | 'anulado';
  void_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

export const statusBadge = (status: string) => html`<span class="badge badge-${status}">${STATUS_LABELS[status] ?? status}</span>`;

export function moneyCell(value: number): SafeHtml {
  return html`<span class="money">${formatMoney(value)}</span>`;
}

// ─── Selector de paciente con búsqueda ──────────────────────────────────────

export function patientPickerMarkup(label = 'Paciente'): SafeHtml {
  return html`<div class="field full patient-picker">
    <span>${icon('user')} ${label}</span>
    <div class="search-input">${icon('search')}<input type="search" data-patient-search placeholder="Nombre, documento o celular" autocomplete="off" /></div>
    <input type="hidden" name="patientId" />
    <div class="suggestions" data-patient-results hidden></div>
    <small class="field-hint" data-patient-selected>Escribe al menos 2 letras para buscar.</small>
  </div>`;
}

export function attachPatientPicker(root: HTMLElement, onSelect?: (patient: PatientSummary) => void, preselected?: PatientSummary): void {
  const searchInput = root.querySelector<HTMLInputElement>('[data-patient-search]');
  const hiddenInput = root.querySelector<HTMLInputElement>('input[name="patientId"]');
  const resultsElement = root.querySelector<HTMLElement>('[data-patient-results]');
  const selectedHint = root.querySelector<HTMLElement>('[data-patient-selected]');
  if (!searchInput || !hiddenInput || !resultsElement || !selectedHint) return;

  let lastResults: PatientSummary[] = [];
  const select = (patient: PatientSummary) => {
    hiddenInput.value = patient.id;
    searchInput.value = patient.full_name;
    resultsElement.hidden = true;
    setContent(selectedHint, html`${icon('user-check')} ${patient.full_name} · ${patient.document_type} ${patient.document_number} · ${patient.phone}`);
    refreshIcons(selectedHint);
    onSelect?.(patient);
  };
  if (preselected) select(preselected);

  const search = debounce(async (query: string) => {
    if (query.length < 2) {
      resultsElement.hidden = true;
      return;
    }
    try {
      lastResults = await api.get<PatientSummary[]>('/api/patients', { q: query, limit: 8 });
      setContent(
        resultsElement,
        lastResults.length
          ? html`${lastResults.map(
              (patient) => html`<button type="button" class="suggestion" data-patient-id="${patient.id}">
                <span><strong>${patient.full_name}</strong><br /><small class="muted">${patient.document_type} ${patient.document_number}</small></span>
                <small class="muted">${patient.phone}</small></button>`,
            )}`
          : html`<div class="suggestion">No hay coincidencias.</div>`,
      );
      resultsElement.hidden = false;
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Error buscando pacientes', 'error');
    }
  }, 250);

  searchInput.addEventListener('input', () => {
    hiddenInput.value = '';
    search(searchInput.value.trim());
  });
  resultsElement.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-patient-id]');
    const patient = lastResults.find((candidate) => candidate.id === button?.dataset.patientId);
    if (patient) select(patient);
  });
}

// ─── Paciente nuevo / edición ───────────────────────────────────────────────

export function patientFormFields(patient?: Partial<PatientSummary> & { birth_date?: string | null; guardian_name?: string | null; guardian_phone?: string | null; admin_notes?: string | null }): SafeHtml {
  const isNew = !patient?.id;
  return html`<div class="form-grid">
    <label class="field"><span>Tipo de documento</span>
      <select name="documentType" required>
        ${DOCUMENT_TYPES.map(([code, label]) => html`<option value="${code}" ${patient?.document_type === code ? 'selected' : ''}>${label}</option>`)}
      </select></label>
    <label class="field"><span>Número de documento</span><input name="documentNumber" required maxlength="20" value="${patient?.document_number ?? ''}" /></label>
    <label class="field full"><span>Nombre completo</span><input name="fullName" required maxlength="120" value="${patient?.full_name ?? ''}" /></label>
    <label class="field"><span>${icon('phone')} Celular</span><input name="phone" type="tel" required maxlength="20" value="${patient?.phone ?? ''}" placeholder="300 123 4567" /></label>
    <label class="field"><span>Correo (opcional)</span><input name="email" type="email" maxlength="200" value="${patient?.email ?? ''}" /></label>
    <label class="field"><span>Fecha de nacimiento</span><input name="birthDate" type="date" value="${patient?.birth_date ?? ''}" /></label>
    <label class="field"><span>Acudiente (menores)</span><input name="guardianName" maxlength="120" value="${patient?.guardian_name ?? ''}" /></label>
    <label class="field full"><span>Notas administrativas <span class="hint" data-tooltip="Solo datos administrativos (ej. prefiere la tarde). No escribas información clínica.">${icon('info')}</span></span>
      <textarea name="adminNotes" rows="2" maxlength="1000">${patient?.admin_notes ?? ''}</textarea></label>
    ${isNew
      ? html`<label class="checkbox full"><input type="checkbox" name="consentGiven" value="si" required />
          <span>El paciente autorizó el tratamiento de sus datos personales (Ley 1581 de 2012) para gestionar citas, pagos y recordatorios.</span></label>`
      : ''}
  </div>`;
}

export function patientPayload(form: HTMLFormElement) {
  const values = readForm(form);
  return {
    documentType: values.documentType,
    documentNumber: values.documentNumber,
    fullName: values.fullName,
    phone: values.phone,
    email: emptyToNull(values.email),
    birthDate: emptyToNull(values.birthDate),
    guardianName: emptyToNull(values.guardianName),
    guardianPhone: null,
    adminNotes: emptyToNull(values.adminNotes),
  };
}

export function openNewPatientModal(onCreated: (patient: PatientSummary) => void): void {
  openFormModal({
    title: 'Nuevo paciente',
    iconName: 'user-plus',
    submitLabel: 'Crear paciente',
    size: 'wide',
    fields: patientFormFields(),
    onSubmit: async (form) => {
      const consent = (form.elements.namedItem('consentGiven') as HTMLInputElement).checked;
      if (!consent) throw new Error('Registra la autorización de tratamiento de datos.');
      const patient = await api.post<PatientSummary>('/api/patients', { ...patientPayload(form), consentGiven: true });
      toast('Paciente creado.', 'success');
      onCreated(patient);
    },
  });
}

// ─── Pagos ──────────────────────────────────────────────────────────────────

export function openPaymentModal(options: { patient?: PatientSummary; onDone: () => void }): void {
  const modal = openFormModal({
    title: 'Registrar pago',
    iconName: 'circle-dollar-sign',
    submitLabel: 'Registrar y ver recibo',
    fields: html`
      ${options.patient ? html`<input type="hidden" name="patientId" value="${options.patient.id}" /><p><strong>${options.patient.full_name}</strong></p>` : patientPickerMarkup()}
      <div class="form-grid">
        <label class="field"><span>Valor recibido</span><input name="amount" type="number" min="1" step="1" required inputmode="numeric" placeholder="Ej: 120000" /></label>
        <label class="field"><span>Medio de pago</span>
          <select name="method">${Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></label>
        <label class="field"><span>Referencia (opcional)</span><input name="reference" maxlength="80" placeholder="N.º de transferencia o voucher" /></label>
        <label class="field"><span>Nota (opcional)</span><input name="notes" maxlength="300" /></label>
        <label class="checkbox full"><input type="checkbox" name="applyToCharges" checked />
          <span>Abonar a lo que debe (de lo más antiguo a lo más nuevo). Si lo desmarcas, todo queda como <strong>anticipo</strong>.</span></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      if (!values.patientId) throw new Error('Selecciona el paciente.');
      const payment = await api.post<PaymentItem>('/api/payments', {
        patientId: values.patientId,
        amount: Number(values.amount),
        method: values.method,
        reference: emptyToNull(values.reference),
        notes: emptyToNull(values.notes),
        applyToCharges: (form.elements.namedItem('applyToCharges') as HTMLInputElement).checked,
      });
      toast(`Pago registrado. Recibo N.º ${payment.receipt_number}.`, 'success');
      options.onDone();
      window.setTimeout(() => void openReceiptModal(payment.id), 50);
    },
  });
  if (!options.patient) attachPatientPicker(modal.body);
}

interface ReceiptData {
  clinic: { name: string; address: string | null; city: string | null; phone: string | null };
  payment: PaymentItem;
  patient: { fullName: string; documentType: string; documentNumber: string };
  allocations: Array<{ description: string; amount: number }>;
  issuedAtLocalDate: string;
}

export async function openReceiptModal(paymentId: string): Promise<void> {
  const receipt = await api.get<ReceiptData>(`/api/payments/${paymentId}/receipt`);
  const { payment } = receipt;
  const modal = openModal({
    title: `Recibo de caja N.º ${payment.receipt_number}`,
    iconName: 'receipt',
    content: html`<div class="receipt">
      <div class="receipt-header">
        <div><strong>${receipt.clinic.name}</strong><br /><span class="muted">${[receipt.clinic.address, receipt.clinic.city].filter(Boolean).join(', ')}</span><br /><span class="muted">${receipt.clinic.phone ?? ''}</span></div>
        <div class="receipt-number">Recibo de caja<br />N.º ${payment.receipt_number}</div>
      </div>
      ${payment.status === 'anulado' ? html`<p class="form-error">ANULADO: ${payment.void_reason ?? ''}</p>` : ''}
      <dl class="detail-list">
        <dt>Fecha</dt><dd>${formatLongDate(receipt.issuedAtLocalDate)}</dd>
        <dt>Recibido de</dt><dd>${receipt.patient.fullName} · ${receipt.patient.documentType} ${receipt.patient.documentNumber}</dd>
        <dt>Medio de pago</dt><dd>${PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}${payment.reference ? ` · Ref. ${payment.reference}` : ''}</dd>
        ${payment.notes ? html`<dt>Nota</dt><dd>${payment.notes}</dd>` : ''}
        <dt>Registró</dt><dd>${payment.created_by_name ?? '—'}</dd>
      </dl>
      <table>
        <thead><tr><th>Concepto</th><th class="align-right">Valor</th></tr></thead>
        <tbody>
          ${receipt.allocations.map((allocation) => html`<tr><td>Abono a: ${allocation.description}</td><td class="money">${formatMoney(allocation.amount)}</td></tr>`)}
          ${payment.available > 0 ? html`<tr><td>Anticipo / saldo a favor</td><td class="money">${formatMoney(payment.available)}</td></tr>` : ''}
        </tbody>
      </table>
      <p class="total">Total recibido: ${formatMoney(payment.amount)}</p>
      <p class="subtle">Documento soporte de recaudo. No reemplaza la factura electrónica cuando esta sea exigible.</p>
      <div class="modal-actions no-print">
        <button class="button button-secondary" type="button" data-close-modal>Cerrar</button>
        <button class="button button-primary" type="button" data-action="print">${icon('printer')} Imprimir</button>
      </div>
    </div>`,
  });
  refreshIcons(modal.dialog);
  $('[data-action="print"]', modal.dialog).addEventListener('click', () => window.print());
}

export function canSeeMoney(): boolean {
  return can('cartera.ver', 'caja.recaudo.ver');
}
