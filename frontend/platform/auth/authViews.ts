/**
 * Ingreso del dueño: crear la primera cuenta (una sola vez, con la clave
 * maestra), iniciar sesión con correo + contraseña (+ código de 6 dígitos si
 * activó la verificación en dos pasos) y recuperar el acceso.
 */
import { logoTooth } from '../../core/brand.js';
import { api, ApiError } from '../../core/api.js';
import { $, html, readForm, setContent, type SafeHtml } from '../../core/dom.js';
import { icon, refreshIcons, themeToggleButton } from '../../core/ui.js';

const authLayout = (title: string, body: SafeHtml) => html`<main class="public-page platform-auth">
  <header class="public-header">
    <div class="brand"><span class="brand-mark">${logoTooth()}</span><div><div class="brand-name">Panel del dueño</div><div class="brand-product">Agenda Sonrisa · Plataforma</div></div></div>
    ${themeToggleButton()}
  </header>
  <section class="card card-padded auth-card">
    <h1>${title}</h1>
    ${body}
  </section>
</main>`;

function bindForm(root: HTMLElement, onSubmit: (values: Record<string, string>, form: HTMLFormElement) => Promise<void>): void {
  const form = root.querySelector('form') as HTMLFormElement;
  const errorElement = $('.form-error', form);
  const submitButton = form.querySelector<HTMLButtonElement>('button[type=submit]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    if (submitButton) submitButton.disabled = true;
    try {
      await onSubmit(readForm(form), form);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo completar.';
      errorElement.hidden = false;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}

/** Primera vez: no existe ninguna cuenta de dueño. */
export function renderSetup(root: HTMLElement, onDone: () => Promise<void>): void {
  setContent(
    root,
    authLayout(
      'Crea tu cuenta de dueño',
      html`<p class="muted">Solo se hace una vez. La <strong>clave maestra</strong> (<code>PLATFORM_ADMIN_KEY</code>) confirma que eres el dueño del servidor; después entrarás con tu correo y contraseña desde cualquier dispositivo.</p>
      <form class="form" novalidate>
        <label class="field"><span>Clave maestra</span><input name="masterKey" type="password" required autocomplete="off" /></label>
        <label class="field"><span>Tu nombre</span><input name="fullName" required maxlength="120" autocomplete="name" /></label>
        <label class="field"><span>Correo</span><input name="email" type="email" required maxlength="200" autocomplete="username" /></label>
        <label class="field"><span>Contraseña</span><input name="password" type="password" required minlength="10" autocomplete="new-password" />
          <small class="field-hint">Mínimo 10 caracteres, con letras y números.</small></label>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('user-check')} Crear cuenta</button>
      </form>`,
    ),
  );
  refreshIcons(root);
  bindForm(root, async (values) => {
    await api.post('/api/platform/setup', { masterKey: values.masterKey, fullName: values.fullName, email: values.email, password: values.password });
    await api.post('/api/platform/login', { email: values.email, password: values.password });
    await onDone();
  });
}

export function renderLogin(root: HTMLElement, onDone: () => Promise<void>): void {
  let needsCode = false;
  setContent(
    root,
    authLayout(
      'Ingresar',
      html`<form class="form" novalidate>
        <label class="field"><span>Correo</span><input name="email" type="email" required maxlength="200" autocomplete="username" autofocus /></label>
        <label class="field"><span>Contraseña</span><input name="password" type="password" required autocomplete="current-password" /></label>
        <label class="field" data-code hidden><span>${icon('smartphone')} Código de tu app autenticadora</span>
          <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" />
          <small class="field-hint">Abre Google Authenticator (o tu app) y escribe el código de 6 dígitos de Agenda Sonrisa.</small></label>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('log-in')} Ingresar</button>
      </form>
      <p class="subtle"><a href="#/recuperar">¿Olvidaste tu contraseña o perdiste el celular?</a></p>`,
    ),
  );
  refreshIcons(root);
  bindForm(root, async (values, form) => {
    try {
      await api.post('/api/platform/login', { email: values.email, password: values.password, code: needsCode ? values.code || null : null });
      await onDone();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TOTP_REQUIRED') {
        // Contraseña correcta: falta el segundo paso (no es un error).
        needsCode = true;
        $('[data-code]', form).hidden = false;
        form.querySelector<HTMLInputElement>('input[name=code]')?.focus();
        return;
      }
      throw error;
    }
  });
}

export function renderRecover(root: HTMLElement, onDone: () => Promise<void>): void {
  setContent(
    root,
    authLayout(
      'Recuperar el acceso',
      html`<p class="muted">Con la clave maestra (<code>PLATFORM_ADMIN_KEY</code>) defines una contraseña nueva. Por seguridad se cierran las sesiones abiertas y se desactiva la verificación en dos pasos (vuelve a activarla en <em>Mi cuenta</em>).</p>
      <form class="form" novalidate>
        <label class="field"><span>Clave maestra</span><input name="masterKey" type="password" required autocomplete="off" /></label>
        <label class="field"><span>Correo de tu cuenta</span><input name="email" type="email" required maxlength="200" autocomplete="username" /></label>
        <label class="field"><span>Contraseña nueva</span><input name="newPassword" type="password" required minlength="10" autocomplete="new-password" /></label>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('key-round')} Cambiar contraseña</button>
      </form>
      <p class="subtle"><a href="#/">← Volver a ingresar</a> · ¿Perdiste también la clave maestra? Genera otra y guárdala con <code>npx wrangler secret put PLATFORM_ADMIN_KEY</code>.</p>`,
    ),
  );
  refreshIcons(root);
  bindForm(root, async (values) => {
    await api.post('/api/platform/recover', { masterKey: values.masterKey, email: values.email, newPassword: values.newPassword });
    await api.post('/api/platform/login', { email: values.email, password: values.newPassword });
    window.location.hash = '#/resumen';
    await onDone();
  });
}
