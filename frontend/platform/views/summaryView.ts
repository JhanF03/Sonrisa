/**
 * Resumen: ingresos, consultorios activos y los que requieren atención.
 */
import { api } from '../../core/api.js';
import { html, setContent, type SafeHtml } from '../../core/dom.js';
import { formatMoney } from '../../core/format.js';
import { emptyState, icon, refreshIcons } from '../../core/ui.js';
import { type Summary, type TenantOverview } from '../types.js';

import { attachClinicActions, clinicsTable } from './clinicsView.js';

export async function renderSummaryView(content: HTMLElement): Promise<void> {
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
  attachClinicActions(content, attention, () => renderSummaryView(content));
}

