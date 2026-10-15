/**
 * Pantalla de ingreso al panel, "¿Olvidaste tu contraseña?" y creación de una
 * contraseña nueva con el enlace que llega al correo (#/restablecer/<token>).
 */
import { logoTooth } from '../core/brand.js';
import { api } from '../core/api.js';
import { $, html, readForm, setContent, type SafeHtml } from '../core/dom.js';
import { icon, refreshIcons, themeToggleButton } from '../core/ui.js';
import { legalLinks } from '../public/legal.js';

/** Marco común de las pantallas de acceso (logo, modo día/noche y enlaces legales). */
function authFrame(content: SafeHtml): SafeHtml {
  return html`<main class="auth-page">
    <div class="card auth-card">
      <div class="button-row" style="justify-content: space-between">
        <div class="brand">
          <span class="brand-mark">${logoTooth()}</span>
          <div><div class="brand-name">Agenda Sonrisa</div><div class="brand-product">Gestión para consultorios</div></div>
        </div>
        ${themeToggleButton()}
      </div>
      ${content}
      <nav class="legal-links" aria-label="Información legal">${legalLinks(true)}</nav>
    </div>
  </main>`;
}

/** Envía el formulario mostrando el error en el mismo formulario. */
function bindSubmit(form: HTMLFormElement, action: (values: Record<string, string>) => Promise<void>): void {
  const errorElement = $('.form-error', form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const submitButton = form.querySelector('button[type=submit]') as HTMLButtonElement;
    submitButton.disabled = true;
    try {
      await action(readForm(form));
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo completar.';
      errorElement.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}

export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  setContent(
    root,
    authFrame(html`<div>
        <h1>Ingresa a tu consultorio</h1>
        <p class="muted">Usa el correo y la contraseña que te asignaron.</p>
      </div>
      <form class="form" id="login-form" novalidate>
        <label class="field"><span>${icon('user')} Correo</span>
          <input name="email" type="email" autocomplete="username" required maxlength="200" />
        </label>
        <label class="field"><span>${icon('lock')} Contraseña</span>
          <input name="password" type="password" autocomplete="current-password" required maxlength="128" />
        </label>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('key-round')} Ingresar</button>
        <button class="button button-ghost button-small" type="button" data-action="forgot">¿Olvidaste tu contraseña?</button>
      </form>
      <p class="subtle">${icon('shield-check')} Tu sesión se cierra sola tras 12 horas sin uso.</p>`),
  );
  refreshIcons(root);
  const form = $('#login-form', root) as HTMLFormElement;
  bindSubmit(form, async ({ email, password }) => {
    await api.post('/api/auth/login', { email, password });
    onSuccess();
  });
  $('[data-action="forgot"]', root).addEventListener('click', () => {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value;
    renderForgotPassword(root, email, () => renderLogin(root, onSuccess));
  });
}

/** Pide el enlace para crear una contraseña nueva (respuesta igual exista o no la cuenta). */
function renderForgotPassword(root: HTMLElement, email: string, onBack: () => void): void {
  setContent(
    root,
    authFrame(html`<div>
        <h1>Recupera tu acceso</h1>
        <p class="muted">Escribe el correo con el que ingresas. Te enviaremos un enlace para crear una contraseña nueva; sirve una sola vez y vence en 1 hora.</p>
      </div>
      <form class="form" novalidate>
        <label class="field"><span>${icon('mail')} Correo</span>
          <input name="email" type="email" autocomplete="username" required maxlength="200" value="${email}" />
        </label>
        <p class="form-error" role="alert" hidden></p>
        <div data-sent hidden class="tax-notice">${icon('mail-check')}<span data-sent-text></span></div>
        <button class="button button-primary" type="submit">${icon('send')} Enviar enlace</button>
        <button class="button button-ghost button-small" type="button" data-action="back">${icon('chevron-left')} Volver a ingresar</button>
      </form>`),
  );
  refreshIcons(root);
  const form = root.querySelector('form') as HTMLFormElement;
  bindSubmit(form, async ({ email: address }) => {
    const result = await api.post<{ message: string }>('/api/auth/forgot', { email: address });
    $('[data-sent-text]', form).textContent = result.message;
    $('[data-sent]', form).hidden = false;
  });
  $('[data-action="back"]', root).addEventListener('click', onBack);
}

/** Pantalla del enlace del correo: crea la contraseña nueva. */
export function renderPasswordReset(root: HTMLElement, token: string, onDone: () => void): void {
  setContent(
    root,
    authFrame(html`<div>
        <h1>Crea tu contraseña nueva</h1>
        <p class="muted">Al guardarla se cierran las sesiones abiertas en otros equipos.</p>
      </div>
      <form class="form" novalidate>
        <label class="field"><span>${icon('lock')} Contraseña nueva <span class="hint" data-tooltip="Mínimo 10 caracteres, con letras y números.">${icon('info')}</span></span>
          <input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="128" />
        </label>
        <label class="field"><span>${icon('lock')} Repítela</span>
          <input name="confirm" type="password" autocomplete="new-password" required maxlength="128" />
        </label>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('check')} Guardar contraseña</button>
      </form>`),
  );
  refreshIcons(root);
  const form = root.querySelector('form') as HTMLFormElement;
  bindSubmit(form, async ({ password, confirm }) => {
    // eslint-disable-next-line security/detect-possible-timing-attacks -- compara lo que el usuario escribió en dos campos, no un secreto
    if (password !== confirm) throw new Error('Las dos contraseñas no coinciden.');
    await api.post('/api/auth/reset', { token, password });
    window.history.replaceState(null, '', '/app');
    setContent(
      root,
      authFrame(html`<div class="tax-notice">${icon('circle-check-big')}<span>Listo. Tu contraseña quedó cambiada; ya puedes ingresar con ella.</span></div>
        <button class="button button-primary" type="button" data-action="go">${icon('log-in')} Ingresar</button>`),
    );
    refreshIcons(root);
    $('[data-action="go"]', root).addEventListener('click', onDone);
  });
}
