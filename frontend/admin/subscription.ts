/**
 * Suscripción del consultorio en la interfaz:
 *  • Pantalla de acceso suspendido con el paso a paso para reactivar.
 *  • Aviso superior cuando está por vencer o vencida (en gracia).
 *  • Vista "Mi suscripción" con historial y pago en línea.
 *  • Página de regreso desde Wompi que verifica el pago y reactiva.
 */
import { api } from '../core/api.js';
import { html, safeUrl, setContent, type SafeHtml } from '../core/dom.js';
import { formatLongDate, formatMoney, formatShortDate, formatUtcAsLocal } from '../core/format.js';
import { emptyState, icon, loadingState, refreshIcons, themeToggleButton, toast, withErrorToast } from '../core/ui.js';
import { SUBSCRIPTION_LABELS, type SubscriptionStatus } from '../../src/shared/subscription.js';
import { can, clinicOffset, session } from './session.js';

interface SubscriptionView {
  clinicName: string;
  status: SubscriptionStatus;
  monthlyPrice: number;
  graceDays: number;
  paymentInstructions: string;
  ownerName: string;
  ownerWhatsappUrl: string | null;
  onlinePaymentAvailable: boolean;
  payments: Array<{ id: string; amount: number; months: number; newPaidUntil: string; method: string; reference: string | null; status: string; createdAt: string }>;
}

const PLAN_OPTIONS = [1, 3, 6, 12] as const;

const stateBadge = (status: SubscriptionStatus) => {
  const tone = { exento: 'badge-neutral', al_dia: 'badge-success', por_vencer: 'badge-warning', en_gracia: 'badge-danger', suspendido: 'badge-danger' }[status.state];
  return html`<span class="badge ${tone}">${SUBSCRIPTION_LABELS[status.state]}</span>`;
};

/** Aviso en la parte superior del panel (null si no hace falta). */
export function subscriptionBanner(): SafeHtml | null {
  const { subscription } = session();
  const link = can('suscripcion.pagar') ? html` <a href="#/suscripcion">Ver cómo pagar →</a>` : html` Avísale al administrador del consultorio.`;
  if (subscription.state === 'por_vencer' && subscription.paidUntil) {
    return html`<div class="subscription-banner is-warning">${icon('calendar-clock')} Tu suscripción vence el <strong>${formatLongDate(subscription.paidUntil)}</strong>.${link}</div>`;
  }
  if (subscription.state === 'en_gracia' && subscription.suspendOn) {
    return html`<div class="subscription-banner is-danger">${icon('triangle-alert')} Tu suscripción está vencida. El acceso se suspenderá el <strong>${formatLongDate(subscription.suspendOn)}</strong> si no se registra el pago.${link}</div>`;
  }
  return null;
}

function payOnlineMarkup(view: SubscriptionView): SafeHtml {
  if (!view.onlinePaymentAvailable || !can('suscripcion.pagar')) return html``;
  return html`<div class="plan-options">
    ${PLAN_OPTIONS.map((months) => html`<button type="button" class="plan-option" data-pay-months="${months}">
      <strong>${months === 1 ? '1 mes' : `${months} meses`}</strong>
      <span class="money">${formatMoney(view.monthlyPrice * months)}</span>
    </button>`)}
  </div>`;
}

async function startOnlinePayment(months: number): Promise<void> {
  const checkout = await withErrorToast(() => api.post<{ checkoutUrl: string }>('/api/subscription/checkout', { months }));
  if (!checkout) return;
  const url = new URL(checkout.checkoutUrl);
  if (url.origin !== 'https://checkout.wompi.co') {
    toast('Enlace de pago inválido.', 'error');
    return;
  }
  window.location.assign(url.toString());
}

function stepsMarkup(view: SubscriptionView): SafeHtml {
  const canPay = can('suscripcion.pagar');
  return html`<ol class="steps-list">
    ${view.onlinePaymentAvailable && canPay
      ? html`<li><strong>Paga en línea</strong> (tarjeta, PSE, Nequi o Bancolombia): elige cuántos meses quieres pagar. El acceso se reactiva <strong>automáticamente</strong> en cuanto se aprueba el pago.${payOnlineMarkup(view)}</li>`
      : ''}
    ${view.paymentInstructions
      ? html`<li><strong>${view.onlinePaymentAvailable && canPay ? 'O paga por transferencia' : 'Realiza el pago'}</strong>${view.monthlyPrice ? html` de <strong class="money">${formatMoney(view.monthlyPrice)}</strong> por mes` : ''}:
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

/** Pantalla completa cuando el acceso está suspendido. */
export async function renderSuspendedScreen(root: HTMLElement, onRetry: () => Promise<void>, onLogout: () => Promise<void>): Promise<void> {
  setContent(root, html`<main class="public-page">${loadingState()}</main>`);
  const view = await api.get<SubscriptionView>('/api/subscription').catch(() => null);
  const status = view?.status ?? session().subscription;
  document.title = 'Acceso suspendido · Agenda Sonrisa';

  setContent(
    root,
    html`<main class="public-page suspended-page">
      <header class="public-header">
        <div class="brand"><span class="brand-mark">${icon('lock')}</span><div><div class="brand-name">${session().clinic.name}</div><div class="brand-product">Agenda Sonrisa</div></div></div>
        ${themeToggleButton()}
      </header>
      <section class="card card-padded suspended-card">
        <div class="suspended-icon">${icon('lock')}</div>
        <h1>Acceso suspendido por falta de pago</h1>
        <p class="muted">La suscripción de <strong>${session().clinic.name}</strong> ${status.paidUntil ? html`venció el <strong>${formatLongDate(status.paidUntil)}</strong>` : 'no tiene un pago registrado'} y terminó el periodo de gracia.
          Por eso se revocó el acceso al panel y la página de reservas en línea no recibe citas nuevas.</p>
        <p class="reassure">${icon('shield-check')} <span><strong>Tu información está segura.</strong> No se ha borrado nada: pacientes, citas, caja y cartera quedan intactos y vuelven a estar disponibles apenas se registre el pago.</span></p>
        <h2>${icon('list-checks')} Cómo recuperar el acceso</h2>
        ${view ? stepsMarkup(view) : html`<p>Comunícate con tu proveedor de Agenda Sonrisa para conocer el valor y la forma de pago.</p>`}
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

/** Vista "Mi suscripción" (#/suscripcion). */
export async function renderSubscriptionView(container: HTMLElement): Promise<void> {
  setContent(container, loadingState());
  const view = await api.get<SubscriptionView>('/api/subscription');
  const { status } = view;
  setContent(
    container,
    html`<section class="card">
        <div class="card-padded"><div class="kpi-grid">
          <div class="card kpi"><span class="kpi-icon">${icon('shield-check')}</span><div><div class="kpi-value">${stateBadge(status)}</div><div class="kpi-label">Estado de la suscripción</div></div></div>
          <div class="card kpi"><span class="kpi-icon is-info">${icon('calendar-clock')}</span><div><div class="kpi-value" style="font-size: 1.05rem">${status.paidUntil ? formatShortDate(status.paidUntil) : '—'}</div><div class="kpi-label">Pagado hasta</div></div></div>
          <div class="card kpi"><span class="kpi-icon is-info">${icon('wallet')}</span><div><div class="kpi-value money">${view.monthlyPrice ? formatMoney(view.monthlyPrice) : '—'}</div><div class="kpi-label">Valor mensual</div></div></div>
        </div></div>
        ${status.state === 'exento'
          ? html`<p class="card-padded muted">Este consultorio no tiene cobro de suscripción.</p>`
          : html`<div class="card-padded">
              <p class="muted">${status.state === 'en_gracia' && status.suspendOn
                ? html`La suscripción está vencida. Tienes hasta el <strong>${formatLongDate(status.suspendOn)}</strong> (periodo de gracia de ${view.graceDays} días) antes de que se suspenda el acceso.`
                : html`Paga antes del vencimiento para no perder el acceso. Si pagas antes, los meses se suman a partir de la fecha actual de vencimiento.`}</p>
              <h3>${icon('list-checks')} Cómo pagar</h3>
              ${stepsMarkup(view)}
            </div>`}
      </section>
      <section class="card" style="margin-top: 16px">
        <div class="card-header"><h3>${icon('receipt')} Historial de pagos</h3></div>
        ${view.payments.length === 0
          ? emptyState('receipt', 'Sin pagos registrados', 'Aquí verás cada pago de la suscripción y hasta qué fecha cubrió.')
          : html`<div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Fecha</th><th>Meses</th><th>Cubre hasta</th><th>Medio</th><th class="align-right">Valor</th><th>Estado</th></tr></thead>
            <tbody>${view.payments.map((payment) => html`<tr class="${payment.status === 'anulado' ? 'is-muted' : ''}">
              <td>${formatUtcAsLocal(payment.createdAt, clinicOffset())}</td><td>${payment.months}</td><td>${formatShortDate(payment.newPaidUntil)}</td>
              <td>${payment.method === 'wompi' ? 'En línea (Wompi)' : payment.method}</td><td class="align-right money">${formatMoney(payment.amount)}</td>
              <td>${payment.status === 'aprobado' ? html`<span class="badge badge-success">Aprobado</span>` : html`<span class="badge badge-neutral">Anulado</span>`}</td>
            </tr>`)}</tbody></table></div>`}
      </section>`,
  );
  refreshIcons(container);
  container.onclick = async (event) => {
    const months = (event.target as HTMLElement).closest<HTMLElement>('[data-pay-months]')?.dataset.payMonths;
    if (months) await startOnlinePayment(Number(months));
  };
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
