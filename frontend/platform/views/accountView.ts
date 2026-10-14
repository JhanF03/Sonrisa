/**
 * Mi cuenta: contraseña, verificación en dos pasos (app autenticadora con QR)
 * y otras cuentas de dueño (socios, contador).
 */
import { api } from '../../core/api.js';
import { $, html, raw, readForm, setContent } from '../../core/dom.js';
import { formatUtcAsLocal } from '../../core/format.js';
import { copyToClipboard, emptyState, icon, openFormModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { OFFSET, type PlatformAdmin } from '../types.js';

export async function renderAccountView(content: HTMLElement, me: PlatformAdmin, reload: () => Promise<void>): Promise<void> {
  const admins = await api.get<PlatformAdmin[]>('/api/platform/admins');
  const current = admins.find((admin) => admin.id === me.id) ?? me;

  setContent(
    content,
    html`<section class="card card-padded account-grid">
        <div>
          <h3>${icon('user')} ${current.fullName}</h3>
          <p class="muted">${current.email}${current.lastLoginAt ? html` · último ingreso ${formatUtcAsLocal(current.lastLoginAt, OFFSET)}` : ''}</p>
          <button class="button button-secondary" data-action="password">${icon('key-round')} Cambiar contraseña</button>
        </div>
        <div>
          <h3>${icon('smartphone')} Verificación en dos pasos
            <span class="badge ${current.twoFactorEnabled ? 'badge-success' : 'badge-warning'}">${current.twoFactorEnabled ? 'Activa' : 'Inactiva'}</span></h3>
          <p class="muted">${current.twoFactorEnabled
            ? 'Al ingresar te pedimos el código de 6 dígitos de tu app autenticadora. Aunque alguien conozca tu contraseña, no podrá entrar sin tu celular.'
            : 'Recomendado: además de la contraseña, pide un código de tu celular (Google Authenticator, Microsoft Authenticator, Authy…). Es gratis.'}</p>
          ${current.twoFactorEnabled
            ? html`<button class="button button-ghost" data-action="disable-2fa">${icon('ban')} Desactivar</button>`
            : html`<button class="button button-primary" data-action="enable-2fa">${icon('shield-check')} Activar</button>`}
        </div>
      </section>
      <section class="card" style="margin-top: 16px">
        <div class="card-header"><h3>${icon('users')} Cuentas con acceso a la plataforma</h3>
          <button class="button button-primary" data-action="new-admin">${icon('user-plus')} Nueva cuenta</button></div>
        ${admins.length === 0
          ? emptyState('users', 'Sin cuentas', '')
          : html`<div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Nombre</th><th>Correo</th><th>Dos pasos</th><th>Último ingreso</th><th>Estado</th><th></th></tr></thead>
            <tbody>${admins.map((admin) => html`<tr class="${admin.isActive ? '' : 'is-muted'}">
              <td><strong>${admin.fullName}</strong>${admin.id === me.id ? html` <span class="badge badge-info">Tú</span>` : ''}</td>
              <td>${admin.email}</td>
              <td>${admin.twoFactorEnabled ? html`<span class="badge badge-success">Sí</span>` : html`<span class="badge badge-neutral">No</span>`}</td>
              <td>${admin.lastLoginAt ? formatUtcAsLocal(admin.lastLoginAt, OFFSET) : html`<span class="subtle">Nunca</span>`}</td>
              <td>${admin.isActive ? html`<span class="badge badge-success">Activa</span>` : html`<span class="badge badge-neutral">Desactivada</span>`}</td>
              <td class="align-right">${admin.id === me.id ? '' : html`<button class="button button-ghost button-small" data-toggle="${admin.id}" data-active="${admin.isActive ? '1' : '0'}">${admin.isActive ? 'Desactivar' : 'Activar'}</button>`}</td>
            </tr>`)}</tbody></table></div>`}
      </section>`,
  );
  refreshIcons(content);

  content.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'password') openPasswordModal();
    if (action === 'enable-2fa') await openEnableTwoFactor(reload);
    if (action === 'disable-2fa') openDisableTwoFactor(reload);
    if (action === 'new-admin') openNewAdmin(reload);
    const toggle = target.closest<HTMLElement>('[data-toggle]');
    if (toggle) {
      const isActive = toggle.dataset.active !== '1';
      const done = await withErrorToast(() => api.put(`/api/platform/admins/${toggle.dataset.toggle}/active`, { isActive }));
      if (done) {
        toast(isActive ? 'Cuenta activada.' : 'Cuenta desactivada y sesiones cerradas.', 'info');
        await reload();
      }
    }
  };
}

function openPasswordModal(): void {
  openFormModal({
    title: 'Cambiar contraseña',
    iconName: 'key-round',
    submitLabel: 'Guardar',
    fields: html`<label class="field"><span>Contraseña actual</span><input type="password" name="currentPassword" required autocomplete="current-password" /></label>
      <label class="field"><span>Nueva contraseña</span><input type="password" name="newPassword" required minlength="10" autocomplete="new-password" />
        <small class="field-hint">Mínimo 10 caracteres, con letras y números. Se cerrarán tus sesiones en otros dispositivos.</small></label>`,
    onSubmit: async (form) => {
      await api.post('/api/platform/account/password', readForm(form));
      toast('Contraseña actualizada.', 'success');
    },
  });
}

async function openEnableTwoFactor(reload: () => Promise<void>): Promise<void> {
  const setup = await withErrorToast(() => api.post<{ secret: string; otpauthUrl: string }>('/api/platform/account/2fa/start'));
  if (!setup) return;
  // Librería de QR cargada solo aquí (no pesa en el resto del panel).
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(setup.otpauthUrl);
  qr.make();
  const modal = openFormModal({
    title: 'Activar verificación en dos pasos',
    iconName: 'smartphone',
    submitLabel: 'Activar',
    fields: html`<ol class="steps-list">
        <li>Instala una app autenticadora gratuita: <strong>Google Authenticator</strong>, <strong>Microsoft Authenticator</strong> o Authy.</li>
        <li>Escanea este código QR con la app${html`<div class="qr-box">${raw(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}</div>`}
          Si estás en el celular: <a href="${setup.otpauthUrl}">abrir en la app autenticadora</a>, o escribe la clave manualmente:
          <div class="secret-row"><code>${setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code> <button type="button" class="icon-button" data-copy aria-label="Copiar clave">${icon('copy')}</button></div></li>
        <li>Escribe el código de 6 dígitos que muestra la app:</li>
      </ol>
      <label class="field"><span>Código</span><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="123456" /></label>`,
    onSubmit: async (form) => {
      await api.post('/api/platform/account/2fa/confirm', { code: readForm(form).code });
      toast('Verificación en dos pasos activada.', 'success');
      await reload();
    },
  });
  $('[data-copy]', modal.body).addEventListener('click', () => copyToClipboard(setup.secret, 'Clave copiada.'));
}

function openDisableTwoFactor(reload: () => Promise<void>): void {
  openFormModal({
    title: 'Desactivar verificación en dos pasos',
    iconName: 'triangle-alert',
    danger: true,
    submitLabel: 'Desactivar',
    fields: html`<p class="muted">Tu cuenta quedará protegida solo con la contraseña.</p>
      <label class="field"><span>Confirma tu contraseña</span><input type="password" name="password" required autocomplete="current-password" /></label>`,
    onSubmit: async (form) => {
      await api.post('/api/platform/account/2fa/disable', readForm(form));
      toast('Verificación en dos pasos desactivada.', 'info');
      await reload();
    },
  });
}

function openNewAdmin(reload: () => Promise<void>): void {
  openFormModal({
    title: 'Nueva cuenta de plataforma',
    iconName: 'user-plus',
    submitLabel: 'Crear cuenta',
    fields: html`<p class="muted">Tendrá acceso completo al panel del dueño (consultorios, pagos y configuración). Créala solo para personas de total confianza.</p>
      <label class="field"><span>Nombre</span><input name="fullName" required maxlength="120" /></label>
      <label class="field"><span>Correo</span><input name="email" type="email" required maxlength="200" /></label>
      <label class="field"><span>Contraseña inicial</span><input name="password" type="password" required minlength="10" autocomplete="new-password" /></label>`,
    onSubmit: async (form) => {
      await api.post('/api/platform/admins', readForm(form));
      toast('Cuenta creada. Pídele que active la verificación en dos pasos.', 'success');
      await reload();
    },
  });
}

