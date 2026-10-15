/**
 * Resumen: ingresos, consultorios activos y los que requieren atención.
 */
import { api } from '../../core/api.js';
import { html, setContent, type SafeHtml } from '../../core/dom.js';
import { formatMoney } from '../../core/format.js';
import { copyToClipboard, emptyState, icon, refreshIcons } from '../../core/ui.js';
import { type Summary, type TenantOverview } from '../types.js';

import { attachClinicActions, clinicsTable, loadPlanNames } from './clinicsView.js';

export async function renderSummaryView(content: HTMLElement): Promise<void> {
  const [summary, tenants] = await Promise.all([api.get<Summary>('/api/platform/summary'), api.get<TenantOverview[]>('/api/platform/tenants'), loadPlanNames()]);
  const signupUrl = `${window.location.origin}/registro`;
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
        ${kpi('gift', String(summary.trials), 'En prueba gratis', 'is-info')}
        ${kpi('rocket', `${summary.selfDemos} · ${summary.conversions}`, 'Demos de autoservicio · registros', 'is-info')}
      </div></section>
      ${ivaMeter(summary)}
      <section class="card card-padded" style="margin-top: 16px">
        <h3>${icon('link')} Tu página de planes y registro <span class="hint" data-tooltip="Compártela en tu web, redes o WhatsApp. Ahí los interesados ven precios, crean su demo o su consultorio con prueba gratis y pagan solos.">${icon('info')}</span></h3>
        <div class="secret-row"><code>${signupUrl}</code>
          <button class="icon-button" data-copy-signup aria-label="Copiar enlace" data-tooltip="Copiar enlace">${icon('copy')}</button>
          <a class="icon-button" href="/registro" target="_blank" rel="noopener" aria-label="Abrir" data-tooltip="Abrir la página">${icon('external-link')}</a></div>
        <p class="subtle">Atajos: <code>/registro?accion=demo</code> abre la demo · <code>/registro?plan=profesional</code> preselecciona un plan.</p>
      </section>
      <section class="card" style="margin-top: 16px">
        <div class="card-header"><h3>${icon('triangle-alert')} Requieren atención</h3></div>
        ${attention.length === 0
          ? emptyState('circle-check-big', 'Todo al día', 'Ningún consultorio está por vencer ni vencido.')
          : clinicsTable(attention, false)}
      </section>`,
  );
  refreshIcons(content);
  attachClinicActions(content, attention, () => renderSummaryView(content));
  content.querySelector('[data-copy-signup]')?.addEventListener('click', () => void copyToClipboard(signupUrl, 'Enlace copiado.'));
}


/**
 * Ingresos del año frente al tope de 3.500 UVT (art. 437 del Estatuto Tributario).
 * Si se supera, desde el periodo siguiente se es responsable de IVA y se debe facturar.
 */
function ivaMeter(summary: Summary): SafeHtml {
  if (summary.taxRegime === 'responsable_iva' || summary.ivaThreshold <= 0) return html``;
  const percent = Math.min(100, Math.round((summary.yearCollected / summary.ivaThreshold) * 100));
  const tone = percent >= 90 ? 'is-danger' : percent >= 80 ? 'is-warning' : '';
  return html`<section class="card card-padded" style="margin-top: 16px; display: grid; gap: 8px">
    <h3>${icon('scale')} Tope para no ser responsable de IVA <span class="hint" data-tooltip="Como persona natural no responsable de IVA, tus ingresos brutos del año deben ser menores a 3.500 UVT. Aquí solo se suma lo cobrado por Agenda Sonrisa: si tienes otros ingresos, súmalos tú. Si lo superas, consulta con un contador: debes inscribirte como responsable de IVA y facturar electrónicamente.">${icon('info')}</span></h3>
    <div class="meter ${tone}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="Ingresos del año frente al tope"><span style="width: ${percent}%"></span></div>
    <p class="subtle">${formatMoney(summary.yearCollected)} cobrados este año de ${formatMoney(summary.ivaThreshold)} (3.500 UVT) · ${percent}%.
      ${percent >= 80 ? html`<strong>Te estás acercando al tope: habla con un contador.</strong>` : ''}</p>
  </section>`;
}
