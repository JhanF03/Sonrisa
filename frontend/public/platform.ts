/**
 * Página de plataforma (/plataforma): para ti, el proveedor.
 * Crea demos personalizadas para prospectos (modo vitrina) o consultorios reales.
 * La clave de plataforma solo vive en memoria de esta pestaña.
 */
import { apiRequest } from '../core/api.js';
import { emptyToNull, html, readForm, setContent } from '../core/dom.js';
import { copyToClipboard, icon, refreshIcons, themeToggleButton } from '../core/ui.js';

interface ShowcaseResult {
  slug: string;
  bookingUrl: string;
  panelUrl: string;
  login?: { email: string; password: string };
}

export function renderPlatformPage(root: HTMLElement): void {
  document.title = 'Plataforma · Agenda Sonrisa';
  setContent(
    root,
    html`<main class="public-page">
      <header class="public-header">
        <div class="brand"><span class="brand-mark">${icon('sparkles')}</span><div><div class="brand-name">Modo vitrina</div><div class="brand-product">Demos para prospectos</div></div></div>
        ${themeToggleButton()}
      </header>
      <section class="card card-padded">
        <p class="muted" style="margin-bottom: 14px">Crea en segundos una demo con el nombre, color y logo del consultorio que vas a visitar. Incluye pacientes, citas y pagos de ejemplo.</p>
        <form class="form" novalidate>
          <div class="form-grid">
            <label class="field full"><span>${icon('key-round')} Clave de plataforma</span><input name="platformKey" type="password" required autocomplete="off" /></label>
            <label class="field full"><span>Nombre del consultorio</span><input name="clinicName" required maxlength="120" placeholder="Clínica Dental Sonrisas del Norte" /></label>
            <label class="field"><span>Ciudad</span><input name="city" maxlength="80" /></label>
            <label class="field"><span>Teléfono</span><input name="phone" maxlength="30" /></label>
            <label class="field"><span>${icon('palette')} Color</span><input name="brandColor" type="color" value="#3f6f68" /></label>
            <label class="field"><span>Logo (URL https)</span><input name="logoUrl" type="url" placeholder="https://…" /></label>
            <label class="checkbox full"><input type="checkbox" name="isReal" /><span>Crear consultorio <strong>real</strong> (sin datos de ejemplo) para un cliente que ya compró</span></label>
            <div class="form-grid full" data-real-fields hidden>
              <label class="field"><span>Nombre del administrador</span><input name="adminFullName" maxlength="120" /></label>
              <label class="field"><span>Correo del administrador</span><input name="adminEmail" type="email" maxlength="200" /></label>
              <label class="field full"><span>Contraseña inicial</span><input name="adminPassword" type="password" minlength="10" autocomplete="new-password" /></label>
            </div>
          </div>
          <p class="form-error" role="alert" hidden></p>
          <button class="button button-primary" type="submit">${icon('sparkles')} Crear</button>
        </form>
      </section>
      <div data-result></div>
    </main>`,
  );
  refreshIcons(root);

  const form = root.querySelector('form') as HTMLFormElement;
  const resultElement = root.querySelector('[data-result]') as HTMLElement;
  const errorElement = form.querySelector('.form-error') as HTMLElement;

  form.addEventListener('change', () => {
    (form.querySelector('[data-real-fields]') as HTMLElement).hidden = !(form.elements.namedItem('isReal') as HTMLInputElement).checked;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const values = readForm(form);
    const isReal = (form.elements.namedItem('isReal') as HTMLInputElement).checked;
    const body = {
      clinicName: values.clinicName,
      city: emptyToNull(values.city),
      phone: emptyToNull(values.phone),
      brandColor: values.brandColor,
      logoUrl: emptyToNull(values.logoUrl),
      ...(isReal ? { adminFullName: values.adminFullName, adminEmail: values.adminEmail, adminPassword: values.adminPassword } : {}),
    };
    try {
      const result = await platformRequest<ShowcaseResult>(isReal ? '/api/platform/clinics' : '/api/platform/showcase', values.platformKey, body);
      setContent(
        resultElement,
        html`<section class="card card-padded" style="margin-top: 16px; display: grid; gap: 10px">
          <h2>${icon('circle-check-big')} ${isReal ? 'Consultorio creado' : 'Demo lista'}</h2>
          <p><strong>Página de reservas:</strong> <a href="${result.bookingUrl}" target="_blank" rel="noopener">${result.bookingUrl}</a></p>
          <p><strong>Panel:</strong> <a href="${result.panelUrl}" target="_blank" rel="noopener">${result.panelUrl}</a></p>
          ${result.login ? html`<p><strong>Ingreso demo:</strong> ${result.login.email} · <code>${result.login.password}</code></p>` : ''}
          <div class="button-row"><button class="button button-secondary" data-copy>${icon('copy')} Copiar datos</button></div>
          <p class="subtle">Comparte la página de reservas con el prospecto y entra al panel durante la reunión para mostrarle la agenda, los recordatorios y la caja.</p>
        </section>`,
      );
      refreshIcons(resultElement);
      resultElement.querySelector('[data-copy]')?.addEventListener('click', () =>
        copyToClipboard(
          `Reservas: ${result.bookingUrl}\nPanel: ${result.panelUrl}${result.login ? `\nUsuario: ${result.login.email}\nContraseña: ${result.login.password}` : ''}`,
          'Datos copiados.',
        ),
      );
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo crear.';
      errorElement.hidden = false;
    }
  });
}

async function platformRequest<TResponse>(path: string, platformKey: string, body: unknown): Promise<TResponse> {
  return apiRequest<TResponse>('POST', path, { body, headers: { 'X-Platform-Key': platformKey } });
}
