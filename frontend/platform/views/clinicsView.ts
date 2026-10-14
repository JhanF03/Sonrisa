/**
 * Consultorios reales y demos: estado de pago, uso y acciones (pago, plan, historial, clave).
 */
import { api } from '../../core/api.js';
import { emptyToNull, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { formatMoney, formatShortDate, formatUtcAsLocal } from '../../core/format.js';
import { askReason, copyToClipboard, emptyState, icon, openFormModal, openModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { SUBSCRIPTION_LABELS, type SubscriptionStatus } from '../../../src/shared/subscription.js';
import { OFFSET, PAYMENT_METHODS, type PaymentRow, type TenantOverview } from '../types.js';

export function badgeFor(status: SubscriptionStatus): SafeHtml {
  const tone = { exento: 'badge-neutral', al_dia: 'badge-success', por_vencer: 'badge-warning', en_gracia: 'badge-danger', suspendido: 'badge-danger' }[status.state];
  return html`<span class="badge ${tone}">${SUBSCRIPTION_LABELS[status.state]}</span>`;
}

let searchText = '';

export function clinicsTable(tenants: TenantOverview[], isDemo: boolean): SafeHtml {
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

export async function renderClinicsView(content: HTMLElement, reload: () => Promise<void>, demos: boolean): Promise<void> {
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

