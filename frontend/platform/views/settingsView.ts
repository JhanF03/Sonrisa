/**
 * Configuración de cobro: datos del dueño, valores por defecto y Wompi propio.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent } from '../../core/dom.js';
import { icon, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { type PlatformSettings } from '../types.js';

export async function renderSettingsView(content: HTMLElement, reload: () => Promise<void>): Promise<void> {
  const settings = await api.get<PlatformSettings>('/api/platform/settings');
  setContent(
    content,
    html`<section class="card card-padded">
      <form class="form" novalidate>
        <h3>${icon('wallet')} Cómo te pagan tus clientes</h3>
        <p class="subtle">Esto lo ve el consultorio cuando su suscripción está por vencer o suspendida.</p>
        <div class="form-grid">
          <label class="field"><span>Tu nombre</span><input name="ownerName" maxlength="120" value="${settings.ownerName}" /></label>
          <label class="field"><span>Tu WhatsApp (para comprobantes)</span><input name="ownerWhatsapp" maxlength="30" value="${settings.ownerWhatsapp}" placeholder="300 123 4567" /></label>
          <label class="field full"><span>Instrucciones de pago</span><textarea name="paymentInstructions" rows="4" maxlength="2000" placeholder="Nequi 300 123 4567 a nombre de …&#10;Bancolombia ahorros 123-456789-00">${settings.paymentInstructions}</textarea></label>
        </div>
        <h3>${icon('settings')} Valores por defecto para consultorios nuevos</h3>
        <div class="form-grid">
          <label class="field"><span>Valor mensual (COP)</span><input name="defaultMonthlyPrice" type="number" min="0" step="1" value="${settings.defaultMonthlyPrice}" /></label>
          <label class="field"><span>Días de prueba</span><input name="defaultTrialDays" type="number" min="0" max="365" value="${settings.defaultTrialDays}" /></label>
          <label class="field"><span>Días de gracia</span><input name="defaultGraceDays" type="number" min="0" max="60" value="${settings.defaultGraceDays}" /></label>
        </div>
        <h3>${icon('credit-card')} Pago en línea con tu Wompi <span class="badge ${settings.wompiConfigured ? 'badge-success' : 'badge-neutral'}">${settings.wompiConfigured ? 'Activo' : 'Inactivo'}</span></h3>
        <p class="subtle">Con esto, tus clientes pagan desde el panel y el acceso se reactiva solo. En Wompi → Desarrolladores, configura la URL de eventos:<br /><code>${settings.webhookUrl}</code></p>
        <div class="form-grid">
          <label class="field"><span>Ambiente</span><select name="wompiEnvironment">
            <option value="" ${!settings.wompiEnvironment ? 'selected' : ''}>Desactivado</option>
            <option value="sandbox" ${settings.wompiEnvironment === 'sandbox' ? 'selected' : ''}>Pruebas (sandbox)</option>
            <option value="production" ${settings.wompiEnvironment === 'production' ? 'selected' : ''}>Producción</option></select></label>
          <label class="field"><span>Llave pública</span><input name="wompiPublicKey" maxlength="300" value="${settings.wompiPublicKey}" autocomplete="off" /></label>
          <label class="field"><span>Secreto de integridad</span><input name="wompiIntegritySecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedIntegritySecret ? `Guardado (${settings.maskedIntegritySecret})` : ''}" /></label>
          <label class="field"><span>Secreto de eventos</span><input name="wompiEventsSecret" type="password" maxlength="300" autocomplete="new-password" placeholder="${settings.maskedEventsSecret ? `Guardado (${settings.maskedEventsSecret})` : ''}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <div class="button-row">
          <button class="button button-primary" type="submit">${icon('check')} Guardar</button>
          ${settings.wompiConfigured ? html`<button class="button button-secondary" type="button" data-action="test-wompi">${icon('plug-zap')} Probar Wompi</button>` : ''}
        </div>
      </form>
    </section>`,
  );
  refreshIcons(content);
  const form = content.querySelector('form') as HTMLFormElement;
  content.onclick = async (event) => {
    if (!(event.target as HTMLElement).closest('[data-action="test-wompi"]')) return;
    const result = await withErrorToast(() => api.post<{ message: string }>('/api/platform/settings/test-wompi'));
    if (result) toast(result.message, 'success');
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    const values = readForm(form);
    try {
      await api.put('/api/platform/settings', {
        ownerName: emptyToNull(values.ownerName),
        ownerWhatsapp: emptyToNull(values.ownerWhatsapp),
        paymentInstructions: emptyToNull(values.paymentInstructions),
        defaultMonthlyPrice: Number(values.defaultMonthlyPrice || 0),
        defaultTrialDays: Number(values.defaultTrialDays || 0),
        defaultGraceDays: Number(values.defaultGraceDays || 0),
        wompiEnvironment: values.wompiEnvironment || null,
        wompiPublicKey: emptyToNull(values.wompiPublicKey),
        wompiIntegritySecret: emptyToNull(values.wompiIntegritySecret),
        wompiEventsSecret: emptyToNull(values.wompiEventsSecret),
      });
      toast('Configuración guardada.', 'success');
      await reload();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    }
  });
}

