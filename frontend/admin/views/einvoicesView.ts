/**
 * Facturación electrónica: facturas de venta (a partir de los cargos del
 * paciente) y configuración del proveedor (externo, Factus o webhook).
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, safeUrl, setContent, type SafeHtml } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { addDays, formatMoney, formatShortDate, formatUtcAsLocal, todayLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, openModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { attachPatientPicker, patientPickerMarkup, type PatientSummary } from '../components.js';
import { can, clinicOffset } from '../session.js';

type ProviderName = 'externo' | 'factus' | 'webhook';

interface Settings {
  provider: ProviderName;
  environment: 'pruebas' | 'produccion';
  isEnabled: boolean;
  clientId: string;
  username: string;
  numberingRangeId: number | null;
  webhookUrl: string;
  maskedClientSecret: string | null;
  hasPassword: boolean;
  maskedWebhookSecret: string | null;
  lastVerifiedAt: string | null;
}

interface Invoice {
  id: string;
  patient_name: string;
  reference_code: string;
  provider: ProviderName;
  status: 'pendiente' | 'emitida' | 'rechazada' | 'anulada';
  number: string | null;
  cufe: string | null;
  qr_url: string | null;
  public_url: string | null;
  payment_form: 'contado' | 'credito';
  payment_method: string;
  due_date: string | null;
  subtotal: number;
  tax_total: number;
  total: number;
  last_error: string | null;
  attempts: number;
  void_reason: string | null;
  credit_note_ref: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface InvoiceDetail extends Invoice {
  customer: { documentType: string; documentNumber: string; name: string; email: string | null; phone: string | null; address: string | null };
  observation: string | null;
  lines: Array<{ code: string; description: string; quantity: number; unit_price: number; tax_rate_bps: number; line_total: number }>;
}

interface BillableCharge {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  created_at: string;
}

const STATUS: Record<Invoice['status'], [string, string]> = {
  pendiente: ['Pendiente', 'badge-warning'],
  emitida: ['Emitida', 'badge-success'],
  rechazada: ['Rechazada', 'badge-danger'],
  anulada: ['Anulada', 'badge-neutral'],
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  externo: 'Software actual del consultorio (registro manual)',
  factus: 'Factus (emisión automática)',
  webhook: 'Webhook propio (Make, n8n u otro proveedor)',
};

const PAYMENT_METHODS: Array<[string, string]> = [
  ['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta_debito', 'Tarjeta débito'], ['tarjeta_credito', 'Tarjeta crédito'],
  ['nequi', 'Nequi'], ['daviplata', 'Daviplata'], ['consignacion', 'Consignación'], ['otro', 'Otro'],
];

const filters = { from: '', to: '' };

export async function renderEInvoicesView(container: HTMLElement, params: string[] = []): Promise<void> {
  const tabs = [
    { id: 'facturas', label: 'Facturas', iconName: 'file-text', allowed: can('facturacion.ver') },
    { id: 'configuracion', label: 'Proveedor', iconName: 'plug-zap', allowed: can('facturacion.configurar') },
  ].filter((tab) => tab.allowed);
  const activeTab = tabs.find((tab) => tab.id === params[0]) ?? tabs[0];
  if (!activeTab) return;
  setContent(
    container,
    html`<div class="tabs tabs-scroll" role="tablist">${tabs.map(
      (tab) => html`<a class="tab ${tab.id === activeTab.id ? 'is-active' : ''}" role="tab" href="#/facturacion/${tab.id}">${icon(tab.iconName)} ${tab.label}</a>`,
    )}</div><div data-tab-content>${loadingState()}</div>`,
  );
  refreshIcons(container);
  const content = $('[data-tab-content]', container);
  const reload = () => renderEInvoicesView(container, [activeTab.id]);
  content.onclick = null;
  content.onchange = null;
  content.onsubmit = null;
  if (activeTab.id === 'configuracion') return renderSettingsTab(content, reload);
  return renderInvoicesTab(content, reload);
}

// ─── Facturas ───────────────────────────────────────────────────────────────

async function renderInvoicesTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const today = todayLocal(clinicOffset());
  filters.to ||= today;
  filters.from ||= addDays(today, -30);
  const [invoices, settings] = await Promise.all([
    api.get<Invoice[]>('/api/einvoices', { from: filters.from, to: filters.to }),
    can('facturacion.emitir') ? api.get<Settings>('/api/settings/einvoicing') : Promise.resolve(null),
  ]);
  const issued = invoices.filter((invoice) => invoice.status === 'emitida');
  const pending = invoices.filter((invoice) => invoice.status === 'pendiente');
  const offset = clinicOffset();

  setContent(
    content,
    html`<section class="card">
      <div class="card-padded"><div class="kpi-grid">
        <div class="card kpi"><span class="kpi-icon">${icon('file-text')}</span><div><div class="kpi-value money">${formatMoney(issued.reduce((sum, row) => sum + row.total, 0))}</div><div class="kpi-label">Facturado · ${issued.length} facturas</div></div></div>
        <div class="card kpi"><span class="kpi-icon ${pending.length ? 'is-danger' : 'is-info'}">${icon('hourglass')}</span><div><div class="kpi-value">${pending.length}</div><div class="kpi-label">Pendientes de envío</div></div></div>
        ${settings ? html`<div class="card kpi"><span class="kpi-icon is-info">${icon('plug-zap')}</span><div><div class="kpi-value" style="font-size: 1rem">${settings.provider === 'factus' ? `Factus · ${settings.environment}` : settings.provider === 'webhook' ? 'Webhook' : 'Registro manual'}</div><div class="kpi-label">${settings.isEnabled ? 'Proveedor activo' : 'Desactivado'}</div></div></div>` : ''}
      </div></div>
      <div class="card-header">
        <div class="agenda-toolbar">
          <label class="muted">Desde <input class="input" type="date" name="from" value="${filters.from}" style="width:auto" /></label>
          <label class="muted">Hasta <input class="input" type="date" name="to" value="${filters.to}" style="width:auto" /></label>
        </div>
        <div class="button-row">
          ${invoices.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${settings?.isEnabled ? html`<button class="button button-primary" data-action="new">${icon('plus')} Nueva factura</button>` : ''}
        </div>
      </div>
      ${invoices.length === 0
        ? emptyState('file-text', 'Sin facturas en estas fechas', 'Factura los servicios atendidos a partir de los cargos del paciente.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Número</th><th>Paciente</th><th class="align-right">Total</th><th>Pago</th><th>Estado</th><th></th></tr></thead>
          <tbody>${invoices.map((invoice) => html`<tr class="${invoice.status === 'anulada' || invoice.status === 'rechazada' ? 'is-muted' : ''}">
            <td>${formatUtcAsLocal(invoice.created_at, offset)}</td>
            <td>${invoice.number ? html`<strong>${invoice.number}</strong>` : html`<span class="subtle">${invoice.reference_code}</span>`}</td>
            <td>${invoice.patient_name}</td>
            <td class="align-right money">${formatMoney(invoice.total)}</td>
            <td>${invoice.payment_form === 'credito' ? html`Crédito${invoice.due_date ? html`<br /><small class="subtle">Vence ${formatShortDate(invoice.due_date)}</small>` : ''}` : 'Contado'}</td>
            <td>${statusBadge(invoice)}</td>
            <td class="align-right">
              ${invoice.public_url ? html`<a class="icon-button" href="${safeUrl(invoice.public_url, ['https:'])}" target="_blank" rel="noopener" aria-label="Ver factura" data-tooltip="Ver representación gráfica">${icon('external-link')}</a>` : ''}
              <button class="icon-button" data-invoice="${invoice.id}" aria-label="Detalle" data-tooltip="Detalle">${icon('eye')}</button>
            </td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'from' || input.name === 'to') {
      filters[input.name] = input.value;
      void reload();
    }
  };
  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'new' && settings) openNewInvoiceModal(settings, reload);
    if (action === 'export') {
      void downloadExcel(`facturas-${filters.from}-a-${filters.to}`, 'Facturas', invoices, [
        { header: 'Fecha', width: 18, value: (row) => formatUtcAsLocal(row.created_at, offset) },
        { header: 'Número', width: 16, value: (row) => row.number },
        { header: 'Referencia', width: 24, value: (row) => row.reference_code },
        { header: 'Paciente', width: 30, value: (row) => row.patient_name },
        { header: 'Subtotal', width: 14, value: (row) => row.subtotal, isMoney: true },
        { header: 'IVA', width: 12, value: (row) => row.tax_total, isMoney: true },
        { header: 'Total', width: 14, value: (row) => row.total, isMoney: true },
        { header: 'Forma de pago', width: 12, value: (row) => row.payment_form },
        { header: 'Estado', width: 12, value: (row) => STATUS[row.status][0] },
        { header: 'CUFE', width: 50, value: (row) => row.cufe },
        { header: 'Nota crédito', width: 16, value: (row) => row.credit_note_ref },
      ]);
    }
    const invoiceId = target.closest<HTMLElement>('[data-invoice]')?.dataset.invoice;
    if (invoiceId) void openInvoiceDetail(invoiceId, reload);
  };
}

function statusBadge(invoice: Invoice): SafeHtml {
  const [label, badge] = STATUS[invoice.status];
  return html`<span class="badge ${badge}" ${invoice.last_error ? html`data-tooltip="${invoice.last_error}"` : ''}>${label}</span>`;
}

function openNewInvoiceModal(settings: Settings, onDone: () => Promise<void>): void {
  const isExternal = settings.provider === 'externo';
  let charges: BillableCharge[] = [];
  let patient: PatientSummary | null = null;

  const modal = openFormModal({
    title: 'Nueva factura electrónica',
    iconName: 'file-text',
    size: 'wide',
    submitLabel: isExternal ? 'Registrar factura' : 'Emitir factura',
    fields: html`${patientPickerMarkup('Paciente (adquiriente)')}
      <div data-charges><p class="subtle">Selecciona el paciente para ver sus cargos sin facturar.</p></div>
      <div class="form-grid">
        <label class="field"><span>Forma de pago</span><select name="paymentForm"><option value="contado">Contado</option><option value="credito">Crédito</option></select></label>
        <label class="field"><span>Medio de pago</span><select name="paymentMethod">${PAYMENT_METHODS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></label>
        <label class="field" data-due hidden><span>Vence</span><input name="dueDate" type="date" min="${todayLocal(clinicOffset())}" /></label>
        <label class="field"><span>Correo para enviar la factura</span><input name="customerEmail" type="email" maxlength="200" /></label>
        <label class="field"><span>Dirección (opcional)</span><input name="customerAddress" maxlength="200" /></label>
        <label class="field full"><span>Observación</span><input name="observation" maxlength="500" /></label>
        ${isExternal
          ? html`<label class="field"><span>N.º de factura (de tu software)</span><input name="externalNumber" required maxlength="40" placeholder="FE-1234" /></label>
            <label class="field"><span>CUFE (opcional)</span><input name="externalCufe" maxlength="128" /></label>`
          : ''}
      </div>
      <p class="subtle">${isExternal
        ? 'Modo manual: emite la factura en tu software de facturación con estos valores y registra aquí su número.'
        : `Se enviará a ${settings.provider === 'factus' ? `Factus (${settings.environment})` : 'tu webhook'}. Los servicios de salud se reportan como excluidos de IVA.`}</p>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      if (!patient) throw new Error('Selecciona el paciente.');
      const chargeIds = [...form.querySelectorAll<HTMLInputElement>('input[name="chargeId"]:checked')].map((input) => input.value);
      if (chargeIds.length === 0) throw new Error('Selecciona al menos un cargo.');
      const invoice = await api.post<Invoice>('/api/einvoices', {
        patientId: patient.id,
        chargeIds,
        paymentForm: values.paymentForm,
        paymentMethod: values.paymentMethod,
        dueDate: values.paymentForm === 'credito' ? emptyToNull(values.dueDate) : null,
        observation: emptyToNull(values.observation),
        customerEmail: emptyToNull(values.customerEmail),
        customerAddress: emptyToNull(values.customerAddress),
        externalNumber: emptyToNull(values.externalNumber),
        externalCufe: emptyToNull(values.externalCufe),
      });
      if (invoice.status === 'emitida') toast(`Factura ${invoice.number ?? ''} emitida.`, 'success');
      else if (invoice.status === 'rechazada') toast(`Factura rechazada: ${invoice.last_error ?? ''}`, 'error');
      else toast(`Quedó pendiente: ${invoice.last_error ?? 'reintenta en unos minutos.'}`, 'info');
      await onDone();
    },
  });

  const form = modal.body.querySelector('form') as HTMLFormElement;
  const chargesElement = $('[data-charges]', form);
  const drawCharges = () => {
    if (charges.length === 0) {
      setContent(chargesElement, html`<p class="form-error">${icon('info')} ${patient?.full_name} no tiene cargos pendientes de facturar. Los cargos se crean al atender la cita o desde Cartera.</p>`);
    } else {
      setContent(
        chargesElement,
        html`<div class="table-wrapper"><table class="data-table"><thead><tr><th></th><th>Cargo</th><th>Fecha</th><th class="align-right">Valor</th></tr></thead>
          <tbody>${charges.map((charge) => html`<tr>
            <td><input type="checkbox" name="chargeId" value="${charge.id}" checked /></td>
            <td>${charge.description}${charge.quantity > 1 ? ` × ${charge.quantity}` : ''}</td>
            <td>${formatUtcAsLocal(charge.created_at, clinicOffset())}</td>
            <td class="align-right money">${formatMoney(charge.amount)}</td>
          </tr>`)}</tbody></table></div><p class="purchase-totals" data-invoice-total></p>`,
      );
    }
    refreshIcons(chargesElement);
    updateTotal();
  };
  const updateTotal = () => {
    const totalElement = form.querySelector<HTMLElement>('[data-invoice-total]');
    if (!totalElement) return;
    const selected = new Set([...form.querySelectorAll<HTMLInputElement>('input[name="chargeId"]:checked')].map((input) => input.value));
    const total = charges.filter((charge) => selected.has(charge.id)).reduce((sum, charge) => sum + charge.amount, 0);
    setContent(totalElement, html`<span>Total a facturar <strong class="money">${formatMoney(total)}</strong></span>`);
  };

  attachPatientPicker(form, (selected) => {
    patient = selected;
    (form.elements.namedItem('customerEmail') as HTMLInputElement).value = selected.email ?? '';
    setContent(chargesElement, loadingState('Buscando cargos…'));
    void withErrorToast(async () => {
      charges = await api.get<BillableCharge[]>(`/api/patients/${selected.id}/billable-charges`);
      drawCharges();
    });
  });
  form.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'chargeId') updateTotal();
    if (input.name === 'paymentForm') ($('[data-due]', form)).hidden = input.value !== 'credito';
  });
}

async function openInvoiceDetail(invoiceId: string, onChange: () => Promise<void>): Promise<void> {
  const invoice = await withErrorToast(() => api.get<InvoiceDetail>(`/api/einvoices/${invoiceId}`));
  if (!invoice) return;
  const modal = openModal({
    title: invoice.number ? `Factura ${invoice.number}` : `Factura ${invoice.reference_code}`,
    iconName: 'file-text',
    size: 'wide',
    content: html`<div class="detail-grid">
        <div><span class="subtle">Adquiriente</span><strong>${invoice.customer.name}</strong><small>${invoice.customer.documentType} ${invoice.customer.documentNumber}</small></div>
        <div><span class="subtle">Total</span><strong class="money">${formatMoney(invoice.total)}</strong><small>IVA ${formatMoney(invoice.tax_total)}</small></div>
        <div><span class="subtle">Estado</span>${statusBadge(invoice)}<small>${PROVIDER_LABELS[invoice.provider]}</small></div>
        <div><span class="subtle">Referencia</span><strong>${invoice.reference_code}</strong><small>${invoice.attempts} envíos</small></div>
      </div>
      ${invoice.last_error ? html`<p class="form-error">${icon('triangle-alert')} ${invoice.last_error}</p>` : ''}
      ${invoice.cufe ? html`<p class="subtle" style="word-break: break-all"><strong>CUFE:</strong> ${invoice.cufe}</p>` : ''}
      ${invoice.void_reason ? html`<p class="subtle"><strong>Anulada:</strong> ${invoice.void_reason}${invoice.credit_note_ref ? ` · Nota crédito ${invoice.credit_note_ref}` : ''}</p>` : ''}
      <div class="table-wrapper"><table class="data-table"><thead><tr><th>Código</th><th>Descripción</th><th class="align-right">Cant.</th><th class="align-right">Valor</th></tr></thead>
        <tbody>${invoice.lines.map((line) => html`<tr><td><code>${line.code}</code></td><td>${line.description}</td><td class="align-right">${line.quantity}</td><td class="align-right money">${formatMoney(line.line_total)}</td></tr>`)}</tbody></table></div>
      <div class="modal-actions">
        ${invoice.qr_url ? html`<a class="button button-ghost" href="${safeUrl(invoice.qr_url, ['https:'])}" target="_blank" rel="noopener">${icon('external-link')} Consultar en la DIAN</a>` : ''}
        ${invoice.public_url ? html`<a class="button button-secondary" href="${safeUrl(invoice.public_url, ['https:'])}" target="_blank" rel="noopener">${icon('printer')} Ver / imprimir</a>` : ''}
        ${(invoice.status === 'pendiente' || invoice.status === 'emitida') && can('facturacion.anular') ? html`<button class="button button-ghost" data-action="void">${icon('ban')} Anular</button>` : ''}
        ${invoice.status === 'pendiente' && can('facturacion.emitir') ? html`<button class="button button-primary" data-action="retry">${icon('refresh-cw')} Reintentar envío</button>` : ''}
      </div>`,
  });
  refreshIcons(modal.body);

  modal.body.addEventListener('click', async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'retry') {
      const result = await withErrorToast(() => api.post<Invoice>(`/api/einvoices/${invoice.id}/retry`));
      if (!result) return;
      toast(result.status === 'emitida' ? `Factura ${result.number ?? ''} emitida.` : result.last_error ?? 'Sin cambios.', result.status === 'emitida' ? 'success' : 'info');
      modal.close();
      await onChange();
    }
    if (action === 'void') {
      const needsCreditNote = invoice.status === 'emitida';
      openFormModal({
        title: 'Anular factura',
        iconName: 'triangle-alert',
        danger: true,
        submitLabel: 'Anular',
        fields: html`<p class="muted">${needsCreditNote
          ? 'La DIAN no permite borrar una factura emitida: primero haz la nota crédito en el portal de tu proveedor y escribe aquí su número. Los cargos quedarán disponibles para volver a facturar.'
          : 'La factura no se ha emitido. Los cargos quedarán disponibles para facturar de nuevo.'}</p>
          ${needsCreditNote ? html`<label class="field"><span>N.º de la nota crédito</span><input name="creditNoteRef" required maxlength="60" /></label>` : ''}
          <label class="field"><span>Motivo</span><input name="reason" required maxlength="200" /></label>`,
        onSubmit: async (form) => {
          const values = readForm(form);
          await api.post(`/api/einvoices/${invoice.id}/void`, { reason: values.reason, creditNoteRef: emptyToNull(values.creditNoteRef) });
          toast('Factura anulada.', 'info');
          modal.close();
          await onChange();
        },
      });
    }
  });
}

// ─── Configuración del proveedor ────────────────────────────────────────────

async function renderSettingsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const settings = await api.get<Settings>('/api/settings/einvoicing');
  let provider: ProviderName = settings.provider;

  const draw = () => {
    setContent(
      content,
      html`<section class="card card-padded">
        <form class="form" data-einvoice-form novalidate>
          <h3>${icon('plug-zap')} ¿Cómo factura electrónicamente este consultorio?</h3>
          <div class="option-list">
            ${(Object.keys(PROVIDER_LABELS) as ProviderName[]).map((name) => html`<label class="checkbox"><input type="radio" name="provider" value="${name}" ${provider === name ? 'checked' : ''} /> <span>${PROVIDER_LABELS[name]}</span></label>`)}
          </div>
          ${provider === 'externo'
            ? html`<p class="subtle">Sin costo ni integración: emites la factura en el software que ya usas (Siigo, Alegra, el facturador gratuito de la DIAN…) y registras aquí el número y el CUFE. Así queda la relación factura ↔ cargos y nadie factura dos veces lo mismo.</p>`
            : provider === 'factus'
              ? html`<p class="subtle">Crea tu cuenta en factus.com.co, habilita la facturación con la DIAN y copia las credenciales de API (Configuración → API). Prueba primero en el ambiente de pruebas.</p>
                <div class="form-grid">
                  <label class="field"><span>Ambiente</span><select name="environment">
                    <option value="pruebas" ${settings.environment === 'pruebas' ? 'selected' : ''}>Pruebas (sandbox)</option>
                    <option value="produccion" ${settings.environment === 'produccion' ? 'selected' : ''}>Producción</option></select></label>
                  <label class="field"><span>ID del rango de numeración <span class="hint" data-tooltip="Solo si tienes varios rangos activos en Factus.">${icon('info')}</span></span><input name="numberingRangeId" type="number" min="1" value="${settings.numberingRangeId ?? ''}" /></label>
                  <label class="field"><span>Client ID</span><input name="clientId" maxlength="200" value="${settings.clientId}" autocomplete="off" /></label>
                  <label class="field"><span>Client secret</span><input name="clientSecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedClientSecret ? `Guardado (${settings.maskedClientSecret}) · escribe para cambiarlo` : ''}" /></label>
                  <label class="field"><span>Usuario (correo de Factus)</span><input name="username" maxlength="200" value="${settings.username}" autocomplete="off" /></label>
                  <label class="field"><span>Contraseña</span><input name="password" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.hasPassword ? 'Guardada · escribe para cambiarla' : ''}" /></label>
                </div>`
              : html`<p class="subtle">Enviamos cada factura como JSON a tu URL, firmada con HMAC-SHA256 en la cabecera <code>X-AgendaSonrisa-Signature</code> (sobre <code>timestamp.cuerpo</code>). Tu flujo debe emitirla con tu proveedor y responder <code>{"number": "...", "cufe": "...", "publicUrl": "..."}</code>.</p>
                <div class="form-grid">
                  <label class="field full"><span>URL (https)</span><input name="webhookUrl" type="url" maxlength="500" value="${settings.webhookUrl}" placeholder="https://hook.make.com/..." /></label>
                  <label class="field full"><span>Secreto de firma (mín. 16 caracteres)</span><input name="webhookSecret" type="password" maxlength="200" autocomplete="new-password" placeholder="${settings.maskedWebhookSecret ? `Guardado (${settings.maskedWebhookSecret}) · escribe para cambiarlo` : ''}" /></label>
                </div>`}
          <label class="checkbox"><input type="checkbox" name="isEnabled" ${settings.isEnabled ? 'checked' : ''} /> <span>Facturación electrónica activa</span></label>
          ${settings.lastVerifiedAt ? html`<p class="subtle">${icon('circle-check-big')} Conexión verificada el ${formatUtcAsLocal(settings.lastVerifiedAt, clinicOffset())}</p>` : ''}
          <p class="form-error" role="alert" hidden></p>
          <div class="button-row">
            <button type="submit" class="button button-primary">${icon('check')} Guardar</button>
            ${provider !== 'externo' && provider === settings.provider ? html`<button type="button" class="button button-secondary" data-action="test">${icon('plug-zap')} Probar conexión</button>` : ''}
          </div>
        </form>
      </section>`,
    );
    refreshIcons(content);
  };
  draw();

  content.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'provider') {
      provider = input.value as ProviderName;
      draw();
    }
  };
  content.onclick = async (event) => {
    if (!(event.target as HTMLElement).closest('[data-action="test"]')) return;
    const result = await withErrorToast(() => api.post<{ message: string }>('/api/settings/einvoicing/test'));
    if (result) {
      toast(result.message, 'success');
      await reload();
    }
  };
  content.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const errorElement = $('.form-error', form);
    const values = readForm(form);
    try {
      await api.put('/api/settings/einvoicing', {
        provider,
        environment: values.environment || 'pruebas',
        isEnabled: (form.elements.namedItem('isEnabled') as HTMLInputElement).checked,
        clientId: emptyToNull(values.clientId),
        clientSecret: emptyToNull(values.clientSecret),
        username: emptyToNull(values.username),
        password: emptyToNull(values.password),
        numberingRangeId: values.numberingRangeId ? Number(values.numberingRangeId) : null,
        webhookUrl: emptyToNull(values.webhookUrl),
        webhookSecret: emptyToNull(values.webhookSecret),
      });
      toast('Configuración guardada.', 'success');
      await reload();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    }
  };
}
