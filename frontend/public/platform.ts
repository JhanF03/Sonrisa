/**
 * Panel del dueño del software (/plataforma).
 *
 * • Ingreso con la clave de plataforma → sesión segura de 8 horas (cookie
 *   HttpOnly; la clave nunca se guarda en el navegador).
 * • Resumen: consultorios reales, demos, ingresos recurrentes, vencidos.
 * • Consultorios reales: estado de pago, registrar pagos, editar plan y
 *   fechas, suspender / dar cortesía, restablecer la clave del administrador.
 * • Demos: listado y creación en segundos (modo vitrina).
 * • Configuración: datos de cobro, Wompi del dueño y valores por defecto.
 */
import { api, ApiError } from '../core/api.js';
import { $, emptyToNull, html, readForm, safeUrl, setContent, type SafeHtml } from '../core/dom.js';
import { downloadExcel } from '../core/excel.js';
import { formatMoney, formatShortDate, formatUtcAsLocal } from '../core/format.js';
import { askReason, copyToClipboard, emptyState, icon, loadingState, openFormModal, openModal, refreshIcons, themeToggleButton, toast, withErrorToast } from '../core/ui.js';
import { addDaysToDate, SUBSCRIPTION_LABELS, type SubscriptionStatus } from '../../src/shared/subscription.js';

interface TenantOverview {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  isShowcase: boolean;
  createdAt: string;
  adminEmail: string | null;
  users: number;
  patients: number;
  appointmentsLast30: number;
  lastLoginAt: string | null;
  monthlyPrice: number;
  graceDays: number;
  billingMode: 'auto' | 'exento' | 'suspendido';
  ownerNotes: string | null;
  subscription: SubscriptionStatus;
  lastPaymentAt: string | null;
}

interface Summary {
  realClinics: number;
  demos: number;
  active: number;
  dueSoon: number;
  inGrace: number;
  suspended: number;
  monthlyRecurring: number;
  collectedThisMonth: number;
}

interface PlatformSettings {
  ownerName: string;
  ownerWhatsapp: string;
  paymentInstructions: string;
  defaultMonthlyPrice: number;
  defaultGraceDays: number;
  defaultTrialDays: number;
  wompiEnvironment: 'sandbox' | 'production' | null;
  wompiPublicKey: string;
  maskedIntegritySecret: string | null;
  maskedEventsSecret: string | null;
  wompiConfigured: boolean;
  webhookUrl: string;
  defaults: { trialUntil: string; monthlyPrice: number; graceDays: number };
}

interface PaymentRow {
  id: string;
  amount: number;
  months: number;
  new_paid_until: string;
  method: string;
  reference: string | null;
  status: 'aprobado' | 'anulado';
  notes: string | null;
  void_reason: string | null;
  created_at: string;
}

const OFFSET = -300;
const TABS = [
  { id: 'resumen', label: 'Resumen', iconName: 'layout-dashboard' },
  { id: 'reales', label: 'Consultorios', iconName: 'building-2' },
  { id: 'demos', label: 'Demos', iconName: 'sparkles' },
  { id: 'crear', label: 'Crear', iconName: 'plus' },
  { id: 'configuracion', label: 'Configuración', iconName: 'settings' },
  { id: 'auditoria', label: 'Auditoría', iconName: 'scroll-text' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const PAYMENT_METHODS: Array<[string, string]> = [
  ['transferencia', 'Transferencia'], ['nequi', 'Nequi'], ['daviplata', 'Daviplata'], ['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['otro', 'Otro'],
];

let activeTab: TabId = 'resumen';
let searchText = '';

function badgeFor(status: SubscriptionStatus): SafeHtml {
  const tone = { exento: 'badge-neutral', al_dia: 'badge-success', por_vencer: 'badge-warning', en_gracia: 'badge-danger', suspendido: 'badge-danger' }[status.state];
  return html`<span class="badge ${tone}">${SUBSCRIPTION_LABELS[status.state]}</span>`;
}

const header = (authenticated: boolean) => html`<header class="public-header">
  <div class="brand"><span class="brand-mark">${icon('layout-dashboard')}</span><div><div class="brand-name">Panel del dueño</div><div class="brand-product">Agenda Sonrisa · Plataforma</div></div></div>
  <div class="button-row">${themeToggleButton()}${authenticated ? html`<button class="button button-ghost button-small" data-action="logout">${icon('log-out')} Salir</button>` : ''}</div>
</header>`;

export async function renderPlatformPage(root: HTMLElement): Promise<void> {
  document.title = 'Plataforma · Agenda Sonrisa';
  setContent(root, html`<main class="public-page platform-page">${loadingState()}</main>`);
  const { authenticated } = await api.get<{ authenticated: boolean }>('/api/platform/session').catch(() => ({ authenticated: false }));
  if (!authenticated) return renderLogin(root);
  return renderPanel(root);
}

// ─── Ingreso ────────────────────────────────────────────────────────────────

function renderLogin(root: HTMLElement): void {
  setContent(
    root,
    html`<main class="public-page platform-page">${header(false)}
      <section class="card card-padded" style="max-width: 460px; margin: 24px auto; display: grid; gap: 12px">
        <h1 style="margin: 0; font-size: 1.3rem">${icon('key-round')} Ingresar a la plataforma</h1>
        <p class="muted">Usa tu clave de plataforma (<code>PLATFORM_ADMIN_KEY</code>). La sesión dura 8 horas y la clave no se guarda en el navegador.</p>
        <form class="form" novalidate>
          <label class="field"><span>Clave de plataforma</span><input name="key" type="password" required autocomplete="current-password" autofocus /></label>
          <p class="form-error" role="alert" hidden></p>
          <button class="button button-primary" type="submit">${icon('log-in')} Ingresar</button>
        </form>
        <p class="subtle">¿Perdiste la clave? Genera una nueva y guárdala con <code>npx wrangler secret put PLATFORM_ADMIN_KEY</code>.</p>
      </section>
    </main>`,
  );
  refreshIcons(root);
  const form = root.querySelector('form') as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    try {
      await api.post('/api/platform/login', { key: readForm(form).key });
      await renderPanel(root);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo ingresar.';
      errorElement.hidden = false;
    }
  });
}

// ─── Panel ──────────────────────────────────────────────────────────────────

async function renderPanel(root: HTMLElement): Promise<void> {
  setContent(
    root,
    html`<main class="public-page platform-page">${header(true)}
      <nav class="tabs tabs-scroll" role="tablist">${TABS.map(
        (tab) => html`<button type="button" class="tab ${tab.id === activeTab ? 'is-active' : ''}" role="tab" data-tab="${tab.id}">${icon(tab.iconName)} ${tab.label}</button>`,
      )}</nav>
      <div data-content>${loadingState()}</div>
    </main>`,
  );
  refreshIcons(root);
  const content = $('[data-content]', root);
  const reload = () => renderPanel(root);

  root.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset.tab as TabId | undefined;
    if (tab) {
      activeTab = tab;
      await reload();
    }
    if (target.closest('[data-action="logout"]')) {
      await api.post('/api/platform/logout');
      renderLogin(root);
    }
  };

  try {
    if (activeTab === 'resumen') await renderSummaryTab(content);
    else if (activeTab === 'reales') await renderClinicsTab(content, reload, false);
    else if (activeTab === 'demos') await renderClinicsTab(content, reload, true);
    else if (activeTab === 'crear') await renderCreateTab(content);
    else if (activeTab === 'configuracion') await renderSettingsTab(content, reload);
    else await renderAuditTab(content);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return renderLogin(root);
    setContent(content, html`<div class="card card-padded form-error">${error instanceof Error ? error.message : 'No se pudo cargar.'}</div>`);
  }
}

async function renderSummaryTab(content: HTMLElement): Promise<void> {
  const [summary, tenants] = await Promise.all([api.get<Summary>('/api/platform/summary'), api.get<TenantOverview[]>('/api/platform/tenants')]);
  const attention = tenants
    .filter((tenant) => !tenant.isShowcase && ['por_vencer', 'en_gracia', 'suspendido'].includes(tenant.subscription.state))
    .sort((a, b) => (a.subscription.paidUntil ?? '').localeCompare(b.subscription.paidUntil ?? ''));
  const kpi = (iconName: string, value: SafeHtml | string, label: string, tone = '') =>
    html`<div class="card kpi"><span class="kpi-icon ${tone}">${icon(iconName)}</span><div><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div></div>`;

  setContent(
    content,
    html`<section class="card card-padded"><div class="kpi-grid">
        ${kpi('building-2', String(summary.realClinics), `Consultorios reales · ${summary.active} activos`)}
        ${kpi('sparkles', String(summary.demos), 'Demos creadas', 'is-info')}
        ${kpi('trending-up', html`<span class="money">${formatMoney(summary.monthlyRecurring)}</span>`, 'Ingreso mensual recurrente', 'is-info')}
        ${kpi('wallet', html`<span class="money">${formatMoney(summary.collectedThisMonth)}</span>`, 'Recaudado este mes')}
        ${kpi('calendar-clock', String(summary.dueSoon), 'Vencen en 5 días o menos', summary.dueSoon ? 'is-danger' : 'is-info')}
        ${kpi('lock', String(summary.suspended + summary.inGrace), `Vencidos · ${summary.suspended} suspendidos`, summary.suspended ? 'is-danger' : 'is-info')}
      </div></section>
      <section class="card" style="margin-top: 16px">
        <div class="card-header"><h3>${icon('triangle-alert')} Requieren atención</h3></div>
        ${attention.length === 0
          ? emptyState('circle-check-big', 'Todo al día', 'Ningún consultorio está por vencer ni vencido.')
          : clinicsTable(attention, false)}
      </section>`,
  );
  refreshIcons(content);
  attachClinicActions(content, attention, () => renderSummaryTab(content));
}

function clinicsTable(tenants: TenantOverview[], isDemo: boolean): SafeHtml {
  return html`<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Consultorio</th>${isDemo ? '' : html`<th>Estado</th><th>Pagado hasta</th><th class="align-right">Plan</th>`}<th class="align-right">Pacientes</th><th class="align-right">Citas 30 d</th><th>Último ingreso</th><th></th></tr></thead>
    <tbody>${tenants.map((tenant) => html`<tr>
      <td><strong>${tenant.name}</strong><br /><small class="subtle">${tenant.adminEmail ?? 'sin administrador'}${tenant.city ? ` · ${tenant.city}` : ''} · creado ${formatShortDate(tenant.createdAt.slice(0, 10))}</small>
        ${tenant.ownerNotes ? html`<br /><small class="subtle">${icon('info')} ${tenant.ownerNotes}</small>` : ''}</td>
      ${isDemo
        ? ''
        : html`<td>${badgeFor(tenant.subscription)}${tenant.subscription.state === 'en_gracia' && tenant.subscription.suspendOn ? html`<br /><small class="subtle">Se suspende ${formatShortDate(tenant.subscription.suspendOn)}</small>` : ''}</td>
          <td>${tenant.subscription.paidUntil ? formatShortDate(tenant.subscription.paidUntil) : '—'}</td>
          <td class="align-right money">${tenant.monthlyPrice ? formatMoney(tenant.monthlyPrice) : '—'}</td>`}
      <td class="align-right">${tenant.patients}</td>
      <td class="align-right">${tenant.appointmentsLast30}</td>
      <td>${tenant.lastLoginAt ? formatUtcAsLocal(tenant.lastLoginAt, OFFSET) : html`<span class="subtle">Nunca</span>`}</td>
      <td class="align-right"><div class="button-row" style="justify-content: flex-end; flex-wrap: nowrap">
        ${isDemo ? '' : html`<button class="button button-primary button-small" data-pay="${tenant.id}">${icon('circle-dollar-sign')} Pago</button>
          <button class="icon-button" data-plan="${tenant.id}" aria-label="Plan y fechas" data-tooltip="Plan, fechas y suspensión">${icon('pencil')}</button>
          <button class="icon-button" data-history="${tenant.id}" aria-label="Historial" data-tooltip="Historial de pagos">${icon('receipt')}</button>`}
        <button class="icon-button" data-reset="${tenant.id}" aria-label="Restablecer clave" data-tooltip="Restablecer la clave del administrador">${icon('key-round')}</button>
        <a class="icon-button" href="/c/${tenant.slug}" target="_blank" rel="noopener" aria-label="Página de reservas" data-tooltip="Página de reservas">${icon('external-link')}</a>
      </div></td>
    </tr>`)}</tbody></table></div>`;
}

async function renderClinicsTab(content: HTMLElement, reload: () => Promise<void>, demos: boolean): Promise<void> {
  const all = await api.get<TenantOverview[]>('/api/platform/tenants');
  const tenants = all.filter((tenant) => tenant.isShowcase === demos);
  const draw = () => {
    const query = searchText.trim().toLowerCase();
    const visible = query ? tenants.filter((tenant) => `${tenant.name} ${tenant.adminEmail ?? ''} ${tenant.city ?? ''}`.toLowerCase().includes(query)) : tenants;
    setContent(
      content,
      html`<section class="card">
        <div class="card-header">
          <div class="search-input" style="max-width: 320px">${icon('search')}<input type="search" data-search placeholder="Buscar por nombre, correo o ciudad" value="${searchText}" /></div>
          <div class="button-row">
            ${visible.length ? html`<button class="button button-secondary" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
            <button class="button button-primary" data-action="create">${icon('plus')} ${demos ? 'Nueva demo' : 'Nuevo consultorio'}</button>
          </div>
        </div>
        ${visible.length === 0
          ? emptyState(demos ? 'sparkles' : 'building-2', demos ? 'Sin demos' : 'Sin consultorios reales', demos ? 'Crea una demo con el nombre del consultorio que vas a visitar.' : 'Cuando un cliente compre, créale su consultorio real.')
          : clinicsTable(visible, demos)}
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
        { header: 'Plan mensual', width: 14, value: (row) => row.monthlyPrice, isMoney: true },
        { header: 'Pacientes', width: 10, value: (row) => row.patients },
        { header: 'Citas 30 días', width: 12, value: (row) => row.appointmentsLast30 },
        { header: 'Último ingreso', width: 18, value: (row) => (row.lastLoginAt ? formatUtcAsLocal(row.lastLoginAt, OFFSET) : '') },
        { header: 'Creado', width: 12, value: (row) => row.createdAt.slice(0, 10) },
      ]),
    );
    content.querySelector('[data-action="create"]')?.addEventListener('click', () => {
      activeTab = 'crear';
      document.querySelector<HTMLElement>('[data-tab="crear"]')?.click();
    });
    attachClinicActions(content, visible, reload);
  };
  draw();
}

function attachClinicActions(content: HTMLElement, tenants: TenantOverview[], reload: () => Promise<void>): void {
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
  openFormModal({
    title: `Plan y acceso · ${tenant.name}`,
    iconName: 'pencil',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
        <label class="field"><span>Valor mensual (COP)</span><input name="monthlyPrice" type="number" min="0" step="1" value="${tenant.monthlyPrice}" required /></label>
        <label class="field"><span>Días de gracia <span class="hint" data-tooltip="Días después del vencimiento en que aún puede entrar (con aviso).">${icon('info')}</span></span><input name="graceDays" type="number" min="0" max="60" value="${tenant.graceDays}" required /></label>
        <label class="field"><span>Pagado hasta <span class="hint" data-tooltip="Último día cubierto. Corrígelo solo si es necesario: lo normal es registrar pagos.">${icon('info')}</span></span><input name="paidUntil" type="date" value="${tenant.subscription.paidUntil ?? ''}" /></label>
        <label class="field"><span>Modo de cobro</span><select name="billingMode">
          <option value="auto" ${tenant.billingMode === 'auto' ? 'selected' : ''}>Automático (se suspende si no paga)</option>
          <option value="exento" ${tenant.billingMode === 'exento' ? 'selected' : ''}>Cortesía (sin cobro)</option>
          <option value="suspendido" ${tenant.billingMode === 'suspendido' ? 'selected' : ''}>Suspendido manualmente</option>
        </select></label>
        <label class="field full"><span>Notas internas</span><textarea name="ownerNotes" rows="2" maxlength="1000">${tenant.ownerNotes ?? ''}</textarea></label>
      </div>
      <p class="subtle">Los cambios aplican de inmediato. Un pago registrado reactiva también a un consultorio suspendido manualmente.</p>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      await api.put(`/api/platform/tenants/${tenant.id}/subscription`, {
        monthlyPrice: Number(values.monthlyPrice),
        graceDays: Number(values.graceDays),
        paidUntil: emptyToNull(values.paidUntil),
        billingMode: values.billingMode,
        ownerNotes: emptyToNull(values.ownerNotes),
      });
      toast('Plan actualizado.', 'success');
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
          <td>${formatUtcAsLocal(payment.created_at, OFFSET)}</td><td>${payment.months}</td><td>${formatShortDate(payment.new_paid_until)}</td>
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

// ─── Crear ──────────────────────────────────────────────────────────────────

async function renderCreateTab(content: HTMLElement): Promise<void> {
  const settings = await api.get<PlatformSettings>('/api/platform/settings');
  setContent(
    content,
    html`<section class="card card-padded">
      <form class="form" novalidate>
        <div class="option-list">
          <label class="checkbox"><input type="radio" name="kind" value="demo" checked /> <span><strong>Demo</strong> para un prospecto: con datos de ejemplo, sin cobro.</span></label>
          <label class="checkbox"><input type="radio" name="kind" value="real" /> <span><strong>Consultorio real</strong> para un cliente que compró: vacío, con suscripción.</span></label>
        </div>
        <div class="form-grid">
          <label class="field full"><span>Nombre del consultorio</span><input name="clinicName" required maxlength="120" placeholder="Clínica Dental Sonrisas del Norte" /></label>
          <label class="field"><span>Ciudad</span><input name="city" maxlength="80" /></label>
          <label class="field"><span>Teléfono</span><input name="phone" maxlength="30" /></label>
          <label class="field"><span>${icon('palette')} Color</span><input name="brandColor" type="color" value="#3f6f68" /></label>
          <label class="field"><span>Logo (URL https)</span><input name="logoUrl" type="url" placeholder="https://…" /></label>
        </div>
        <div class="form-grid" data-real-fields hidden>
          <label class="field"><span>Nombre del administrador</span><input name="adminFullName" maxlength="120" /></label>
          <label class="field"><span>Correo del administrador</span><input name="adminEmail" type="email" maxlength="200" /></label>
          <label class="field full"><span>Contraseña inicial <span class="hint" data-tooltip="Mínimo 10 caracteres con letras y números. Pídele que la cambie al entrar.">${icon('info')}</span></span><input name="adminPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          <label class="field"><span>Valor mensual (COP)</span><input name="monthlyPrice" type="number" min="0" step="1" value="${settings.defaults.monthlyPrice}" /></label>
          <label class="field"><span>Días de gracia</span><input name="graceDays" type="number" min="0" max="60" value="${settings.defaults.graceDays}" /></label>
          <label class="field"><span>Acceso pagado / prueba hasta</span><input name="paidUntil" type="date" value="${settings.defaults.trialUntil}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('sparkles')} Crear</button>
      </form>
    </section>
    <div data-result></div>`,
  );
  refreshIcons(content);
  const form = content.querySelector('form') as HTMLFormElement;
  const resultElement = $('[data-result]', content);
  const errorElement = $('.form-error', form);
  form.addEventListener('change', () => {
    $('[data-real-fields]', form).hidden = readForm(form).kind !== 'real';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const values = readForm(form);
    const isReal = values.kind === 'real';
    const body = {
      clinicName: values.clinicName,
      city: emptyToNull(values.city),
      phone: emptyToNull(values.phone),
      brandColor: values.brandColor,
      logoUrl: emptyToNull(values.logoUrl),
      ...(isReal
        ? {
            adminFullName: values.adminFullName,
            adminEmail: values.adminEmail,
            adminPassword: values.adminPassword,
            monthlyPrice: Number(values.monthlyPrice || 0),
            graceDays: Number(values.graceDays || 0),
            paidUntil: values.paidUntil || addDaysToDate(new Date().toISOString().slice(0, 10), 15),
          }
        : {}),
    };
    try {
      const result = await api.post<{ bookingUrl: string; panelUrl: string; login?: { email: string; password: string }; paidUntil?: string }>(
        isReal ? '/api/platform/clinics' : '/api/platform/showcase',
        body,
      );
      setContent(
        resultElement,
        html`<section class="card card-padded" style="margin-top: 16px; display: grid; gap: 10px">
          <h2>${icon('circle-check-big')} ${isReal ? 'Consultorio creado' : 'Demo lista'}</h2>
          <p><strong>Página de reservas:</strong> <a href="${safeUrl(result.bookingUrl)}" target="_blank" rel="noopener">${result.bookingUrl}</a></p>
          <p><strong>Panel:</strong> <a href="${safeUrl(result.panelUrl)}" target="_blank" rel="noopener">${result.panelUrl}</a></p>
          ${result.login ? html`<p><strong>Ingreso demo:</strong> ${result.login.email} · <code>${result.login.password}</code> <span class="subtle">(cópialo: no se vuelve a mostrar)</span></p>` : ''}
          ${result.paidUntil ? html`<p><strong>Acceso hasta:</strong> ${formatShortDate(result.paidUntil)} (luego aplica el cobro mensual).</p>` : ''}
          <div class="button-row"><button class="button button-secondary" data-copy>${icon('copy')} Copiar datos</button></div>
        </section>`,
      );
      refreshIcons(resultElement);
      resultElement.querySelector('[data-copy]')?.addEventListener('click', () =>
        copyToClipboard(
          `Reservas: ${result.bookingUrl}\nPanel: ${result.panelUrl}${result.login ? `\nUsuario: ${result.login.email}\nContraseña: ${result.login.password}` : ''}`,
          'Datos copiados.',
        ),
      );
      form.reset();
      $('[data-real-fields]', form).hidden = true;
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo crear.';
      errorElement.hidden = false;
    }
  });
}

// ─── Configuración ──────────────────────────────────────────────────────────

async function renderSettingsTab(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const settings = await api.get<PlatformSettings>('/api/platform/settings');
  setContent(
    content,
    html`<section class="card card-padded">
      <form class="form" novalidate>
        <h3>${icon('wallet')} Cómo te pagan tus clientes</h3>
        <p class="subtle">Esto lo ve el consultorio cuando su suscripción está por vencer o suspendida.</p>
        <div class="form-grid">
          <label class="field"><span>Tu nombre</span><input name="ownerName" maxlength="120" value="${settings.ownerName}" /></label>
          <label class="field"><span>Tu WhatsApp (para comprobantes)</span><input name="ownerWhatsapp" maxlength="30" value="${settings.ownerWhatsapp}" placeholder="300 123 4567" /></label>
          <label class="field full"><span>Instrucciones de pago</span><textarea name="paymentInstructions" rows="4" maxlength="2000" placeholder="Nequi 300 123 4567 a nombre de …&#10;Bancolombia ahorros 123-456789-00">${settings.paymentInstructions}</textarea></label>
        </div>
        <h3>${icon('settings')} Valores por defecto para consultorios nuevos</h3>
        <div class="form-grid">
          <label class="field"><span>Valor mensual (COP)</span><input name="defaultMonthlyPrice" type="number" min="0" step="1" value="${settings.defaultMonthlyPrice}" /></label>
          <label class="field"><span>Días de prueba</span><input name="defaultTrialDays" type="number" min="0" max="365" value="${settings.defaultTrialDays}" /></label>
          <label class="field"><span>Días de gracia</span><input name="defaultGraceDays" type="number" min="0" max="60" value="${settings.defaultGraceDays}" /></label>
        </div>
        <h3>${icon('credit-card')} Pago en línea con tu Wompi <span class="badge ${settings.wompiConfigured ? 'badge-success' : 'badge-neutral'}">${settings.wompiConfigured ? 'Activo' : 'Inactivo'}</span></h3>
        <p class="subtle">Con esto, tus clientes pagan desde el panel y el acceso se reactiva solo. En Wompi → Desarrolladores, configura la URL de eventos:<br /><code>${settings.webhookUrl}</code></p>
        <div class="form-grid">
          <label class="field"><span>Ambiente</span><select name="wompiEnvironment">
            <option value="" ${!settings.wompiEnvironment ? 'selected' : ''}>Desactivado</option>
            <option value="sandbox" ${settings.wompiEnvironment === 'sandbox' ? 'selected' : ''}>Pruebas (sandbox)</option>
            <option value="production" ${settings.wompiEnvironment === 'production' ? 'selected' : ''}>Producción</option></select></label>
          <label class="field"><span>Llave pública</span><input name="wompiPublicKey" maxlength="300" value="${settings.wompiPublicKey}" autocomplete="off" /></label>
          <label class="field"><span>Secreto de integridad</span><input name="wompiIntegritySecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedIntegritySecret ? `Guardado (${settings.maskedIntegritySecret})` : ''}" /></label>
          <label class="field"><span>Secreto de eventos</span><input name="wompiEventsSecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedEventsSecret ? `Guardado (${settings.maskedEventsSecret})` : ''}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <div class="button-row">
          <button class="button button-primary" type="submit">${icon('check')} Guardar</button>
          ${settings.wompiConfigured ? html`<button class="button button-secondary" type="button" data-action="test-wompi">${icon('plug-zap')} Probar Wompi</button>` : ''}
        </div>
      </form>
    </section>`,
  );
  refreshIcons(content);
  const form = content.querySelector('form') as HTMLFormElement;
  content.onclick = async (event) => {
    if (!(event.target as HTMLElement).closest('[data-action="test-wompi"]')) return;
    const result = await withErrorToast(() => api.post<{ message: string }>('/api/platform/settings/test-wompi'));
    if (result) toast(result.message, 'success');
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    const values = readForm(form);
    try {
      await api.put('/api/platform/settings', {
        ownerName: emptyToNull(values.ownerName),
        ownerWhatsapp: emptyToNull(values.ownerWhatsapp),
        paymentInstructions: emptyToNull(values.paymentInstructions),
        defaultMonthlyPrice: Number(values.defaultMonthlyPrice || 0),
        defaultTrialDays: Number(values.defaultTrialDays || 0),
        defaultGraceDays: Number(values.defaultGraceDays || 0),
        wompiEnvironment: values.wompiEnvironment || null,
        wompiPublicKey: emptyToNull(values.wompiPublicKey),
        wompiIntegritySecret: emptyToNull(values.wompiIntegritySecret),
        wompiEventsSecret: emptyToNull(values.wompiEventsSecret),
      });
      toast('Configuración guardada.', 'success');
      await reload();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    }
  });
}

// ─── Auditoría ──────────────────────────────────────────────────────────────

const AUDIT_LABELS: Record<string, string> = {
  ingreso_plataforma: 'Ingreso a la plataforma',
  configuracion_plataforma: 'Configuración actualizada',
  consultorio_creado: 'Consultorio real creado',
  demo_creada: 'Demo creada',
  suscripcion_editada: 'Plan / acceso editado',
  pago_suscripcion: 'Pago registrado',
  pago_suscripcion_anulado: 'Pago anulado',
  clave_admin_restablecida: 'Clave de administrador restablecida',
};

async function renderAuditTab(content: HTMLElement): Promise<void> {
  const rows = await api.get<Array<{ id: string; action: string; tenant_name: string | null; details: string | null; ip: string | null; created_at: string }>>('/api/platform/audit');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('scroll-text')} Lo que se hizo en la plataforma</h3></div>
      ${rows.length === 0
        ? emptyState('scroll-text', 'Sin registros', 'Aquí quedan los ingresos, pagos y cambios de la plataforma.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Acción</th><th>Consultorio</th><th>IP</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr><td>${formatUtcAsLocal(row.created_at, OFFSET)}</td><td>${AUDIT_LABELS[row.action] ?? row.action}</td><td>${row.tenant_name ?? '—'}</td><td><small class="subtle">${row.ip ?? 'automático'}</small></td></tr>`)}</tbody>
        </table></div>`}
    </section>`,
  );
  refreshIcons(content);
}
