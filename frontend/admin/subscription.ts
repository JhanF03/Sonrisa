/**
 * Suscripción del consultorio en la interfaz:
 *  • Pantalla de acceso suspendido con el paso a paso para reactivar.
 *  • Aviso superior cuando está por vencer o vencida (en gracia).
 *  • Vista "Mi plan": plan, módulos, límites, cambio de plan, pago e historial.
 *  • Página de regreso desde Wompi que verifica el pago y reactiva.
 */
import { api } from '../core/api.js';
import { html, safeUrl, setContent, type SafeHtml } from '../core/dom.js';
import { addDays, formatLongDate, formatMoney, formatShortDate, formatUtcAsLocal } from '../core/format.js';
import { planCard, priceSummary } from '../core/planCards.js';
import { emptyState, icon, loadingState, refreshIcons, themeToggleButton, toast, withErrorToast } from '../core/ui.js';
import { SUBSCRIPTION_LABELS, type SubscriptionStatus } from '../../src/shared/subscription.js';
import {
  ALL_PLAN_MODULES, MIN_ONLINE_CHARGE, PLAN_MODULES, prorateUpgrade, resolvePlan, type PlanCatalog, type PlanModule, type PlanSelection,
} from '../../src/shared/plans.js';
import { can, clinicOffset, session } from './session.js';

interface SubscriptionView {
  clinicName: string;
  status: SubscriptionStatus;
  onTrial: boolean;
  monthlyPrice: number;
  renewalPrice: number;
  customPrice: number | null;
  graceDays: number;
  plan: {
    selection: PlanSelection;
    modules: PlanModule[];
    maxProfessionals: number;
    maxUsers: number;
    usage: { professionals: number; users: number };
    pending: (PlanSelection & { monthlyPrice: number; effectiveOn: string }) | null;
  };
  catalog: PlanCatalog;
  paymentInstructions: string;
  ownerName: string;
  ownerWhatsappUrl: string | null;
  onlinePaymentAvailable: boolean;
  paymentOptions: Array<{ months: number; amount: number }>;
  payments: Array<{ id: string; amount: number; months: number; newPaidUntil: string; method: string; reference: string | null; status: string; createdAt: string; kind: string }>;
}

const STATE_TONES: Record<SubscriptionStatus['state'], string> = {
  exento: 'badge-neutral', al_dia: 'badge-success', por_vencer: 'badge-warning', en_gracia: 'badge-danger', suspendido: 'badge-danger', demo_vencida: 'badge-neutral',
};

const stateBadge = (status: SubscriptionStatus, onTrial: boolean) =>
  html`<span class="badge ${STATE_TONES[status.state]}">${onTrial && !status.blocked ? 'Prueba gratis' : SUBSCRIPTION_LABELS[status.state]}</span>`;

/** Aviso en la parte superior del panel (null si no hace falta). */
export function subscriptionBanner(): SafeHtml | null {
  const { subscription } = session();
  const link = can('suscripcion.pagar') ? html` <a href="#/suscripcion">${subscription.onTrial ? 'Elegir plan y pagar →' : 'Ver cómo pagar →'}</a>` : html` Avísale al administrador del consultorio.`;
  if (subscription.state === 'por_vencer' && subscription.paidUntil) {
    return subscription.onTrial
      ? html`<div class="subscription-banner is-warning">${icon('gift')} Tu prueba gratis termina el <strong>${formatLongDate(subscription.paidUntil)}</strong>.${link}</div>`
      : html`<div class="subscription-banner is-warning">${icon('calendar-clock')} Tu suscripción vence el <strong>${formatLongDate(subscription.paidUntil)}</strong>.${link}</div>`;
  }
  if (subscription.state === 'en_gracia' && subscription.suspendOn) {
    return html`<div class="subscription-banner is-danger">${icon('triangle-alert')} ${subscription.onTrial ? 'Tu prueba gratis terminó' : 'Tu suscripción está vencida'}. El acceso se suspenderá el <strong>${formatLongDate(subscription.suspendOn)}</strong> si no se registra el pago.${link}</div>`;
  }
  return null;
}

function payOnlineMarkup(view: SubscriptionView): SafeHtml {
  if (!view.onlinePaymentAvailable || !can('suscripcion.pagar')) return html``;
  const free = view.catalog.annualFreeMonths;
  return html`<div class="plan-options">
    ${view.paymentOptions.map((option) => html`<button type="button" class="plan-option" data-pay-months="${option.months}">
      <strong>${option.months === 1 ? '1 mes' : option.months === 12 ? '1 año' : `${option.months} meses`}</strong>
      <span class="money">${formatMoney(option.amount)}</span>
      ${option.months === 12 && free ? html`<small class="badge badge-success">${free} ${free === 1 ? 'mes gratis' : 'meses gratis'}</small>` : ''}
    </button>`)}
  </div>`;
}

async function goToCheckout(checkoutUrl: string): Promise<void> {
  const url = new URL(checkoutUrl);
  if (url.origin !== 'https://checkout.wompi.co') {
    toast('Enlace de pago inválido.', 'error');
    return;
  }
  window.location.assign(url.toString());
}

async function startOnlinePayment(months: number): Promise<void> {
  const checkout = await withErrorToast(() => api.post<{ checkoutUrl: string }>('/api/subscription/checkout', { months }));
  if (checkout) await goToCheckout(checkout.checkoutUrl);
}

function stepsMarkup(view: SubscriptionView): SafeHtml {
  const canPay = can('suscripcion.pagar');
  return html`<ol class="steps-list">
    ${view.onlinePaymentAvailable && canPay
      ? html`<li><strong>Paga en línea</strong> (tarjeta, PSE, Nequi o Bancolombia): elige cuánto tiempo quieres pagar. El acceso se activa <strong>automáticamente</strong> en cuanto se aprueba el pago.${payOnlineMarkup(view)}</li>`
      : ''}
    ${view.paymentInstructions
      ? html`<li><strong>${view.onlinePaymentAvailable && canPay ? 'O paga por transferencia' : 'Realiza el pago'}</strong>${view.renewalPrice ? html` de <strong class="money">${formatMoney(view.renewalPrice)}</strong> por mes` : ''}:
          <div class="payment-instructions">${view.paymentInstructions}</div></li>`
      : ''}
    ${view.ownerWhatsappUrl
      ? html`<li><strong>Envía el comprobante</strong> por WhatsApp${view.ownerName ? ` a ${view.ownerName}` : ''}.
          <a class="button button-whatsapp button-small" target="_blank" rel="noopener" href="${safeUrl(view.ownerWhatsappUrl, ['https:'])}">${icon('message-circle')} Enviar comprobante</a></li>`
      : ''}
    <li><strong>Vuelve a entrar.</strong> Cuando el pago quede registrado, el acceso se habilita al instante: oprime <em>“Ya pagué, verificar”</em> o recarga la página.</li>
    ${!canPay ? html`<li class="subtle">Tu usuario no puede pagar la suscripción: avísale al administrador del consultorio.</li>` : ''}
  </ol>`;
}

/** Pantalla completa cuando el acceso está suspendido (o la demo terminó). */
export async function renderSuspendedScreen(root: HTMLElement, onRetry: () => Promise<void>, onLogout: () => Promise<void>): Promise<void> {
  const current = session();
  if (current.subscription.state === 'demo_vencida') {
    document.title = 'Demo terminada · Agenda Sonrisa';
    setContent(
      root,
      html`<main class="public-page suspended-page">
        <header class="public-header"><div class="brand"><span class="brand-mark">${icon('sparkles')}</span><div><div class="brand-name">${current.clinic.name}</div><div class="brand-product">Agenda Sonrisa · Demo</div></div></div>${themeToggleButton()}</header>
        <section class="card card-padded suspended-card">
          <div class="suspended-icon">${icon('hourglass')}</div>
          <h1>Tu demo terminó</h1>
          <p class="muted">Gracias por probar Agenda Sonrisa. Los datos de la demo eran ficticios y se borrarán en las próximas horas.</p>
          <p>${current.demo?.convertedTenantId ? 'Ya tienes tu consultorio: entra con tu correo y tu contraseña.' : 'Crea tu consultorio real con la prueba gratis y elige el plan que necesitas.'}</p>
          <div class="button-row" style="justify-content: center; margin-top: 16px">
            ${current.demo?.convertedTenantId ? '' : html`<a class="button button-primary" href="/registro">${icon('rocket')} Crear mi consultorio</a>`}
            <button class="button button-ghost" data-action="logout">${icon('log-out')} Salir</button>
          </div>
        </section>
      </main>`,
    );
    refreshIcons(root);
    root.onclick = async (event) => {
      if ((event.target as HTMLElement).closest('[data-action="logout"]')) await onLogout();
    };
    return;
  }

  setContent(root, html`<main class="public-page">${loadingState()}</main>`);
  const view = await api.get<SubscriptionView>('/api/subscription').catch(() => null);
  const status = view?.status ?? current.subscription;
  const trialEnded = view?.onTrial ?? current.subscription.onTrial;
  document.title = 'Acceso suspendido · Agenda Sonrisa';

  setContent(
    root,
    html`<main class="public-page suspended-page">
      <header class="public-header">
        <div class="brand"><span class="brand-mark">${icon('lock')}</span><div><div class="brand-name">${current.clinic.name}</div><div class="brand-product">Agenda Sonrisa</div></div></div>
        ${themeToggleButton()}
      </header>
      <section class="card card-padded suspended-card">
        <div class="suspended-icon">${icon('lock')}</div>
        <h1>${trialEnded ? 'Terminó tu prueba gratis' : 'Acceso suspendido por falta de pago'}</h1>
        <p class="muted">${trialEnded
          ? html`La prueba de <strong>${current.clinic.name}</strong> terminó${status.paidUntil ? html` el <strong>${formatLongDate(status.paidUntil)}</strong>` : ''}. Paga tu plan para seguir usando el sistema.`
          : html`La suscripción de <strong>${current.clinic.name}</strong> ${status.paidUntil ? html`venció el <strong>${formatLongDate(status.paidUntil)}</strong>` : 'no tiene un pago registrado'} y terminó el periodo de gracia.
            Por eso se revocó el acceso al panel y la página de reservas en línea no recibe citas nuevas.`}</p>
        <p class="reassure">${icon('shield-check')} <span><strong>Tu información está segura.</strong> No se ha borrado nada: pacientes, citas, caja y cartera quedan intactos y vuelven a estar disponibles apenas se registre el pago.</span></p>
        <h2>${icon('list-checks')} Cómo ${trialEnded ? 'activar tu plan' : 'recuperar el acceso'}</h2>
        ${view ? html`${planLine(view)}${stepsMarkup(view)}` : html`<p>Comunícate con tu proveedor de Agenda Sonrisa para conocer el valor y la forma de pago.</p>`}
        <div class="button-row" style="justify-content: center; margin-top: 16px">
          <button class="button button-primary" data-action="retry">${icon('refresh-cw')} Ya pagué, verificar</button>
          <button class="button button-ghost" data-action="logout">${icon('log-out')} Salir</button>
        </div>
      </section>
    </main>`,
  );
  refreshIcons(root);
  root.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const months = target.closest<HTMLElement>('[data-pay-months]')?.dataset.payMonths;
    if (months) await startOnlinePayment(Number(months));
    if (target.closest('[data-action="retry"]')) await onRetry();
    if (target.closest('[data-action="logout"]')) await onLogout();
  };
}

function planLine(view: SubscriptionView): SafeHtml {
  const plan = view.catalog.plans.find((candidate) => candidate.id === (view.plan.pending?.planId ?? view.plan.selection.planId));
  return plan ? html`<p class="muted">Plan <strong>${plan.name}</strong> · <span class="money">${formatMoney(view.renewalPrice)}</span> al mes.</p>` : html``;
}

function usageMeter(label: string, used: number, max: number): SafeHtml {
  const ratio = max > 0 ? Math.min(1, used / max) : 1;
  return html`<div class="usage-meter ${used >= max ? 'is-full' : ''}"><div style="display: flex; justify-content: space-between"><span>${label}</span><strong>${used} de ${max}</strong></div>
    <div class="bar"><span style="width: ${Math.round(ratio * 100)}%"></span></div></div>`;
}

/** Vista "Mi plan" (#/suscripcion). */
export async function renderSubscriptionView(container: HTMLElement): Promise<void> {
  setContent(container, loadingState());
  if (session().clinic.isShowcase) {
    await renderDemoPlans(container);
    return;
  }
  const view = await api.get<SubscriptionView>('/api/subscription');
  const { status } = view;
  const currentPlan = view.catalog.plans.find((plan) => plan.id === view.plan.selection.planId);
  const pendingPlan = view.plan.pending ? view.catalog.plans.find((plan) => plan.id === view.plan.pending?.planId) : null;
  const canPay = can('suscripcion.pagar');

  setContent(
    container,
    html`<section class="card">
        <div class="card-padded"><div class="kpi-grid">
          <div class="card kpi"><span class="kpi-icon">${icon('shield-check')}</span><div><div class="kpi-value">${stateBadge(status, view.onTrial)}</div><div class="kpi-label">Estado</div></div></div>
          <div class="card kpi"><span class="kpi-icon is-info">${icon('crown')}</span><div><div class="kpi-value" style="font-size: 1.05rem">${currentPlan?.name ?? view.plan.selection.planId}</div><div class="kpi-label">Plan actual</div></div></div>
          <div class="card kpi"><span class="kpi-icon is-info">${icon('calendar-clock')}</span><div><div class="kpi-value" style="font-size: 1.05rem">${status.paidUntil ? formatShortDate(status.paidUntil) : '—'}</div><div class="kpi-label">${view.onTrial ? 'Prueba hasta' : 'Pagado hasta'}</div></div></div>
          <div class="card kpi"><span class="kpi-icon is-info">${icon('wallet')}</span><div><div class="kpi-value money">${view.monthlyPrice ? formatMoney(view.monthlyPrice) : '—'}</div><div class="kpi-label">Valor mensual${view.customPrice !== null ? ' (precio especial)' : ''}</div></div></div>
        </div></div>
        <div class="card-padded" style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); padding-top: 0">
          ${usageMeter('Profesionales con agenda', view.plan.usage.professionals, view.plan.maxProfessionals)}
          ${usageMeter('Usuarios activos', view.plan.usage.users, view.plan.maxUsers)}
        </div>
        ${pendingPlan && view.plan.pending
          ? html`<p class="card-padded subscription-banner is-warning" style="margin: 0 18px 18px; border-radius: var(--radius-md)">${icon('calendar-clock')}
              Cambio programado al plan <strong>${pendingPlan.name}</strong> (${formatMoney(view.plan.pending.monthlyPrice)}/mes) desde el ${formatLongDate(view.plan.pending.effectiveOn)}.
              ${canPay ? html`<button class="button button-ghost button-small" data-action="cancel-pending">${icon('undo-2')} Cancelar cambio</button>` : ''}</p>`
          : ''}
      </section>
      ${canPay && status.state !== 'exento'
        ? html`<section class="card" style="margin-top: 16px">
            <div class="card-header"><h3>${icon('crown')} Cambiar de plan <span class="hint" data-tooltip="Subir de plan estando al día: pagas solo la diferencia de los días que quedan. Bajar: aplica cuando termina lo ya pagado. En prueba o vencido: cambia de inmediato.">${icon('info')}</span></h3></div>
            <div class="card-padded" data-plan-builder></div>
          </section>`
        : ''}
      ${status.state === 'exento'
        ? html`<section class="card card-padded" style="margin-top: 16px"><p class="muted">Este consultorio no tiene cobro de suscripción.</p></section>`
        : html`<section class="card card-padded" style="margin-top: 16px">
            <h3>${icon('list-checks')} ${view.onTrial ? 'Activa tu plan antes de que termine la prueba' : 'Cómo pagar'}</h3>
            <p class="muted">${status.state === 'en_gracia' && status.suspendOn
              ? html`Está vencido. Tienes hasta el <strong>${formatLongDate(status.suspendOn)}</strong> (periodo de gracia de ${view.graceDays} días) antes de que se suspenda el acceso.`
              : view.onTrial
                ? html`Al pagar, el tiempo se suma desde el final de tu prueba: no pierdes días.`
                : html`Paga antes del vencimiento para no perder el acceso. Si pagas antes, el tiempo se suma a partir de la fecha actual de vencimiento.`}</p>
            ${stepsMarkup(view)}
          </section>`}
      <section class="card" style="margin-top: 16px">
        <div class="card-header"><h3>${icon('receipt')} Historial de pagos</h3></div>
        ${view.payments.length === 0
          ? emptyState('receipt', 'Sin pagos registrados', 'Aquí verás cada pago de la suscripción y hasta qué fecha cubrió.')
          : html`<div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Fecha</th><th>Concepto</th><th>Cubre hasta</th><th>Medio</th><th class="align-right">Valor</th><th>Estado</th></tr></thead>
            <tbody>${view.payments.map((payment) => html`<tr class="${payment.status === 'anulado' ? 'is-muted' : ''}">
              <td>${formatUtcAsLocal(payment.createdAt, clinicOffset())}</td>
              <td>${payment.kind === 'cambio_plan' ? 'Cambio de plan' : payment.months === 1 ? '1 mes' : `${payment.months} meses`}</td>
              <td>${formatShortDate(payment.newPaidUntil)}</td>
              <td>${payment.method === 'wompi' ? 'En línea (Wompi)' : payment.method}</td><td class="align-right money">${formatMoney(payment.amount)}</td>
              <td>${payment.status === 'aprobado' ? html`<span class="badge badge-success">Aprobado</span>` : html`<span class="badge badge-neutral">Anulado</span>`}</td>
            </tr>`)}</tbody></table></div>`}
      </section>`,
  );
  refreshIcons(container);
  const builder = container.querySelector<HTMLElement>('[data-plan-builder]');
  if (builder) mountPlanBuilder(builder, view, () => renderSubscriptionView(container));
  container.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const months = target.closest<HTMLElement>('[data-pay-months]')?.dataset.payMonths;
    if (months) await startOnlinePayment(Number(months));
    if (target.closest('[data-action="cancel-pending"]')) {
      const done = await withErrorToast(() => api.post('/api/subscription/plan', view.plan.selection));
      if (done) {
        toast('Cambio programado cancelado.', 'info');
        await renderSubscriptionView(container);
      }
    }
  };
}

/** Selector de plan + módulos + adicionales con el precio calculado al instante. */
function mountPlanBuilder(root: HTMLElement, view: SubscriptionView, onChanged: () => Promise<void>): void {
  const selection: PlanSelection = { ...view.plan.selection, addonModules: [...view.plan.selection.addonModules] };
  const addonById = new Map(view.catalog.addons.map((addon) => [addon.id, addon]));
  const status = view.status;
  const plans = view.catalog.plans;

  const draw = () => {
    let resolved: ReturnType<typeof resolvePlan> | null = null;
    let problem = '';
    try {
      resolved = resolvePlan(view.catalog, selection, { allowInactivePlan: true });
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Selección no válida.';
    }
    const selectedPlan = plans.find((plan) => plan.id === selection.planId);
    const moduleAddons = ALL_PLAN_MODULES.filter((module) => !selectedPlan?.modules.includes(module) && addonById.get(module)?.isActive);
    const seat = (id: 'profesional' | 'usuario', field: 'extraProfessionals' | 'extraUsers', label: string) =>
      addonById.get(id)?.isActive
        ? html`<label class="field"><span>${label} <span class="subtle">(${formatMoney(addonById.get(id)?.monthlyPrice ?? 0)} c/u)</span></span>
            <input type="number" min="0" max="50" step="1" data-seat="${field}" value="${selection[field]}" /></label>`
        : html``;

    const willApplyNow = view.onTrial || status.blocked || (status.daysLeft ?? -1) < 0;
    let note: string = '';
    if (resolved) {
      if (willApplyNow) note = 'Se aplica de inmediato. El valor nuevo se cobra en tu próximo pago.';
      else if (resolved.monthlyPrice > view.monthlyPrice) {
        const difference = prorateUpgrade(view.monthlyPrice, resolved.monthlyPrice, (status.daysLeft ?? 0) + 1);
        note = difference >= MIN_ONLINE_CHARGE
          ? `Pagas hoy ${formatMoney(difference)} (la diferencia de los ${(status.daysLeft ?? 0) + 1} días que quedan) y se activa al aprobarse el pago.`
          : 'La diferencia es mínima: se aplica de inmediato sin cobro.';
      } else if (status.paidUntil) note = `Se aplica el ${formatLongDate(addDays(status.paidUntil, 1))}, cuando termina lo que ya pagaste.`;
    }

    setContent(
      root,
      html`<div class="plan-grid" style="margin-top: 0">
          ${plans.filter((plan) => plan.isActive || plan.id === view.plan.selection.planId).map((plan) =>
            planCard(plan, {
              billing: 'mensual',
              annualFreeMonths: view.catalog.annualFreeMonths,
              ribbon: plan.id === view.plan.selection.planId ? 'Tu plan' : undefined,
              selected: plan.id === selection.planId,
              action: html`<button type="button" class="button ${plan.id === selection.planId ? 'button-primary' : 'button-secondary'}" data-choose="${plan.id}">${plan.id === selection.planId ? html`${icon('check')} Elegido` : 'Elegir'}</button>`,
            }),
          )}
        </div>
        <div class="form-grid" style="margin-top: 16px; align-items: start">
          <div>
            <h4>${icon('plus')} Módulos adicionales</h4>
            ${moduleAddons.length
              ? html`<div class="option-list" style="margin-top: 8px">${moduleAddons.map((module) => html`<label class="checkbox"><input type="checkbox" data-addon="${module}" ${selection.addonModules.includes(module) ? 'checked' : ''} />
                  <span><strong>${PLAN_MODULES[module].name}</strong> · <span class="money">${formatMoney(addonById.get(module)?.monthlyPrice ?? 0)}</span>/mes<br /><small class="subtle">${PLAN_MODULES[module].description}</small></span></label>`)}</div>`
              : html`<p class="subtle">Este plan ya incluye todos los módulos.</p>`}
            <div class="form-grid" style="margin-top: 10px">
              ${seat('profesional', 'extraProfessionals', 'Profesionales extra')}
              ${seat('usuario', 'extraUsers', 'Usuarios extra')}
            </div>
          </div>
          <div>
            ${resolved ? priceSummary(resolved.lines, resolved.monthlyPrice, note) : html`<p class="form-error">${problem}</p>`}
            ${view.customPrice !== null ? html`<p class="subtle" style="margin-top: 8px">${icon('info')} Hoy tienes un precio especial (${formatMoney(view.customPrice)}). Si cambias de plan, pasas a los precios de la lista.</p>` : ''}
            <button type="button" class="button button-primary" data-action="apply-plan" style="margin-top: 12px" ${resolved ? '' : 'disabled'}>${icon('check')} Aplicar cambio</button>
          </div>
        </div>`,
    );
    refreshIcons(root);
  };

  root.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const choose = target.closest<HTMLElement>('[data-choose]')?.dataset.choose;
    if (choose) {
      selection.planId = choose;
      const plan = plans.find((candidate) => candidate.id === choose);
      selection.addonModules = selection.addonModules.filter((module) => !plan?.modules.includes(module));
      draw();
    }
    if (target.closest('[data-action="apply-plan"]')) {
      const result = await withErrorToast(() =>
        api.post<{ mode: 'inmediato' | 'programado' | 'pago' | 'sin_cambios'; checkoutUrl?: string; effectiveOn?: string }>('/api/subscription/plan', selection),
      );
      if (!result) return;
      if (result.mode === 'pago' && result.checkoutUrl) return goToCheckout(result.checkoutUrl);
      if (result.mode === 'inmediato') {
        toast('Plan actualizado. Recargando el panel…', 'success');
        window.setTimeout(() => window.location.reload(), 700);
        return;
      }
      toast(result.mode === 'programado' && result.effectiveOn ? `Cambio programado para el ${formatLongDate(result.effectiveOn)}.` : 'No hubo cambios.', 'info');
      await onChanged();
    }
  });
  root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.addon) {
      const module = input.dataset.addon as PlanModule;
      selection.addonModules = input.checked ? [...selection.addonModules, module] : selection.addonModules.filter((item) => item !== module);
      draw();
    }
    if (input.dataset.seat) {
      const value = Math.max(0, Math.min(50, Math.floor(Number(input.value) || 0)));
      selection[input.dataset.seat as 'extraProfessionals' | 'extraUsers'] = value;
      draw();
    }
  });
  draw();
}

/** En una demo, "Mi plan" muestra los planes y lleva a crear el consultorio. */
async function renderDemoPlans(container: HTMLElement): Promise<void> {
  const offer = await api.get<{ plans: PlanCatalog['plans']; annualFreeMonths: number; trialDays: number }>('/api/public/offer');
  setContent(
    container,
    html`<section class="card card-padded">
      <h3>${icon('sparkles')} Así se cobra Agenda Sonrisa</h3>
      <p class="muted">En la demo tienes todos los módulos para que los conozcas. En tu consultorio eliges el plan según lo que necesitas y lo cambias cuando quieras.</p>
      <div class="plan-grid">${offer.plans.map((plan) =>
        planCard(plan, {
          billing: 'mensual',
          annualFreeMonths: offer.annualFreeMonths,
          action: html`<a class="button button-secondary" href="/registro?plan=${plan.id}">${icon('gift')} Probar ${offer.trialDays} días gratis</a>`,
        }),
      )}</div>
    </section>`,
  );
  refreshIcons(container);
}

/** Regreso desde Wompi: /suscripcion/pago?ref=SUB-…&id=transacción */
export async function renderSubscriptionPaymentReturn(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('ref') ?? '';
  const transactionId = params.get('id') ?? '';
  const draw = (iconName: string, title: string, message: string, actions: SafeHtml) => {
    setContent(
      root,
      html`<main class="public-page"><section class="card success-panel" style="margin-top: 40px">${icon(iconName)}<h1>${title}</h1><p class="muted">${message}</p>${actions}</section></main>`,
    );
    refreshIcons(root);
  };
  const goToPanel = html`<a class="button button-primary" href="/app#/suscripcion">${icon('arrow-right')} Ir al panel</a>`;
  if (!reference || !transactionId) {
    draw('circle-help', 'No se recibió el pago', 'Si cerraste la ventana de Wompi antes de terminar, vuelve a intentarlo desde el panel.', goToPanel);
    return;
  }
  draw('hourglass', 'Verificando tu pago…', 'Estamos consultando a Wompi. No cierres esta ventana.', html``);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { result } = await api.post<{ result: 'aprobado' | 'rechazado' | 'pendiente' }>('/api/subscription/verify', { reference, transactionId });
      if (result === 'aprobado') {
        draw('circle-check-big', '¡Pago aprobado!', 'Tu suscripción quedó al día y el acceso está activo.', goToPanel);
        return;
      }
      if (result === 'rechazado') {
        draw('circle-x', 'El pago no fue aprobado', 'Wompi rechazó o anuló la transacción. Puedes intentar de nuevo con otro medio de pago.', goToPanel);
        return;
      }
    } catch (error) {
      draw('triangle-alert', 'No pudimos verificar el pago', error instanceof Error ? error.message : 'Intenta de nuevo en unos minutos.', html`<a class="button button-primary" href="/app">${icon('log-in')} Ingresar al panel</a>`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  draw('hourglass', 'Tu pago está en proceso', 'Wompi aún no confirma la transacción (pasa con PSE o Nequi). En cuanto se apruebe, el acceso se activa solo.', goToPanel);
}
