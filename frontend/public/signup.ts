/**
 * Página pública /registro: presentación, planes y precios, demo con datos
 * de ejemplo y registro del consultorio con prueba gratis. Todo sin intervención del dueño.
 * Las capturas (public/img) son del propio sistema con datos de la demo.
 *
 *   ?plan=profesional   preselecciona un plan (útil para enlaces desde una landing)
 *   ?accion=demo        abre directamente el formulario de la demo
 */
import { api } from '../core/api.js';
import { emptyToNull, html, raw, readForm, setContent, type SafeHtml } from '../core/dom.js';
import { brandLockup } from '../core/brand.js';
import { formatLongDate, formatMoney } from '../core/format.js';
import { planCard, type BillingView } from '../core/planCards.js';
import { copyToClipboard, icon, loadingState, openFormModal, openModal, themeToggleButton } from '../core/ui.js';
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
  document.title = 'Planes y precios · Agenda Sonrisa';
  setContent(root, html`<main class="public-page">${loadingState('Cargando planes…')}</main>`);
  let offer: PublicOffer;
  try {
    offer = await api.get<PublicOffer>('/api/public/offer');
  } catch {
    setContent(root, html`<main class="public-page"><section class="card success-panel" style="margin-top: 40px">${icon('triangle-alert')}<h1>No pudimos cargar los planes</h1><p class="muted">Revisa tu conexión y recarga la página.</p></section></main>`);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  let billing: BillingView = 'mensual';

  setContent(root, pageMarkup(offer));
  const plansContainer = root.querySelector<HTMLElement>('[data-plans]') as HTMLElement;
  const drawPlans = () => {
    setContent(
      plansContainer,
      html`<div class="billing-toggle" role="group" aria-label="Ver precios">
          <button type="button" data-billing="mensual" class="${billing === 'mensual' ? 'is-active' : ''}" aria-pressed="${billing === 'mensual'}">Pago mensual</button>
          <button type="button" data-billing="anual" class="${billing === 'anual' ? 'is-active' : ''}" aria-pressed="${billing === 'anual'}">Pago anual${offer.annualFreeMonths ? ` (${offer.annualFreeMonths} ${offer.annualFreeMonths === 1 ? 'mes gratis' : 'meses gratis'})` : ''}</button>
        </div>
        <div class="plan-grid">
          ${offer.plans.map((plan) =>
            planCard(plan, {
              billing,
              annualFreeMonths: offer.annualFreeMonths,
              ribbon: plan.id === FEATURED_PLAN ? 'El más elegido' : undefined,
              action: offer.selfSignupEnabled
                ? html`<button class="button ${plan.id === FEATURED_PLAN ? 'button-primary' : 'button-secondary'}" data-signup="${plan.id}">Probar ${plan.name} ${offer.trialDays} días gratis</button>`
                : html``,
            }),
          )}
        </div>`,
    );
  };
  drawPlans();

  root.onclick = (event) => {
    const target = event.target as HTMLElement;
    const billingButton = target.closest<HTMLElement>('[data-billing]');
    if (billingButton) {
      billing = billingButton.dataset.billing as BillingView;
      drawPlans();
      return;
    }
    const signupButton = target.closest<HTMLElement>('[data-signup]');
    if (signupButton) openSignupModal(offer, signupButton.dataset.signup ?? FEATURED_PLAN);
    if (target.closest('[data-action="demo"]')) openDemoModal(offer);
  };

  if (params.get('accion') === 'demo' && offer.selfDemoEnabled && !offer.fromDemo) openDemoModal(offer);
  else if (params.get('plan') && offer.selfSignupEnabled) openSignupModal(offer, params.get('plan') ?? FEATURED_PLAN);
}

/** Flecha a mano alzada en tinta azul para las notas sobre las capturas. */
const inkArrow = (path: string, width: number, height: number) =>
  raw(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${path}"/></svg>`);

function pageMarkup(offer: PublicOffer): SafeHtml {
  const trial = `${offer.trialDays} días gratis`;
  const primaryCta = offer.selfSignupEnabled
    ? html`<button class="button button-primary" data-signup="${FEATURED_PLAN}">${icon('rocket')} Crear mi consultorio</button>`
    : html``;
  const demoCta = offer.selfDemoEnabled && !offer.fromDemo
    ? html`<button class="button button-secondary" data-action="demo">${icon('sparkles')} Ver una demo con datos</button>`
    : offer.fromDemo
      ? html`<a class="button button-secondary" href="/app">${icon('arrow-right')} Volver a mi demo</a>`
      : html``;

  return html`<div class="site">
    <header class="site-bar"><div class="site-bar-inner">
      ${brandLockup('Agenda para consultorios odontológicos', '/registro')}
      <nav aria-label="Secciones"><a href="#funciones">Qué incluye</a><a href="#planes">Planes</a><a href="#preguntas">Preguntas</a></nav>
      <div class="site-actions">${themeToggleButton()}<a class="button button-secondary button-small" href="/app">${icon('log-in')} Ingresar</a></div>
    </div></header>
    ${offer.fromDemo
      ? html`<div class="demo-banner">${icon('sparkles')} Estás probando la demo de ${offer.fromDemo.clinicName}. Cuando crees tu consultorio, la demo seguirá abierta 24 horas más.</div>`
      : ''}
    <main>
      <section class="hero">
        <div class="hero-copy">
          <h1>La agenda del consultorio, sin cuaderno y sin citas perdidas</h1>
          <p>Tus pacientes reservan desde el celular y reciben el recordatorio por WhatsApp. Tú ves la agenda de cada profesional, la caja y lo que te deben, desde el computador o el celular.</p>
          <div class="hero-actions">${primaryCta}${demoCta}</div>
          ${offer.selfSignupEnabled ? html`<p class="hero-note">${icon('gift')} ${trial} para probarlo con tus pacientes. No pedimos tarjeta.</p>` : ''}
        </div>
        <div class="hero-shots">
          <figure class="shot-browser" style="margin: 0">
            <div class="shot-browser-bar"><i></i><i></i><i></i><span>Panel del consultorio</span></div>
            <img src="/img/panel-agenda.webp" width="1280" height="800" alt="Agenda del día con una columna por profesional y las citas de colores según su estado" fetchpriority="high" />
          </figure>
          <figure class="shot-phone" style="margin: 0">
            <img src="/img/reserva-celular.webp" width="390" height="780" alt="Página de reservas en el celular: el paciente elige servicio, día y hora" loading="lazy" />
          </figure>
          <p class="ink-note is-agenda">${inkArrow('M4 6c22 2 40 12 46 34', 56, 44)} Cada profesional en su columna</p>
          <p class="ink-note is-phone">${inkArrow('M48 6C30 4 12 12 6 30', 54, 36)} El paciente reserva solo, a cualquier hora</p>
        </div>
      </section>

      <section class="site-section" id="funciones">
        <div class="section-head">
          <h2>Lo que resuelve en el día a día</h2>
          <p>Menos llamadas para confirmar, menos huecos en la agenda y cuentas claras al cerrar la caja.</p>
        </div>
        <div class="feature-strip">
          <article class="feature">
            <h3>${icon('message-circle')} Recordatorios por WhatsApp</h3>
            <p>Cada tarde ves quién tiene cita mañana y le envías el recordatorio con un toque, desde tu propio WhatsApp.</p>
            <div class="feature-shot"><img src="/img/recordatorios.webp" width="1280" height="800" alt="Lista de recordatorios de las citas de mañana" loading="lazy" /></div>
          </article>
          <article class="feature">
            <h3>${icon('wallet')} Caja y cartera</h3>
            <p>Registra abonos y anticipos, imprime el recibo y cierra el día sabiendo cuánto entró y quién quedó debiendo.</p>
            <div class="feature-shot"><img src="/img/caja.webp" width="1280" height="800" alt="Caja del día con pagos y recibos" loading="lazy" /></div>
          </article>
          <article class="feature">
            <h3>${icon('chart-column')} Indicadores del mes</h3>
            <p>Citas atendidas, inasistencias, ingresos y servicios más vendidos, sin armar hojas de cálculo.</p>
            <div class="feature-shot"><img src="/img/indicadores.webp" width="1280" height="800" alt="Indicadores del mes del consultorio" loading="lazy" /></div>
          </article>
        </div>
      </section>

      <section class="site-section" id="planes">
        <div class="section-head">
          <h2>Planes según el tamaño de tu consultorio</h2>
          <p>Pagas por los profesionales que atienden con agenda. Puedes cambiar de plan cuando quieras desde tu panel.</p>
        </div>
        <div data-plans style="display: grid; gap: 4px; margin-top: 18px"></div>
        ${offer.addons.length
          ? html`<div class="card card-padded" style="margin-top: 16px">
              <h3>${icon('plus')} Adicionales para cualquier plan <span class="hint" data-tooltip="Los agregas o los quitas desde tu panel, en Mi plan.">${icon('info')}</span></h3>
              <table class="addon-table" style="margin-top: 6px"><tbody>${offer.addons.map((addon) => html`<tr><td>${addon.name}</td><td class="money">${formatMoney(addon.monthlyPrice)} al mes</td></tr>`)}</tbody></table>
            </div>`
          : ''}
      </section>

      <section class="site-section" id="preguntas">
        <div class="section-head"><h2>Preguntas frecuentes</h2></div>
        <div class="faq">
          <div><h3>¿Qué pasa cuando termina la prueba?</h3><p>Pagas desde tu panel y sigues con todo lo que ya registraste. Si no pagas, el acceso se pausa, pero no se borra nada.</p></div>
          <div><h3>¿Puedo cambiar de plan?</h3><p>Sí. Si subes, pagas solo la diferencia de los días que quedan. Si bajas, el cambio se aplica cuando termina lo que ya pagaste.</p></div>
          <div><h3>¿Qué es la demo?</h3><p>Un consultorio con pacientes y citas de ejemplo para que lo explores ${offer.demoDays} días. Al vencer se borra sola.</p></div>
          <div><h3>¿Cómo pago?</h3><p>Con tarjeta, PSE, Nequi o Bancolombia desde tu panel, mensual o anual. También puedes pagar por transferencia.</p></div>
          <div><h3>¿Mis datos están seguros?</h3><p>Cada consultorio ve solo su información, con usuarios y permisos por rol, y queda registro de quién hizo cada cambio.</p></div>
          <div><h3>¿Necesito instalar algo?</h3><p>No. Funciona en el navegador del computador y del celular.</p></div>
        </div>
      </section>
    </main>
    ${offer.selfSignupEnabled
      ? html`<section class="closing"><div class="site-section">
          <h2>Pruébalo con tus pacientes durante ${trial}</h2>
          <div class="hero-actions">${primaryCta}${offer.selfDemoEnabled && !offer.fromDemo ? html`<button class="button button-secondary" data-action="demo">${icon('sparkles')} Ver una demo con datos</button>` : ''}</div>
        </div></section>`
      : ''}
    <footer class="site-footer"><span>Agenda Sonrisa, hecho en Colombia.</span><a href="/app">Ingresar a mi consultorio</a></footer>
  </div>`;
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
