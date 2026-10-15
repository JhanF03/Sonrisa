/**
 * Página a la que vuelve el paciente desde Wompi (/c/:slug/pago/:token?id=…).
 * El servidor confirma el pago consultando a Wompi (nunca confía en la URL).
 */
import { applyFavicon } from '../core/favicon.js';
import { api } from '../core/api.js';
import { html, safeUrl, setContent } from '../core/dom.js';
import { formatLongDate, formatMoney, formatTime } from '../core/format.js';
import { applyBrandColor, icon, loadingState, refreshIcons, toast, withErrorToast } from '../core/ui.js';
import { publicLayout } from './booking.js';

interface PaymentState {
  state: 'aprobado' | 'pendiente' | 'rechazado' | 'vencido' | 'sin_cupo' | 'cancelado';
  canRetry: boolean;
  amount: number;
  clinic: { name: string; brandColor: string; logoUrl: string | null; favicon?: string | null; phone: string | null; address: string | null; city: string | null };
  appointment: { startAt: string; serviceName: string; professionalName: string };
  manageUrl: string | null;
  calendarUrl: string | null;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 45;

export async function renderPaymentResultPage(root: HTMLElement, token: string): Promise<void> {
  setContent(root, loadingState('Confirmando tu pago con Wompi…'));
  const basePath = `/api/public/payments/${encodeURIComponent(token)}`;
  const transactionId = new URLSearchParams(window.location.search).get('id') ?? undefined;
  let polls = 0;

  const load = async (): Promise<void> => {
    let data: PaymentState;
    try {
      data = await api.get<PaymentState>(basePath, { id: transactionId });
    } catch {
      setContent(root, html`<main class="public-page"><div class="card success-panel" style="margin-top: 40px">${icon('triangle-alert')}<h1>Enlace no válido</h1><p class="muted">Comunícate con el consultorio.</p></div></main>`);
      refreshIcons(root);
      return;
    }
    applyBrandColor(data.clinic.brandColor);
  applyFavicon(data.clinic.favicon);
    setContent(root, publicLayout(data.clinic, stateContent(data, polls < MAX_POLLS)));
    refreshIcons(root);
    // PSE o Nequi pueden tardar: se consulta de nuevo mientras siga pendiente.
    if (data.state === 'pendiente' && transactionId && polls++ < MAX_POLLS) window.setTimeout(() => void load(), POLL_INTERVAL_MS);
  };

  root.onclick = async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'retry') {
      const result = await withErrorToast(() => api.post<{ checkoutUrl: string }>(`${basePath}/resume`));
      if (result && new URL(result.checkoutUrl).origin === 'https://checkout.wompi.co') window.location.assign(result.checkoutUrl);
    }
    if (action === 'cancel' && window.confirm('¿Liberar el horario y cancelar la reserva?')) {
      if (await withErrorToast(() => api.post(`${basePath}/cancel`))) {
        toast('Reserva cancelada.', 'info');
        await load();
      }
    }
  };

  await load();
}

function stateContent(data: PaymentState, stillPolling: boolean) {
  const when = html`<strong>${data.appointment.serviceName}</strong> con ${data.appointment.professionalName}<br />
    <span class="first-cap">${formatLongDate(data.appointment.startAt.slice(0, 10))}</span> a las ${formatTime(data.appointment.startAt)}`;

  switch (data.state) {
    case 'aprobado':
      return html`<section class="card success-panel" style="margin-top: 16px">${icon('circle-check-big')}
        <h2>¡Pago recibido y cita confirmada!</h2><p>${when}</p><p class="muted">Anticipo pagado: ${formatMoney(data.amount)}</p>
        <div class="button-row" style="justify-content: center">
          ${data.calendarUrl ? html`<a class="button button-primary" href="${safeUrl(data.calendarUrl)}">${icon('calendar-plus')} Agregar a mi calendario</a>` : ''}
          ${data.manageUrl ? html`<a class="button button-secondary" href="${safeUrl(data.manageUrl)}">${icon('calendar-clock')} Gestionar mi cita</a>` : ''}
        </div></section>`;
    case 'pendiente':
      return html`<section class="card success-panel" style="margin-top: 16px">${stillPolling ? html`<span class="spinner" aria-hidden="true"></span>` : icon('hourglass')}
        <h2>Tu pago está en proceso</h2><p>${when}</p>
        <p class="muted">${stillPolling ? 'Estamos esperando la confirmación de Wompi. No cierres esta página.' : 'Wompi aún no confirma. Te avisaremos; también puedes recargar esta página en unos minutos.'}</p>
        ${data.canRetry ? html`<div class="button-row" style="justify-content: center"><button class="button button-secondary" data-action="retry">${icon('credit-card')} Ir a pagar</button><button class="button button-ghost" data-action="cancel">Cancelar reserva</button></div>` : ''}
      </section>`;
    case 'rechazado':
      return html`<section class="card success-panel" style="margin-top: 16px">${icon('triangle-alert')}
        <h2>El pago no fue aprobado</h2><p>${when}</p><p class="muted">Tu horario sigue apartado unos minutos. Puedes intentar con otro medio de pago.</p>
        <div class="button-row" style="justify-content: center"><button class="button button-primary" data-action="retry">${icon('credit-card')} Intentar de nuevo</button><button class="button button-ghost" data-action="cancel">Cancelar reserva</button></div>
      </section>`;
    case 'sin_cupo':
      return html`<section class="card success-panel" style="margin-top: 16px">${icon('triangle-alert')}
        <h2>Recibimos tu pago, pero el horario ya no estaba disponible</h2>
        <p class="muted">Tu dinero (${formatMoney(data.amount)}) quedó a tu favor. El consultorio te contactará para agendar otra hora${data.clinic.phone ? ` (o llama al ${data.clinic.phone})` : ''}.</p></section>`;
    case 'cancelado':
      return html`<section class="card success-panel" style="margin-top: 16px">${icon('calendar-x')}<h2>Reserva cancelada</h2><p class="muted">El horario quedó libre.</p></section>`;
    default:
      return html`<section class="card success-panel" style="margin-top: 16px">${icon('calendar-x')}
        <h2>El tiempo para pagar terminó</h2><p class="muted">El horario se liberó. Puedes hacer una nueva reserva.</p></section>`;
  }
}
