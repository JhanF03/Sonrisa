/**
 * Envío de correos con la cuenta de Gmail del dueño.
 *
 * • Si el correo no está configurado, no falla: deja el envío como "omitido"
 *   en el registro (email_log) y el sistema sigue funcionando.
 * • Un correo que falla nunca rompe un pago ni un registro: se anota el error.
 * • Los envíos se pueden dejar corriendo en segundo plano (`queue`); en Workers
 *   se mantienen vivos con waitUntil y en las pruebas se esperan con `flush`.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { AppConfig } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../security/secretBox.js';
import { isoNow } from '../../utils/time.js';
import { sendSmtp, type OpenSocket, type OutgoingMail } from './smtpClient.js';

const GMAIL_HOST = 'smtp.gmail.com';
const GMAIL_PORT = 465;

export interface MailSettingsView {
  smtpUser: string;
  smtpFromName: string;
  maskedPassword: string | null;
  configured: boolean;
  notifyOwner: boolean;
}

interface MailRow {
  smtp_user: string | null;
  smtp_password_enc: string | null;
  smtp_from_name: string | null;
  notify_owner: number;
  legal_email: string | null;
}

export class MailService {
  private readonly pending = new Set<Promise<unknown>>();
  /** Copia breve de la configuración: ahorra consultas a D1 (50 por ejecución en el plan gratuito). */
  private cached: { row: MailRow | null; at: number } | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly openSocket: OpenSocket | null,
  ) {}

  private async row(): Promise<MailRow | null> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.row;
    const row = await this.db.prepare('SELECT smtp_user, smtp_password_enc, smtp_from_name, notify_owner, legal_email FROM platform_settings WHERE id = 1').first<MailRow>();
    this.cached = { row, at: Date.now() };
    return row;
  }

  /** Olvida la copia breve de la configuración (tras cambiar datos legales o de correo). */
  forgetCachedSettings(): void {
    this.cached = null;
  }

  async getSettings(): Promise<MailSettingsView> {
    const row = await this.row();
    const password = row?.smtp_password_enc ? await decryptSecret(this.config.appSecret, row.smtp_password_enc, 'platform:smtp').catch(() => null) : null;
    return {
      smtpUser: row?.smtp_user ?? '',
      smtpFromName: row?.smtp_from_name ?? '',
      maskedPassword: password ? maskSecret(password) : null,
      configured: Boolean(row?.smtp_user && password),
      notifyOwner: row?.notify_owner !== 0,
    };
  }

  async saveSettings(input: { smtpUser: string | null; smtpPassword: string | null; smtpFromName: string | null; notifyOwner: boolean }): Promise<MailSettingsView> {
    const current = await this.row();
    const password = input.smtpPassword
      ? await encryptSecret(this.config.appSecret, input.smtpPassword.replace(/\s+/g, ''), 'platform:smtp')
      : input.smtpUser
        ? current?.smtp_password_enc ?? null
        : null;
    await this.db
      .prepare('UPDATE platform_settings SET smtp_user = ?, smtp_password_enc = ?, smtp_from_name = ?, notify_owner = ?, updated_at = ? WHERE id = 1')
      .bind(input.smtpUser?.trim().toLowerCase() || null, password, input.smtpFromName, input.notifyOwner ? 1 : 0, isoNow())
      .run();
    this.cached = null;
    return this.getSettings();
  }

  /** Correo del dueño para avisos (el de contacto legal o el de Gmail). */
  async ownerAddress(): Promise<string | null> {
    const row = await this.row();
    if (row?.notify_owner === 0) return null;
    return row?.legal_email || row?.smtp_user || null;
  }

  /** Envía y registra el resultado. Devuelve true si salió. Nunca lanza error. */
  async send(mail: OutgoingMail, meta: { kind: string; tenantId?: string | null }): Promise<boolean> {
    const log = (status: 'enviado' | 'fallido' | 'omitido', error: string | null) =>
      this.db
        .prepare('INSERT INTO email_log (id, tenant_id, kind, recipient, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), meta.tenantId ?? null, meta.kind, mail.to.slice(0, 200), mail.subject.slice(0, 200), status, error, isoNow())
        .run()
        .catch(() => undefined);
    try {
      const row = await this.row();
      const password = row?.smtp_password_enc ? await decryptSecret(this.config.appSecret, row.smtp_password_enc, 'platform:smtp') : null;
      if (!row?.smtp_user || !password || !this.openSocket) {
        await log('omitido', 'Correo no configurado');
        return false;
      }
      await sendSmtp(
        this.openSocket,
        { host: GMAIL_HOST, port: GMAIL_PORT, user: row.smtp_user, password, fromName: row.smtp_from_name || 'Agenda Sonrisa' },
        { ...mail, replyTo: mail.replyTo ?? row.legal_email ?? null },
      );
      await log('enviado', null);
      return true;
    } catch (error) {
      await log('fallido', (error instanceof Error ? error.message : String(error)).slice(0, 300));
      return false;
    }
  }

  /** Envía en segundo plano (no hace esperar a quien hizo la petición). */
  queue(task: Promise<unknown>): void {
    const tracked = task.catch((error: unknown) => console.error('[correo]', error)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Espera los envíos pendientes (pruebas y tareas programadas). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Correo de prueba desde Configuración: aquí sí se informa el error exacto. */
  async sendTest(to: string): Promise<void> {
    const sent = await this.send(
      { to, subject: 'Prueba de correo · Agenda Sonrisa', text: 'Si lees esto, el correo de Agenda Sonrisa quedó bien configurado.', html: '<p>Si lees esto, el correo de <strong>Agenda Sonrisa</strong> quedó bien configurado.</p>' },
      { kind: 'prueba' },
    );
    if (!sent) {
      const last = await this.db.prepare("SELECT status, error FROM email_log WHERE kind = 'prueba' ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string | null }>();
      throw new AppError(last?.status === 'omitido' ? 'Primero guarda tu correo de Gmail y la contraseña de aplicación.' : `No se pudo enviar: ${last?.error ?? 'error desconocido'}`, 422, 'MAIL_FAILED');
    }
  }

  async listLog(limit = 100): Promise<Array<{ id: string; kind: string; recipient: string; subject: string; status: string; error: string | null; created_at: string; tenant_name: string | null }>> {
    const { results } = await this.db
      .prepare('SELECT e.id, e.kind, e.recipient, e.subject, e.status, e.error, e.created_at, t.name AS tenant_name FROM email_log e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.created_at DESC LIMIT ?')
      .bind(limit)
      .all<{ id: string; kind: string; recipient: string; subject: string; status: string; error: string | null; created_at: string; tenant_name: string | null }>();
    return results;
  }
}
