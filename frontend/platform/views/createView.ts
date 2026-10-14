/**
 * Crear demos (modo vitrina) o consultorios reales con su suscripción.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, safeUrl, setContent } from '../../core/dom.js';
import { formatShortDate } from '../../core/format.js';
import { copyToClipboard, icon, refreshIcons } from '../../core/ui.js';
import { addDaysToDate } from '../../../src/shared/subscription.js';
import { type PlatformSettings } from '../types.js';

export async function renderCreateView(content: HTMLElement): Promise<void> {
  const settings = await api.get<PlatformSettings>('/api/platform/settings');
  setContent(
    content,
    html`<section class="card card-padded">
      <form class="form" novalidate>
        <div class="option-list">
          <label class="checkbox"><input type="radio" name="kind" value="demo" checked /> <span><strong>Demo</strong> para un prospecto: con datos de ejemplo, sin cobro.</span></label>
          <label class="checkbox"><input type="radio" name="kind" value="real" /> <span><strong>Consultorio real</strong> para un cliente que compró: vacío, con suscripción.</span></label>
        </div>
        <div class="form-grid">
          <label class="field full"><span>Nombre del consultorio</span><input name="clinicName" required maxlength="120" placeholder="Clínica Dental Sonrisas del Norte" /></label>
          <label class="field"><span>Ciudad</span><input name="city" maxlength="80" /></label>
          <label class="field"><span>Teléfono</span><input name="phone" maxlength="30" /></label>
          <label class="field"><span>${icon('palette')} Color</span><input name="brandColor" type="color" value="#3f6f68" /></label>
          <label class="field"><span>Logo (URL https)</span><input name="logoUrl" type="url" placeholder="https://…" /></label>
        </div>
        <div class="form-grid" data-real-fields hidden>
          <label class="field"><span>Nombre del administrador</span><input name="adminFullName" maxlength="120" /></label>
          <label class="field"><span>Correo del administrador</span><input name="adminEmail" type="email" maxlength="200" /></label>
          <label class="field full"><span>Contraseña inicial <span class="hint" data-tooltip="Mínimo 10 caracteres con letras y números. Pídele que la cambie al entrar.">${icon('info')}</span></span><input name="adminPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          <label class="field"><span>Valor mensual (COP)</span><input name="monthlyPrice" type="number" min="0" step="1" value="${settings.defaults.monthlyPrice}" /></label>
          <label class="field"><span>Días de gracia</span><input name="graceDays" type="number" min="0" max="60" value="${settings.defaults.graceDays}" /></label>
          <label class="field"><span>Acceso pagado / prueba hasta</span><input name="paidUntil" type="date" value="${settings.defaults.trialUntil}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('sparkles')} Crear</button>
      </form>
    </section>
    <div data-result></div>`,
  );
  refreshIcons(content);
  const form = content.querySelector('form') as HTMLFormElement;
  const resultElement = $('[data-result]', content);
  const errorElement = $('.form-error', form);
  form.addEventListener('change', () => {
    $('[data-real-fields]', form).hidden = readForm(form).kind !== 'real';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const values = readForm(form);
    const isReal = values.kind === 'real';
    const body = {
      clinicName: values.clinicName,
      city: emptyToNull(values.city),
      phone: emptyToNull(values.phone),
      brandColor: values.brandColor,
      logoUrl: emptyToNull(values.logoUrl),
      ...(isReal
        ? {
            adminFullName: values.adminFullName,
            adminEmail: values.adminEmail,
            adminPassword: values.adminPassword,
            monthlyPrice: Number(values.monthlyPrice || 0),
            graceDays: Number(values.graceDays || 0),
            paidUntil: values.paidUntil || addDaysToDate(new Date().toISOString().slice(0, 10), 15),
          }
        : {}),
    };
    try {
      const result = await api.post<{ bookingUrl: string; panelUrl: string; login?: { email: string; password: string }; paidUntil?: string }>(
        isReal ? '/api/platform/clinics' : '/api/platform/showcase',
        body,
      );
      setContent(
        resultElement,
        html`<section class="card card-padded" style="margin-top: 16px; display: grid; gap: 10px">
          <h2>${icon('circle-check-big')} ${isReal ? 'Consultorio creado' : 'Demo lista'}</h2>
          <p><strong>Página de reservas:</strong> <a href="${safeUrl(result.bookingUrl)}" target="_blank" rel="noopener">${result.bookingUrl}</a></p>
          <p><strong>Panel:</strong> <a href="${safeUrl(result.panelUrl)}" target="_blank" rel="noopener">${result.panelUrl}</a></p>
          ${result.login ? html`<p><strong>Ingreso demo:</strong> ${result.login.email} · <code>${result.login.password}</code> <span class="subtle">(cópialo: no se vuelve a mostrar)</span></p>` : ''}
          ${result.paidUntil ? html`<p><strong>Acceso hasta:</strong> ${formatShortDate(result.paidUntil)} (luego aplica el cobro mensual).</p>` : ''}
          <div class="button-row"><button class="button button-secondary" data-copy>${icon('copy')} Copiar datos</button></div>
        </section>`,
      );
      refreshIcons(resultElement);
      resultElement.querySelector('[data-copy]')?.addEventListener('click', () =>
        copyToClipboard(
          `Reservas: ${result.bookingUrl}\nPanel: ${result.panelUrl}${result.login ? `\nUsuario: ${result.login.email}\nContraseña: ${result.login.password}` : ''}`,
          'Datos copiados.',
        ),
      );
      form.reset();
      $('[data-real-fields]', form).hidden = true;
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo crear.';
      errorElement.hidden = false;
    }
  });
}

