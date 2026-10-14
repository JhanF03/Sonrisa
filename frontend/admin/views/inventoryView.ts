/**
 * Inventario: insumos con existencias y alertas de mínimo, movimientos
 * (kardex), ajustes y costo de insumos / margen por servicio (recetas).
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { addDays, formatMoney, formatUtcAsLocal, todayLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, refreshIcons, toast } from '../../core/ui.js';
import { can, clinicOffset } from '../session.js';

export const SUPPLY_UNITS = ['unidad', 'caja', 'paquete', 'par', 'ml', 'l', 'g', 'kg', 'cm', 'm', 'rollo', 'tubo', 'frasco', 'carpule', 'jeringa', 'sobre'] as const;

export interface SupplyItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  min_stock: number;
  avg_cost: number;
  is_active: number;
  stock: number;
  stock_value: number;
  is_low: number;
}

interface Movement {
  id: string;
  supply_name: string;
  supply_unit: string;
  kind: 'compra' | 'consumo' | 'ajuste' | 'anulacion_compra';
  quantity: number;
  unit_cost: number;
  reason: string | null;
  invoice_number: string | null;
  patient_name: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface ServiceCost {
  service_id: string;
  code: string;
  name: string;
  price: number;
  supplies_cost: number;
  margin: number;
  margin_percent: number | null;
  recipe_items: number;
}

interface RecipeItem {
  supply_id: string;
  supply_name: string;
  unit: string;
  quantity: number;
  avg_cost: number;
  line_cost: number;
}

const KIND_LABELS: Record<Movement['kind'], [string, string]> = {
  compra: ['Compra', 'badge-success'],
  consumo: ['Consumo', 'badge-info'],
  ajuste: ['Ajuste', 'badge-warning'],
  anulacion_compra: ['Compra anulada', 'badge-neutral'],
};

const quantityFormatter = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 });
export const formatQuantity = (value: number) => quantityFormatter.format(value);
/** Costo unitario: con decimales si es menor a $100 (ej. un guante). */
const formatUnitCost = (value: number) =>
  value > 0 && value < 100 ? `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(value)}` : formatMoney(Math.round(value));

const TABS = [
  { id: 'insumos', label: 'Insumos', iconName: 'package' },
  { id: 'movimientos', label: 'Movimientos', iconName: 'arrow-down-up' },
  { id: 'costos', label: 'Costo por servicio', iconName: 'calculator' },
];

const movementFilters = { from: '', to: '', supplyId: '' };

export async function renderInventoryView(container: HTMLElement, params: string[] = []): Promise<void> {
  const activeTab = TABS.find((tab) => tab.id === params[0]) ?? TABS[0]!;
  setContent(
    container,
    html`<div class="tabs tabs-scroll" role="tablist">${TABS.map(
      (tab) => html`<a class="tab ${tab.id === activeTab.id ? 'is-active' : ''}" role="tab" href="#/inventario/${tab.id}">${icon(tab.iconName)} ${tab.label}</a>`,
    )}</div><div data-tab-content>${loadingState()}</div>`,
  );
  refreshIcons(container);
  const content = $('[data-tab-content]', container);
  const reload = () => renderInventoryView(container, [activeTab.id]);
  content.onchange = null;
  if (activeTab.id === 'movimientos') return renderMovementsTab(content, reload);
  if (activeTab.id === 'costos') return renderCostsTab(content, reload);
  return renderSuppliesTab(content, reload);
}

// ─── Insumos ────────────────────────────────────────────────────────────────

async function renderSuppliesTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const [supplies, summary] = await Promise.all([
    api.get<SupplyItem[]>('/api/supplies', { all: '1' }),
    api.get<{ inventoryValue: number; lowStockCount: number; monthConsumptionCost: number }>('/api/inventory/summary'),
  ]);
  const canManage = can('inventario.gestionar');
  const ordered = [...supplies].sort((a, b) => b.is_low - a.is_low || b.is_active - a.is_active || a.name.localeCompare(b.name));

  setContent(
    content,
    html`<section class="card">
      <div class="card-padded"><div class="kpi-grid">
        <div class="card kpi"><span class="kpi-icon">${icon('boxes')}</span><div><div class="kpi-value money">${formatMoney(summary.inventoryValue)}</div><div class="kpi-label">Valor del inventario</div></div></div>
        <div class="card kpi"><span class="kpi-icon ${summary.lowStockCount ? 'is-danger' : 'is-info'}">${icon('triangle-alert')}</span><div><div class="kpi-value">${summary.lowStockCount}</div><div class="kpi-label">Insumos en o bajo el mínimo</div></div></div>
        <div class="card kpi"><span class="kpi-icon is-info">${icon('stethoscope')}</span><div><div class="kpi-value money">${formatMoney(summary.monthConsumptionCost)}</div><div class="kpi-label">Consumido en citas este mes</div></div></div>
      </div></div>
      <div class="card-header"><h3>${icon('package')} Insumos</h3>
        <div class="button-row">
          ${supplies.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${canManage ? html`<button class="button button-primary" data-action="new">${icon('plus')} Nuevo insumo</button>` : ''}
        </div></div>
      ${supplies.length === 0
        ? emptyState('package', 'Sin insumos', 'Crea tus insumos o regístralos al importar la factura de compra. Luego define cuánto gasta cada servicio.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Código</th><th>Insumo</th><th class="align-right">Existencia</th><th class="align-right">Mínimo</th><th class="align-right">Costo unit.</th><th class="align-right">Valor</th><th>Estado</th><th></th></tr></thead>
          <tbody>${ordered.map((supply) => html`<tr class="${supply.is_active ? '' : 'is-muted'}">
            <td><code>${supply.code}</code></td>
            <td><strong>${supply.name}</strong></td>
            <td class="align-right"><strong>${formatQuantity(supply.stock)}</strong> <small class="subtle">${supply.unit}</small></td>
            <td class="align-right">${formatQuantity(supply.min_stock)}</td>
            <td class="align-right money">${formatUnitCost(supply.avg_cost)}</td>
            <td class="align-right money">${formatMoney(supply.stock_value)}</td>
            <td>${!supply.is_active ? html`<span class="badge badge-neutral">Inactivo</span>`
              : supply.stock < 0 ? html`<span class="badge badge-danger" data-tooltip="Se consumió más de lo registrado. Haz un ajuste con el conteo físico.">Negativo</span>`
              : supply.is_low ? html`<span class="badge badge-danger">Pedir</span>`
              : html`<span class="badge badge-success">OK</span>`}</td>
            <td class="align-right">
              <button class="icon-button" data-movements="${supply.id}" aria-label="Movimientos" data-tooltip="Ver movimientos">${icon('arrow-down-up')}</button>
              ${canManage ? html`<button class="icon-button" data-adjust="${supply.id}" aria-label="Ajustar" data-tooltip="Ajustar existencia (conteo, vencidos, inventario inicial)">${icon('scale')}</button>
                <button class="icon-button" data-edit="${supply.id}" aria-label="Editar" data-tooltip="Editar">${icon('pencil')}</button>` : ''}
            </td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'new') openSupplyModal(null, reload);
    if (action === 'export') {
      void downloadExcel(`inventario-${todayLocal(clinicOffset())}`, 'Inventario', ordered, [
        { header: 'Código', width: 12, value: (row) => row.code },
        { header: 'Insumo', width: 36, value: (row) => row.name },
        { header: 'Unidad', width: 10, value: (row) => row.unit },
        { header: 'Existencia', width: 12, value: (row) => row.stock },
        { header: 'Mínimo', width: 10, value: (row) => row.min_stock },
        { header: 'Costo unitario', width: 14, value: (row) => Math.round(row.avg_cost * 100) / 100 },
        { header: 'Valor', width: 14, value: (row) => row.stock_value, isMoney: true },
        { header: 'Pedir', width: 8, value: (row) => (row.is_low ? 'Sí' : '') },
      ]);
    }
    const find = (attribute: string) => supplies.find((supply) => supply.id === target.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute));
    const toEdit = find('data-edit');
    if (toEdit) openSupplyModal(toEdit, reload);
    const toAdjust = find('data-adjust');
    if (toAdjust) openAdjustModal(toAdjust, reload);
    const toView = find('data-movements');
    if (toView) {
      movementFilters.supplyId = toView.id;
      window.location.hash = '#/inventario/movimientos';
    }
  };
}

function openSupplyModal(supply: SupplyItem | null, onDone: () => Promise<void>): void {
  openFormModal({
    title: supply ? 'Editar insumo' : 'Nuevo insumo',
    iconName: 'package',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
      <label class="field full"><span>Nombre</span><input name="name" required maxlength="150" value="${supply?.name ?? ''}" placeholder="Guantes de nitrilo talla M" /></label>
      <label class="field"><span>Código <span class="hint" data-tooltip="Déjalo vacío para asignar uno automático (INS-0001).">${icon('info')}</span></span><input name="code" maxlength="20" value="${supply?.code ?? ''}" ${supply ? 'required' : ''} /></label>
      <label class="field"><span>Unidad de inventario <span class="hint" data-tooltip="La unidad en que lo gastas. Ej.: guantes por unidad, resina por gramo, anestesia por carpule.">${icon('info')}</span></span>
        <select name="unit">${SUPPLY_UNITS.map((unit) => html`<option ${unit === (supply?.unit ?? 'unidad') ? 'selected' : ''}>${unit}</option>`)}</select></label>
      <label class="field"><span>Existencia mínima <span class="hint" data-tooltip="Al llegar a este nivel aparece como “Pedir”.">${icon('info')}</span></span><input name="minStock" type="number" min="0" step="any" value="${supply?.min_stock ?? 0}" /></label>
      ${supply ? html`<label class="checkbox"><input type="checkbox" name="isActive" ${supply.is_active ? 'checked' : ''} /> <span>Activo</span></label>` : ''}
    </div>
    ${supply ? '' : html`<p class="subtle">Para cargar la existencia actual usa “Ajustar” con el costo unitario (inventario inicial).</p>`}`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const payload = {
        code: emptyToNull(values.code),
        name: values.name,
        unit: values.unit,
        minStock: Number(values.minStock || 0),
        isActive: supply ? (form.elements.namedItem('isActive') as HTMLInputElement).checked : true,
      };
      if (supply) await api.put(`/api/supplies/${supply.id}`, payload);
      else await api.post('/api/supplies', payload);
      toast('Insumo guardado.', 'success');
      await onDone();
    },
  });
}

function openAdjustModal(supply: SupplyItem, onDone: () => Promise<void>): void {
  const modal = openFormModal({
    title: `Ajustar: ${supply.name}`,
    iconName: 'scale',
    submitLabel: 'Guardar ajuste',
    fields: html`<p class="muted">Existencia actual: <strong>${formatQuantity(supply.stock)} ${supply.unit}</strong></p>
      <div class="form-grid">
        <label class="field"><span>Tipo</span><select name="mode">
          <option value="count">Conteo físico (dejar en…)</option>
          <option value="in">Entrada (sumar)</option>
          <option value="out">Salida (restar: vencido, dañado…)</option>
        </select></label>
        <label class="field"><span>Cantidad (${supply.unit})</span><input name="quantity" type="number" min="0" step="any" required /></label>
        <label class="field full" data-cost-field hidden><span>Costo unitario (opcional) <span class="hint" data-tooltip="Para inventario inicial o una entrada sin factura. Actualiza el costo promedio.">${icon('info')}</span></span><input name="unitCost" type="number" min="0" step="any" /></label>
        <label class="field full"><span>Motivo</span><input name="reason" required maxlength="200" placeholder="Conteo mensual, inventario inicial, producto vencido…" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const amount = Number(values.quantity);
      if (!Number.isFinite(amount) || amount < 0) throw new Error('Cantidad inválida.');
      const quantity = values.mode === 'count' ? Math.round((amount - supply.stock) * 1000) / 1000 : values.mode === 'in' ? amount : -amount;
      if (quantity === 0) throw new Error('La existencia ya es esa cantidad; no hay nada que ajustar.');
      const unitCost = quantity > 0 && values.unitCost !== '' ? Number(values.unitCost) : null;
      await api.post(`/api/supplies/${supply.id}/adjust`, { quantity, reason: values.reason, unitCost });
      toast('Ajuste registrado.', 'success');
      await onDone();
    },
  });
  const form = modal.body.querySelector('form') as HTMLFormElement;
  form.addEventListener('input', () => {
    const values = readForm(form);
    const costField = form.querySelector<HTMLElement>('[data-cost-field]');
    const entering = values.mode === 'in' || (values.mode === 'count' && Number(values.quantity) > supply.stock);
    if (costField) costField.hidden = !entering;
  });
}

// ─── Movimientos ────────────────────────────────────────────────────────────

async function renderMovementsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const today = todayLocal(clinicOffset());
  movementFilters.to ||= today;
  movementFilters.from ||= addDays(today, -30);
  const [movements, supplies] = await Promise.all([
    api.get<Movement[]>('/api/stock-movements', { from: movementFilters.from, to: movementFilters.to, supplyId: movementFilters.supplyId || undefined }),
    api.get<SupplyItem[]>('/api/supplies', { all: '1' }),
  ]);
  const offset = clinicOffset();

  setContent(
    content,
    html`<section class="card">
      <div class="card-header">
        <div class="agenda-toolbar">
          <select class="input" name="supplyId" style="width:auto"><option value="">Todos los insumos</option>
            ${supplies.map((supply) => html`<option value="${supply.id}" ${supply.id === movementFilters.supplyId ? 'selected' : ''}>${supply.name}</option>`)}</select>
          <label class="muted">Desde <input class="input" type="date" name="from" value="${movementFilters.from}" style="width:auto" /></label>
          <label class="muted">Hasta <input class="input" type="date" name="to" value="${movementFilters.to}" style="width:auto" /></label>
        </div>
        ${movements.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
      </div>
      ${movements.length === 0
        ? emptyState('arrow-down-up', 'Sin movimientos', 'Aquí verás compras, consumos de citas atendidas y ajustes.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Insumo</th><th>Tipo</th><th class="align-right">Cantidad</th><th class="align-right">Costo unit.</th><th>Detalle</th><th>Usuario</th></tr></thead>
          <tbody>${movements.map((movement) => {
            const [label, badge] = KIND_LABELS[movement.kind];
            return html`<tr>
              <td>${formatUtcAsLocal(movement.created_at, offset)}</td>
              <td>${movement.supply_name}</td>
              <td><span class="badge ${badge}">${label}</span></td>
              <td class="align-right ${movement.quantity < 0 ? 'text-danger' : ''}"><strong>${movement.quantity > 0 ? '+' : ''}${formatQuantity(movement.quantity)}</strong> <small class="subtle">${movement.supply_unit}</small></td>
              <td class="align-right money">${formatUnitCost(movement.unit_cost)}</td>
              <td>${movementDetail(movement)}</td>
              <td>${movement.created_by_name ?? html`<span class="subtle">Automático</span>`}</td>
            </tr>`;
          })}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);

  content.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'from' || input.name === 'to' || input.name === 'supplyId') {
      movementFilters[input.name] = input.value;
      void reload();
    }
  };
  content.onclick = (event) => {
    if (!(event.target as HTMLElement).closest('[data-action="export"]')) return;
    void downloadExcel(`movimientos-${movementFilters.from}-a-${movementFilters.to}`, 'Movimientos', movements, [
      { header: 'Fecha', width: 18, value: (row) => formatUtcAsLocal(row.created_at, offset) },
      { header: 'Insumo', width: 32, value: (row) => row.supply_name },
      { header: 'Tipo', width: 16, value: (row) => KIND_LABELS[row.kind][0] },
      { header: 'Cantidad', width: 12, value: (row) => row.quantity },
      { header: 'Unidad', width: 10, value: (row) => row.supply_unit },
      { header: 'Costo unitario', width: 14, value: (row) => Math.round(row.unit_cost * 100) / 100 },
      { header: 'Detalle', width: 40, value: (row) => row.patient_name ?? row.invoice_number ?? row.reason },
      { header: 'Usuario', width: 22, value: (row) => row.created_by_name },
    ]);
  };
}

function movementDetail(movement: Movement): SafeHtml {
  if (movement.kind === 'consumo') return html`Cita de ${movement.patient_name ?? 'paciente'}`;
  if (movement.invoice_number && movement.kind === 'compra') return html`Factura <code>${movement.invoice_number}</code>`;
  return html`${movement.reason ?? '—'}`;
}

// ─── Costo por servicio ─────────────────────────────────────────────────────

async function renderCostsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const costs = await api.get<ServiceCost[]>('/api/service-costs');
  const canManage = can('inventario.gestionar');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('calculator')} Costo de insumos y margen por servicio</h3></div>
      <p class="subtle card-padded" style="padding-top: 0">Define qué insumos gasta cada servicio (su “receta”). Al marcar una cita como <strong>atendida</strong>, se descuentan del inventario automáticamente.</p>
      ${costs.length === 0
        ? emptyState('stethoscope', 'Sin servicios activos', 'Crea tus servicios en el menú Servicios.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Servicio</th><th class="align-right">Precio</th><th class="align-right">Costo insumos</th><th class="align-right">Margen</th><th>Receta</th><th></th></tr></thead>
          <tbody>${costs.map((cost) => html`<tr>
            <td><code>${cost.code}</code> <strong>${cost.name}</strong></td>
            <td class="align-right money">${formatMoney(cost.price)}</td>
            <td class="align-right money">${cost.recipe_items ? formatMoney(cost.supplies_cost) : html`<span class="subtle">—</span>`}</td>
            <td class="align-right money">${cost.recipe_items
              ? html`<strong>${formatMoney(cost.margin)}</strong> <span class="badge ${cost.margin_percent !== null && cost.margin_percent < 50 ? 'badge-warning' : 'badge-success'}">${cost.margin_percent ?? 0} %</span>`
              : html`<span class="subtle">—</span>`}</td>
            <td>${cost.recipe_items ? html`${cost.recipe_items} insumos` : html`<span class="badge badge-neutral">Sin definir</span>`}</td>
            <td class="align-right"><button class="button button-ghost button-small" data-recipe="${cost.service_id}">${icon(canManage ? 'pencil' : 'eye')} ${canManage ? 'Editar receta' : 'Ver'}</button></td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);
  content.onclick = (event) => {
    const serviceId = (event.target as HTMLElement).closest<HTMLElement>('[data-recipe]')?.dataset.recipe;
    const service = costs.find((cost) => cost.service_id === serviceId);
    if (service) void openRecipeModal(service, canManage, reload);
  };
}

async function openRecipeModal(service: ServiceCost, canManage: boolean, onDone: () => Promise<void>): Promise<void> {
  const [recipe, supplies] = await Promise.all([
    api.get<RecipeItem[]>(`/api/services/${service.service_id}/recipe`),
    api.get<SupplyItem[]>('/api/supplies'),
  ]);
  const rows = recipe.map((item) => ({ supplyId: item.supply_id, quantity: item.quantity }));
  if (rows.length === 0) rows.push({ supplyId: '', quantity: 1 });

  const modal = openFormModal({
    title: `Receta: ${service.name}`,
    iconName: 'calculator',
    size: 'wide',
    submitLabel: canManage ? 'Guardar receta' : 'Cerrar',
    fields: html`<p class="muted">Insumos que se gastan en <strong>una</strong> cita de este servicio.</p>
      <div class="table-wrapper"><table class="data-table"><thead><tr><th>Insumo</th><th>Cantidad</th><th class="align-right">Costo</th><th></th></tr></thead><tbody data-rows></tbody></table></div>
      ${canManage ? html`<button type="button" class="button button-ghost button-small" data-add-row>${icon('plus')} Agregar insumo</button>` : ''}
      <p class="purchase-totals" data-total></p>`,
    onSubmit: async () => {
      if (!canManage) return;
      const items = rows.filter((row) => row.supplyId);
      if (items.some((row) => !(row.quantity > 0))) throw new Error('Las cantidades deben ser mayores a cero.');
      await api.put(`/api/services/${service.service_id}/recipe`, { items });
      toast('Receta guardada.', 'success');
      await onDone();
    },
  });
  const form = modal.body.querySelector('form') as HTMLFormElement;
  const body = $('[data-rows]', form);
  const totalElement = $('[data-total]', form);

  const draw = () => {
    let total = 0;
    setContent(
      body,
      html`${rows.map((row, index) => {
        const supply = supplies.find((candidate) => candidate.id === row.supplyId);
        const cost = supply ? row.quantity * supply.avg_cost : 0;
        total += cost;
        return html`<tr data-index="${index}">
          <td><select class="input" data-field="supplyId" ${canManage ? '' : 'disabled'}><option value="">Selecciona…</option>
            ${supplies.map((candidate) => html`<option value="${candidate.id}" ${candidate.id === row.supplyId ? 'selected' : ''}>${candidate.name} (${candidate.unit})</option>`)}</select></td>
          <td><input class="input input-number" type="number" min="0.001" step="any" data-field="quantity" value="${row.quantity}" ${canManage ? '' : 'disabled'} /> <small class="subtle">${supply?.unit ?? ''}</small></td>
          <td class="align-right money">${formatUnitCost(cost)}</td>
          <td>${canManage ? html`<button type="button" class="icon-button" data-remove aria-label="Quitar">${icon('trash-2')}</button>` : ''}</td>
        </tr>`;
      })}`,
    );
    const margin = service.price - Math.round(total);
    setContent(totalElement, html`<span>Costo de insumos <strong class="money">${formatMoney(Math.round(total))}</strong></span><span>Precio <strong class="money">${formatMoney(service.price)}</strong></span><span>Margen <strong class="money">${formatMoney(margin)}</strong></span>`);
    refreshIcons(body);
  };

  body.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const row = rows[Number(input.closest<HTMLElement>('[data-index]')?.dataset.index)];
    if (!row) return;
    if (input.dataset.field === 'supplyId') row.supplyId = input.value;
    if (input.dataset.field === 'quantity') row.quantity = Number(input.value);
    draw();
  });
  body.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-remove]');
    if (!button) return;
    rows.splice(Number(button.closest<HTMLElement>('[data-index]')?.dataset.index), 1);
    draw();
  });
  form.querySelector('[data-add-row]')?.addEventListener('click', () => {
    rows.push({ supplyId: '', quantity: 1 });
    draw();
  });
  draw();
}
