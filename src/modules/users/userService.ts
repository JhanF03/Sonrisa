/**
 * Usuarios y roles con permisos granulares.
 *
 * Protecciones contra escalamiento de privilegios:
 * • Nadie puede otorgar (a un rol o a un usuario) permisos que no tiene.
 * • El rol "Administrador" del sistema no se puede editar ni eliminar.
 * • Siempre debe quedar al menos un administrador activo.
 * • Un usuario no puede desactivarse a sí mismo.
 * • Solo se puede editar o cambiar la clave de usuarios con iguales o menos
 *   permisos (evita que alguien tome la cuenta de un administrador).
 * • Al desactivar o cambiar la clave de alguien, se cierran sus sesiones.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import { sqlPlaceholders } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { AppError, conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthService } from '../../security/authService.js';
import { verifyPassword } from '../../security/crypto.js';
import { isPermission, PERMISSION_CATALOG, type Permission } from '../../security/permissions.js';
import { isoNow } from '../../utils/time.js';
import { diffFields, type AuditService } from '../audit/auditService.js';
import { assertNotDemoDomain, claimEmail } from './emailClaims.js';
import type { PlanService } from '../plans/planService.js';

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
  userCount: number;
}

export interface UserView {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  roleIds: string[];
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: number;
  user_count: number;
}

export class UserService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly seats?: Pick<PlanService, 'assertSeatAvailable'>,
  ) {}

  // ─── Roles ────────────────────────────────────────────────────────────────

  async listRoles(tenantId: string): Promise<RoleView[]> {
    const [roleResult, permissionResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT r.id, r.name, r.description, r.is_system,
                  (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
           FROM roles r WHERE r.tenant_id = ? ORDER BY r.is_system DESC, r.name`,
        )
        .bind(tenantId)
        .all<RoleRow>(),
      this.db
        .prepare('SELECT rp.role_id, rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.tenant_id = ?')
        .bind(tenantId)
        .all<{ role_id: string; permission: string }>(),
    ]);

    return roleResult.results.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.is_system === 1,
      userCount: role.user_count,
      permissions: permissionResult.results
        .filter((row) => row.role_id === role.id)
        .map((row) => row.permission)
        .filter(isPermission),
    }));
  }

  async createRole(
    actor: Actor,
    actorPermissions: ReadonlySet<Permission>,
    input: { name: string; description: string | null; permissions: Permission[] },
  ): Promise<RoleView> {
    assertCanGrant(actorPermissions, input.permissions);
    await this.assertRoleNameAvailable(actor.tenantId, input.name);

    const roleId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare('INSERT INTO roles (id, tenant_id, name, description, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .bind(roleId, actor.tenantId, input.name, input.description, isoNow()),
      ...this.permissionInserts(roleId, input.permissions),
      this.audit.buildStatement(actor, { action: 'rol_creado', entity: 'rol', entityId: roleId, details: { name: input.name, permissions: input.permissions } }),
    ]);
    return this.getRole(actor.tenantId, roleId);
  }

  async updateRole(
    actor: Actor,
    actorPermissions: ReadonlySet<Permission>,
    roleId: string,
    input: { name: string; description: string | null; permissions: Permission[] },
  ): Promise<RoleView> {
    const role = await this.getRole(actor.tenantId, roleId);
    if (role.isSystem) throw forbidden('El rol Administrador no se puede modificar.');

    // Solo se exige poseer los permisos que se AGREGAN; quitar siempre está permitido.
    const addedPermissions = input.permissions.filter((permission) => !role.permissions.includes(permission));
    assertCanGrant(actorPermissions, addedPermissions);
    if (input.name !== role.name) await this.assertRoleNameAvailable(actor.tenantId, input.name);

    await this.db.batch([
      this.db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ? AND tenant_id = ?').bind(input.name, input.description, roleId, actor.tenantId),
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(roleId),
      ...this.permissionInserts(roleId, input.permissions),
      this.audit.buildStatement(actor, {
        action: 'rol_actualizado',
        entity: 'rol',
        entityId: roleId,
        details: {
          added: addedPermissions,
          removed: role.permissions.filter((permission) => !input.permissions.includes(permission)),
        },
      }),
    ]);
    return this.getRole(actor.tenantId, roleId);
  }

  async deleteRole(actor: Actor, roleId: string): Promise<void> {
    const role = await this.getRole(actor.tenantId, roleId);
    if (role.isSystem) throw forbidden('El rol Administrador no se puede eliminar.');
    if (role.userCount > 0) throw conflict('Quita este rol a sus usuarios antes de eliminarlo.');

    await this.db.batch([
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(roleId),
      this.db.prepare('DELETE FROM roles WHERE id = ? AND tenant_id = ?').bind(roleId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'rol_eliminado', entity: 'rol', entityId: roleId, details: { name: role.name } }),
    ]);
  }

  async getRole(tenantId: string, roleId: string): Promise<RoleView> {
    const role = (await this.listRoles(tenantId)).find((candidate) => candidate.id === roleId);
    if (!role) throw notFound('El rol');
    return role;
  }

  // ─── Usuarios ─────────────────────────────────────────────────────────────

  async listUsers(tenantId: string): Promise<UserView[]> {
    const [userResult, roleResult] = await Promise.all([
      this.db
        .prepare('SELECT id, email, full_name, is_active, last_login_at FROM users WHERE tenant_id = ? ORDER BY full_name')
        .bind(tenantId)
        .all<{ id: string; email: string; full_name: string; is_active: number; last_login_at: string | null }>(),
      this.db
        .prepare('SELECT ur.user_id, ur.role_id FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.tenant_id = ?')
        .bind(tenantId)
        .all<{ user_id: string; role_id: string }>(),
    ]);

    return userResult.results.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      isActive: user.is_active === 1,
      lastLoginAt: user.last_login_at,
      roleIds: roleResult.results.filter((row) => row.user_id === user.id).map((row) => row.role_id),
    }));
  }

  async createUser(
    actor: Actor,
    actorPermissions: ReadonlySet<Permission>,
    input: { email: string; fullName: string; password: string; roleIds: string[] },
  ): Promise<UserView> {
    await this.assertCanAssignRoles(actor.tenantId, actorPermissions, input.roleIds);
    const normalizedEmail = input.email.trim().toLowerCase();
    const tenant = await this.db.prepare('SELECT is_showcase FROM tenants WHERE id = ?').bind(actor.tenantId).first<{ is_showcase: number }>();
    const isShowcase = tenant?.is_showcase === 1;
    if (!isShowcase) assertNotDemoDomain(normalizedEmail);
    await claimEmail(this.db, normalizedEmail, isShowcase);
    await this.seats?.assertSeatAvailable(actor.tenantId, 'usuario');

    const userId = crypto.randomUUID();
    const passwordHash = await this.auth.hashNewPassword(input.password);
    await this.db.batch([
      this.db
        .prepare('INSERT INTO users (id, tenant_id, email, full_name, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(userId, actor.tenantId, normalizedEmail, input.fullName, passwordHash, isoNow()),
      ...this.roleAssignments(userId, input.roleIds),
      this.audit.buildStatement(actor, { action: 'usuario_creado', entity: 'usuario', entityId: userId, details: { email: normalizedEmail, roleIds: input.roleIds } }),
    ]);
    return this.getUser(actor.tenantId, userId);
  }

  async updateUser(
    actor: Actor,
    actorPermissions: ReadonlySet<Permission>,
    userId: string,
    input: { fullName: string; isActive: boolean; roleIds: string[] },
  ): Promise<UserView> {
    const user = await this.getUser(actor.tenantId, userId);
    if (userId === actor.userId && !input.isActive) throw forbidden('No puedes desactivar tu propio usuario.');
    await this.assertCanManageUser(actorPermissions, userId);

    const addedRoleIds = input.roleIds.filter((roleId) => !user.roleIds.includes(roleId));
    await this.assertCanAssignRoles(actor.tenantId, actorPermissions, addedRoleIds);
    await this.assertRolesBelongToTenant(actor.tenantId, input.roleIds);
    await this.assertAdministratorRemains(actor.tenantId, userId, input);
    if (input.isActive && !user.isActive) await this.seats?.assertSeatAvailable(actor.tenantId, 'usuario');

    await this.db.batch([
      this.db
        .prepare('UPDATE users SET full_name = ?, is_active = ? WHERE id = ? AND tenant_id = ?')
        .bind(input.fullName, input.isActive ? 1 : 0, userId, actor.tenantId),
      this.db.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(userId),
      ...this.roleAssignments(userId, input.roleIds),
      this.audit.buildStatement(actor, {
        action: 'usuario_actualizado',
        entity: 'usuario',
        entityId: userId,
        details: {
          cambios: diffFields(
            { fullName: user.fullName, isActive: user.isActive, roleIds: [...user.roleIds].sort() },
            { fullName: input.fullName, isActive: input.isActive, roleIds: [...input.roleIds].sort() },
            ['fullName', 'isActive', 'roleIds'],
          ),
        },
      }),
    ]);

    if (!input.isActive) await this.auth.revokeUserSessions(userId);
    return this.getUser(actor.tenantId, userId);
  }

  async resetPassword(
    actor: Actor,
    actorPermissions: ReadonlySet<Permission>,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    await this.getUser(actor.tenantId, userId);
    await this.assertCanManageUser(actorPermissions, userId);
    const passwordHash = await this.auth.hashNewPassword(newPassword);
    await this.db.batch([
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?').bind(passwordHash, userId, actor.tenantId),
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      this.audit.buildStatement(actor, { action: 'clave_restablecida', entity: 'usuario', entityId: userId }),
    ]);
  }

  async changeOwnPassword(actor: Actor & { userId: string }, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.db
      .prepare('SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?')
      .bind(actor.userId, actor.tenantId)
      .first<{ password_hash: string }>();
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError('La contraseña actual no es correcta.', 422, 'WRONG_PASSWORD');
    }
    const passwordHash = await this.auth.hashNewPassword(newPassword);
    await this.db.batch([
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, actor.userId),
      this.audit.buildStatement(actor, { action: 'clave_cambiada', entity: 'usuario', entityId: actor.userId }),
    ]);
  }

  async getUser(tenantId: string, userId: string): Promise<UserView> {
    const user = (await this.listUsers(tenantId)).find((candidate) => candidate.id === userId);
    if (!user) throw notFound('El usuario');
    return user;
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async assertCanManageUser(actorPermissions: ReadonlySet<Permission>, targetUserId: string): Promise<void> {
    const targetPermissions = await this.auth.loadPermissions(targetUserId);
    const exceeds = [...targetPermissions].some((permission) => !actorPermissions.has(permission));
    if (exceeds) throw forbidden('No puedes modificar a un usuario con más permisos que tú.');
  }

  private permissionInserts(roleId: string, permissions: Permission[]): SqlStatement[] {
    return [...new Set(permissions)].map((permission) =>
      this.db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(roleId, permission),
    );
  }

  private roleAssignments(userId: string, roleIds: string[]): SqlStatement[] {
    return [...new Set(roleIds)].map((roleId) =>
      this.db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(userId, roleId),
    );
  }

  private async assertRoleNameAvailable(tenantId: string, name: string): Promise<void> {
    const existing = await this.db.prepare('SELECT 1 FROM roles WHERE tenant_id = ? AND name = ?').bind(tenantId, name).first();
    if (existing) throw conflict('Ya existe un rol con ese nombre.');
  }

  private async assertRolesBelongToTenant(tenantId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const uniqueRoleIds = [...new Set(roleIds)];
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM roles WHERE tenant_id = ? AND id IN (${sqlPlaceholders(uniqueRoleIds.length)})`)
      .bind(tenantId, ...uniqueRoleIds)
      .first<{ total: number }>();
    if ((row?.total ?? 0) !== uniqueRoleIds.length) throw notFound('Uno de los roles');
  }

  private async assertCanAssignRoles(tenantId: string, actorPermissions: ReadonlySet<Permission>, roleIds: string[]): Promise<void> {
    await this.assertRolesBelongToTenant(tenantId, roleIds);
    if (roleIds.length === 0) return;
    const roles = await this.listRoles(tenantId);
    for (const roleId of roleIds) {
      const role = roles.find((candidate) => candidate.id === roleId);
      if (role) assertCanGrant(actorPermissions, role.permissions);
    }
  }

  private async assertAdministratorRemains(
    tenantId: string,
    userId: string,
    input: { isActive: boolean; roleIds: string[] },
  ): Promise<void> {
    const adminRole = (await this.listRoles(tenantId)).find((role) => role.isSystem);
    if (!adminRole) return;

    const keepsAdmin = input.isActive && input.roleIds.includes(adminRole.id);
    if (keepsAdmin) return;

    const otherAdmins = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.role_id = ? AND u.is_active = 1 AND u.id <> ?`,
      )
      .bind(adminRole.id, userId)
      .first<{ total: number }>();
    if ((otherAdmins?.total ?? 0) === 0) {
      throw conflict('Debe quedar al menos un administrador activo.');
    }
  }
}

function assertCanGrant(actorPermissions: ReadonlySet<Permission>, requestedPermissions: readonly Permission[]): void {
  const missing = requestedPermissions.filter((permission) => !actorPermissions.has(permission));
  if (missing.length > 0) {
    const labels = missing.map((permission) => PERMISSION_CATALOG[permission].label).join(', ');
    throw forbidden(`No puedes otorgar permisos que no tienes: ${labels}.`);
  }
}
