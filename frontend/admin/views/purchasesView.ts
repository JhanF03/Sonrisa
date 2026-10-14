/**
 * Compras: facturas de proveedores (manual o importando el XML de la DIAN),
 * cuentas por pagar con abonos y directorio de proveedores.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { addDays, formatMoney, formatShortDate, todayLocal } from '../../core/format.js';
import { askReason, emptyState, icon, loadingState, openFormModal, openModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { InvoiceXmlError, parseDianInvoice, type ParsedInvoice } from '../../../src/shared/dianInvoiceXml.js';
import { can, clinicOffset } from '../session.js';
import { formatQuantity, SUPPLY_UNITS, type SupplyItem } from './inventoryView.js';

interface Supplier {
  id: string;
  name: string;
  nit: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
  notes: string | null;
  is_active: number;
  balance: number;
}

interface Purchase {
  id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_nit: string | null;
  invoice_number: string;
  cufe: string | null;
  issue_date: string;
  due_date: string | null;
  subtotal: number;
  tax_total: number;
  total: number;
  paid: number;
  balance: number;
  notes: string | null;
  source: 'manual' | 'xml';
  status: 'registrada' | 'anulada';
  void_reason: string | null;
  created_by_name: string | null;
}

interface PurchaseDetail extends Purchase {
  lines: Array<{ id: string; supply_name: string | null; supply_unit: string | null; description: string; supplier_code: string | null; quantity: number; conversion_factor: number; line_total: number; tax_amount: number }>;
  payments: Array<{ id: string; amount: number; method: string; payment_date: string; reference: string | null; status: 'activo' | 'anulado'; void_reason: string | null; created_by_name: string | null }>;
}

const SUPPLIER_PAYMENT_METHODS: Array<[string, string]> = [
  ['transferencia', 'Transferencia'], ['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['cheque', 'Cheque'],
  ['nequi', 'Nequi'], ['daviplata', 'Daviplata'], ['otro', 'Otro'],
];
const methodLabel = (method: string) => SUPPLIER_PAYMENT_METHODS.find(([value]) => value === method)?.[1] ?? method;

const TABS = [
  { id: 'facturas', label: 'Compras', iconName: 'receipt', permissions: ['compras.ver'] },
  { id: 'por-pagar', label: 'Cuentas por pagar', iconName: 'hand-coins', permissions: ['compras.ver'] },
  { id: 'proveedores', label: 'Proveedores', iconName: 'truck', permissions: ['compras.ver', 'compras.gestionar'] },
];

const filters = { from: '', to: '' };

export async function renderPurchasesView(container: HTMLElement, params: string[] = []): Promise<void> {
  const allowedTabs = TABS.filter((tab) => can(...tab.permissions));
  const activeTab = allowedTabs.find((tab) => tab.id === params[0]) ?? allowedTabs[0];
  if (!activeTab) return;
  setContent(
    container,
    html`<div class="tabs tabs-scroll" role="tablist">${allowedTabs.map(
      (tab) => html`<a class="tab ${tab.id === activeTab.id ? 'is-active' : ''}" role="tab" href="#/compras/${tab.id}">${icon(tab.iconName)} ${tab.label}</a>`,
    )}</div><div data-tab-content>${loadingState()}</div>`,
  );
  refreshIcons(container);
  const content = $('[data-tab-content]', container);
  const reload = () => renderPurchasesView(container, [activeTab.id]);
  if (activeTab.id === 'facturas') return renderInvoicesTab(content, reload);
  if (activeTab.id === 'por-pagar') return renderPayablesTab(content, reload);
  return renderSuppliersTab(content, reload);
}

// ─── Compras ────────────────────────────────────────────────────────────────

async function renderInvoicesTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const today = todayLocal(clinicOffset());
  filters.to ||= today;
  filters.from ||= addDays(today, -30);
  const purchases = await api.get<Purchase[]>('/api/purchases', { from: filters.from, to: filters.to });
  const active = purchases.filter((purchase) => purchase.status === 'registrada');
  const total = active.reduce((sum, purchase) => sum + purchase.total, 0);

  setContent(
    content,
    html`<section class="card">
      <div class="card-header">
        <div class="agenda-toolbar">
          <label class="muted">Desde <input class="input" type="date" name="from" value="${filters.from}" style="width:auto" /></label>
          <label class="muted">Hasta <input class="input" type="date" name="to" value="${filters.to}" style="width:auto" /></label>
          <span class="subtle">${active.length} facturas · <strong class="money">${formatMoney(total)}</strong></span>
        </div>
        <div class="button-row">
          ${purchases.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${can('compras.gestionar') ? html`<button class="button button-primary" data-action="new">${icon('plus')} Registrar compra</button>` : ''}
        </div>
      </div>
      ${purchases.length === 0
        ? emptyState('receipt', 'Sin compras en estas fechas', 'Registra las facturas de tus proveedores; puedes importar el XML de la factura electrónica.')
        : purchaseTable(purchases, false)}
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
    if (action === 'new') void openPurchaseModal(reload);
    if (action === 'export') void exportPurchases(purchases, `compras-${filters.from}-a-${filters.to}`);
    const detailId = target.closest<HTMLElement>('[data-purchase]')?.dataset.purchase;
    if (detailId) void openPurchaseDetail(detailId, reload);
  };
}

function dueBadge(purchase: Purchase): SafeHtml {
  if (purchase.status === 'anulada') return html`<span class="badge badge-neutral">Anulada</span>`;
  if (purchase.balance <= 0) return html`<span class="badge badge-success">Pagada</span>`;
  if (!purchase.due_date) return html`<span class="badge badge-warning">Pendiente</span>`;
  const today = todayLocal(clinicOffset());
  const days = Math.round((Date.parse(purchase.due_date) - Date.parse(today)) / 86_400_000);
  if (days < 0) return html`<span class="badge badge-danger">Vencida hace ${-days} d</span>`;
  if (days <= 7) return html`<span class="badge badge-warning">Vence en ${days} d</span>`;
  return html`<span class="badge badge-info">Vence ${formatShortDate(purchase.due_date)}</span>`;
}

function purchaseTable(purchases: Purchase[], showDue: boolean): SafeHtml {
  return html`<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th>${showDue ? html`<th>Vence</th>` : ''}<th class="align-right">Total</th><th class="align-right">Pagado</th><th class="align-right">Saldo</th><th>Estado</th><th></th></tr></thead>
    <tbody>${purchases.map((purchase) => html`<tr class="${purchase.status === 'anulada' ? 'is-muted' : ''}">
      <td>${formatShortDate(purchase.issue_date)}</td>
      <td><strong>${purchase.supplier_name}</strong>${purchase.supplier_nit ? html`<br /><small class="subtle">NIT ${purchase.supplier_nit}</small>` : ''}</td>
      <td><code>${purchase.invoice_number}</code> ${purchase.source === 'xml' ? html`<span class="hint" data-tooltip="Importada del XML de la factura electrónica">${icon('file-up')}</span>` : ''}</td>
      ${showDue ? html`<td>${purchase.due_date ? formatShortDate(purchase.due_date) : '—'}</td>` : ''}
      <td class="align-right money">${formatMoney(purchase.total)}</td>
      <td class="align-right money">${formatMoney(purchase.paid)}</td>
      <td class="align-right money"><strong>${formatMoney(purchase.balance)}</strong></td>
      <td>${dueBadge(purchase)}</td>
      <td class="align-right"><button class="icon-button" data-purchase="${purchase.id}" aria-label="Ver detalle" data-tooltip="Ver detalle">${icon('eye')}</button></td>
    </tr>`)}</tbody></table></div>`;
}

async function exportPurchases(purchases: Purchase[], fileName: string): Promise<void> {
  await downloadExcel(fileName, 'Compras', purchases, [
    { header: 'Fecha', width: 12, value: (row) => row.issue_date },
    { header: 'Proveedor', width: 32, value: (row) => row.supplier_name },
    { header: 'NIT', width: 14, value: (row) => row.supplier_nit },
    { header: 'Factura', width: 16, value: (row) => row.invoice_number },
    { header: 'Vence', width: 12, value: (row) => row.due_date },
    { header: 'Subtotal', width: 14, value: (row) => row.subtotal, isMoney: true },
    { header: 'IVA', width: 12, value: (row) => row.tax_total, isMoney: true },
    { header: 'Total', width: 14, value: (row) => row.total, isMoney: true },
    { header: 'Pagado', width: 14, value: (row) => row.paid, isMoney: true },
    { header: 'Saldo', width: 14, value: (row) => row.balance, isMoney: true },
    { header: 'Estado', width: 12, value: (row) => row.status },
    { header: 'CUFE', width: 40, value: (row) => row.cufe },
  ]);
}

// ─── Cuentas por pagar ──────────────────────────────────────────────────────

async function renderPayablesTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const purchases = await api.get<Purchase[]>('/api/purchases', { pending: '1' });
  const today = todayLocal(clinicOffset());
  const totalDue = purchases.reduce((sum, purchase) => sum + purchase.balance, 0);
  const overdue = purchases.filter((purchase) => purchase.due_date && purchase.due_date < today);
  const nextWeek = purchases.filter((purchase) => purchase.due_date && purchase.due_date >= today && purchase.due_date <= addDays(today, 7));
  const sum = (rows: Purchase[]) => rows.reduce((total, row) => total + row.balance, 0);

  setContent(
    content,
    html`<section class="card">
      <div class="card-padded"><div class="kpi-grid">
        <div class="card kpi"><span class="kpi-icon">${icon('hand-coins')}</span><div><div class="kpi-value money">${formatMoney(totalDue)}</div><div class="kpi-label">Total por pagar · ${purchases.length} facturas</div></div></div>
        <div class="card kpi"><span class="kpi-icon is-danger">${icon('triangle-alert')}</span><div><div class="kpi-value money">${formatMoney(sum(overdue))}</div><div class="kpi-label">Vencido · ${overdue.length}</div></div></div>
        <div class="card kpi"><span class="kpi-icon is-info">${icon('calendar-clock')}</span><div><div class="kpi-value money">${formatMoney(sum(nextWeek))}</div><div class="kpi-label">Vence en 7 días · ${nextWeek.length}</div></div></div>
      </div></div>
      <div class="card-header"><h3>${icon('hand-coins')} Facturas con saldo</h3>
        ${purchases.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}</div>
      ${purchases.length === 0 ? emptyState('circle-check-big', 'Estás al día', 'No hay facturas de proveedores pendientes de pago.') : purchaseTable(purchases, true)}
    </section>`,
  );
  refreshIcons(content);
  content.onchange = null;
  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="export"]')) void exportPurchases(purchases, `cuentas-por-pagar-${today}`);
    const detailId = target.closest<HTMLElement>('[data-purchase]')?.dataset.purchase;
    if (detailId) void openPurchaseDetail(detailId, reload);
  };
}

// ─── Proveedores ────────────────────────────────────────────────────────────

async function renderSuppliersTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const suppliers = await api.get<Supplier[]>('/api/suppliers');
  const canManage = can('compras.gestionar');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('truck')} Proveedores</h3>
        ${canManage ? html`<button class="button button-primary" data-action="new">${icon('plus')} Nuevo proveedor</button>` : ''}</div>
      ${suppliers.length === 0
        ? emptyState('truck', 'Sin proveedores', 'Crea tus proveedores o impórtalos automáticamente al cargar el XML de una factura.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Proveedor</th><th>NIT</th><th>Contacto</th><th>Teléfono</th><th class="align-right">Saldo por pagar</th><th>Estado</th><th></th></tr></thead>
          <tbody>${suppliers.map((supplier) => html`<tr>
            <td><strong>${supplier.name}</strong></td>
            <td>${supplier.nit ?? '—'}</td>
            <td>${supplier.contact_name ?? '—'}${supplier.email ? html`<br /><small class="subtle">${supplier.email}</small>` : ''}</td>
            <td>${supplier.phone ?? '—'}</td>
            <td class="align-right money">${formatMoney(supplier.balance)}</td>
            <td>${supplier.is_active ? html`<span class="badge badge-success">Activo</span>` : html`<span class="badge badge-neutral">Inactivo</span>`}</td>
            <td class="align-right">${canManage ? html`<button class="icon-button" data-edit="${supplier.id}" aria-label="Editar" data-tooltip="Editar">${icon('pencil')}</button>` : ''}</td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);
  content.onchange = null;
  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="new"]')) openSupplierModal(null, reload);
    const editId = target.closest<HTMLElement>('[data-edit]')?.dataset.edit;
    const supplier = suppliers.find((candidate) => candidate.id === editId);
    if (supplier) openSupplierModal(supplier, reload);
  };
}

function openSupplierModal(supplier: Supplier | null, onDone: () => Promise<void>): void {
  openFormModal({
    title: supplier ? 'Editar proveedor' : 'Nuevo proveedor',
    iconName: 'truck',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
      <label class="field full"><span>Razón social</span><input name="name" required maxlength="150" value="${supplier?.name ?? ''}" /></label>
      <label class="field"><span>NIT <span class="hint" data-tooltip="Sin dígito de verificación. Sirve para reconocer al proveedor al importar el XML.">${icon('info')}</span></span><input name="nit" maxlength="20" value="${supplier?.nit ?? ''}" /></label>
      <label class="field"><span>Teléfono</span><input name="phone" maxlength="30" value="${supplier?.phone ?? ''}" /></label>
      <label class="field"><span>Persona de contacto</span><input name="contactName" maxlength="120" value="${supplier?.contact_name ?? ''}" /></label>
      <label class="field"><span>Correo</span><input name="email" type="email" maxlength="200" value="${supplier?.email ?? ''}" /></label>
      <label class="field full"><span>Notas</span><textarea name="notes" maxlength="500" rows="2">${supplier?.notes ?? ''}</textarea></label>
      <label class="checkbox"><input type="checkbox" name="isActive" ${!supplier || supplier.is_active ? 'checked' : ''} /> <span>Activo</span></label>
    </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const payload = {
        name: values.name,
        nit: emptyToNull(values.nit),
        phone: emptyToNull(values.phone),
        email: emptyToNull(values.email),
        contactName: emptyToNull(values.contactName),
        notes: emptyToNull(values.notes),
        isActive: (form.elements.namedItem('isActive') as HTMLInputElement).checked,
      };
      if (supplier) await api.put(`/api/suppliers/${supplier.id}`, payload);
      else await api.post('/api/suppliers', payload);
      toast('Proveedor guardado.', 'success');
      await onDone();
    },
  });
}

// ─── Registrar compra (manual o XML) ────────────────────────────────────────

interface LineState {
  /** '' = gasto (no inventario), 'new' = crear insumo, o id del insumo. */
  supplyChoice: string;
  newUnit: string;
  description: string;
  supplierCode: string | null;
  quantity: number;
  conversionFactor: number;
  lineTotal: number;
  taxAmount: number;
}

const emptyLine = (): LineState => ({ supplyChoice: '', newUnit: 'unidad', description: '', supplierCode: null, quantity: 1, conversionFactor: 1, lineTotal: 0, taxAmount: 0 });

async function openPurchaseModal(onDone: () => Promise<void>): Promise<void> {
  const [suppliers, supplies] = await Promise.all([api.get<Supplier[]>('/api/suppliers'), api.get<SupplyItem[]>('/api/supplies')]);
  const activeSuppliers = suppliers.filter((supplier) => supplier.is_active);
  const lines: LineState[] = [emptyLine()];
  let imported: ParsedInvoice | null = null;
  let newSupplierFromXml: { name: string; nit: string | null } | null = null;
  const today = todayLocal(clinicOffset());

  const modal = openFormModal({
    title: 'Registrar compra',
    iconName: 'receipt',
    size: 'wide',
    submitLabel: 'Registrar compra',
    fields: html`<div class="import-box">
        <label class="button button-secondary">${icon('file-up')} Importar XML de la factura electrónica
          <input type="file" accept=".xml,text/xml,application/xml" data-xml-file hidden /></label>
        <span class="subtle">Usa el XML que llega al correo junto al PDF. Se lee en tu navegador; no se sube el archivo.</span>
      </div>
      <p class="form-hint" data-import-status hidden></p>
      <div class="form-grid">
        <label class="field full"><span>Proveedor</span>
          <select name="supplierId" required data-supplier>
            <option value="">Selecciona…</option>
            ${activeSuppliers.map((supplier) => html`<option value="${supplier.id}">${supplier.name}${supplier.nit ? ` · NIT ${supplier.nit}` : ''}</option>`)}
          </select></label>
        <label class="field"><span>N.º de factura</span><input name="invoiceNumber" required maxlength="40" /></label>
        <label class="field"><span>Fecha de la factura</span><input name="issueDate" type="date" required value="${today}" max="${today}" /></label>
        <label class="field"><span>Vence <span class="hint" data-tooltip="Déjalo vacío si se pagó de contado.">${icon('info')}</span></span><input name="dueDate" type="date" /></label>
        <label class="field"><span>Notas</span><input name="notes" maxlength="500" /></label>
      </div>
      <div class="table-wrapper"><table class="data-table purchase-lines">
        <thead><tr><th>Insumo <span class="hint" data-tooltip="Si es insumo, entra al inventario. Si no (ej. mantenimiento), queda como gasto.">${icon('info')}</span></th><th>Descripción</th><th>Cant.</th>
          <th>Unid. x cant. <span class="hint" data-tooltip="Cuántas unidades de inventario trae cada unidad comprada. Ej.: 1 caja de 100 guantes = 100.">${icon('info')}</span></th>
          <th>Valor sin IVA</th><th>IVA</th><th></th></tr></thead>
        <tbody data-lines></tbody>
      </table></div>
      <div class="button-row" style="justify-content: space-between; margin-top: 8px">
        <button type="button" class="button button-ghost button-small" data-add-line>${icon('plus')} Agregar línea</button>
        <div data-totals class="purchase-totals"></div>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const supplierId = values.supplierId && values.supplierId !== 'xml' ? values.supplierId : null;
      if (!supplierId && !newSupplierFromXml) throw new Error('Selecciona el proveedor.');
      const payload = {
        supplierId,
        newSupplier: supplierId ? null : newSupplierFromXml,
        invoiceNumber: values.invoiceNumber,
        cufe: imported?.cufe ?? null,
        issueDate: values.issueDate,
        dueDate: emptyToNull(values.dueDate),
        notes: emptyToNull(values.notes),
        source: imported ? 'xml' : 'manual',
        lines: lines.map((line, index) => {
          if (!line.description.trim()) throw new Error(`Falta la descripción en la línea ${index + 1}.`);
          return {
            supplyId: line.supplyChoice && line.supplyChoice !== 'new' ? line.supplyChoice : null,
            newSupply: line.supplyChoice === 'new' ? { name: line.description.trim().slice(0, 150), unit: line.newUnit } : null,
            description: line.description.trim(),
            supplierCode: line.supplierCode,
            quantity: line.quantity,
            conversionFactor: line.conversionFactor,
            lineTotal: line.lineTotal,
            taxAmount: line.taxAmount,
          };
        }),
      };
      await api.post('/api/purchases', payload);
      toast('Compra registrada. El inventario quedó actualizado.', 'success');
      await onDone();
    },
  });

  const form = modal.body.querySelector('form') as HTMLFormElement;
  const linesBody = $('[data-lines]', form);
  const totalsElement = $('[data-totals]', form);
  const statusElement = $('[data-import-status]', form);
  const supplierSelect = $('[data-supplier]', form) as HTMLSelectElement;

  const supplyOptions = (selected: string) => html`
    <option value="" ${selected === '' ? 'selected' : ''}>— Gasto (no es inventario) —</option>
    <option value="new" ${selected === 'new' ? 'selected' : ''}>＋ Crear insumo con esta descripción</option>
    ${supplies.map((supply) => html`<option value="${supply.id}" ${selected === supply.id ? 'selected' : ''}>${supply.name} (${supply.unit})</option>`)}`;

  const drawTotals = () => {
    const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);
    const tax = lines.reduce((total, line) => total + line.taxAmount, 0);
    const differs = imported && imported.payableAmount > 0 && imported.payableAmount !== subtotal + tax;
    setContent(
      totalsElement,
      html`<span>Subtotal <strong class="money">${formatMoney(subtotal)}</strong></span>
        <span>IVA <strong class="money">${formatMoney(tax)}</strong></span>
        <span>Total <strong class="money">${formatMoney(subtotal + tax)}</strong></span>
        ${differs ? html`<small class="subtle" data-tooltip="Diferencia normal por retenciones, descuentos o cargos globales de la factura.">${icon('info')} A pagar según factura: ${formatMoney(imported?.payableAmount ?? 0)}</small>` : ''}`,
    );
    refreshIcons(totalsElement);
  };

  const drawLines = () => {
    setContent(
      linesBody,
      html`${lines.map((line, index) => {
        const supply = supplies.find((candidate) => candidate.id === line.supplyChoice);
        const unitLabel = supply ? supply.unit : line.supplyChoice === 'new' ? line.newUnit : '';
        return html`<tr data-index="${index}">
          <td><select class="input" data-field="supplyChoice">${supplyOptions(line.supplyChoice)}</select>
            ${line.supplyChoice === 'new' ? html`<select class="input" data-field="newUnit" aria-label="Unidad">${SUPPLY_UNITS.map((unit) => html`<option ${unit === line.newUnit ? 'selected' : ''}>${unit}</option>`)}</select>` : ''}</td>
          <td><input class="input" data-field="description" maxlength="300" value="${line.description}" />${line.supplierCode ? html`<small class="subtle">Cód. ${line.supplierCode}</small>` : ''}</td>
          <td><input class="input input-number" type="number" min="0.001" step="any" data-field="quantity" value="${line.quantity}" /></td>
          <td>${line.supplyChoice ? html`<input class="input input-number" type="number" min="0.001" step="any" data-field="conversionFactor" value="${line.conversionFactor}" /><small class="subtle" data-unit="${unitLabel}">= ${formatQuantity(line.quantity * line.conversionFactor)} ${unitLabel}</small>` : html`<span class="subtle">—</span>`}</td>
          <td><input class="input input-number" type="number" min="0" step="1" data-field="lineTotal" value="${line.lineTotal}" /></td>
          <td><input class="input input-number" type="number" min="0" step="1" data-field="taxAmount" value="${line.taxAmount}" /></td>
          <td>${lines.length > 1 ? html`<button type="button" class="icon-button" data-remove-line aria-label="Quitar línea">${icon('trash-2')}</button>` : ''}</td>
        </tr>`;
      })}`,
    );
    refreshIcons(linesBody);
    drawTotals();
  };

  linesBody.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const index = Number(input.closest<HTMLElement>('[data-index]')?.dataset.index);
    const line = lines[index];
    const field = input.dataset.field as keyof LineState | undefined;
    if (!line || !field) return;
    if (field === 'description' || field === 'supplyChoice' || field === 'newUnit') {
      (line as unknown as Record<string, string>)[field] = input.value;
    } else {
      (line as unknown as Record<string, number>)[field] = Number(input.value) || 0;
    }
    if (field === 'supplyChoice' || field === 'newUnit' || field === 'quantity' || field === 'conversionFactor') {
      if (field === 'supplyChoice' || field === 'newUnit') drawLines();
      else {
        const hint = input.closest('tr')?.querySelector<HTMLElement>('[data-unit]');
        if (hint) hint.textContent = `= ${formatQuantity(line.quantity * line.conversionFactor)} ${hint.dataset.unit ?? ''}`;
        drawTotals();
      }
    } else {
      drawTotals();
    }
  });
  linesBody.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-remove-line]');
    if (!button) return;
    lines.splice(Number(button.closest<HTMLElement>('[data-index]')?.dataset.index), 1);
    drawLines();
  });
  $('[data-add-line]', form).addEventListener('click', () => {
    lines.push(emptyLine());
    drawLines();
  });

  // Importación del XML.
  ($('[data-xml-file]', form) as HTMLInputElement).addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new InvoiceXmlError('El archivo es demasiado grande (máximo 5 MB).');
      const parsed = parseDianInvoice(await file.text(), (xml) => new DOMParser().parseFromString(xml, 'application/xml'));
      imported = parsed;
      const normalizedNit = (parsed.supplier.nit ?? '').split('-')[0]?.replace(/\D/g, '') ?? '';
      const supplier = activeSuppliers.find((candidate) => candidate.nit && candidate.nit === normalizedNit);
      let links: Array<{ supplier_code: string; supply_id: string; conversion_factor: number }> = [];
      if (supplier) {
        supplierSelect.value = supplier.id;
        newSupplierFromXml = null;
        links = await api.get('/api/suppliers/' + supplier.id + '/item-links');
      } else {
        newSupplierFromXml = { name: parsed.supplier.name, nit: parsed.supplier.nit };
        supplierSelect.querySelector('option[value="xml"]')?.remove();
        supplierSelect.insertAdjacentHTML('beforeend', '<option value="xml"></option>');
        const option = supplierSelect.querySelector('option[value="xml"]') as HTMLOptionElement;
        option.textContent = `＋ Nuevo: ${parsed.supplier.name}${parsed.supplier.nit ? ` · NIT ${parsed.supplier.nit}` : ''}`;
        supplierSelect.value = 'xml';
      }
      (form.elements.namedItem('invoiceNumber') as HTMLInputElement).value = parsed.invoiceNumber;
      (form.elements.namedItem('issueDate') as HTMLInputElement).value = parsed.issueDate;
      (form.elements.namedItem('dueDate') as HTMLInputElement).value = parsed.dueDate ?? '';
      lines.splice(
        0,
        lines.length,
        ...parsed.lines.map((line): LineState => {
          const link = line.supplierCode ? links.find((candidate) => candidate.supplier_code === line.supplierCode) : undefined;
          return {
            ...emptyLine(),
            supplyChoice: link?.supply_id ?? '',
            conversionFactor: link?.conversion_factor ?? 1,
            description: line.description,
            supplierCode: line.supplierCode,
            quantity: line.quantity,
            lineTotal: line.lineTotal,
            taxAmount: line.taxAmount,
          };
        }),
      );
      const recognized = lines.filter((line) => line.supplyChoice).length;
      statusElement.hidden = false;
      statusElement.textContent = `✔ Factura ${parsed.invoiceNumber} de ${parsed.supplier.name}: ${parsed.lines.length} líneas` +
        (recognized ? `, ${recognized} reconocidas como insumos.` : '.') +
        ' Revisa en cada línea si es insumo (entra al inventario) o gasto.';
      drawLines();
    } catch (error) {
      statusElement.hidden = false;
      statusElement.textContent = error instanceof InvoiceXmlError ? `✘ ${error.message}` : '✘ No se pudo leer el archivo.';
    }
  });

  drawLines();
}

// ─── Detalle, pagos y anulación ─────────────────────────────────────────────

async function openPurchaseDetail(purchaseId: string, onChange: () => Promise<void>): Promise<void> {
  const purchase = await withErrorToast(() => api.get<PurchaseDetail>(`/api/purchases/${purchaseId}`));
  if (!purchase) return;
  const isActive = purchase.status === 'registrada';
  const modal = openModal({
    title: `Factura ${purchase.invoice_number}`,
    iconName: 'receipt',
    size: 'wide',
    content: html`<div class="detail-grid">
        <div><span class="subtle">Proveedor</span><strong>${purchase.supplier_name}</strong>${purchase.supplier_nit ? html`<small>NIT ${purchase.supplier_nit}</small>` : ''}</div>
        <div><span class="subtle">Fecha</span><strong>${formatShortDate(purchase.issue_date)}</strong>${purchase.due_date ? html`<small>Vence ${formatShortDate(purchase.due_date)}</small>` : html`<small>Contado</small>`}</div>
        <div><span class="subtle">Total</span><strong class="money">${formatMoney(purchase.total)}</strong><small>Saldo ${formatMoney(purchase.balance)}</small></div>
        <div><span class="subtle">Estado</span>${dueBadge(purchase)}${purchase.void_reason ? html`<small>${purchase.void_reason}</small>` : ''}</div>
      </div>
      ${purchase.cufe ? html`<p class="subtle" style="word-break: break-all"><strong>CUFE:</strong> ${purchase.cufe}</p>` : ''}
      <div class="table-wrapper"><table class="data-table">
        <thead><tr><th>Descripción</th><th>Inventario</th><th class="align-right">Cant.</th><th class="align-right">Valor</th><th class="align-right">IVA</th></tr></thead>
        <tbody>${purchase.lines.map((line) => html`<tr>
          <td>${line.description}${line.supplier_code ? html`<br /><small class="subtle">Cód. ${line.supplier_code}</small>` : ''}</td>
          <td>${line.supply_name ? html`${line.supply_name}<br /><small class="subtle">+${formatQuantity(line.quantity * line.conversion_factor)} ${line.supply_unit ?? ''}</small>` : html`<span class="badge badge-neutral">Gasto</span>`}</td>
          <td class="align-right">${formatQuantity(line.quantity)}</td>
          <td class="align-right money">${formatMoney(line.line_total)}</td>
          <td class="align-right money">${formatMoney(line.tax_amount)}</td>
        </tr>`)}</tbody></table></div>
      <h4 style="margin-top: 16px">${icon('hand-coins')} Pagos al proveedor</h4>
      ${purchase.payments.length === 0
        ? html`<p class="subtle">Sin pagos registrados.</p>`
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Medio</th><th>Referencia</th><th class="align-right">Valor</th><th>Estado</th><th></th></tr></thead>
          <tbody>${purchase.payments.map((payment) => html`<tr class="${payment.status === 'anulado' ? 'is-muted' : ''}">
            <td>${formatShortDate(payment.payment_date)}</td><td>${methodLabel(payment.method)}</td><td>${payment.reference ?? '—'}</td>
            <td class="align-right money">${formatMoney(payment.amount)}</td>
            <td>${payment.status === 'activo' ? html`<span class="badge badge-success">Activo</span>` : html`<span class="badge badge-neutral" data-tooltip="${payment.void_reason ?? ''}">Anulado</span>`}</td>
            <td class="align-right">${payment.status === 'activo' && can('compras.pagar') ? html`<button class="icon-button" data-void-payment="${payment.id}" aria-label="Anular pago" data-tooltip="Anular pago">${icon('ban')}</button>` : ''}</td>
          </tr>`)}</tbody></table></div>`}
      <div class="modal-actions">
        ${isActive && can('compras.gestionar') ? html`<button class="button button-ghost" data-action="void">${icon('ban')} Anular compra</button>` : ''}
        ${isActive && purchase.balance > 0 && can('compras.pagar') ? html`<button class="button button-primary" data-action="pay">${icon('circle-dollar-sign')} Registrar pago</button>` : ''}
      </div>`,
  });
  refreshIcons(modal.body);

  const refresh = async () => {
    modal.close();
    await onChange();
    await openPurchaseDetail(purchaseId, onChange);
  };

  modal.body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'pay') openSupplierPaymentModal(purchase, refresh);
    if (action === 'void') {
      askReason({
        title: 'Anular compra',
        message: 'Lo que entró al inventario con esta factura se descontará. Esta acción queda en la auditoría.',
        confirmLabel: 'Anular compra',
        onConfirm: async (reason) => {
          await api.post(`/api/purchases/${purchase.id}/void`, { reason });
          toast('Compra anulada.', 'info');
          await refresh();
        },
      });
    }
    const paymentId = target.closest<HTMLElement>('[data-void-payment]')?.dataset.voidPayment;
    if (paymentId) {
      askReason({
        title: 'Anular pago al proveedor',
        message: 'El valor vuelve a quedar como saldo por pagar.',
        confirmLabel: 'Anular pago',
        onConfirm: async (reason) => {
          await api.post(`/api/supplier-payments/${paymentId}/void`, { reason });
          toast('Pago anulado.', 'info');
          await refresh();
        },
      });
    }
  });
}

function openSupplierPaymentModal(purchase: Purchase, onDone: () => Promise<void>): void {
  openFormModal({
    title: `Pago a ${purchase.supplier_name}`,
    iconName: 'circle-dollar-sign',
    submitLabel: 'Registrar pago',
    fields: html`<p class="muted">Factura <strong>${purchase.invoice_number}</strong> · Saldo <strong class="money">${formatMoney(purchase.balance)}</strong></p>
      <div class="form-grid">
        <label class="field"><span>Valor</span><input name="amount" type="number" min="1" max="${purchase.balance}" step="1" required value="${purchase.balance}" /></label>
        <label class="field"><span>Fecha del pago</span><input name="paymentDate" type="date" required value="${todayLocal(clinicOffset())}" /></label>
        <label class="field"><span>Medio</span><select name="method">${SUPPLIER_PAYMENT_METHODS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></label>
        <label class="field"><span>Referencia</span><input name="reference" maxlength="80" placeholder="N.º de transferencia…" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      await api.post(`/api/purchases/${purchase.id}/payments`, {
        amount: Number(values.amount),
        paymentDate: values.paymentDate,
        method: values.method,
        reference: emptyToNull(values.reference),
      });
      toast('Pago registrado.', 'success');
      await onDone();
    },
  });
}
