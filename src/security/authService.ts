/**
 * Autenticación: ingreso, sesiones y carga de permisos.
 *
 * Decisiones de seguridad:
 * • El token de sesión viaja solo en una cookie HttpOnly; en la base se guarda
 *   su hash SHA-256 (si alguien lee la base, no puede suplantar sesiones).
 * • Mismo mensaje de error para "usuario no existe" y "clave incorrecta",
 *   con verificación de hash simulada para no filtrar por tiempo de respuesta.
 * • Límite de intentos por IP y por correo.
 */
import type { SqlDatabase } from '../db/database.js';
import { AppError } from '../http/errors.js';
import type { AppConfig, AuthContext, TenantRow } from '../http/context.js';
import { isoNow } from '../utils/time.js';
import type { AuditService } from '../modules/audit/auditService.js';
import { generateSecureToken, getHashIterations, hashPassword, sha256Hex, verifyPassword } from './crypto.js';
import { isPermission, type Permission } from './permissions.js';
import { ALL_PLAN_MODULES, moduleOfPermission, parseModules } from '../shared/plans.js';
import { RATE_LIMIT_RULES, type RateLimiter } from './rateLimiter.js';

const INVALID_CREDENTIALS_MESSAGE = 'Correo o contraseña incorrectos.';
const HOUR_MS = 3_600_000;

interface LoginUserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  is_active: number;
}

interface SessionUserRow {
  user_id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  expires_at: number;
}

export interface LoginResult {
  sessionToken: string;
  expiresAt: number;
}

export class AuthService {
  private dummyPasswordHash: Promise<string> | undefined;

  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, clientIp: string, userAgent: string): Promise<LoginResult> {
    const normalizedEmail = email.trim().toLowerCase();
    await this.rateLimiter.consume(`login:ip:${clientIp}`, RATE_LIMIT_RULES.loginPerIp);
    await this.rateLimiter.consume(`login:email:${normalizedEmail}`, RATE_LIMIT_RULES.loginPerEmail);

    const user = await this.db
      .prepare('SELECT id, tenant_id, email, password_hash, is_active FROM users WHERE email = ?')
      .bind(normalizedEmail)
      .first<LoginUserRow>();

    // Se verifica un hash aunque el usuario no exista, para igualar tiempos.
    const passwordHash = user?.password_hash ?? (await this.getDummyPasswordHash());
    const isPasswordValid = await verifyPassword(password, passwordHash);

    if (!user || !isPasswordValid || user.is_active !== 1) {
      if (user) {
        await this.audit.record(
          { tenantId: user.tenant_id, userId: user.id, ip: clientIp },
          { action: 'login_fallido', entity: 'usuario', entityId: user.id },
        );
      }
      throw new AppError(INVALID_CREDENTIALS_MESSAGE, 401, 'INVALID_CREDENTIALS');
    }

    await this.rateLimiter.reset(`login:email:${normalizedEmail}`);

    const sessionToken = generateSecureToken(32);
    const expiresAt = Date.now() + this.config.sessionTtlHours * HOUR_MS;
    const now = isoNow();

    // Si cambió la configuración de iteraciones, se re-cifra la clave ahora
    // que la conocemos (permite subir o bajar el costo sin resetear claves).
    const rehashStatements =
      getHashIterations(user.password_hash) !== this.config.passwordHashIterations
        ? [this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await this.hashNewPassword(password), user.id)]
        : [];

    await this.db.batch([
      ...rehashStatements,
      this.db
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, created_at, ip, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(await sha256Hex(sessionToken), user.id, user.tenant_id, expiresAt, now, clientIp, userAgent.slice(0, 300)),
      this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, user.id),
      // Mantenimiento: limpia sesiones vencidas y contadores de intentos de hace más de un día.
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
      this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - 24 * HOUR_MS),
      this.audit.buildStatement(
        { tenantId: user.tenant_id, userId: user.id, ip: clientIp },
        { action: 'login', entity: 'usuario', entityId: user.id },
      ),
    ]);

    return { sessionToken, expiresAt };
  }

  /** Devuelve el contexto del usuario si la sesión es válida; si no, undefined. */
  async resolveSession(sessionToken: string): Promise<AuthContext | undefined> {
    const tokenHash = await sha256Hex(sessionToken);
    const now = Date.now();

    const sessionRow = await this.db
      .prepare(
        `SELECT s.user_id, s.tenant_id, u.email, u.full_name, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id AND u.is_active = 1 AND u.tenant_id = s.tenant_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<SessionUserRow>();

    if (!sessionRow) return undefined;

    // SELECT * para que cualquier columna nueva del consultorio llegue sola al contexto.
    const [tenant, permissions, professional] = await Promise.all([
      this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(sessionRow.tenant_id).first<TenantRow>(),
      this.loadPermissions(sessionRow.user_id),
      this.db
        .prepare('SELECT id FROM professionals WHERE user_id = ? AND tenant_id = ? AND is_active = 1')
        .bind(sessionRow.user_id, sessionRow.tenant_id)
        .first<{ id: string }>(),
    ]);
    if (!tenant) return undefined;

    // Renovación deslizante: si queda menos de la mitad del tiempo, se extiende.
    const sessionTtlMs = this.config.sessionTtlHours * HOUR_MS;
    if (sessionRow.expires_at - now < sessionTtlMs / 2) {
      await this.db
        .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
        .bind(now + sessionTtlMs, tokenHash)
        .run();
    }

    // El plan del consultorio recorta los permisos del rol (las demos tienen todo).
    const enabledModules = tenant.is_showcase === 1 ? ALL_PLAN_MODULES : parseModules(tenant.enabled_modules);
    const allowed = new Set<Permission>();
    const locked = new Set<Permission>();
    for (const permission of permissions) {
      const module = moduleOfPermission(permission);
      (module === null || enabledModules.includes(module) ? allowed : locked).add(permission);
    }

    return {
      userId: sessionRow.user_id,
      email: sessionRow.email,
      fullName: sessionRow.full_name,
      tenant,
      permissions: allowed,
      lockedPermissions: locked,
      professionalId: professional?.id ?? null,
    };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(sessionToken)).run();
  }

  /** Cierra las sesiones del usuario en otros dispositivos y conserva la actual. */
  async revokeOtherSessions(userId: string, currentSessionToken: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .bind(userId, await sha256Hex(currentSessionToken))
      .run();
  }

  /** Cierra todas las sesiones de un usuario (al desactivarlo o cambiar su clave). */
  async revokeUserSessions(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  }

  async loadPermissions(userId: string): Promise<Set<Permission>> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT rp.permission FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ?`,
      )
      .bind(userId)
      .all<{ permission: string }>();
    return new Set(results.map((row) => row.permission).filter(isPermission));
  }

  hashNewPassword(password: string): Promise<string> {
    return hashPassword(password, this.config.passwordHashIterations);
  }

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword(generateSecureToken(16), this.config.passwordHashIterations);
    return this.dummyPasswordHash;
  }
}
