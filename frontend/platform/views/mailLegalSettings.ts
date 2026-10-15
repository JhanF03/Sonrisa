/**
 * Configuración para que todo funcione sin ti:
 *  • Correo: tu Gmail con una "contraseña de aplicación" envía bienvenidas,
 *    comprobantes de pago, recordatorios y enlaces para recuperar la contraseña.
 *  • Datos legales: aparecen en los términos, la política de datos, el pie de
 *    /registro, "Mi plan" de cada consultorio y los comprobantes.
 */
import { api } from '../../core/api.js';
import { $, emptyToNull, html, readForm, setContent } from '../../core/dom.js';
import { icon, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import type { LegalSettings, MailSettings } from '../types.js';

export async function renderMailAndLegalSettings(container: HTMLElement): Promise<void> {
  const [mail, legal] = await Promise.all([api.get<MailSettings>('/api/platform/settings/mail'), api.get<LegalSettings>('/api/platform/settings/legal')]);
  setContent(
    container,
    html`<section class="card card-padded" style="margin-top: 16px">
      <form class="form" data-form="mail" novalidate>
        <h3>${icon('mail')} Correo automático con tu Gmail <span class="badge ${mail.configured ? 'badge-success' : 'badge-neutral'}">${mail.configured ? 'Activo' : 'Inactivo'}</span>
          <span class="hint" data-tooltip="Gratis: Gmail permite unos 500 correos al día. Se envían bienvenidas, datos de la demo, comprobantes de pago, recordatorios de vencimiento y enlaces para recuperar la contraseña. Puedes revisar cada envío en la pestaña Correos.">${icon('info')}</span></h3>
        <ol class="mail-steps">
          <li>En tu cuenta de Google activa la <strong>Verificación en 2 pasos</strong> (Seguridad → Cómo inicias sesión en Google).</li>
          <li>Entra a <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>, escribe "Agenda Sonrisa" y pulsa Crear.</li>
          <li>Copia aquí la contraseña de 16 letras que te muestra Google (no es tu contraseña normal) y guarda.</li>
          <li>Pulsa <em>Enviar correo de prueba</em>. Si llega, ya quedó.</li>
        </ol>
        <div class="form-grid">
          <label class="field"><span>Tu correo de Gmail</span><input name="smtpUser" type="email" maxlength="200" value="${mail.smtpUser}" placeholder="tucorreo@gmail.com" autocomplete="off" /></label>
          <label class="field"><span>Contraseña de aplicación <span class="hint" data-tooltip="Se guarda cifrada y nunca se vuelve a mostrar. Déjala vacía para conservar la actual. Si la revocas en Google, los correos dejan de salir hasta que pongas otra.">${icon('info')}</span></span>
            <input name="smtpPassword" type="password" maxlength="64" autocomplete="new-password" placeholder="${mail.maskedPassword ? `Guardada (${mail.maskedPassword})` : 'abcd efgh ijkl mnop'}" /></label>
          <label class="field"><span>Nombre del remitente</span><input name="smtpFromName" maxlength="80" value="${mail.smtpFromName}" placeholder="Agenda Sonrisa" /></label>
          <label class="checkbox"><input type="checkbox" name="notifyOwner" value="1" ${mail.notifyOwner ? 'checked' : ''} /> <span><strong>Avisarme</strong><br /><small class="subtle">Te llega un correo con cada registro, demo y pago.</small></span></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <div class="button-row">
          <button class="button button-primary" type="submit">${icon('check')} Guardar correo</button>
          <button class="button button-secondary" type="button" data-action="test-mail">${icon('send')} Enviar correo de prueba</button>
        </div>
      </form>
    </section>
    <section class="card card-padded" style="margin-top: 16px">
      <form class="form" data-form="legal" novalidate>
        <h3>${icon('scale')} Datos legales y tributarios <span class="hint" data-tooltip="Se publican en /legal/terminos, /legal/privacidad, el pie de la página de planes, Mi plan de cada consultorio y los comprobantes de pago.">${icon('info')}</span></h3>
        <p class="subtle">Quien presta el servicio. Como persona natural usa tu nombre completo y tu cédula (o NIT si tienes RUT). Revisa los textos en <a href="/legal/terminos" target="_blank" rel="noopener">Términos</a> y <a href="/legal/privacidad" target="_blank" rel="noopener">Datos personales</a>.</p>
        <div class="form-grid">
          <label class="field"><span>Nombre o razón social</span><input name="legalName" maxlength="120" value="${legal.providerName}" placeholder="Nombre completo" /></label>
          <label class="field"><span>Cédula o NIT</span><input name="legalId" maxlength="30" value="${legal.providerId}" placeholder="CC 1.234.567.890" /></label>
          <label class="field"><span>Ciudad</span><input name="legalCity" maxlength="80" value="${legal.city}" /></label>
          <label class="field"><span>Correo para consultas, reclamos y datos <span class="hint" data-tooltip="Obligatorio por la Ley 1581: aquí los usuarios ejercen sus derechos. También es la dirección de respuesta de los correos y donde recibes los avisos.">${icon('info')}</span></span><input name="legalEmail" type="email" maxlength="200" value="${legal.contactEmail}" /></label>
          <label class="field"><span>Régimen frente al IVA <span class="hint" data-tooltip="No responsable: persona natural con ingresos del año menores a 3.500 UVT y que cumple los demás requisitos del art. 437 del Estatuto Tributario. No cobra IVA ni está obligada a facturar: se envía comprobante de pago. Responsable: cobra IVA y debe expedir factura electrónica.">${icon('info')}</span></span>
            <select name="taxRegime">
              <option value="no_responsable_iva" ${legal.taxRegime === 'no_responsable_iva' ? 'selected' : ''}>No responsable de IVA (persona natural)</option>
              <option value="responsable_iva" ${legal.taxRegime === 'responsable_iva' ? 'selected' : ''}>Responsable de IVA (factura electrónica)</option>
            </select></label>
          <label class="field"><span>Valor de la UVT del año <span class="hint" data-tooltip="La fija la DIAN cada año (2026: $52.374). Se usa para avisarte cuando tus ingresos del año se acerquen a 3.500 UVT.">${icon('info')}</span></span><input name="uvtValue" type="number" min="10000" max="1000000" value="${legal.uvtValue}" /></label>
          <label class="field full"><span>Dirección pública del sistema <span class="hint" data-tooltip="Con https://, sin barra al final. Se usa en los enlaces de los correos que salen desde las tareas automáticas (recordatorios). Ej.: https://agenda-sonrisa.tu-usuario.workers.dev">${icon('info')}</span></span><input name="publicUrl" maxlength="500" value="${legal.publicUrl}" placeholder="${window.location.origin}" /></label>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${icon('check')} Guardar datos legales</button>
      </form>
    </section>`,
  );
  refreshIcons(container);

  const submitWith = (form: HTMLFormElement, save: (values: Record<string, string>) => Promise<void>) =>
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorElement = $('.form-error', form);
      errorElement.hidden = true;
      try {
        await save(readForm(form));
      } catch (error) {
        errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
        errorElement.hidden = false;
      }
    });

  const mailForm = $('[data-form="mail"]', container) as HTMLFormElement;
  submitWith(mailForm, async (values) => {
    await api.put('/api/platform/settings/mail', {
      smtpUser: emptyToNull(values.smtpUser),
      smtpPassword: emptyToNull(values.smtpPassword),
      smtpFromName: emptyToNull(values.smtpFromName),
      notifyOwner: values.notifyOwner === '1',
    });
    toast('Correo guardado.', 'success');
    await renderMailAndLegalSettings(container);
  });
  $('[data-action="test-mail"]', container).addEventListener('click', async () => {
    const to = (mailForm.elements.namedItem('smtpUser') as HTMLInputElement).value || mail.smtpUser;
    const result = await withErrorToast(() => api.post<{ message: string }>('/api/platform/settings/mail/test', { to }));
    if (result) toast(result.message, 'success');
  });

  submitWith($('[data-form="legal"]', container) as HTMLFormElement, async (values) => {
    await api.put('/api/platform/settings/legal', {
      legalName: emptyToNull(values.legalName),
      legalId: emptyToNull(values.legalId),
      legalCity: emptyToNull(values.legalCity),
      legalEmail: emptyToNull(values.legalEmail),
      taxRegime: values.taxRegime,
      uvtValue: Number(values.uvtValue || 52374),
      publicUrl: emptyToNull(values.publicUrl),
    });
    toast('Datos legales guardados.', 'success');
    await renderMailAndLegalSettings(container);
  });
}
