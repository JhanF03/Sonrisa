/**
 * Consultorios reales y demos: estado de pago, plan, uso y acciones (pago,
 * plan, historial, clave). Demos: interesado, vencimiento, extender y eliminar.
 */
import { api } from '../../core/api.js';
import { emptyToNull, html, readForm, safeUrl, setContent, type SafeHtml } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { formatMoney, formatShortDate, formatUtcAsLocal, whatsappLink } from '../../core/format.js';
import { priceSummary } from '../../core/planCards.js';
import { askReason, copyToClipboard, emptyState, icon, openFormModal, openModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { SUBSCRIPTION_LABELS, type SubscriptionStatus } from '../../../src/shared/subscription.js';
import { ALL_PLAN_MODULES, PLAN_MODULES, resolvePlan, type PlanCatalog, type PlanSelection } from '../../../src/shared/plans.js';
import { OFFSET, PAYMENT_METHODS, type PaymentRow, type TenantOverview } from '../types.js';

export function badgeFor(status: SubscriptionStatus, onTrial = false): SafeHtml {
  const tone = { exento: 'badge-neutral', al_dia: 'badge-success', por_vencer: 'badge-warning', en_gracia: 'badge-danger', suspendido: 'badge-danger', demo_vencida: 'badge-neutral' }[status.state];
  return html`<span class="badge ${tone}">${SUBSCRIPTION_LABELS[status.state]}</span>${onTrial && !status.blocked ? html` <span class="badge badge-info" data-tooltip="Aún no ha hecho su primer pago">Prueba</span>` : ''}`;
}

let searchText = '';
let planNames: Record<string, string> = {};

const SOURCE_LABELS: Record<TenantOverview['signupSource'], string> = { dueno: 'Creada por ti', registro: 'Se registró solo', autoservicio: 'Autoservicio' };

function expiryMarkup(tenant: TenantOverview): SafeHtml {
  if (!tenant.demoExpiresAt) return html`<span class="badge badge-neutral" data-tooltip="No vence: bórrala cuando ya no la necesites">Permanente</span>`;
  const hours = (Date.parse(tenant.demoExpiresAt) - Date.now()) / 3_600_000;
  if (hours <= 0) return html`<span class="badge badge-neutral">Vencida · se borra pronto</span>`;
  const label = hours < 24 ? `${Math.max(1, Math.round(hours))} h` : `${Math.ceil(hours / 24)} días`;
  return html`<span class="badge ${hours < 24 ? 'badge-warning' : 'badge-info'}" data-tooltip="Se borra sola el ${formatUtcAsLocal(tenant.demoExpiresAt, OFFSET)}">Vence en ${label}</span>`;
}

function demosTable(tenants: TenantOverview[], all: TenantOverview[]): SafeHtml {
  return html`<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Demo</th><th>Interesado <span class="hint" data-tooltip="Datos que dejó quien creó la demo desde /registro">${icon('info')}</span></th><th>Vence</th><th class="align-right">Citas 30 d</th><th>Último ingreso</th><th></th></tr></thead>
    <tbody>${tenants.map((tenant) => {
      const converted = tenant.convertedTenantId ? all.find((row) => row.id === tenant.convertedTenantId) : null;
      const whatsapp = tenant.contact.phone ? whatsappLink(tenant.contact.phone, `Hola ${tenant.contact.name ?? ''}, te escribo de Agenda Sonrisa por la demo que creaste. ¿Te ayudo a configurar tu consultorio?`) : null;
      return html`<tr>
      <td><strong>${tenant.name}</strong><br /><small class="subtle">${SOURCE_LABELS[tenant.signupSource]} · creada ${formatShortDate(tenant.createdAt.slice(0, 10))}</small>
        ${converted ? html`<br /><span class="badge badge-success" data-tooltip="Creó su consultorio real desde esta demo">${icon('circle-check-big')} Ya es cliente: ${converted.name}</span>` : ''}</td>
      <td>${tenant.contact.name || tenant.contact.email
        ? html`${tenant.contact.name ?? ''}<br /><small class="subtle">${tenant.contact.email ?? ''}${tenant.contact.phone ? ` · ${tenant.contact.phone}` : ''}</small>`
        : html`<span class="subtle">—</span>`}</td>
      <td>${expiryMarkup(tenant)}</td>
      <td class="align-right">${tenant.appointmentsLast30}</td>
      <td>${tenant.lastLoginAt ? formatUtcAsLocal(tenant.lastLoginAt, OFFSET) : html`<span class="subtle">Nunca</span>`}</td>
      <td class="align-right"><div class="button-row" style="justify-content: flex-end; flex-wrap: nowrap">
        <button class="button button-primary button-small" data-open-demo="${tenant.id}" data-tooltip="Entra al panel de administración de la demo (agenda, caja, inventario…) como su administrador">${icon('layout-dashboard')} Abrir panel</button>
        ${whatsapp ? html`<a class="icon-button" href="${safeUrl(whatsapp, ['https:'])}" target="_blank" rel="noopener" aria-label="WhatsApp" data-tooltip="Escribirle por WhatsApp al interesado">${icon('message-circle')}</a>` : ''}
        <button class="icon-button" data-expiry="${tenant.id}" aria-label="Vencimiento" data-tooltip="Extender o cambiar el vencimiento">${icon('calendar-clock')}</button>
        <a class="icon-button" href="/c/${tenant.slug}" target="_blank" rel="noopener" aria-label="Página de reservas" data-tooltip="Página de reservas de los pacientes">${icon('calendar-plus')}</a>
        <button class="icon-button" data-delete-demo="${tenant.id}" aria-label="Eliminar demo" data-tooltip="Eliminar la demo y sus datos ficticios">${icon('trash-2')}</button>
      </div></td>
    </tr>`;
    })}</tbody></table></div>`;
}

export function clinicsTable(tenants: TenantOverview[], isDemo: boolean, all: TenantOverview[] = tenants): SafeHtml {
  if (isDemo) return demosTable(tenants, all);
  return html`<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Consultorio</th><th>Estado</th><th>Plan</th><th>Pagado hasta</th><th class="align-right">Valor mes</th><th class="align-right">Pacientes</th><th>Último ingreso</th><th></th></tr></thead>
    <tbody>${tenants.map((tenant) => html`<tr>
      <td><strong>${tenant.name}</strong><br /><small class="subtle">${tenant.adminEmail ?? 'sin administrador'}${tenant.city ? ` · ${tenant.city}` : ''} · ${tenant.signupSource === 'registro' ? 'se registró solo' : 'creado'} ${formatShortDate(tenant.createdAt.slice(0, 10))}</small>
        ${tenant.ownerNotes ? html`<br /><small class="subtle">${icon('info')} ${tenant.ownerNotes}</small>` : ''}</td>
      <td>${badgeFor(tenant.subscription, tenant.onTrial)}${tenant.subscription.state === 'en_gracia' && tenant.subscription.suspendOn ? html`<br /><small class="subtle">Se suspende ${formatShortDate(tenant.subscription.suspendOn)}</small>` : ''}</td>
      <td><strong>${planNames[tenant.planId] ?? tenant.planId}</strong><br /><small class="subtle" data-tooltip="Profesionales activos / permitidos · usuarios activos / permitidos">${tenant.professionals}/${tenant.maxProfessionals} prof. · ${tenant.users}/${tenant.maxUsers} usu.</small>
        ${tenant.pendingPlan ? html`<br /><span class="badge badge-warning" data-tooltip="Bajada programada">→ ${planNames[tenant.pendingPlan.planId] ?? tenant.pendingPlan.planId} el ${formatShortDate(tenant.pendingPlan.effectiveOn)}</span>` : ''}</td>
      <td>${tenant.subscription.paidUntil ? formatShortDate(tenant.subscription.paidUntil) : '—'}</td>
      <td class="align-right money">${tenant.monthlyPrice ? formatMoney(tenant.monthlyPrice) : '—'}${tenant.customPrice !== null ? html`<br /><small class="subtle" data-tooltip="Precio especial: no cambia aunque edites la lista de precios">especial</small>` : ''}</td>
      <td class="align-right">${tenant.patients}</td>
      <td>${tenant.lastLoginAt ? formatUtcAsLocal(tenant.lastLoginAt, OFFSET) : html`<span class="subtle">Nunca</span>`}</td>
      <td class="align-right"><div class="button-row" style="justify-content: flex-end; flex-wrap: nowrap">
        <button class="button button-primary button-small" data-pay="${tenant.id}">${icon('circle-dollar-sign')} Pago</button>
        <button class="icon-button" data-plan="${tenant.id}" aria-label="Plan y fechas" data-tooltip="Plan, módulos, precio, fechas y suspensión">${icon('pencil')}</button>
        <button class="icon-button" data-history="${tenant.id}" aria-label="Historial" data-tooltip="Historial de pagos">${icon('receipt')}</button>
        <button class="icon-button" data-reset="${tenant.id}" aria-label="Restablecer clave" data-tooltip="Restablecer la clave del administrador">${icon('key-round')}</button>
        <a class="icon-button" href="/c/${tenant.slug}" target="_blank" rel="noopener" aria-label="Página de reservas" data-tooltip="Página de reservas de los pacientes">${icon('calendar-plus')}</a>
      </div></td>
    </tr>`)}</tbody></table></div>`;
}

/** Nombres de los planes para las tablas (se cargan una vez por vista). */
export async function loadPlanNames(): Promise<PlanCatalog> {
  const catalog = await api.get<PlanCatalog>('/api/platform/plans');
  planNames = Object.fromEntries(catalog.plans.map((plan) => [plan.id, plan.name]));
  return catalog;
}

export async function renderClinicsView(content: HTMLElement, reload: () => Promise<void>, demos: boolean): Promise<void> {
  const [all] = await Promise.all([api.get<TenantOverview[]>('/api/platform/tenants'), loadPlanNames()]);
  const tenants = all.filter((tenant) => tenant.isShowcase === demos);
  const draw = () => {
    const query = searchText.trim().toLowerCase();
    const visible = query
      ? tenants.filter((tenant) => `${tenant.name} ${tenant.adminEmail ?? ''} ${tenant.city ?? ''} ${tenant.contact.name ?? ''} ${tenant.contact.email ?? ''}`.toLowerCase().includes(query))
      : tenants;
    setContent(
      content,
      html`<section class="card">
        <div class="card-header">
          <div class="search-input" style="max-width: 320px">${icon('search')}<input type="search" data-search placeholder="Buscar nombre, correo…" value="${searchText}" /></div>
          <div class="button-row">
            ${visible.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
            <button class="button button-primary" data-action="create">${icon('plus')} ${demos ? 'Nueva demo' : 'Nuevo consultorio'}</button>
          </div>
        </div>
        ${visible.length === 0
          ? emptyState(demos ? 'sparkles' : 'building-2', demos ? 'Sin demos' : 'Sin consultorios reales', demos ? 'Crea una demo o comparte /registro para que los interesados creen la suya.' : 'Comparte /registro para que se registren solos, o créales el consultorio aquí.')
          : clinicsTable(visible, demos, all)}
      </section>`,
    );
    refreshIcons(content);
    const searchInput = content.querySelector<HTMLInputElement>('[data-search]');
    searchInput?.addEventListener('input', () => {
      searchText = searchInput.value;
      draw();
      const again = content.querySelector<HTMLInputElement>('[data-search]');
      again?.focus();
      again?.setSelectionRange(searchText.length, searchText.length);
    });
    content.querySelector('[data-action="export"]')?.addEventListener('click', () =>
      void downloadExcel(demos ? 'demos' : 'consultorios', demos ? 'Demos' : 'Consultorios', visible, [
        { header: 'Consultorio', width: 32, value: (row) => row.name },
        { header: 'Administrador', width: 30, value: (row) => row.adminEmail },
        { header: 'Ciudad', width: 16, value: (row) => row.city },
        { header: 'Estado', width: 16, value: (row) => SUBSCRIPTION_LABELS[row.subscription.state] },
        { header: 'Pagado hasta', width: 14, value: (row) => row.subscription.paidUntil },
        { header: 'Plan', width: 14, value: (row) => planNames[row.planId] ?? row.planId },
        { header: 'Valor mensual', width: 14, value: (row) => row.monthlyPrice, isMoney: true },
        { header: 'En prueba', width: 10, value: (row) => (row.onTrial ? 'Sí' : 'No') },
        { header: 'Origen', width: 16, value: (row) => SOURCE_LABELS[row.signupSource] },
        { header: 'Contacto', width: 28, value: (row) => [row.contact.name, row.contact.email, row.contact.phone].filter(Boolean).join(' · ') },
        { header: 'Vence demo', width: 18, value: (row) => (row.demoExpiresAt ? formatUtcAsLocal(row.demoExpiresAt, OFFSET) : '') },
        { header: 'Pacientes', width: 10, value: (row) => row.patients },
        { header: 'Citas 30 días', width: 12, value: (row) => row.appointmentsLast30 },
        { header: 'Último ingreso', width: 18, value: (row) => (row.lastLoginAt ? formatUtcAsLocal(row.lastLoginAt, OFFSET) : '') },
        { header: 'Creado', width: 12, value: (row) => row.createdAt.slice(0, 10) },
      ]),
    );
    content.querySelector('[data-action="create"]')?.addEventListener('click', () => {
      window.location.hash = '#/crear';
    });
    attachClinicActions(content, visible, reload);
  };
  draw();
}

export function attachClinicActions(content: HTMLElement, tenants: TenantOverview[], reload: () => Promise<void>): void {
  content.onclick = (event) => {
    const target = event.target as HTMLElement;
    const find = (attribute: string) => tenants.find((tenant) => tenant.id === target.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute));
    const toPay = find('data-pay');
    if (toPay) openPaymentModal(toPay, reload);
    const toPlan = find('data-plan');
    if (toPlan) openPlanModal(toPlan, reload);
    const toHistory = find('data-history');
    if (toHistory) void openHistoryModal(toHistory, reload);
    const toReset = find('data-reset');
    if (toReset) confirmResetPassword(toReset);
    const toOpen = find('data-open-demo');
    if (toOpen) void openDemoPanel(toOpen);
    const toExpire = find('data-expiry');
    if (toExpire) openExpiryModal(toExpire, reload);
    const toDelete = find('data-delete-demo');
    if (toDelete) confirmDeleteDemo(toDelete, reload);
  };
}

function openPaymentModal(tenant: TenantOverview, onDone: () => Promise<void>): void {
  const modal = openFormModal({
    title: `Registrar pago · ${tenant.name}`,
    iconName: 'circle-dollar-sign',
    submitLabel: 'Registrar pago',
    fields: html`<p class="muted">${tenant.subscription.paidUntil ? html`Pagado hasta <strong>${formatShortDate(tenant.subscription.paidUntil)}</strong>. ` : ''}
        Si está al día, los meses se suman desde esa fecha; si ya venció, desde hoy. El acceso se reactiva al instante.</p>
      <div class="form-grid">
        <label class="field"><span>Meses</span><input name="months" type="number" min="1" max="24" step="1" value="1" required /></label>
        <label class="field"><span>Valor recibido</span><input name="amount" type="number" min="1" step="1" value="${tenant.monthlyPrice || ''}" required /></label>
        <label class="field"><span>Medio</span><select name="method">${PAYMENT_METHODS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select></label>
        <label class="field"><span>Referencia</span><input name="reference" maxlength="80" placeholder="N.º de transacción" /></label>
        <label class="field full"><span>Notas</span><input name="notes" maxlength="300" /></label>
      </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const result = await api.post<TenantOverview>(`/api/platform/tenants/${tenant.id}/payments`, {
        months: Number(values.months),
        amount: Number(values.amount),
        method: values.method,
        reference: emptyToNull(values.reference),
        notes: emptyToNull(values.notes),
      });
      toast(`Pago registrado. Pagado hasta ${result.subscription.paidUntil ? formatShortDate(result.subscription.paidUntil) : ''}.`, 'success');
      await onDone();
    },
  });
  const form = modal.body.querySelector('form') as HTMLFormElement;
  form.addEventListener('input', (event) => {
    if ((event.target as HTMLInputElement).name === 'months' && tenant.monthlyPrice) {
      (form.elements.namedItem('amount') as HTMLInputElement).value = String(tenant.monthlyPrice * Number(readForm(form).months || 1));
    }
  });
}

function openPlanModal(tenant: TenantOverview, onDone: () => Promise<void>): void {
  void withErrorToast(async () => {
    const catalog = await loadPlanNames();
    const selection = tenant.planSelection;
    const modal = openFormModal({
      title: `Plan y acceso · ${tenant.name}`,
      iconName: 'pencil',
      submitLabel: 'Guardar',
      size: 'wide',
      fields: html`<div class="form-grid">
          <label class="field"><span>Plan</span><select name="planId">${catalog.plans.map((plan) => html`<option value="${plan.id}" ${plan.id === selection.planId ? 'selected' : ''}>${plan.name} · ${formatMoney(plan.monthlyPrice)}${plan.isActive ? '' : ' (inactivo)'}</option>`)}</select></label>
          <label class="field"><span>Precio especial (COP/mes) <span class="hint" data-tooltip="Déjalo vacío para usar la lista de precios. Si lo llenas, se cobra ese valor sin importar el plan (negociaciones, clientes antiguos).">${icon('info')}</span></span>
            <input name="customPrice" type="number" min="0" step="1" value="${tenant.customPrice ?? ''}" placeholder="Precio de lista" /></label>
          <label class="field"><span>Profesionales adicionales</span><input name="extraProfessionals" type="number" min="0" max="50" value="${selection.extraProfessionals}" /></label>
          <label class="field"><span>Usuarios adicionales</span><input name="extraUsers" type="number" min="0" max="50" value="${selection.extraUsers}" /></label>
          <div class="field full"><span>Módulos adicionales <span class="hint" data-tooltip="Se suman a los que ya trae el plan. Uno que ya venga en el plan no se cobra.">${icon('info')}</span></span>
            <div class="option-list">${ALL_PLAN_MODULES.map((module) => html`<label class="checkbox"><input type="checkbox" name="addon_${module}" value="1" ${selection.addonModules.includes(module) ? 'checked' : ''} /> <span>${PLAN_MODULES[module].name}</span></label>`)}</div></div>
          <label class="field"><span>Días de gracia <span class="hint" data-tooltip="Días después del vencimiento en que aún puede entrar (con aviso).">${icon('info')}</span></span><input name="graceDays" type="number" min="0" max="60" value="${tenant.graceDays}" required /></label>
          <label class="field"><span>Pagado hasta <span class="hint" data-tooltip="Último día cubierto. Corrígelo solo si es necesario: lo normal es registrar pagos.">${icon('info')}</span></span><input name="paidUntil" type="date" value="${tenant.subscription.paidUntil ?? ''}" /></label>
          <label class="field"><span>Modo de cobro</span><select name="billingMode">
            <option value="auto" ${tenant.billingMode === 'auto' ? 'selected' : ''}>Automático (se suspende si no paga)</option>
            <option value="exento" ${tenant.billingMode === 'exento' ? 'selected' : ''}>Cortesía (sin cobro)</option>
            <option value="suspendido" ${tenant.billingMode === 'suspendido' ? 'selected' : ''}>Suspendido manualmente</option>
          </select></label>
          <label class="field full"><span>Notas internas</span><textarea name="ownerNotes" rows="2" maxlength="1000">${tenant.ownerNotes ?? ''}</textarea></label>
        </div>
        <div data-price-preview></div>
        <p class="subtle">Los cambios aplican de inmediato y sin cobro${tenant.pendingPlan ? ' (y cancelan la bajada programada)' : ''}. Un pago registrado reactiva también a un consultorio suspendido manualmente.</p>`,
      onSubmit: async (form) => {
        const values = readForm(form);
        await api.put(`/api/platform/tenants/${tenant.id}/subscription`, {
          selection: selectionFromForm(values),
          customPrice: values.customPrice === '' || values.customPrice === undefined ? null : Number(values.customPrice),
          graceDays: Number(values.graceDays),
          paidUntil: emptyToNull(values.paidUntil),
          billingMode: values.billingMode,
          ownerNotes: emptyToNull(values.ownerNotes),
        });
        toast('Plan actualizado.', 'success');
        await onDone();
      },
    });
    const form = modal.body.querySelector('form') as HTMLFormElement;
    const preview = () => {
      const values = readForm(form);
      const target = modal.body.querySelector('[data-price-preview]') as HTMLElement;
      try {
        const resolved = resolvePlan(catalog, selectionFromForm(values), { allowInactivePlan: true });
        const custom = values.customPrice ? Number(values.customPrice) : null;
        setContent(target, priceSummary(resolved.lines, resolved.monthlyPrice, custom !== null ? `Se cobrará el precio especial: ${formatMoney(custom)}` : undefined));
      } catch (error) {
        setContent(target, html`<p class="form-error">${error instanceof Error ? error.message : ''}</p>`);
      }
    };
    form.addEventListener('input', preview);
    preview();
  });
}

function selectionFromForm(values: Record<string, string>): PlanSelection {
  return {
    planId: values.planId ?? 'completo',
    addonModules: ALL_PLAN_MODULES.filter((module) => values[`addon_${module}`] === '1'),
    extraProfessionals: Math.max(0, Math.floor(Number(values.extraProfessionals) || 0)),
    extraUsers: Math.max(0, Math.floor(Number(values.extraUsers) || 0)),
  };
}

function openExpiryModal(tenant: TenantOverview, onDone: () => Promise<void>): void {
  openFormModal({
    title: `Vencimiento · ${tenant.name}`,
    iconName: 'calendar-clock',
    submitLabel: 'Guardar',
    fields: html`<p class="muted">${tenant.demoExpiresAt ? html`Hoy vence el <strong>${formatUtcAsLocal(tenant.demoExpiresAt, OFFSET)}</strong>.` : 'Hoy no vence.'} Al vencer, la demo y sus datos ficticios se borran solos.</p>
      <label class="field"><span>Nuevo vencimiento</span><select name="days">
        ${[1, 3, 5, 7, 15, 30].map((days) => html`<option value="${days}" ${days === 5 ? 'selected' : ''}>En ${days} ${days === 1 ? 'día' : 'días'} desde hoy</option>`)}
        <option value="">Sin vencimiento (permanente)</option></select></label>`,
    onSubmit: async (form) => {
      const { days } = readForm(form);
      await api.put(`/api/platform/tenants/${tenant.id}/demo-expiry`, { days: days ? Number(days) : null });
      toast('Vencimiento actualizado.', 'success');
      await onDone();
    },
  });
}

function confirmDeleteDemo(tenant: TenantOverview, onDone: () => Promise<void>): void {
  openFormModal({
    title: 'Eliminar demo',
    iconName: 'trash-2',
    danger: true,
    submitLabel: 'Eliminar',
    fields: html`<p>Se borrará <strong>${tenant.name}</strong> con todos sus datos ficticios y se cerrarán sus sesiones. No se puede deshacer.</p>
      ${tenant.convertedTenantId ? html`<p class="subtle">${icon('info')} El consultorio real que creó desde esta demo no se toca.</p>` : ''}`,
    onSubmit: async () => {
      await api.delete(`/api/platform/tenants/${tenant.id}`);
      toast('Demo eliminada.', 'info');
      await onDone();
    },
  });
}

async function openHistoryModal(tenant: TenantOverview, onDone: () => Promise<void>): Promise<void> {
  const payments = await withErrorToast(() => api.get<PaymentRow[]>(`/api/platform/tenants/${tenant.id}/payments`));
  if (!payments) return;
  const modal = openModal({
    title: `Pagos · ${tenant.name}`,
    iconName: 'receipt',
    size: 'wide',
    content: payments.length === 0
      ? emptyState('receipt', 'Sin pagos', 'Aún no hay pagos registrados para este consultorio.')
      : html`<div class="table-wrapper"><table class="data-table">
        <thead><tr><th>Fecha</th><th>Meses</th><th>Cubre hasta</th><th>Medio</th><th>Referencia</th><th class="align-right">Valor</th><th>Estado</th><th></th></tr></thead>
        <tbody>${payments.map((payment, index) => html`<tr class="${payment.status === 'anulado' ? 'is-muted' : ''}">
          <td>${formatUtcAsLocal(payment.created_at, OFFSET)}</td><td>${payment.kind === 'cambio_plan' ? 'Cambio de plan' : payment.months}</td><td>${formatShortDate(payment.new_paid_until)}</td>
          <td>${payment.method}</td><td>${payment.reference ?? '—'}</td><td class="align-right money">${formatMoney(payment.amount)}</td>
          <td>${payment.status === 'aprobado' ? html`<span class="badge badge-success">Aprobado</span>` : html`<span class="badge badge-neutral" data-tooltip="${payment.void_reason ?? ''}">Anulado</span>`}</td>
          <td>${payment.status === 'aprobado' && index === payments.findIndex((row) => row.status === 'aprobado') ? html`<button class="icon-button" data-void="${payment.id}" aria-label="Anular" data-tooltip="Anular (solo el más reciente)">${icon('ban')}</button>` : ''}</td>
        </tr>`)}</tbody></table></div>`,
  });
  refreshIcons(modal.body);
  modal.body.addEventListener('click', (event) => {
    const paymentId = (event.target as HTMLElement).closest<HTMLElement>('[data-void]')?.dataset.void;
    if (!paymentId) return;
    askReason({
      title: 'Anular pago',
      message: 'La fecha de "pagado hasta" vuelve a la anterior. Si queda vencido, el acceso se suspende según los días de gracia.',
      confirmLabel: 'Anular pago',
      onConfirm: async (reason) => {
        await api.post(`/api/platform/subscription-payments/${paymentId}/void`, { reason });
        toast('Pago anulado.', 'info');
        modal.close();
        await onDone();
      },
    });
  });
}

function confirmResetPassword(tenant: TenantOverview): void {
  openFormModal({
    title: 'Restablecer clave del administrador',
    iconName: 'key-round',
    danger: true,
    submitLabel: 'Generar clave temporal',
    fields: html`<p class="muted">Se generará una contraseña temporal para <strong>${tenant.adminEmail ?? 'el administrador'}</strong> de <strong>${tenant.name}</strong> y se cerrarán sus sesiones abiertas. Entrégasela por un canal seguro y pídele que la cambie en “Clave”.</p>`,
    onSubmit: async () => {
      const result = await api.post<{ email: string; temporaryPassword: string }>(`/api/platform/tenants/${tenant.id}/reset-admin-password`);
      const modal = openModal({
        title: 'Clave temporal generada',
        iconName: 'key-round',
        content: html`<p>Usuario: <strong>${result.email}</strong></p><p>Contraseña temporal: <code>${result.temporaryPassword}</code></p>
          <p class="subtle">No se volverá a mostrar.</p>
          <div class="modal-actions"><button class="button button-primary" data-copy>${icon('copy')} Copiar</button></div>`,
      });
      refreshIcons(modal.body);
      modal.body.querySelector('[data-copy]')?.addEventListener('click', () => copyToClipboard(`Usuario: ${result.email}\nContraseña temporal: ${result.temporaryPassword}`, 'Copiado.'));
    },
  });
}


/**
 * Abre el panel de administración de la demo en otra pestaña, ya con sesión.
 * La pestaña se abre antes de la petición para que el navegador no la bloquee.
 */
async function openDemoPanel(tenant: TenantOverview): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    const result = await api.post<{ panelUrl: string }>(`/api/platform/tenants/${tenant.id}/demo-session`);
    if (tab) tab.location.href = result.panelUrl;
    else window.location.href = result.panelUrl;
  } catch (error) {
    tab?.close();
    toast(error instanceof Error ? error.message : 'No se pudo abrir la demo.', 'error');
  }
}
