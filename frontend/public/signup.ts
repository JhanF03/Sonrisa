/**
 * Página pública /registro: planes y precios, demo con datos de ejemplo y
 * registro del consultorio con prueba gratis. Todo sin intervención del dueño.
 *
 *   ?plan=profesional   preselecciona un plan (útil para enlaces desde una landing)
 *   ?accion=demo        abre directamente el formulario de la demo
 */
import { api } from '../core/api.js';
import { emptyToNull, html, readForm, setContent, type SafeHtml } from '../core/dom.js';
import { formatLongDate, formatMoney } from '../core/format.js';
import { planCard, type BillingView } from '../core/planCards.js';
import { copyToClipboard, icon, loadingState, openFormModal, openModal, refreshIcons, themeToggleButton } from '../core/ui.js';
import type { AddonDefinition, PlanDefinition } from '../../src/shared/plans.js';
import { mountTurnstile, readTurnstileToken } from './booking.js';

interface PublicOffer {
  plans: PlanDefinition[];
  addons: AddonDefinition[];
  annualFreeMonths: number;
  trialDays: number;
  demoDays: number;
  selfSignupEnabled: boolean;
  selfDemoEnabled: boolean;
  turnstileSiteKey: string | null;
  fromDemo: { clinicName: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null } | null;
}

const FEATURED_PLAN = 'profesional';

export async function renderSignupPage(root: HTMLElement): Promise<void> {
  document.title = 'Planes y registro · Agenda Sonrisa';
  setContent(root, html`<main class="public-page">${loadingState('Cargando planes…')}</main>`);
  let offer: PublicOffer;
  try {
    offer = await api.get<PublicOffer>('/api/public/offer');
  } catch {
    setContent(root, html`<main class="public-page"><section class="card success-panel" style="margin-top: 40px">${icon('triangle-alert')}<h1>No pudimos cargar los planes</h1><p class="muted">Intenta de nuevo en unos minutos.</p></section></main>`);
    refreshIcons(root);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  let billing: BillingView = 'mensual';
  const plans = offer.plans;

  const draw = () => {
    setContent(
      root,
      html`<main class="public-page is-wide">
        <header class="public-header">
          <div class="brand"><span class="brand-mark">${icon('smile')}</span><div><div class="brand-name">Agenda Sonrisa</div><div class="brand-product">Software para consultorios odontológicos</div></div></div>
          <div class="button-row"><a class="button button-ghost button-small" href="/app">${icon('log-in')} Ingresar</a>${themeToggleButton()}</div>
        </header>
        ${offer.fromDemo
          ? html`<div class="demo-banner" style="border-radius: var(--radius-md)">${icon('sparkles')} Estás probando la demo <strong>${offer.fromDemo.clinicName}</strong>. Cuando crees tu consultorio, la demo seguirá abierta 24 horas más.</div>`
          : ''}
        <section class="offer-hero">
          <h1>Agenda, pacientes y caja de tu consultorio, en un solo lugar</h1>
          <p>Tus pacientes reservan en línea, reciben recordatorios por WhatsApp y tú ves la agenda de todos tus profesionales desde el celular o el computador.</p>
          <div class="offer-actions">
            ${offer.selfSignupEnabled ? html`<button class="button button-primary" data-signup="${FEATURED_PLAN}">${icon('rocket')} Crear mi consultorio · ${offer.trialDays} días gratis</button>` : ''}
            ${offer.selfDemoEnabled && !offer.fromDemo ? html`<button class="button button-secondary" data-action="demo" data-tooltip="Un consultorio de ejemplo con pacientes, citas y caja para que lo explores ${offer.demoDays} días">${icon('sparkles')} Ver demo con datos</button>` : ''}
            ${offer.fromDemo ? html`<a class="button button-secondary" href="/app">${icon('arrow-right')} Volver a mi demo</a>` : ''}
          </div>
          <p class="subtle">Sin tarjeta para la prueba. Al terminar eliges cómo pagar: tarjeta, PSE, Nequi o transferencia.</p>
          <div class="billing-toggle" role="group" aria-label="Ver precios">
            <button type="button" data-billing="mensual" class="${billing === 'mensual' ? 'is-active' : ''}">Mensual</button>
            <button type="button" data-billing="anual" class="${billing === 'anual' ? 'is-active' : ''}">Anual${offer.annualFreeMonths ? ` · ${offer.annualFreeMonths} ${offer.annualFreeMonths === 1 ? 'mes' : 'meses'} gratis` : ''}</button>
          </div>
        </section>
        <section class="plan-grid">
          ${plans.map((plan) =>
            planCard(plan, {
              billing,
              annualFreeMonths: offer.annualFreeMonths,
              ribbon: plan.id === FEATURED_PLAN ? 'Más elegido' : undefined,
              action: offer.selfSignupEnabled
                ? html`<button class="button ${plan.id === FEATURED_PLAN ? 'button-primary' : 'button-secondary'}" data-signup="${plan.id}">${icon('gift')} Probar ${offer.trialDays} días gratis</button>`
                : html``,
            }),
          )}
        </section>
        ${offer.addons.length
          ? html`<section class="card card-padded" style="margin-top: 16px">
              <h3>${icon('plus')} Adicionales para cualquier plan <span class="hint" data-tooltip="Los agregas o quitas desde tu panel, en Mi plan, cuando los necesites.">${icon('info')}</span></h3>
              <table class="addon-table"><tbody>${offer.addons.map((addon) => html`<tr><td>${addon.name}</td><td class="money">${formatMoney(addon.monthlyPrice)} / mes</td></tr>`)}</tbody></table>
            </section>`
          : ''}
        <section class="card card-padded" style="margin-top: 16px">
          <h3>${icon('circle-help')} Preguntas frecuentes</h3>
          <ul class="feature-list" style="margin-top: 8px">
            <li>${icon('check')} <span><strong>¿Qué pasa al terminar la prueba?</strong> Pagas desde tu panel y sigues con tus datos. Si no pagas, el acceso se pausa, pero no se borra nada.</span></li>
            <li>${icon('check')} <span><strong>¿Puedo cambiar de plan?</strong> Sí, cuando quieras. Si subes, pagas solo la diferencia de los días que quedan; si bajas, aplica al terminar lo ya pagado.</span></li>
            <li>${icon('check')} <span><strong>¿Qué es la demo?</strong> Un consultorio con datos ficticios para explorar todo durante ${offer.demoDays} días. Se borra solo al vencer.</span></li>
          </ul>
        </section>
      </main>`,
    );
    refreshIcons(root);
  };

  root.onclick = (event) => {
    const target = event.target as HTMLElement;
    const billingButton = target.closest<HTMLElement>('[data-billing]');
    if (billingButton) {
      billing = billingButton.dataset.billing as BillingView;
      draw();
      return;
    }
    const signupButton = target.closest<HTMLElement>('[data-signup]');
    if (signupButton) openSignupModal(offer, signupButton.dataset.signup ?? FEATURED_PLAN);
    if (target.closest('[data-action="demo"]')) openDemoModal(offer);
  };

  draw();
  if (params.get('accion') === 'demo' && offer.selfDemoEnabled && !offer.fromDemo) openDemoModal(offer);
  else if (params.get('plan') && offer.selfSignupEnabled) openSignupModal(offer, params.get('plan') ?? FEATURED_PLAN);
}

const trapField = html`<label class="trap-field" aria-hidden="true">Sitio web<input name="website" tabindex="-1" autocomplete="off" /></label>`;

const turnstileField = (offer: PublicOffer) => (offer.turnstileSiteKey ? html`<div data-turnstile data-sitekey="${offer.turnstileSiteKey}"></div>` : html``);

function passwordField(label: string): SafeHtml {
  return html`<label class="field"><span>${label} <span class="hint" data-tooltip="Mínimo 10 caracteres, con letras y números.">${icon('info')}</span></span>
    <input name="password" type="password" required minlength="10" autocomplete="new-password" /></label>`;
}

function openDemoModal(offer: PublicOffer): void {
  const modal = openFormModal({
    title: 'Ver demo con datos de ejemplo',
    iconName: 'sparkles',
    submitLabel: 'Crear mi demo',
    fields: html`<p class="muted">Te creamos un consultorio de ejemplo con pacientes, citas, caja e inventario para que explores todo.
        <strong>Dura ${offer.demoDays} días</strong> y luego se borra solo. Cuando quieras, creas tu consultorio real con la prueba gratis.</p>
      <div class="form-grid">
        <label class="field"><span>Tu nombre</span><input name="fullName" required maxlength="120" autocomplete="name" /></label>
        <label class="field"><span>Correo</span><input name="email" type="email" required maxlength="200" autocomplete="email" /></label>
        <label class="field"><span>Celular (opcional)</span><input name="phone" maxlength="30" autocomplete="tel" inputmode="tel" /></label>
        <label class="field"><span>Nombre de tu consultorio (opcional)</span><input name="clinicName" maxlength="120" /></label>
        ${passwordField('Contraseña para entrar a la demo')}
      </div>
      ${trapField}${turnstileField(offer)}`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const result = await api.post<{ loginEmail: string; expiresAt: string; panelUrl: string }>('/api/public/demo', {
        fullName: values.fullName,
        email: values.email,
        phone: emptyToNull(values.phone),
        clinicName: emptyToNull(values.clinicName),
        password: values.password,
        website: values.website || undefined,
        turnstileToken: readTurnstileToken(form),
      });
      showDemoCreated(result);
    },
  });
  mountTurnstile(modal.body);
}

function showDemoCreated(result: { loginEmail: string; expiresAt: string; panelUrl: string }): void {
  const modal = openModal({
    title: 'Tu demo está lista',
    iconName: 'circle-check-big',
    content: html`<p>Guarda tu usuario para volver a entrar a la demo (la contraseña es la que acabas de escribir):</p>
      <p class="secret-row"><code>${result.loginEmail}</code> <button type="button" class="icon-button" data-copy aria-label="Copiar usuario">${icon('copy')}</button></p>
      <p class="subtle">Disponible hasta el ${formatLongDate(result.expiresAt.slice(0, 10))}.</p>
      <div class="modal-actions"><a class="button button-primary" href="${result.panelUrl}">${icon('arrow-right')} Entrar a la demo</a></div>`,
  });
  modal.body.querySelector('[data-copy]')?.addEventListener('click', () => void copyToClipboard(result.loginEmail, 'Usuario copiado.'));
}

function openSignupModal(offer: PublicOffer, planId: string): void {
  const contact = offer.fromDemo;
  const modal = openFormModal({
    title: 'Crear mi consultorio',
    iconName: 'rocket',
    submitLabel: `Empezar ${offer.trialDays} días gratis`,
    size: 'wide',
    fields: html`<p class="muted">Tu consultorio empieza vacío y es solo tuyo. Durante <strong>${offer.trialDays} días</strong> no pagas nada; puedes cambiar de plan cuando quieras.</p>
      <div class="form-grid">
        <label class="field"><span>Plan</span><select name="planId">${offer.plans.map((plan) => html`<option value="${plan.id}" ${plan.id === planId ? 'selected' : ''}>${plan.name} · ${formatMoney(plan.monthlyPrice)}/mes · ${plan.maxProfessionals} prof.</option>`)}</select></label>
        <label class="field"><span>Nombre del consultorio</span><input name="clinicName" required maxlength="120" placeholder="Clínica Dental Sonrisas" /></label>
        <label class="field"><span>Ciudad</span><input name="city" maxlength="80" /></label>
        <label class="field"><span>Tu nombre</span><input name="fullName" required maxlength="120" autocomplete="name" value="${contact?.contactName ?? ''}" /></label>
        <label class="field"><span>Correo (con este ingresas)</span><input name="email" type="email" required maxlength="200" autocomplete="email" value="${contact?.contactEmail ?? ''}" /></label>
        <label class="field"><span>Celular</span><input name="phone" maxlength="30" autocomplete="tel" inputmode="tel" value="${contact?.contactPhone ?? ''}" /></label>
        ${passwordField('Contraseña')}
      </div>
      <label class="checkbox"><input type="checkbox" name="acceptTerms" value="1" required /> <span>Acepto los términos del servicio y el tratamiento de mis datos personales (Ley 1581 de 2012).</span></label>
      ${trapField}${turnstileField(offer)}`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const result = await api.post<{ panelUrl: string; trialUntil: string; demoAvailableUntil: string | null; demoLoginEmail: string | null }>('/api/public/signup', {
        planId: values.planId,
        clinicName: values.clinicName,
        city: emptyToNull(values.city),
        fullName: values.fullName,
        email: values.email,
        phone: emptyToNull(values.phone),
        password: values.password,
        acceptTerms: values.acceptTerms === '1',
        website: values.website || undefined,
        turnstileToken: readTurnstileToken(form),
      });
      showSignupDone(result);
    },
  });
  mountTurnstile(modal.body);
}

function showSignupDone(result: { panelUrl: string; trialUntil: string; demoAvailableUntil: string | null; demoLoginEmail: string | null }): void {
  openModal({
    title: '¡Tu consultorio está listo!',
    iconName: 'circle-check-big',
    content: html`<p>Tu prueba gratis va hasta el <strong>${formatLongDate(result.trialUntil)}</strong>. Antes de esa fecha eliges cómo pagar desde <em>Mi plan</em>.</p>
      ${result.demoAvailableUntil
        ? html`<p class="subtle">${icon('info')} Tu demo sigue abierta hasta el ${formatLongDate(result.demoAvailableUntil.slice(0, 10))} (24 horas).${result.demoLoginEmail ? html` Para volver a ella, sal y entra con <code>${result.demoLoginEmail}</code>.` : ''}</p>`
        : ''}
      <div class="modal-actions"><a class="button button-primary" href="${result.panelUrl}">${icon('arrow-right')} Ir a mi consultorio</a></div>`,
  });
}
