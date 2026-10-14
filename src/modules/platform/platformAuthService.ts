/**
 * Cuentas y sesiones del dueño de la plataforma.
 *
 * • Ingreso con correo + contraseña (PBKDF2), mismo mensaje para usuario
 *   inexistente o clave errada, tiempos igualados y límite de intentos por
 *   IP y por correo.
 * • Verificación en dos pasos opcional (TOTP, app autenticadora). Un código
 *   no se puede reutilizar.
 * • Sesión en cookie HttpOnly + SameSite=Strict; en la base solo se guarda el
 *   hash del token. Cambiar la contraseña cierra las demás sesiones.
 * • La clave maestra (PLATFORM_ADMIN_KEY) solo sirve para crear la primera
 *   cuenta y para recuperar el acceso si se pierde la contraseña o el celular.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { AppConfig } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import type { AuthService } from '../../security/authService.js';
import { constantTimeEqualText, generateSecureToken, sha256Hex, verifyPassword } from '../../security/crypto.js';
import { RATE_LIMIT_RULES, type RateLimiter } from '../../security/rateLimiter.js';
import { decryptSecret, encryptSecret } from '../../security/secretBox.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../security/totp.js';
import { isoNow } from '../../utils/time.js';

const SESSION_HOURS = 12;
const MIN_MASTER_KEY_LENGTH = 24;
const INVALID_LOGIN = 'Correo o contraseña incorrectos.';

export interface PlatformAdmin {
  id: string;
  email: string;
  fullName: string;
  twoFactorEnabled: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface AdminRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_last_step: number;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}

const toAdmin = (row: AdminRow): PlatformAdmin => ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  twoFactorEnabled: Boolean(row.totp_secret_enc),
  isActive: row.is_active === 1,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

export class PlatformAuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  private audit(action: string, details: unknown, ip: string | null) {
    return this.db
      .prepare('INSERT INTO platform_audit (id, action, tenant_id, details, ip, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
      .bind(crypto.randomUUID(), action, details === null ? null : JSON.stringify(details), ip, isoNow());
  }

  private totpAad = (adminId: string) => `platform-admin:${adminId}:totp`;

  async hasAdmins(): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT 1 AS ok FROM platform_admins LIMIT 1').first());
  }

  /** Verifica la clave maestra (con límite de intentos por IP). */
  async assertMasterKey(providedKey: string, ip: string): Promise<void> {
    await this.rateLimiter.consume(`platform:${ip}`, RATE_LIMIT_RULES.platformPerIp);
    const configuredKey = this.config.platformAdminKey;
    if (configuredKey.length < MIN_MASTER_KEY_LENGTH) {
      throw new AppError('La plataforma no está habilitada en este servidor (falta PLATFORM_ADMIN_KEY).', 403, 'PLATFORM_DISABLED');
    }
    if (!(await constantTimeEqualText(providedKey, configuredKey))) {
      throw new AppError('Clave maestra incorrecta.', 403, 'PLATFORM_FORBIDDEN');
    }
  }

  // ─── Primera cuenta y recuperación ────────────────────────────────────────

  async setupFirstAdmin(input: { masterKey: string; fullName: string; email: string; password: string }, ip: string): Promise<void> {
    await this.assertMasterKey(input.masterKey, ip);
    if (await this.hasAdmins()) throw new AppError('Ya existe una cuenta de dueño. Ingresa con tu correo.', 409, 'ALREADY_SETUP');
    await this.insertAdmin(input, ip, 'cuenta_dueno_creada');
  }

  async recoverAccess(input: { masterKey: string; email: string; newPassword: string }, ip: string): Promise<void> {
    await this.assertMasterKey(input.masterKey, ip);
    const admin = await this.db.prepare('SELECT id FROM platform_admins WHERE email = ?').bind(input.email.trim().toLowerCase()).first<{ id: string }>();
    if (!admin) throw new AppError('No existe una cuenta de dueño con ese correo.', 404, 'NOT_FOUND');
    await this.db.batch([
      // Se quita la verificación en dos pasos: quien recupera puede haber perdido el celular.
      this.db
        .prepare('UPDATE platform_admins SET password_hash = ?, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = 0, is_active = 1 WHERE id = ?')
        .bind(await this.auth.hashNewPassword(input.newPassword), admin.id),
      this.db.prepare('DELETE FROM platform_sessions WHERE admin_id = ?').bind(admin.id),
      this.audit('acceso_recuperado', { email: input.email }, ip),
    ]);
  }

  private async insertAdmin(input: { fullName: string; email: string; password: string }, ip: string, action: string): Promise<string> {
    const email = input.email.trim().toLowerCase();
    if (await this.db.prepare('SELECT 1 AS ok FROM platform_admins WHERE email = ?').bind(email).first()) {
      throw new AppError('Ya existe una cuenta con ese correo.', 409, 'DUPLICATE_EMAIL');
    }
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare('INSERT INTO platform_admins (id, email, full_name, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(id, email, input.fullName, await this.auth.hashNewPassword(input.password), isoNow()),
      this.audit(action, { email }, ip),
    ]);
    return id;
  }

  // ─── Ingreso ──────────────────────────────────────────────────────────────

  async login(input: { email: string; password: string; code: string | null }, ip: string): Promise<{ token: string; expiresAt: string; admin: PlatformAdmin }> {
    const email = input.email.trim().toLowerCase();
    await this.rateLimiter.consume(`platform-login:ip:${ip}`, RATE_LIMIT_RULES.loginPerIp);
    await this.rateLimiter.consume(`platform-login:email:${email}`, RATE_LIMIT_RULES.loginPerEmail);

    const admin = await this.db.prepare('SELECT * FROM platform_admins WHERE email = ?').bind(email).first<AdminRow>();
    this.dummyHash ??= this.auth.hashNewPassword(generateSecureToken(16));
    const isValid = await verifyPassword(input.password, admin?.password_hash ?? (await this.dummyHash));
    if (!admin || !isValid || admin.is_active !== 1) {
      await this.audit('ingreso_fallido', { email }, ip).run();
      throw new AppError(INVALID_LOGIN, 401, 'INVALID_CREDENTIALS');
    }

    let usedStep: number | null = null;
    if (admin.totp_secret_enc) {
      if (!input.code) throw new AppError('Escribe el código de 6 dígitos de tu app autenticadora.', 401, 'TOTP_REQUIRED');
      const secret = await decryptSecret(this.config.appSecret, admin.totp_secret_enc, this.totpAad(admin.id));
      usedStep = await verifyTotp(secret, input.code, admin.totp_last_step);
      if (usedStep === null) {
        await this.audit('codigo_2fa_fallido', { email }, ip).run();
        throw new AppError('El código no es válido o ya se usó. Espera el siguiente.', 401, 'TOTP_INVALID');
      }
    }

    await this.rateLimiter.reset(`platform-login:email:${email}`);
    const token = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString();
    await this.db.batch([
      this.db.prepare('DELETE FROM platform_sessions WHERE expires_at < ?').bind(isoNow()),
      this.db
        .prepare('INSERT INTO platform_sessions (token_hash, admin_id, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256Hex(token), admin.id, ip, isoNow(), expiresAt),
      this.db
        .prepare('UPDATE platform_admins SET last_login_at = ?, totp_last_step = MAX(totp_last_step, ?) WHERE id = ?')
        .bind(isoNow(), usedStep ?? 0, admin.id),
      this.audit('ingreso_plataforma', { email }, ip),
    ]);
    return { token, expiresAt, admin: toAdmin({ ...admin, last_login_at: isoNow() }) };
  }

  async resolveSession(token: string | undefined): Promise<PlatformAdmin | null> {
    if (!token || token.length > 100) return null;
    const row = await this.db
      .prepare(
        `SELECT a.* FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND a.is_active = 1`,
      )
      .bind(await sha256Hex(token), isoNow())
      .first<AdminRow>();
    return row ? toAdmin(row) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.prepare('DELETE FROM platform_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }

  // ─── Mi cuenta ────────────────────────────────────────────────────────────

  private async getRow(adminId: string): Promise<AdminRow> {
    const row = await this.db.prepare('SELECT * FROM platform_admins WHERE id = ?').bind(adminId).first<AdminRow>();
    if (!row) throw notFound('La cuenta');
    return row;
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string, currentToken: string | undefined, ip: string): Promise<void> {
    const row = await this.getRow(adminId);
    if (!(await verifyPassword(currentPassword, row.password_hash))) throw new AppError('La contraseña actual no es correcta.', 422, 'WRONG_PASSWORD');
    await this.db.batch([
      this.db.prepare('UPDATE platform_admins SET password_hash = ? WHERE id = ?').bind(await this.auth.hashNewPassword(newPassword), adminId),
      // Cierra las demás sesiones (otros dispositivos), deja la actual.
      this.db.prepare('DELETE FROM platform_sessions WHERE admin_id = ? AND token_hash != ?').bind(adminId, currentToken ? await sha256Hex(currentToken) : ''),
      this.audit('clave_dueno_cambiada', { email: row.email }, ip),
    ]);
  }

  async startTwoFactor(adminId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const row = await this.getRow(adminId);
    const secret = generateTotpSecret();
    await this.db
      .prepare('UPDATE platform_admins SET totp_pending_enc = ? WHERE id = ?')
      .bind(await encryptSecret(this.config.appSecret, secret, this.totpAad(adminId)), adminId)
      .run();
    return { secret, otpauthUrl: otpauthUrl(secret, row.email) };
  }

  async confirmTwoFactor(adminId: string, code: string, ip: string): Promise<void> {
    const row = await this.getRow(adminId);
    if (!row.totp_pending_enc) throw new AppError('Primero genera el código QR.', 409, 'NO_PENDING');
    const secret = await decryptSecret(this.config.appSecret, row.totp_pending_enc, this.totpAad(adminId));
    const step = await verifyTotp(secret, code, 0);
    if (step === null) throw new AppError('El código no coincide. Revisa la hora del celular e intenta con el siguiente código.', 422, 'TOTP_INVALID');
    await this.db.batch([
      this.db
        .prepare('UPDATE platform_admins SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = ? WHERE id = ?')
        .bind(step, adminId),
      this.audit('2fa_activada', { email: row.email }, ip),
    ]);
  }

  async disableTwoFactor(adminId: string, password: string, ip: string): Promise<void> {
    const row = await this.getRow(adminId);
    if (!(await verifyPassword(password, row.password_hash))) throw new AppError('La contraseña no es correcta.', 422, 'WRONG_PASSWORD');
    await this.db.batch([
      this.db.prepare('UPDATE platform_admins SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = 0 WHERE id = ?').bind(adminId),
      this.audit('2fa_desactivada', { email: row.email }, ip),
    ]);
  }

  // ─── Otras cuentas de dueño (socios, contador…) ───────────────────────────

  async listAdmins(): Promise<PlatformAdmin[]> {
    const { results } = await this.db.prepare('SELECT * FROM platform_admins ORDER BY created_at').all<AdminRow>();
    return results.map(toAdmin);
  }

  async createAdmin(input: { fullName: string; email: string; password: string }, ip: string): Promise<PlatformAdmin> {
    const id = await this.insertAdmin(input, ip, 'cuenta_dueno_creada');
    return toAdmin(await this.getRow(id));
  }

  async setAdminActive(actorId: string, adminId: string, isActive: boolean, ip: string): Promise<void> {
    if (actorId === adminId && !isActive) throw new AppError('No puedes desactivar tu propia cuenta.', 409, 'SELF');
    const row = await this.getRow(adminId);
    if (!isActive) {
      const active = await this.db.prepare('SELECT COUNT(*) AS total FROM platform_admins WHERE is_active = 1').first<{ total: number }>();
      if ((active?.total ?? 0) <= 1) throw new AppError('Debe quedar al menos una cuenta activa.', 409, 'LAST_ADMIN');
    }
    await this.db.batch([
      this.db.prepare('UPDATE platform_admins SET is_active = ? WHERE id = ?').bind(isActive ? 1 : 0, adminId),
      ...(isActive ? [] : [this.db.prepare('DELETE FROM platform_sessions WHERE admin_id = ?').bind(adminId)]),
      this.audit(isActive ? 'cuenta_dueno_activada' : 'cuenta_dueno_desactivada', { email: row.email }, ip),
    ]);
  }
}
