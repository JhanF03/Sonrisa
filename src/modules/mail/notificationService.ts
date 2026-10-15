/**
 * Avisos automáticos por correo: lo que antes dependía del dueño.
 *
 *   Registro      → bienvenida al consultorio + aviso al dueño
 *   Demo          → usuario y vencimiento al interesado + aviso al dueño; aviso 2 días antes de borrarse
 *   Pago aplicado → comprobante de pago al consultorio + aviso al dueño
 *   Vencimientos  → 5 días antes, el día anterior, vencida (gracia) y suspendida (una vez cada uno)
 *
 * Los recordatorios los envía la tarea programada; cada aviso se anota en
 * subscription_notices para no repetirlo.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { TenantRow } from '../../http/context.js';
import { subscriptionOfTenant } from '../../shared/subscription.js';
import { formatCop } from '../../utils/money.js';
import { isoNow } from '../../utils/time.js';
import type { PlatformService } from '../platform/platformService.js';
import type { MailService } from './mailService.js';
import {
  demoEmail, demoEndingEmail, ownerAlertEmail, receiptEmail, reminderEmail, welcomeEmail, type ReminderKind,
} from './templates.js';

/** Pocos por vez: cada aviso usa ~4 consultas y el plan gratuito de D1 permite 50 por ejecución. Corre cada hora. */
const REMINDERS_PER_RUN = 6;

export class NotificationService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly mail: MailService,
    private readonly platform: PlatformService,
  ) {}

  private async context(requestOrigin?: string | null) {
    const { uvtValue: _uvt, publicUrl, ...legal } = await this.platform.getLegalSettings();
    return { legal, baseUrl: publicUrl || requestOrigin || '' };
  }

  private async adminOf(tenantId: string): Promise<{ email: string; full_name: string } | null> {
    return this.db
      .prepare(
        `SELECT u.email, u.full_name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ? AND r.is_system = 1 AND u.is_active = 1 ORDER BY u.created_at LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ email: string; full_name: string }>();
  }

  private async alertOwner(subject: string, lines: string[], requestOrigin?: string | null): Promise<void> {
    const to = await this.mail.ownerAddress();
    if (!to) return;
    const { legal, baseUrl } = await this.context(requestOrigin);
    await this.mail.send(ownerAlertEmail({ to, subject, lines, baseUrl, legal }), { kind: 'aviso_dueno' });
  }

  async welcome(tenantId: string, planName: string, requestOrigin: string): Promise<void> {
    const tenant = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first<TenantRow>();
    const admin = await this.adminOf(tenantId);
    if (!tenant || !admin || !tenant.paid_until) return;
    const { legal, baseUrl } = await this.context(requestOrigin);
    await this.mail.send(
      welcomeEmail({ to: admin.email, name: admin.full_name, clinicName: tenant.name, planName, trialUntil: tenant.paid_until, baseUrl, legal }),
      { kind: 'bienvenida', tenantId },
    );
    await this.alertOwner(`Nuevo consultorio: ${tenant.name}`, [
      `${admin.full_name} (${admin.email}${tenant.contact_phone ? `, ${tenant.contact_phone}` : ''}) creó ${tenant.name}${tenant.city ? ` en ${tenant.city}` : ''}.`,
      `Plan ${planName}, prueba gratis hasta el ${tenant.paid_until}.`,
    ], requestOrigin);
  }

  async demoCreated(input: { tenantId: string; name: string; contactEmail: string; phone: string | null; loginEmail: string; expiresAt: string }, requestOrigin: string): Promise<void> {
    const { legal, baseUrl } = await this.context(requestOrigin);
    await this.mail.send(demoEmail({ to: input.contactEmail, name: input.name, loginEmail: input.loginEmail, expiresAt: input.expiresAt, baseUrl, legal }), { kind: 'demo', tenantId: input.tenantId });
    await this.alertOwner(`Nueva demo: ${input.name}`, [`${input.name} (${input.contactEmail}${input.phone ? `, ${input.phone}` : ''}) creó una demo que vence el ${input.expiresAt.slice(0, 10)}.`], requestOrigin);
  }

  async paymentReceived(paymentId: string): Promise<void> {
    const receipt = await this.platform.getReceipt(paymentId);
    const { baseUrl } = await this.context();
    if (receipt.customer.email) {
      const payment = await this.db.prepare('SELECT tenant_id FROM subscription_payments WHERE id = ?').bind(paymentId).first<{ tenant_id: string }>();
      await this.mail.send(receiptEmail({ to: receipt.customer.email, receipt, baseUrl }), { kind: 'comprobante', tenantId: payment?.tenant_id ?? null });
    }
    await this.alertOwner(`Pago recibido: ${formatCop(receipt.amount)}`, [
      `${receipt.customer.clinicName} pagó ${formatCop(receipt.amount)} (${receipt.method}).`,
      `${receipt.concept}. Cubre hasta el ${receipt.paidUntil}.`,
    ]);
  }

  /** Recordatorios de vencimiento y de demos por terminar (tarea programada). */
  async sendReminders(nowMs = Date.now()): Promise<number> {
    let sent = 0;
    const { legal, baseUrl } = await this.context();
    const horizon = new Date(nowMs + 6 * 86_400_000).toISOString().slice(0, 10);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM tenants WHERE is_showcase = 0 AND billing_mode IN ('auto', 'suspendido') AND paid_until IS NOT NULL AND paid_until <= ?
         ORDER BY paid_until DESC LIMIT 200`,
      )
      .bind(horizon)
      .all<TenantRow>();
    for (const tenant of results) {
      if (sent >= REMINDERS_PER_RUN) break;
      const status = subscriptionOfTenant(tenant, nowMs);
      const kind: ReminderKind | null =
        status.state === 'por_vencer' ? ((status.daysLeft ?? 0) <= 1 ? 'vence_manana' : 'por_vencer')
          : status.state === 'en_gracia' ? 'vencida'
            : status.state === 'suspendido' && (status.daysLeft ?? -999) >= -45 ? 'suspendida'
              : null;
      if (!kind || !tenant.paid_until) continue;
      if (!(await this.claimNotice(tenant.id, kind, tenant.paid_until))) continue;
      const admin = await this.adminOf(tenant.id);
      if (!admin) continue;
      await this.mail.send(
        reminderEmail({
          to: admin.email, kind, clinicName: tenant.name, onTrial: tenant.on_trial === 1, paidUntil: tenant.paid_until,
          suspendOn: status.suspendOn, monthlyPrice: tenant.monthly_price, baseUrl, legal,
        }),
        { kind: `recordatorio_${kind}`, tenantId: tenant.id },
      );
      sent++;
    }

    // Demos de autoservicio que se borran en menos de 2 días (y que aún no crearon su consultorio).
    const soon = new Date(nowMs + 2 * 86_400_000).toISOString();
    const { results: demos } = await this.db
      .prepare(
        `SELECT * FROM tenants WHERE is_showcase = 1 AND signup_source = 'autoservicio' AND converted_tenant_id IS NULL
           AND contact_email IS NOT NULL AND demo_expires_at > ? AND demo_expires_at <= ? LIMIT 20`,
      )
      .bind(new Date(nowMs).toISOString(), soon)
      .all<TenantRow>();
    for (const demo of demos) {
      if (sent >= REMINDERS_PER_RUN) break;
      if (!demo.demo_expires_at || !demo.contact_email) continue;
      if (!(await this.claimNotice(demo.id, 'demo_por_vencer', demo.demo_expires_at))) continue;
      await this.mail.send(
        demoEndingEmail({ to: demo.contact_email, name: demo.contact_name ?? '', expiresAt: demo.demo_expires_at, baseUrl, legal }),
        { kind: 'demo_por_vencer', tenantId: demo.id },
      );
      sent++;
    }
    return sent;
  }

  /** true si este aviso no se había enviado (y lo deja anotado). */
  private async claimNotice(tenantId: string, kind: string, periodKey: string): Promise<boolean> {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO subscription_notices (tenant_id, kind, period_key, created_at) VALUES (?, ?, ?, ?)')
      .bind(tenantId, kind, periodKey, isoNow())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
