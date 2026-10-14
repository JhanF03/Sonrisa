/**
 * Pantalla de ingreso al panel.
 */
import { logoTooth } from '../core/brand.js';
import { api } from '../core/api.js';
import { $, html, readForm, setContent } from '../core/dom.js';
import { icon, refreshIcons, themeToggleButton } from '../core/ui.js';

export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  setContent(
    root,
    html`<main class="auth-page">
      <div class="card auth-card">
        <div class="button-row" style="justify-content: space-between">
          <div class="brand">
            <span class="brand-mark">${logoTooth()}</span>
            <div><div class="brand-name">Agenda Sonrisa</div><div class="brand-product">Gestión para consultorios</div></div>
          </div>
          ${themeToggleButton()}
        </div>
        <div>
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
        </form>
        <p class="subtle">${icon('shield-check')} Tu sesión se cierra sola tras 12 horas sin uso.</p>
      </div>
    </main>`,
  );
  refreshIcons(root);

  const form = $('#login-form', root) as HTMLFormElement;
  const errorElement = $('.form-error', form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { email, password } = readForm(form);
    errorElement.hidden = true;
    const submitButton = form.querySelector('button[type=submit]') as HTMLButtonElement;
    submitButton.disabled = true;
    try {
      await api.post('/api/auth/login', { email, password });
      onSuccess();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo ingresar.';
      errorElement.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}
