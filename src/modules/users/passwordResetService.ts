/**
 * "¿Olvidaste tu contraseña?" sin depender del dueño del sistema.
 *
 * • La respuesta es la misma exista o no el correo (no revela quién tiene cuenta).
 * • El enlace lleva un token aleatorio de 256 bits; en la base solo se guarda su
 *   huella (SHA-256). Sirve una sola vez y vence en 1 hora.
 * • Al cambiarla se cierran todas las sesiones del usuario y queda en la bitácora.
 */
import type { SqlDatabase } from '../../db/database.js';
import { AppError } from '../../http/errors.js';
import type { AuditService } from '../audit/auditService.js';
import type { AuthService } from '../../security/authService.js';
import { generateSecureToken, sha256Hex } from '../../security/crypto.js';
import { RATE_LIMIT_RULES, type RateLimiter } from '../../security/rateLimiter.js';
import { isoNow } from '../../utils/time.js';
import type { MailService } from '../mail/mailService.js';
import { passwordResetEmail } from '../mail/templates.js';
import type { PlatformService } from '../platform/platformService.js';

const RESET_TTL_MS = 60 * 60_000;
const RESET_PER_EMAIL = { limit: 3, windowMs: 60 * 60_000, message: 'Ya enviamos varios enlaces. Revisa tu correo o espera una hora.' };

export class PasswordResetService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
    private readonly mail: MailService,
    private readonly platform: PlatformService,
  ) {}

  /** Pide el enlace. Devuelve siempre igual; el correo se envía en segundo plano. */
  async request(email: string, ip: string, requestOrigin: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    await this.rateLimiter.consume(`reset:ip:${ip}`, RATE_LIMIT_RULES.loginPerIp);
    await this.rateLimiter.consume(`reset:email:${normalized}`, RESET_PER_EMAIL);
    const user = await this.db
      .prepare(
        `SELECT u.id, u.tenant_id, u.full_name FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = ? AND u.is_active = 1 AND t.is_showcase = 0`,
      )
      .bind(normalized)
      .first<{ id: string; tenant_id: string; full_name: string }>();
    if (!user) return;
    const token = generateSecureToken(32);
    await this.db
      .prepare('INSERT INTO password_resets (token_hash, user_id, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), user.id, user.tenant_id, Date.now() + RESET_TTL_MS, isoNow())
      .run();
    const [legal, baseUrl] = await Promise.all([this.platform.getLegalInfo(), this.platform.publicUrl(requestOrigin)]);
    this.mail.queue(
      this.mail.send(
        passwordResetEmail({ to: normalized, name: user.full_name, url: `${baseUrl}/app#/restablecer/${encodeURIComponent(token)}`, legal, baseUrl }),
        { kind: 'recuperar_clave', tenantId: user.tenant_id },
      ),
    );
  }

  async reset(token: string, newPassword: string, ip: string): Promise<void> {
    const tokenHash = await sha256Hex(token);
    const row = await this.db
      .prepare('SELECT user_id, tenant_id, expires_at, used_at FROM password_resets WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ user_id: string; tenant_id: string; expires_at: number; used_at: string | null }>();
    if (!row || row.used_at || row.expires_at < Date.now()) {
      throw new AppError('El enlace no es válido o ya venció. Pide uno nuevo desde "¿Olvidaste tu contraseña?".', 400, 'RESET_INVALID');
    }
    const passwordHash = await this.auth.hashNewPassword(newPassword);
    // Marca única: si dos pestañas usan el mismo enlace a la vez, solo una cambia la clave.
    const marker = `${isoNow()} ${crypto.randomUUID()}`;
    const [claimed] = await this.db.batch([
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(marker, tokenHash),
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND EXISTS (SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at = ?)').bind(passwordHash, row.user_id, tokenHash, marker),
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at = ?)').bind(row.user_id, tokenHash, marker),
      this.audit.buildStatement({ tenantId: row.tenant_id, userId: row.user_id, ip }, { action: 'clave_recuperada', entity: 'usuario', entityId: row.user_id }),
    ]);
    if ((claimed?.meta?.changes ?? 0) === 0) throw new AppError('El enlace ya se usó.', 400, 'RESET_INVALID');
  }
}
