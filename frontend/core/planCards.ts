/**
 * Tarjetas de planes (las usan /registro y "Mi plan" del consultorio).
 * Muestran precio, límites y qué módulos incluye cada plan.
 */
import { html, type SafeHtml } from './dom.js';
import { formatMoney } from './format.js';
import { icon } from './ui.js';
import { ALL_PLAN_MODULES, BASE_FEATURES, PLAN_MODULES, priceForMonths, type PlanDefinition, type PriceLine } from '../../src/shared/plans.js';

export type BillingView = 'mensual' | 'anual';

export function planPriceMarkup(plan: PlanDefinition, billing: BillingView, annualFreeMonths: number): SafeHtml {
  if (billing === 'anual') {
    const yearly = priceForMonths(plan.monthlyPrice, 12, annualFreeMonths);
    return html`<div class="plan-price money">${formatMoney(yearly)} <small>/ año</small></div>
      <small class="subtle">Equivale a ${formatMoney(Math.round(yearly / 12))} al mes${annualFreeMonths ? ` · ${annualFreeMonths} ${annualFreeMonths === 1 ? 'mes gratis' : 'meses gratis'}` : ''}</small>`;
  }
  return html`<div class="plan-price money">${formatMoney(plan.monthlyPrice)} <small>/ mes</small></div>`;
}

export function planCard(
  plan: PlanDefinition,
  options: { billing: BillingView; annualFreeMonths: number; ribbon?: string; selected?: boolean; action: SafeHtml },
): SafeHtml {
  const classes = ['plan-card', options.ribbon ? 'is-featured' : '', options.selected ? 'is-selected' : ''].filter(Boolean).join(' ');
  return html`<article class="${classes}" ${options.ribbon ? html`data-ribbon="${options.ribbon}"` : ''}>
    <div><h3>${plan.name}</h3><p class="subtle">${plan.description}</p></div>
    <div>${planPriceMarkup(plan, options.billing, options.annualFreeMonths)}</div>
    <div class="plan-limits">
      <span data-tooltip="Profesionales con agenda propia">${icon('stethoscope')} ${plan.maxProfessionals} ${plan.maxProfessionals === 1 ? 'profesional' : 'profesionales'}</span>
      <span data-tooltip="Personas que pueden ingresar al panel (recepción, contador…)">${icon('users')} ${plan.maxUsers} usuarios</span>
    </div>
    <ul class="feature-list">
      ${BASE_FEATURES.map((feature) => html`<li>${icon('check')} ${feature}</li>`)}
      ${ALL_PLAN_MODULES.map((module) =>
        plan.modules.includes(module)
          ? html`<li data-tooltip="${PLAN_MODULES[module].description}">${icon('check')} ${PLAN_MODULES[module].name}</li>`
          : html`<li class="is-off" data-tooltip="Disponible como módulo adicional o en un plan mayor">${icon('minus')} ${PLAN_MODULES[module].name}</li>`,
      )}
    </ul>
    ${options.action}
  </article>`;
}

export function priceSummary(lines: PriceLine[], total: number, note?: SafeHtml | string): SafeHtml {
  return html`<div class="price-summary" aria-live="polite">
    ${lines.map((line) => html`<div><span>${line.label}</span><span class="money">${formatMoney(line.amount)}</span></div>`)}
    <div class="total"><span>Total mensual</span><span class="money">${formatMoney(total)}</span></div>
    ${note ? html`<small class="subtle">${note}</small>` : ''}
  </div>`;
}
