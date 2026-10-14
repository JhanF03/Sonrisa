/**
 * Usuarios y roles con permisos granulares (matriz de permisos editable).
 */
import { api } from '../../core/api.js';
import { emptyToNull, html, readForm, setContent } from '../../core/dom.js';
import { formatUtcAsLocal } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, refreshIcons, toast, withErrorToast } from '../../core/ui.js';
import { can, clinicOffset, session } from '../session.js';

interface UserView {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  roleIds: string[];
}

interface RoleView {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

interface PermissionInfo {
  key: string;
  module: string;
  label: string;
}

type Tab = 'usuarios' | 'roles';
let activeTab: Tab = 'usuarios';

export async function renderUsersView(container: HTMLElement): Promise<void> {
  if (!can('usuarios.gestionar')) activeTab = 'roles';
  setContent(container, loadingState());

  const [users, roles, catalog] = await Promise.all([
    can('usuarios.gestionar') ? api.get<UserView[]>('/api/users') : Promise.resolve([] as UserView[]),
    api.get<RoleView[]>('/api/roles'),
    api.get<PermissionInfo[]>('/api/auth/permission-catalog'),
  ]);
  const reload = () => renderUsersView(container);
  const roleName = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? '—';

  setContent(
    container,
    html`<div class="tabs" role="tablist">
      ${can('usuarios.gestionar') ? html`<button class="tab ${activeTab === 'usuarios' ? 'is-active' : ''}" data-tab="usuarios">${icon('users')} Usuarios</button>` : ''}
      <button class="tab ${activeTab === 'roles' ? 'is-active' : ''}" data-tab="roles">${icon('shield-check')} Roles y permisos</button>
    </div>
    ${activeTab === 'usuarios'
      ? html`<section class="card">
          <div class="card-header"><h3>${icon('users')} Usuarios</h3><button class="button button-primary" data-action="new-user">${icon('user-plus')} Nuevo usuario</button></div>
          <div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Nombre</th><th>Correo</th><th>Roles</th><th>Último ingreso</th><th>Estado</th><th></th></tr></thead>
            <tbody>${users.map((user) => html`<tr>
              <td><strong>${user.fullName}</strong>${user.id === session().user.id ? html` <span class="badge badge-info">Tú</span>` : ''}</td>
              <td>${user.email}</td>
              <td>${user.roleIds.map((roleId) => html`<span class="badge badge-neutral">${roleName(roleId)}</span> `)}</td>
              <td class="nowrap">${user.lastLoginAt ? formatUtcAsLocal(user.lastLoginAt, clinicOffset()) : html`<span class="subtle">Nunca</span>`}</td>
              <td>${user.isActive ? html`<span class="badge badge-success">Activo</span>` : html`<span class="badge badge-neutral">Inactivo</span>`}</td>
              <td class="align-right nowrap">
                <button class="icon-button" data-edit-user="${user.id}" aria-label="Editar" data-tooltip="Editar roles y estado">${icon('pencil')}</button>
                <button class="icon-button" data-reset-user="${user.id}" aria-label="Restablecer contraseña" data-tooltip="Asignar nueva contraseña">${icon('key-round')}</button>
              </td></tr>`)}</tbody>
          </table></div>
        </section>`
      : html`<section class="card">
          <div class="card-header"><h3>${icon('shield-check')} Roles</h3>
            ${can('roles.gestionar') ? html`<button class="button button-primary" data-action="new-role">${icon('plus')} Nuevo rol</button>` : ''}</div>
          <div class="card-padded subtle">${icon('info')} Un rol es un conjunto de permisos. Cada vista y cada botón del sistema se controla con un permiso, y el servidor lo verifica en cada acción. Solo puedes otorgar permisos que tú tienes.</div>
          ${roles.length === 0
            ? emptyState('shield-check', 'Sin roles', '')
            : html`<div class="table-wrapper"><table class="data-table">
              <thead><tr><th>Rol</th><th>Descripción</th><th>Permisos</th><th>Usuarios</th><th></th></tr></thead>
              <tbody>${roles.map((role) => html`<tr>
                <td><strong>${role.name}</strong>${role.isSystem ? html` <span class="badge badge-warning">${icon('lock')} Sistema</span>` : ''}</td>
                <td>${role.description ?? '—'}</td>
                <td>${role.permissions.length} de ${catalog.length}</td>
                <td>${role.userCount}</td>
                <td class="align-right nowrap">
                  <button class="icon-button" data-edit-role="${role.id}" aria-label="${role.isSystem || !can('roles.gestionar') ? 'Ver permisos' : 'Editar'}" data-tooltip="${role.isSystem || !can('roles.gestionar') ? 'Ver permisos' : 'Editar permisos'}">${icon(role.isSystem || !can('roles.gestionar') ? 'eye' : 'pencil')}</button>
                  ${!role.isSystem && can('roles.gestionar') ? html`<button class="icon-button is-danger" data-delete-role="${role.id}" aria-label="Eliminar" data-tooltip="Eliminar rol">${icon('trash-2')}</button>` : ''}
                </td></tr>`)}</tbody></table></div>`}
        </section>`}`,
  );
  refreshIcons(container);

  container.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined;
    if (tab) {
      activeTab = tab;
      await reload();
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'new-user') openUserModal(null, roles, reload);
    if (action === 'new-role') openRoleModal(null, catalog, reload);

    const editUser = users.find((user) => user.id === target.closest<HTMLElement>('[data-edit-user]')?.dataset.editUser);
    if (editUser) openUserModal(editUser, roles, reload);
    const resetUser = users.find((user) => user.id === target.closest<HTMLElement>('[data-reset-user]')?.dataset.resetUser);
    if (resetUser) openResetPasswordModal(resetUser);
    const editRole = roles.find((role) => role.id === target.closest<HTMLElement>('[data-edit-role]')?.dataset.editRole);
    if (editRole) openRoleModal(editRole, catalog, reload);
    const deleteRoleId = target.closest<HTMLElement>('[data-delete-role]')?.dataset.deleteRole;
    if (deleteRoleId && window.confirm('¿Eliminar este rol? Esta acción queda en la auditoría.')) {
      if (await withErrorToast(() => api.delete(`/api/roles/${deleteRoleId}`))) {
        toast('Rol eliminado.', 'success');
        await reload();
      }
    }
  };
}

function openUserModal(user: UserView | null, roles: RoleView[], onDone: () => Promise<void>): void {
  openFormModal({
    title: user ? `Editar ${user.fullName}` : 'Nuevo usuario',
    iconName: user ? 'pencil' : 'user-plus',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
      <label class="field full"><span>Nombre completo</span><input name="fullName" required maxlength="120" value="${user?.fullName ?? ''}" /></label>
      ${user
        ? html`<p class="full muted">${icon('user')} ${user.email}</p>`
        : html`<label class="field"><span>Correo (para ingresar)</span><input name="email" type="email" required maxlength="200" autocomplete="off" /></label>
               <label class="field"><span>Contraseña inicial</span><input name="password" type="password" required minlength="10" autocomplete="new-password" />
                 <small class="field-hint">Mínimo 10 caracteres, con letras y números. Pídele que la cambie al ingresar.</small></label>`}
      <div class="field full"><span>Roles</span>
        <div style="display: grid; gap: 8px">${roles.map((role) => html`<label class="checkbox"><input type="checkbox" name="role" value="${role.id}" ${user?.roleIds.includes(role.id) ? 'checked' : ''} />
          <span><strong>${role.name}</strong> <span class="subtle">${role.description ?? ''}</span></span></label>`)}</div></div>
      ${user ? html`<label class="checkbox full"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''} /><span>Usuario activo (si lo desactivas, se cierran sus sesiones)</span></label>` : ''}
    </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const roleIds = [...form.querySelectorAll<HTMLInputElement>('input[name="role"]:checked')].map((input) => input.value);
      if (user) {
        await api.put(`/api/users/${user.id}`, {
          fullName: values.fullName,
          isActive: (form.elements.namedItem('isActive') as HTMLInputElement).checked,
          roleIds,
        });
      } else {
        await api.post('/api/users', { fullName: values.fullName, email: values.email, password: values.password, roleIds });
      }
      toast('Usuario guardado.', 'success');
      await onDone();
    },
  });
}

function openResetPasswordModal(user: UserView): void {
  openFormModal({
    title: `Nueva contraseña para ${user.fullName}`,
    iconName: 'key-round',
    submitLabel: 'Asignar contraseña',
    fields: html`<p class="muted">Se cerrarán todas sus sesiones abiertas.</p>
      <label class="field"><span>Nueva contraseña</span><input type="password" name="password" required minlength="10" autocomplete="new-password" /></label>`,
    onSubmit: async (form) => {
      await api.post(`/api/users/${user.id}/reset-password`, { password: readForm(form).password });
      toast('Contraseña actualizada.', 'success');
    },
  });
}

function openRoleModal(role: RoleView | null, catalog: PermissionInfo[], onDone: () => Promise<void>): void {
  const isReadOnly = Boolean(role?.isSystem) || !can('roles.gestionar');
  const myPermissions = new Set(session().permissions);
  const modules = [...new Set(catalog.map((permission) => permission.module))];

  openFormModal({
    title: role ? (isReadOnly ? `Permisos de ${role.name}` : `Editar rol ${role.name}`) : 'Nuevo rol',
    iconName: 'shield-check',
    submitLabel: isReadOnly ? 'Cerrar' : 'Guardar rol',
    size: 'wide',
    fields: html`<div class="form-grid">
        <label class="field"><span>Nombre del rol</span><input name="name" required maxlength="60" value="${role?.name ?? ''}" ${isReadOnly ? 'disabled' : ''} /></label>
        <label class="field"><span>Descripción</span><input name="description" maxlength="200" value="${role?.description ?? ''}" ${isReadOnly ? 'disabled' : ''} /></label>
      </div>
      ${modules.map((moduleName) => html`<div class="permission-group">
        <h4>${moduleName}</h4>
        <div class="permission-grid">${catalog
          .filter((permission) => permission.module === moduleName)
          .map((permission) => {
            const isChecked = role?.permissions.includes(permission.key) ?? false;
            const isLocked = isReadOnly || (!myPermissions.has(permission.key) && !isChecked);
            return html`<label class="permission-item checkbox ${isLocked && !isReadOnly ? 'is-locked' : ''}" ${isLocked && !isReadOnly ? html`data-tooltip="No puedes otorgar un permiso que no tienes"` : ''}>
              <input type="checkbox" name="permission" value="${permission.key}" ${isChecked ? 'checked' : ''} ${isLocked ? 'disabled' : ''} />
              <span>${permission.label}<code>${permission.key}</code></span></label>`;
          })}</div>
      </div>`)}`,
    onSubmit: async (form) => {
      if (isReadOnly) return;
      const values = readForm(form);
      const permissions = [...form.querySelectorAll<HTMLInputElement>('input[name="permission"]:checked')].map((input) => input.value);
      const payload = { name: values.name, description: emptyToNull(values.description), permissions };
      if (role) await api.put(`/api/roles/${role.id}`, payload);
      else await api.post('/api/roles', payload);
      toast('Rol guardado.', 'success');
      await onDone();
    },
  });
}
