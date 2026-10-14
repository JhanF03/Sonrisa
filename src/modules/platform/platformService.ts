/**
 * Plataforma del dueño del software: sesión, consultorios (reales y demos),
 * suscripciones, pagos y configuración de cobro.
 *
 * Suscripción:
 *  • El acceso se calcula en cada petición con paid_until + días de gracia
 *    (ver shared/subscription.ts). Pagar mueve paid_until y el acceso vuelve
 *    al instante, sin procesos programados.
 *  • Pagos manuales (los registra el dueño) o en línea con el Wompi DEL DUEÑO:
 *    el evento firmado + la consulta a la API de Wompi confirman el pago y
 *    reactivan solos. Un mismo pago nunca se aplica dos veces (external_id único).
 */
import type { SqlDatabase } from '../../db/database.js';
import type { AppConfig, TenantRow } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { generateSecureToken } from '../../security/crypto.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../security/secretBox.js';
import {
  addDaysToDate,
  computeSubscription,
  extendPaidUntil,
  type SubscriptionStatus,
} from '../../shared/subscription.js';
import { normalizePhone } from '../../utils/phone.js';
import { isoNow, todayLocal } from '../../utils/time.js';
import type { AuthService } from '../../security/authService.js';
import {
  buildCheckoutUrl,
  EVENT_ENVIRONMENT,
  KEY_PREFIXES,
  verifyEventChecksum,
  type WompiApi,
  type WompiEnvironment,
  type WompiEvent,
} from '../payments/wompiClient.js';

const COLOMBIA_OFFSET = -300;
const SUBSCRIPTION_REFERENCE_PREFIX = 'SUB-';

export const SUBSCRIPTION_PAYMENT_METHODS = ['transferencia', 'nequi', 'daviplata', 'efectivo', 'tarjeta', 'wompi', 'otro'] as const;

interface PlatformSettingsRow {
  owner_name: string | null;
  owner_whatsapp: string | null;
  payment_instructions: string | null;
  default_monthly_price: number;
  default_grace_days: number;
  default_trial_days: number;
  wompi_environment: WompiEnvironment | null;
  wompi_public_key: string | null;
  wompi_integrity_enc: string | null;
  wompi_events_enc: string | null;
}

export interface PlatformSettingsView {
  ownerName: string;
  ownerWhatsapp: string;
  paymentInstructions: string;
  defaultMonthlyPrice: number;
  defaultGraceDays: number;
  defaultTrialDays: number;
  wompiEnvironment: WompiEnvironment | null;
  wompiPublicKey: string;
  maskedIntegritySecret: string | null;
  maskedEventsSecret: string | null;
  wompiConfigured: boolean;
}

export interface TenantOverview {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  isShowcase: boolean;
  createdAt: string;
  adminEmail: string | null;
  users: number;
  patients: number;
  appointmentsLast30: number;
  lastLoginAt: string | null;
  monthlyPrice: number;
  graceDays: number;
  billingMode: 'auto' | 'exento' | 'suspendido';
  ownerNotes: string | null;
  subscription: SubscriptionStatus;
  lastPaymentAt: string | null;
}

export interface SubscriptionPaymentRow {
  id: string;
  tenant_id: string;
  amount: number;
  months: number;
  previous_paid_until: string | null;
  new_paid_until: string;
  method: string;
  reference: string | null;
  status: 'aprobado' | 'anulado';
  notes: string | null;
  void_reason: string | null;
  created_at: string;
}

const today = () => todayLocal(COLOMBIA_OFFSET);

export function subscriptionOf(tenant: Pick<TenantRow, 'is_showcase' | 'billing_mode' | 'paid_until' | 'grace_days' | 'utc_offset_minutes'>): SubscriptionStatus {
  return computeSubscription(
    { isShowcase: tenant.is_showcase === 1, billingMode: tenant.billing_mode, paidUntil: tenant.paid_until, graceDays: tenant.grace_days },
    todayLocal(tenant.utc_offset_minutes),
  );
}

export class PlatformService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly wompi: WompiApi,
  ) {}

  private auditStatement(action: string, tenantId: string | null, details: unknown, ip: string | null) {
    return this.db
      .prepare('INSERT INTO platform_audit (id, action, tenant_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), action, tenantId, details === null ? null : JSON.stringify(details), ip, isoNow());
  }

  async listAudit(limit = 200): Promise<Array<{ id: string; action: string; tenant_id: string | null; tenant_name: string | null; details: string | null; ip: string | null; created_at: string }>> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.action, a.tenant_id, t.name AS tenant_name, a.details, a.ip, a.created_at
         FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<{ id: string; action: string; tenant_id: string | null; tenant_name: string | null; details: string | null; ip: string | null; created_at: string }>();
    return results;
  }

  // ─── Configuración ────────────────────────────────────────────────────────

  private async getSettingsRow(): Promise<PlatformSettingsRow> {
    const row = await this.db.prepare('SELECT * FROM platform_settings WHERE id = 1').first<PlatformSettingsRow>();
    if (!row) throw new AppError('Falta la configuración de la plataforma (migración 0005).', 500, 'PLATFORM_NOT_MIGRATED');
    return row;
  }

  async getSettings(): Promise<PlatformSettingsView> {
    const row = await this.getSettingsRow();
    const [integrity, events] = await this.decryptWompiSecrets(row);
    return {
      ownerName: row.owner_name ?? '',
      ownerWhatsapp: row.owner_whatsapp ?? '',
      paymentInstructions: row.payment_instructions ?? '',
      defaultMonthlyPrice: row.default_monthly_price,
      defaultGraceDays: row.default_grace_days,
      defaultTrialDays: row.default_trial_days,
      wompiEnvironment: row.wompi_environment,
      wompiPublicKey: row.wompi_public_key ?? '',
      maskedIntegritySecret: integrity ? maskSecret(integrity) : null,
      maskedEventsSecret: events ? maskSecret(events) : null,
      wompiConfigured: Boolean(row.wompi_environment && row.wompi_public_key && integrity && events),
    };
  }

  private async decryptWompiSecrets(row: PlatformSettingsRow): Promise<[string | null, string | null]> {
    const read = (value: string | null, purpose: string) =>
      value ? decryptSecret(this.config.appSecret, value, `platform:${purpose}`).catch(() => null) : Promise.resolve(null);
    return Promise.all([read(row.wompi_integrity_enc, 'integrity'), read(row.wompi_events_enc, 'events')]);
  }

  async saveSettings(
    input: {
      ownerName: string | null;
      ownerWhatsapp: string | null;
      paymentInstructions: string | null;
      defaultMonthlyPrice: number;
      defaultGraceDays: number;
      defaultTrialDays: number;
      wompiEnvironment: WompiEnvironment | null;
      wompiPublicKey: string | null;
      wompiIntegritySecret: string | null;
      wompiEventsSecret: string | null;
    },
    ip: string,
  ): Promise<PlatformSettingsView> {
    const current = await this.getSettingsRow();
    const [currentIntegrity, currentEvents] = await this.decryptWompiSecrets(current);
    const whatsapp = input.ownerWhatsapp ? normalizePhone(input.ownerWhatsapp) : null;
    if (input.ownerWhatsapp && !whatsapp?.isMobile) throw new AppError('El WhatsApp del dueño debe ser un celular.', 422, 'INVALID_PHONE');

    let integrity = input.wompiIntegritySecret ?? currentIntegrity;
    let events = input.wompiEventsSecret ?? currentEvents;
    let publicKey = input.wompiPublicKey ?? current.wompi_public_key;
    const environment = input.wompiEnvironment;
    if (environment) {
      const prefixes = KEY_PREFIXES[environment];
      if (!publicKey?.startsWith(prefixes.publicKey) || !integrity?.startsWith(prefixes.integrity) || !events?.startsWith(prefixes.events)) {
        throw new AppError(
          `Las llaves de Wompi no corresponden al ambiente ${environment === 'sandbox' ? 'de pruebas' : 'de producción'} (deben empezar por ${prefixes.publicKey}, ${prefixes.integrity} y ${prefixes.events}).`,
          422,
          'INVALID_WOMPI_KEYS',
        );
      }
    } else {
      integrity = null;
      events = null;
      publicKey = null;
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE platform_settings SET owner_name = ?, owner_whatsapp = ?, payment_instructions = ?, default_monthly_price = ?,
             default_grace_days = ?, default_trial_days = ?, wompi_environment = ?, wompi_public_key = ?, wompi_integrity_enc = ?,
             wompi_events_enc = ?, updated_at = ? WHERE id = 1`,
        )
        .bind(
          input.ownerName, whatsapp?.e164 ?? null, input.paymentInstructions, input.defaultMonthlyPrice, input.defaultGraceDays,
          input.defaultTrialDays, environment, publicKey,
          integrity ? await encryptSecret(this.config.appSecret, integrity, 'platform:integrity') : null,
          events ? await encryptSecret(this.config.appSecret, events, 'platform:events') : null,
          isoNow(),
        ),
      this.auditStatement('configuracion_plataforma', null, { wompi: environment ?? 'desactivado' }, ip),
    ]);
    return this.getSettings();
  }

  async testWompi(): Promise<{ message: string }> {
    const row = await this.getSettingsRow();
    if (!row.wompi_environment || !row.wompi_public_key) throw new AppError('Primero guarda las llaves de Wompi.', 422, 'WOMPI_NOT_CONFIGURED');
    const merchant = await this.wompi.getMerchant(row.wompi_environment, row.wompi_public_key).catch(() => null);
    if (!merchant) throw new AppError('Wompi no reconoce la llave pública en ese ambiente.', 422, 'WOMPI_INVALID');
    return { message: `Conectado con el comercio "${merchant.name}".` };
  }

  // ─── Consultorios ─────────────────────────────────────────────────────────

  async listTenants(): Promise<TenantOverview[]> {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT t.*,
           (SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
             WHERE u.tenant_id = t.id AND r.is_system = 1 AND u.is_active = 1 ORDER BY u.created_at LIMIT 1) AS admin_email,
           (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active = 1) AS users_count,
           (SELECT COUNT(*) FROM patients p WHERE p.tenant_id = t.id) AS patients_count,
           (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id = t.id AND a.created_at >= ?) AS appointments_30,
           (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
           (SELECT MAX(sp.created_at) FROM subscription_payments sp WHERE sp.tenant_id = t.id AND sp.status = 'aprobado') AS last_payment_at
         FROM tenants t ORDER BY t.is_showcase, t.created_at DESC`,
      )
      .bind(since)
      .all<TenantRow & { admin_email: string | null; users_count: number; patients_count: number; appointments_30: number; last_login_at: string | null; last_payment_at: string | null; owner_notes: string | null }>();
    return results.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      city: row.city,
      isShowcase: row.is_showcase === 1,
      createdAt: row.created_at,
      adminEmail: row.admin_email,
      users: row.users_count,
      patients: row.patients_count,
      appointmentsLast30: row.appointments_30,
      lastLoginAt: row.last_login_at,
      monthlyPrice: row.monthly_price,
      graceDays: row.grace_days,
      billingMode: row.billing_mode,
      ownerNotes: row.owner_notes,
      subscription: subscriptionOf(row),
      lastPaymentAt: row.last_payment_at,
    }));
  }

  async getSummary(): Promise<{ realClinics: number; demos: number; active: number; dueSoon: number; inGrace: number; suspended: number; monthlyRecurring: number; collectedThisMonth: number }> {
    const tenants = await this.listTenants();
    const real = tenants.filter((tenant) => !tenant.isShowcase);
    const monthStart = `${today().slice(0, 8)}01`;
    const collected = await this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM subscription_payments WHERE status = 'aprobado' AND created_at >= ?")
      .bind(new Date(`${monthStart}T05:00:00Z`).toISOString())
      .first<{ total: number }>();
    return {
      realClinics: real.length,
      demos: tenants.length - real.length,
      active: real.filter((tenant) => ['al_dia', 'por_vencer', 'exento'].includes(tenant.subscription.state)).length,
      dueSoon: real.filter((tenant) => tenant.subscription.state === 'por_vencer').length,
      inGrace: real.filter((tenant) => tenant.subscription.state === 'en_gracia').length,
      suspended: real.filter((tenant) => tenant.subscription.state === 'suspendido').length,
      monthlyRecurring: real.filter((tenant) => tenant.billingMode === 'auto' && !tenant.subscription.blocked).reduce((sum, tenant) => sum + tenant.monthlyPrice, 0),
      collectedThisMonth: collected?.total ?? 0,
    };
  }

  private async getTenant(tenantId: string): Promise<TenantRow> {
    const tenant = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first<TenantRow>();
    if (!tenant) throw notFound('El consultorio');
    return tenant;
  }

  async getDefaults(): Promise<{ trialUntil: string; monthlyPrice: number; graceDays: number }> {
    const settings = await this.getSettingsRow();
    return { trialUntil: addDaysToDate(today(), settings.default_trial_days), monthlyPrice: settings.default_monthly_price, graceDays: settings.default_grace_days };
  }

  async updateSubscription(
    tenantId: string,
    input: { monthlyPrice: number; graceDays: number; billingMode: 'auto' | 'exento' | 'suspendido'; paidUntil: string | null; ownerNotes: string | null },
    ip: string,
  ): Promise<TenantOverview> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.is_showcase === 1) throw new AppError('Las demos no tienen suscripción.', 422, 'SHOWCASE');
    await this.db.batch([
      this.db
        .prepare('UPDATE tenants SET monthly_price = ?, grace_days = ?, billing_mode = ?, paid_until = ?, owner_notes = ? WHERE id = ?')
        .bind(input.monthlyPrice, input.graceDays, input.billingMode, input.paidUntil, input.ownerNotes, tenantId),
      this.auditStatement('suscripcion_editada', tenantId, { ...input, previousPaidUntil: tenant.paid_until, previousMode: tenant.billing_mode }, ip),
    ]);
    return this.getTenantOverview(tenantId);
  }

  async getTenantOverview(tenantId: string): Promise<TenantOverview> {
    const overview = (await this.listTenants()).find((tenant) => tenant.id === tenantId);
    if (!overview) throw notFound('El consultorio');
    return overview;
  }

  async listPayments(tenantId: string): Promise<SubscriptionPaymentRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM subscription_payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200')
      .bind(tenantId)
      .all<SubscriptionPaymentRow>();
    return results;
  }

  /**
   * Registra un pago y extiende paid_until de forma atómica. Si dos pagos
   * llegan a la vez, la condición sobre el paid_until anterior evita que uno
   * pise al otro (se reintenta con el valor nuevo).
   */
  async registerPayment(
    tenantId: string,
    input: { amount: number; months: number; method: string; reference: string | null; notes: string | null; externalId?: string | null },
    ip: string | null,
  ): Promise<{ applied: boolean; paidUntil: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tenant = await this.getTenant(tenantId);
      if (tenant.is_showcase === 1) throw new AppError('Las demos no tienen suscripción.', 422, 'SHOWCASE');
      const previous = tenant.paid_until;
      const next = extendPaidUntil(previous, todayLocal(tenant.utc_offset_minutes), input.months);
      const paymentId = crypto.randomUUID();
      let outcome;
      try {
        outcome = await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO subscription_payments (id, tenant_id, amount, months, previous_paid_until, new_paid_until, method, reference, external_id, notes, created_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT paid_until FROM tenants WHERE id = ?) IS ?`,
            )
            .bind(paymentId, tenantId, input.amount, input.months, previous, next, input.method, input.reference, input.externalId ?? null, input.notes, isoNow(), tenantId, previous),
          this.db.prepare('UPDATE tenants SET paid_until = ? WHERE id = ? AND paid_until IS ?').bind(next, tenantId, previous),
          // Si estaba suspendido manualmente por falta de pago, el pago lo reactiva.
          this.db.prepare("UPDATE tenants SET billing_mode = 'auto' WHERE id = ? AND billing_mode = 'suspendido' AND paid_until = ?").bind(tenantId, next),
          this.auditStatement('pago_suscripcion', tenantId, { amount: input.amount, months: input.months, method: input.method, paidUntil: next }, ip),
        ]);
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: subscription_payments/i.test(error.message)) {
          return { applied: false, paidUntil: (await this.getTenant(tenantId)).paid_until ?? '' };
        }
        throw error;
      }
      if ((outcome[0]?.meta?.changes ?? 0) > 0) return { applied: true, paidUntil: next };
    }
    throw new AppError('Hubo varios pagos al mismo tiempo. Intenta de nuevo.', 409, 'CONCURRENT_PAYMENT');
  }

  /** Solo se anula el pago más reciente (devuelve paid_until al valor anterior). */
  async voidPayment(paymentId: string, reason: string, ip: string): Promise<void> {
    const payment = await this.db.prepare('SELECT * FROM subscription_payments WHERE id = ?').bind(paymentId).first<SubscriptionPaymentRow>();
    if (!payment) throw notFound('El pago');
    if (payment.status !== 'aprobado') throw new AppError('El pago ya está anulado.', 409, 'ALREADY_VOIDED');
    const outcome = await this.db.batch([
      this.db
        .prepare("UPDATE subscription_payments SET status = 'anulado', void_reason = ? WHERE id = ? AND status = 'aprobado' AND (SELECT paid_until FROM tenants WHERE id = ?) = ?")
        .bind(reason, paymentId, payment.tenant_id, payment.new_paid_until),
      this.db.prepare('UPDATE tenants SET paid_until = ? WHERE id = ? AND paid_until = ?').bind(payment.previous_paid_until, payment.tenant_id, payment.new_paid_until),
      this.auditStatement('pago_suscripcion_anulado', payment.tenant_id, { paymentId, reason }, ip),
    ]);
    if ((outcome[0]?.meta?.changes ?? 0) === 0) {
      throw new AppError('Solo se puede anular el pago más reciente (o la fecha de pago se cambió a mano).', 409, 'NOT_LATEST');
    }
  }

  /** Restablece la contraseña del primer administrador activo y cierra sus sesiones. */
  async resetAdminPassword(tenantId: string, ip: string): Promise<{ email: string; temporaryPassword: string }> {
    await this.getTenant(tenantId);
    const admin = await this.db
      .prepare(
        `SELECT u.id, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ? AND r.is_system = 1 AND u.is_active = 1 ORDER BY u.created_at LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ id: string; email: string }>();
    if (!admin) throw new AppError('El consultorio no tiene un administrador activo.', 409, 'NO_ADMIN');
    const temporaryPassword = `Temp-${generateSecureToken(9)}7`;
    await this.db.batch([
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await this.auth.hashNewPassword(temporaryPassword), admin.id),
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(admin.id),
      this.auditStatement('clave_admin_restablecida', tenantId, { email: admin.email }, ip),
    ]);
    return { email: admin.email, temporaryPassword };
  }

  async auditClinicCreated(tenantId: string, kind: 'real' | 'demo', ip: string): Promise<void> {
    await this.auditStatement(kind === 'real' ? 'consultorio_creado' : 'demo_creada', tenantId, null, ip).run();
  }

  // ─── Lado del consultorio: estado y pago en línea ─────────────────────────

  async getTenantSubscriptionView(tenant: TenantRow, includeHistory: boolean) {
    const settings = await this.getSettings();
    const status = subscriptionOf(tenant);
    const whatsappMessage = `Hola${settings.ownerName ? ` ${settings.ownerName}` : ''}, soy de ${tenant.name}. Quiero pagar la suscripción de Agenda Sonrisa${tenant.monthly_price ? ` (${tenant.monthly_price.toLocaleString('es-CO')} COP/mes)` : ''}.`;
    return {
      clinicName: tenant.name,
      status,
      monthlyPrice: tenant.monthly_price,
      graceDays: tenant.grace_days,
      paymentInstructions: settings.paymentInstructions,
      ownerName: settings.ownerName,
      ownerWhatsappUrl: settings.ownerWhatsapp ? `https://wa.me/${settings.ownerWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMessage)}` : null,
      onlinePaymentAvailable: settings.wompiConfigured && tenant.monthly_price >= 1000 && status.state !== 'exento',
      payments: includeHistory
        ? (await this.listPayments(tenant.id)).map((payment) => ({
            id: payment.id, amount: payment.amount, months: payment.months, newPaidUntil: payment.new_paid_until, method: payment.method,
            reference: payment.reference, status: payment.status, createdAt: payment.created_at,
          }))
        : [],
    };
  }

  async createCheckout(tenant: TenantRow, months: number, origin: string, payer: { fullName: string; email: string }): Promise<{ checkoutUrl: string; reference: string }> {
    const row = await this.getSettingsRow();
    const [integrity] = await this.decryptWompiSecrets(row);
    if (!row.wompi_environment || !row.wompi_public_key || !integrity) {
      throw new AppError('El pago en línea no está disponible. Usa las instrucciones de pago.', 409, 'ONLINE_PAYMENT_UNAVAILABLE');
    }
    if (tenant.is_showcase === 1 || tenant.billing_mode === 'exento') throw new AppError('Este consultorio no tiene cobro.', 409, 'EXEMPT');
    if (tenant.monthly_price < 1000) throw new AppError('El valor del plan no está configurado. Escríbele al proveedor.', 409, 'NO_PRICE');

    const amount = tenant.monthly_price * months;
    const reference = `${SUBSCRIPTION_REFERENCE_PREFIX}${tenant.id.slice(0, 8).toUpperCase()}-${generateSecureToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}`;
    await this.db
      .prepare('INSERT INTO subscription_checkouts (reference, tenant_id, amount, months, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(reference, tenant.id, amount, months, 'pendiente', isoNow())
      .run();
    const checkoutUrl = await buildCheckoutUrl({
      publicKey: row.wompi_public_key,
      integritySecret: integrity,
      reference,
      amountInCents: amount * 100,
      redirectUrl: `${origin}/suscripcion/pago?ref=${encodeURIComponent(reference)}`,
      expirationTime: new Date(Date.now() + 60 * 60_000).toISOString(),
      customer: { fullName: payer.fullName, email: payer.email, phoneE164: null, legalId: '', legalIdType: '' },
    });
    return { checkoutUrl, reference };
  }

  /**
   * Aplica una transacción de Wompi consultada en la API (fuente de verdad).
   * Devuelve el estado del checkout después de procesarla.
   */
  private async applyTransaction(reference: string, transactionId: string): Promise<'aprobado' | 'rechazado' | 'pendiente'> {
    const checkout = await this.db
      .prepare('SELECT * FROM subscription_checkouts WHERE reference = ?')
      .bind(reference)
      .first<{ reference: string; tenant_id: string; amount: number; months: number; status: string }>();
    if (!checkout) throw notFound('El pago');
    const row = await this.getSettingsRow();
    if (!row.wompi_environment || !row.wompi_public_key) throw new AppError('Wompi no está configurado.', 409, 'WOMPI_NOT_CONFIGURED');

    const transaction = await this.wompi.getTransaction(row.wompi_environment, row.wompi_public_key, transactionId);
    if (!transaction || transaction.reference !== reference) throw new AppError('La transacción no corresponde a este pago.', 422, 'TRANSACTION_MISMATCH');
    if (transaction.status === 'PENDING') return 'pendiente';
    if (transaction.status !== 'APPROVED' || transaction.currency !== 'COP' || transaction.amount_in_cents !== checkout.amount * 100) {
      await this.db.prepare("UPDATE subscription_checkouts SET status = 'rechazado', transaction_id = ? WHERE reference = ? AND status = 'pendiente'").bind(transactionId, reference).run();
      return 'rechazado';
    }
    await this.registerPayment(
      checkout.tenant_id,
      { amount: checkout.amount, months: checkout.months, method: 'wompi', reference, notes: 'Pago en línea', externalId: `wompi:${transaction.id}` },
      null,
    );
    await this.db.prepare("UPDATE subscription_checkouts SET status = 'aprobado', transaction_id = ? WHERE reference = ?").bind(transactionId, reference).run();
    return 'aprobado';
  }

  /** Verificación al volver de Wompi (también funciona si el webhook no llega). */
  async verifyCheckout(tenantId: string, reference: string, transactionId: string): Promise<{ result: 'aprobado' | 'rechazado' | 'pendiente' }> {
    const checkout = await this.db.prepare('SELECT tenant_id FROM subscription_checkouts WHERE reference = ?').bind(reference).first<{ tenant_id: string }>();
    if (!checkout || checkout.tenant_id !== tenantId) throw notFound('El pago');
    return { result: await this.applyTransaction(reference, transactionId) };
  }

  /** Evento de Wompi del dueño: checksum + ambiente + consulta a la API. */
  async handleWebhook(event: WompiEvent, headerChecksum: string | null): Promise<{ status: string }> {
    const row = await this.getSettingsRow();
    const [, eventsSecret] = await this.decryptWompiSecrets(row);
    if (!row.wompi_environment || !eventsSecret) return { status: 'ignorado' };
    if (!(await verifyEventChecksum(event, eventsSecret, headerChecksum))) throw new AppError('Firma inválida.', 401, 'INVALID_SIGNATURE');
    if (event.environment !== EVENT_ENVIRONMENT[row.wompi_environment]) return { status: 'ignorado' };
    const transaction = event.data.transaction;
    if (event.event !== 'transaction.updated' || !transaction?.reference?.startsWith(SUBSCRIPTION_REFERENCE_PREFIX)) return { status: 'ignorado' };
    return { status: await this.applyTransaction(transaction.reference, transaction.id) };
  }
}
