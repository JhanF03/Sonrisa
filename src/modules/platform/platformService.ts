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
import { generateSecureToken, sha256Hex } from '../../security/crypto.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../security/secretBox.js';
import {
  addDaysToDate,
  extendPaidUntil,
  subscriptionOfTenant,
  type SubscriptionStatus,
  type TenantSubscriptionFields,
} from '../../shared/subscription.js';
import { ALL_PLAN_MODULES, MIN_ONLINE_CHARGE, parseModules, priceForMonths, prorateUpgrade, type PlanCatalog, type PlanModule, type PlanSelection } from '../../shared/plans.js';
import { normalizePhone } from '../../utils/phone.js';
import { parsePending, selectionOf, type PendingPlan, type PlanService } from '../plans/planService.js';
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

/** Después de crear su consultorio, la demo de donde vino sigue abierta este tiempo. */
const DEMO_AFTER_SIGNUP_MS = 24 * 3_600_000;

/**
 * Tablas con datos de un consultorio, de hijas a padres (orden seguro para
 * borrar con llaves foráneas activas). Al agregar una tabla con tenant_id,
 * agrégala aquí: la prueba de borrado de demos falla si se olvida.
 */
export const TENANT_DATA_TABLES = [
  'sales_invoice_lines', 'sales_invoices', 'einvoice_settings',
  'stock_movements', 'supplier_payments', 'purchase_lines', 'purchases', 'service_supplies', 'supplier_item_links', 'supplies', 'suppliers',
  'payment_intents', 'payment_allocations', 'payments', 'charges',
  'waitlist_entries', 'appointments', 'time_blocks', 'schedules', 'patients', 'professionals', 'services',
  'sessions', 'audit_log', 'counters', 'payment_gateways', 'subscription_checkouts', 'subscription_payments',
] as const;
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
  annual_free_months: number;
  demo_days: number;
  self_signup_enabled: number;
  self_demo_enabled: number;
  max_self_demos: number;
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
  demoDays: number;
  selfSignupEnabled: boolean;
  selfDemoEnabled: boolean;
  maxSelfDemos: number;
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
  planId: string;
  planSelection: PlanSelection;
  customPrice: number | null;
  modules: PlanModule[];
  maxProfessionals: number;
  maxUsers: number;
  professionals: number;
  pendingPlan: PendingPlan | null;
  onTrial: boolean;
  signupSource: TenantRow['signup_source'];
  demoExpiresAt: string | null;
  contact: { name: string | null; email: string | null; phone: string | null };
  convertedTenantId: string | null;
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
  kind: 'renovacion' | 'cambio_plan';
}

const today = () => todayLocal(COLOMBIA_OFFSET);

export const subscriptionOf = (tenant: TenantSubscriptionFields): SubscriptionStatus => subscriptionOfTenant(tenant);

export class PlatformService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly wompi: WompiApi,
    private readonly plans: PlanService,
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
      demoDays: row.demo_days,
      selfSignupEnabled: row.self_signup_enabled === 1,
      selfDemoEnabled: row.self_demo_enabled === 1,
      maxSelfDemos: row.max_self_demos,
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
      demoDays?: number;
      selfSignupEnabled?: boolean;
      selfDemoEnabled?: boolean;
      maxSelfDemos?: number;
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
             wompi_events_enc = ?, demo_days = ?, self_signup_enabled = ?, self_demo_enabled = ?, max_self_demos = ?, updated_at = ? WHERE id = 1`,
        )
        .bind(
          input.ownerName, whatsapp?.e164 ?? null, input.paymentInstructions, input.defaultMonthlyPrice, input.defaultGraceDays,
          input.defaultTrialDays, environment, publicKey,
          integrity ? await encryptSecret(this.config.appSecret, integrity, 'platform:integrity') : null,
          events ? await encryptSecret(this.config.appSecret, events, 'platform:events') : null,
          input.demoDays ?? current.demo_days,
          input.selfSignupEnabled === undefined ? current.self_signup_enabled : Number(input.selfSignupEnabled),
          input.selfDemoEnabled === undefined ? current.self_demo_enabled : Number(input.selfDemoEnabled),
          input.maxSelfDemos ?? current.max_self_demos,
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
           (SELECT COUNT(*) FROM professionals pr WHERE pr.tenant_id = t.id AND pr.is_active = 1) AS professionals_count,
           (SELECT COUNT(*) FROM patients p WHERE p.tenant_id = t.id) AS patients_count,
           (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id = t.id AND a.created_at >= ?) AS appointments_30,
           (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
           (SELECT MAX(sp.created_at) FROM subscription_payments sp WHERE sp.tenant_id = t.id AND sp.status = 'aprobado') AS last_payment_at
         FROM tenants t ORDER BY t.is_showcase, t.created_at DESC`,
      )
      .bind(since)
      .all<TenantRow & { admin_email: string | null; users_count: number; professionals_count: number; patients_count: number; appointments_30: number; last_login_at: string | null; last_payment_at: string | null; owner_notes: string | null }>();
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
      planId: row.plan_id,
      planSelection: selectionOf(row),
      customPrice: row.custom_price,
      modules: row.is_showcase === 1 ? ALL_PLAN_MODULES : parseModules(row.enabled_modules),
      maxProfessionals: row.max_professionals,
      maxUsers: row.max_users,
      professionals: row.professionals_count,
      pendingPlan: parsePending(row.pending_plan),
      onTrial: row.on_trial === 1,
      signupSource: row.signup_source,
      demoExpiresAt: row.demo_expires_at,
      contact: { name: row.contact_name, email: row.contact_email, phone: row.contact_phone },
      convertedTenantId: row.converted_tenant_id,
    }));
  }

  async getSummary(): Promise<{
    realClinics: number; demos: number; active: number; dueSoon: number; inGrace: number; suspended: number; monthlyRecurring: number; collectedThisMonth: number;
    trials: number; selfDemos: number; conversions: number; byPlan: Record<string, number>;
  }> {
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
      trials: real.filter((tenant) => tenant.onTrial && !tenant.subscription.blocked).length,
      selfDemos: tenants.filter((tenant) => tenant.isShowcase && tenant.signupSource === 'autoservicio').length,
      conversions: tenants.filter((tenant) => tenant.isShowcase && tenant.convertedTenantId).length + real.filter((tenant) => tenant.signupSource === 'registro').length,
      byPlan: real.reduce<Record<string, number>>((counts, tenant) => ({ ...counts, [tenant.planId]: (counts[tenant.planId] ?? 0) + 1 }), {}),
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

  /** El dueño cambia plan, precio especial, fechas o modo de cobro (aplica de inmediato, sin cobro). */
  async updateSubscription(
    tenantId: string,
    input: {
      selection: PlanSelection;
      customPrice: number | null;
      graceDays: number;
      billingMode: 'auto' | 'exento' | 'suspendido';
      paidUntil: string | null;
      ownerNotes: string | null;
    },
    ip: string,
  ): Promise<TenantOverview> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.is_showcase === 1) throw new AppError('Las demos no tienen suscripción.', 422, 'SHOWCASE');
    const resolved = await this.plans.resolve(input.selection, { allowInactivePlan: true });
    await this.db.batch([
      this.db
        .prepare('UPDATE tenants SET custom_price = ?, grace_days = ?, billing_mode = ?, paid_until = ?, owner_notes = ? WHERE id = ?')
        .bind(input.customPrice, input.graceDays, input.billingMode, input.paidUntil, input.ownerNotes, tenantId),
      this.plans.applyStatement({ id: tenantId, custom_price: input.customPrice }, resolved),
      this.auditStatement('suscripcion_editada', tenantId, { ...input, previousPaidUntil: tenant.paid_until, previousMode: tenant.billing_mode, previousPlan: tenant.plan_id }, ip),
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
    input: { amount: number; months: number; method: string; reference: string | null; notes: string | null; externalId?: string | null; kind?: 'renovacion' | 'cambio_plan' },
    ip: string | null,
  ): Promise<{ applied: boolean; paidUntil: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tenant = await this.getTenant(tenantId);
      if (tenant.is_showcase === 1) throw new AppError('Las demos no tienen suscripción.', 422, 'SHOWCASE');
      const previous = tenant.paid_until;
      // Un pago de cambio de plan (0 meses) no mueve la fecha.
      const next = input.months === 0 ? (previous ?? todayLocal(tenant.utc_offset_minutes)) : extendPaidUntil(previous, todayLocal(tenant.utc_offset_minutes), input.months);
      const paymentId = crypto.randomUUID();
      let outcome;
      try {
        outcome = await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO subscription_payments (id, tenant_id, amount, months, previous_paid_until, new_paid_until, method, reference, external_id, notes, created_at, kind)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT paid_until FROM tenants WHERE id = ?) IS ?`,
            )
            .bind(
              paymentId, tenantId, input.amount, input.months, previous, next, input.method, input.reference, input.externalId ?? null, input.notes, isoNow(),
              input.kind ?? 'renovacion', tenantId, previous,
            ),
          // El primer pago termina el periodo de prueba.
          this.db.prepare('UPDATE tenants SET paid_until = ?, on_trial = 0 WHERE id = ? AND paid_until IS ?').bind(next, tenantId, previous),
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

  /**
   * Abre el panel de una DEMO como su administrador (para mostrarla o revisarla).
   * Solo demos: los consultorios reales tienen datos de pacientes reales.
   */
  async createDemoSession(tenantId: string, ip: string, userAgent: string): Promise<{ token: string; expiresAt: number }> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.is_showcase !== 1) throw new AppError('Solo se puede abrir el panel de las demos.', 403, 'NOT_SHOWCASE');
    const adminId = await this.firstAdminId(tenantId);
    if (!adminId) throw new AppError('La demo no tiene un administrador activo.', 409, 'NO_ADMIN');
    return this.issueSession(adminId, tenantId, ip, userAgent, 'demo_abierta');
  }

  private async firstAdminId(tenantId: string): Promise<string | null> {
    const admin = await this.db
      .prepare(
        `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ? AND r.is_system = 1 AND u.is_active = 1 ORDER BY u.created_at LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ id: string }>();
    return admin?.id ?? null;
  }

  /** Sesión normal del panel del consultorio (misma cookie que al ingresar con contraseña). */
  private async issueSession(userId: string, tenantId: string, ip: string, userAgent: string, auditAction: string): Promise<{ token: string; expiresAt: number }> {
    const token = generateSecureToken(32);
    const expiresAt = Date.now() + this.config.sessionTtlHours * 3_600_000;
    await this.db.batch([
      this.db
        .prepare('INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(await sha256Hex(token), userId, tenantId, expiresAt, isoNow(), ip, userAgent.slice(0, 300)),
      this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(isoNow(), userId),
      this.auditStatement(auditAction, tenantId, null, ip),
    ]);
    return { token, expiresAt };
  }

  // ─── Demos: vencimiento y borrado ─────────────────────────────────────────

  /** Borra una demo con todos sus datos (ficticios). Nunca borra un consultorio real. */
  async deleteDemo(tenantId: string, ip: string | null, reason: 'dueno' | 'vencida'): Promise<void> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.is_showcase !== 1) throw new AppError('Solo se pueden eliminar demos. Un consultorio real se suspende, no se borra.', 403, 'NOT_SHOWCASE');
    await this.db.batch([
      ...TENANT_DATA_TABLES.map((table) => this.db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).bind(tenantId)),
      this.db.prepare('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)').bind(tenantId),
      this.db.prepare('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = ?)').bind(tenantId),
      this.db.prepare('DELETE FROM users WHERE tenant_id = ?').bind(tenantId),
      this.db.prepare('DELETE FROM roles WHERE tenant_id = ?').bind(tenantId),
      this.db.prepare('DELETE FROM tenants WHERE id = ? AND is_showcase = 1').bind(tenantId),
      this.auditStatement(reason === 'vencida' ? 'demo_vencida_borrada' : 'demo_eliminada', null, { tenantId, name: tenant.name, contact: tenant.contact_email }, ip),
    ]);
  }

  /** Cambia el vencimiento de una demo (null = no vence). */
  async setDemoExpiry(tenantId: string, expiresAt: string | null, ip: string): Promise<TenantOverview> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.is_showcase !== 1) throw new AppError('Solo las demos vencen.', 403, 'NOT_SHOWCASE');
    await this.db.batch([
      this.db.prepare('UPDATE tenants SET demo_expires_at = ? WHERE id = ?').bind(expiresAt, tenantId),
      this.auditStatement('demo_vencimiento', tenantId, { expiresAt }, ip),
    ]);
    return this.getTenantOverview(tenantId);
  }

  /** Mantenimiento: borra pocas demos vencidas por vez (límite de operaciones de Workers). */
  async deleteExpiredDemos(limit = 2): Promise<number> {
    const { results } = await this.db
      .prepare('SELECT id FROM tenants WHERE is_showcase = 1 AND demo_expires_at IS NOT NULL AND demo_expires_at <= ? ORDER BY demo_expires_at LIMIT ?')
      .bind(isoNow(), limit)
      .all<{ id: string }>();
    for (const { id } of results) await this.deleteDemo(id, null, 'vencida');
    return results.length;
  }

  /** Mantenimiento: aplica las bajadas de plan cuya fecha ya llegó. */
  async applyDuePendingPlans(): Promise<number> {
    const { results } = await this.db.prepare('SELECT * FROM tenants WHERE pending_plan IS NOT NULL AND is_showcase = 0 LIMIT 20').all<TenantRow>();
    let applied = 0;
    for (const tenant of results) {
      const pending = parsePending(tenant.pending_plan);
      if (!pending) {
        await this.db.prepare('UPDATE tenants SET pending_plan = NULL WHERE id = ?').bind(tenant.id).run();
        continue;
      }
      if (todayLocal(tenant.utc_offset_minutes) < pending.effectiveOn) continue;
      const resolved = await this.plans.resolve(pending, { allowInactivePlan: true }).catch(() => null);
      await this.db.batch(
        resolved
          ? [this.plans.applyStatement({ id: tenant.id, custom_price: null }, resolved), this.db.prepare('UPDATE tenants SET custom_price = NULL WHERE id = ?').bind(tenant.id), this.auditStatement('plan_cambiado', tenant.id, { planId: pending.planId, programado: true }, null)]
          : [this.db.prepare('UPDATE tenants SET pending_plan = NULL WHERE id = ?').bind(tenant.id)],
      );
      if (resolved) applied++;
    }
    return applied;
  }

  // ─── Autoservicio: demo con datos y registro con prueba gratis ────────────

  async getPublicOffer(): Promise<{
    plans: PlanCatalog['plans'];
    addons: PlanCatalog['addons'];
    annualFreeMonths: number;
    trialDays: number;
    demoDays: number;
    selfSignupEnabled: boolean;
    selfDemoEnabled: boolean;
  }> {
    const [catalog, settings] = await Promise.all([this.plans.getCatalog(), this.getSettingsRow()]);
    return {
      plans: catalog.plans.filter((plan) => plan.isActive),
      addons: catalog.addons.filter((addon) => addon.isActive),
      annualFreeMonths: catalog.annualFreeMonths,
      trialDays: settings.default_trial_days,
      demoDays: settings.demo_days,
      selfSignupEnabled: settings.self_signup_enabled === 1,
      selfDemoEnabled: settings.self_demo_enabled === 1,
    };
  }

  /** Antes de crear una demo de autoservicio: activado, cupo y una sola demo activa por correo. */
  async assertSelfDemoAllowed(contactEmail: string): Promise<{ demoDays: number }> {
    const settings = await this.getSettingsRow();
    if (settings.self_demo_enabled !== 1) throw new AppError('Las demos en línea no están disponibles. Escríbenos y te mostramos el sistema.', 403, 'SELF_DEMO_DISABLED');
    const active = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN contact_email = ? THEN 1 ELSE 0 END) AS mine
         FROM tenants WHERE is_showcase = 1 AND signup_source = 'autoservicio' AND demo_expires_at > ?`,
      )
      .bind(contactEmail.toLowerCase(), isoNow())
      .first<{ total: number; mine: number | null }>();
    if ((active?.mine ?? 0) > 0) {
      throw new AppError('Ya tienes una demo activa con este correo. Ingresa con el usuario de demo que te mostramos al crearla.', 409, 'DEMO_EXISTS');
    }
    if ((active?.total ?? 0) >= settings.max_self_demos) {
      throw new AppError('En este momento hay muchas demos activas. Intenta mañana o crea tu consultorio con la prueba gratis.', 429, 'DEMO_CAPACITY');
    }
    return { demoDays: settings.demo_days };
  }

  /** Marca la demo como de autoservicio, con su contacto y su vencimiento. */
  async markSelfDemo(tenantId: string, contact: { name: string; email: string; phone: string | null }, demoDays: number, ip: string): Promise<string> {
    const expiresAt = new Date(Date.now() + demoDays * 86_400_000).toISOString();
    await this.db.batch([
      this.db
        .prepare("UPDATE tenants SET signup_source = 'autoservicio', demo_expires_at = ?, contact_name = ?, contact_email = ?, contact_phone = ? WHERE id = ? AND is_showcase = 1")
        .bind(expiresAt, contact.name, contact.email.toLowerCase(), contact.phone, tenantId),
      this.auditStatement('demo_autoservicio', tenantId, { email: contact.email }, ip),
    ]);
    return expiresAt;
  }

  /** Ajustes de un consultorio creado desde /registro: plan elegido y periodo de prueba. */
  async prepareSelfSignup(planId: string): Promise<{ resolved: Awaited<ReturnType<PlanService['resolve']>>; trialUntil: string; graceDays: number }> {
    const settings = await this.getSettingsRow();
    if (settings.self_signup_enabled !== 1) throw new AppError('El registro en línea no está disponible. Escríbenos para crear tu consultorio.', 403, 'SELF_SIGNUP_DISABLED');
    const resolved = await this.plans.resolve({ planId, addonModules: [], extraProfessionals: 0, extraUsers: 0 });
    return { resolved, trialUntil: addDaysToDate(today(), settings.default_trial_days), graceDays: settings.default_grace_days };
  }

  async completeSelfSignup(
    tenantId: string,
    adminUserId: string,
    resolved: Awaited<ReturnType<PlanService['resolve']>>,
    contact: { name: string; email: string; phone: string | null },
    fromDemoTenantId: string | null,
    ip: string,
    userAgent: string,
  ): Promise<{ token: string; expiresAt: number; demoAvailableUntil: string | null }> {
    const demoUntil = new Date(Date.now() + DEMO_AFTER_SIGNUP_MS).toISOString();
    await this.db.batch([
      this.plans.applyStatement({ id: tenantId, custom_price: null }, resolved),
      this.db
        .prepare("UPDATE tenants SET on_trial = 1, signup_source = 'registro', contact_name = ?, contact_email = ?, contact_phone = ? WHERE id = ?")
        .bind(contact.name, contact.email.toLowerCase(), contact.phone, tenantId),
      // La demo de donde vino sigue disponible solo 24 horas más.
      ...(fromDemoTenantId
        ? [
            this.db
              .prepare(
                `UPDATE tenants SET converted_tenant_id = ?,
                   demo_expires_at = CASE WHEN demo_expires_at IS NULL OR demo_expires_at > ? THEN ? ELSE demo_expires_at END
                 WHERE id = ? AND is_showcase = 1 AND signup_source = 'autoservicio'`,
              )
              .bind(tenantId, demoUntil, demoUntil, fromDemoTenantId),
          ]
        : []),
      this.auditStatement('registro_autoservicio', tenantId, { planId: resolved.plan.id, email: contact.email, fromDemo: fromDemoTenantId }, ip),
    ]);
    const session = await this.issueSession(adminUserId, tenantId, ip, userAgent, 'ingreso_registro');
    const demo = fromDemoTenantId ? await this.db.prepare('SELECT demo_expires_at, converted_tenant_id FROM tenants WHERE id = ?').bind(fromDemoTenantId).first<{ demo_expires_at: string | null; converted_tenant_id: string | null }>() : null;
    return { ...session, demoAvailableUntil: demo?.converted_tenant_id === tenantId ? demo.demo_expires_at : null };
  }

  /** Sesión para entrar a la demo recién creada. */
  async openSelfDemo(tenantId: string, adminUserId: string, ip: string, userAgent: string): Promise<{ token: string; expiresAt: number }> {
    return this.issueSession(adminUserId, tenantId, ip, userAgent, 'demo_abierta');
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

  /** Plan inicial de un consultorio creado por el dueño. */
  async setInitialPlan(tenantId: string, resolved: Awaited<ReturnType<PlanService['resolve']>>, customPrice: number | null): Promise<void> {
    await this.db.batch([
      this.db.prepare('UPDATE tenants SET custom_price = ?, on_trial = 1 WHERE id = ?').bind(customPrice, tenantId),
      this.plans.applyStatement({ id: tenantId, custom_price: customPrice }, resolved),
    ]);
  }

  async auditClinicCreated(tenantId: string, kind: 'real' | 'demo', ip: string): Promise<void> {
    await this.auditStatement(kind === 'real' ? 'consultorio_creado' : 'demo_creada', tenantId, null, ip).run();
  }

  // ─── Lado del consultorio: plan, estado y pago en línea ───────────────────

  async getTenantSubscriptionView(tenant: TenantRow, includeHistory: boolean) {
    const [settings, catalog, usage] = await Promise.all([this.getSettings(), this.plans.getCatalog(), this.plans.usage(tenant.id)]);
    const status = subscriptionOf(tenant);
    const pending = parsePending(tenant.pending_plan);
    const renewalPrice = pending?.monthlyPrice ?? tenant.monthly_price;
    const whatsappMessage = `Hola${settings.ownerName ? ` ${settings.ownerName}` : ''}, soy de ${tenant.name}. Quiero pagar la suscripción de Agenda Sonrisa${renewalPrice ? ` (${renewalPrice.toLocaleString('es-CO')} COP/mes)` : ''}.`;
    return {
      clinicName: tenant.name,
      status,
      onTrial: tenant.on_trial === 1,
      monthlyPrice: tenant.monthly_price,
      renewalPrice,
      customPrice: tenant.custom_price,
      graceDays: tenant.grace_days,
      plan: {
        selection: selectionOf(tenant),
        modules: parseModules(tenant.enabled_modules),
        maxProfessionals: tenant.max_professionals,
        maxUsers: tenant.max_users,
        usage,
        pending,
      },
      catalog: { ...catalog, plans: catalog.plans.filter((plan) => plan.isActive || plan.id === tenant.plan_id) },
      paymentInstructions: settings.paymentInstructions,
      ownerName: settings.ownerName,
      ownerWhatsappUrl: settings.ownerWhatsapp ? `https://wa.me/${settings.ownerWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(whatsappMessage)}` : null,
      onlinePaymentAvailable: settings.wompiConfigured && renewalPrice >= 1000 && status.state !== 'exento',
      paymentOptions: [1, 3, 6, 12].map((months) => ({ months, amount: priceForMonths(renewalPrice, months, catalog.annualFreeMonths) })),
      payments: includeHistory
        ? (await this.listPayments(tenant.id)).map((payment) => ({
            id: payment.id, amount: payment.amount, months: payment.months, newPaidUntil: payment.new_paid_until, method: payment.method,
            reference: payment.reference, status: payment.status, createdAt: payment.created_at, kind: payment.kind,
          }))
        : [],
    };
  }

  /**
   * El consultorio cambia su plan:
   *  • En prueba, vencido o sin cobro → se aplica ya; el precio nuevo se cobra en el próximo pago.
   *  • Subir de plan estando al día → paga la diferencia de los días que quedan y se activa al aprobarse.
   *  • Bajar de plan estando al día → se programa para cuando termine lo ya pagado.
   */
  async requestPlanChange(
    tenant: TenantRow,
    selection: PlanSelection,
    origin: string,
    payer: { fullName: string; email: string },
    ip: string,
  ): Promise<{ mode: 'inmediato' | 'programado' | 'pago' | 'sin_cambios'; checkoutUrl?: string; amount?: number; effectiveOn?: string; monthlyPrice: number }> {
    if (tenant.is_showcase === 1) throw new AppError('En la demo no se cambia de plan. Crea tu consultorio para elegir uno.', 422, 'SHOWCASE');
    const resolved = await this.plans.resolve(selection);
    await this.plans.assertFits(tenant.id, resolved);
    const status = subscriptionOf(tenant);
    const currentSelection = selectionOf(tenant);
    const isSame =
      currentSelection.planId === resolved.selection.planId &&
      currentSelection.extraProfessionals === resolved.selection.extraProfessionals &&
      currentSelection.extraUsers === resolved.selection.extraUsers &&
      [...currentSelection.addonModules].sort().join() === [...resolved.selection.addonModules].sort().join();
    if (isSame) {
      // Elegir de nuevo el plan actual cancela una bajada programada.
      if (tenant.pending_plan) await this.db.batch([this.db.prepare('UPDATE tenants SET pending_plan = NULL WHERE id = ?').bind(tenant.id), this.auditStatement('cambio_plan_cancelado', tenant.id, null, ip)]);
      return { mode: 'sin_cambios', monthlyPrice: tenant.monthly_price };
    }

    const applyNow = async (mode: 'inmediato') => {
      await this.db.batch([
        this.db.prepare('UPDATE tenants SET custom_price = NULL WHERE id = ?').bind(tenant.id),
        this.plans.applyStatement({ id: tenant.id, custom_price: null }, resolved),
        this.auditStatement('plan_cambiado', tenant.id, { from: currentSelection, to: resolved.selection, price: resolved.monthlyPrice }, ip),
      ]);
      return { mode, monthlyPrice: resolved.monthlyPrice };
    };

    const daysLeft = status.daysLeft ?? -1;
    if (tenant.on_trial === 1 || status.state === 'exento' || daysLeft < 0 || status.blocked) return applyNow('inmediato');

    if (resolved.monthlyPrice > tenant.monthly_price) {
      const amount = prorateUpgrade(tenant.monthly_price, resolved.monthlyPrice, daysLeft + 1);
      if (amount < MIN_ONLINE_CHARGE) return applyNow('inmediato');
      const checkout = await this.createCheckout(tenant, 0, origin, payer, { amount, snapshot: resolved.selection });
      return { mode: 'pago', checkoutUrl: checkout.checkoutUrl, amount, monthlyPrice: resolved.monthlyPrice };
    }

    const effectiveOn = addDaysToDate(status.paidUntil ?? today(), 1);
    const pending: PendingPlan = {
      ...resolved.selection,
      monthlyPrice: resolved.monthlyPrice,
      maxProfessionals: resolved.maxProfessionals,
      maxUsers: resolved.maxUsers,
      effectiveOn,
    };
    await this.db.batch([
      this.db.prepare('UPDATE tenants SET pending_plan = ? WHERE id = ?').bind(JSON.stringify(pending), tenant.id),
      this.auditStatement('cambio_plan_programado', tenant.id, { to: resolved.selection, effectiveOn }, ip),
    ]);
    return { mode: 'programado', effectiveOn, monthlyPrice: resolved.monthlyPrice };
  }

  /**
   * Enlace de pago de Wompi. months = 1/3/6/12 para renovar (12 con meses de
   * regalo) o 0 para pagar la diferencia de un cambio de plan.
   */
  async createCheckout(
    tenant: TenantRow,
    months: number,
    origin: string,
    payer: { fullName: string; email: string },
    planChange?: { amount: number; snapshot: PlanSelection },
  ): Promise<{ checkoutUrl: string; reference: string }> {
    const row = await this.getSettingsRow();
    const [integrity] = await this.decryptWompiSecrets(row);
    if (!row.wompi_environment || !row.wompi_public_key || !integrity) {
      throw new AppError('El pago en línea no está disponible. Usa las instrucciones de pago o escríbele al proveedor.', 409, 'ONLINE_PAYMENT_UNAVAILABLE');
    }
    if (tenant.is_showcase === 1 || tenant.billing_mode === 'exento') throw new AppError('Este consultorio no tiene cobro.', 409, 'EXEMPT');
    const renewalPrice = parsePending(tenant.pending_plan)?.monthlyPrice ?? tenant.monthly_price;
    if (!planChange && renewalPrice < 1000) throw new AppError('El valor del plan no está configurado. Escríbele al proveedor.', 409, 'NO_PRICE');

    const amount = planChange ? planChange.amount : priceForMonths(renewalPrice, months, row.annual_free_months);
    const reference = `${SUBSCRIPTION_REFERENCE_PREFIX}${tenant.id.slice(0, 8).toUpperCase()}-${generateSecureToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}`;
    await this.db
      .prepare('INSERT INTO subscription_checkouts (reference, tenant_id, amount, months, status, created_at, kind, plan_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(reference, tenant.id, amount, months, 'pendiente', isoNow(), planChange ? 'cambio_plan' : 'renovacion', planChange ? JSON.stringify(planChange.snapshot) : null)
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
      .first<{ reference: string; tenant_id: string; amount: number; months: number; status: string; kind: string; plan_snapshot: string | null }>();
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
    const isPlanChange = checkout.kind === 'cambio_plan';
    const { applied } = await this.registerPayment(
      checkout.tenant_id,
      {
        amount: checkout.amount, months: checkout.months, method: 'wompi', reference, kind: isPlanChange ? 'cambio_plan' : 'renovacion',
        notes: isPlanChange ? 'Cambio de plan (pago en línea)' : 'Pago en línea', externalId: `wompi:${transaction.id}`,
      },
      null,
    );
    if (applied && isPlanChange && checkout.plan_snapshot) {
      // El plan pagado se activa aunque sus precios hayan cambiado mientras pagaba.
      const resolved = await this.plans.resolve(JSON.parse(checkout.plan_snapshot) as PlanSelection, { allowInactivePlan: true });
      await this.db.batch([
        this.db.prepare('UPDATE tenants SET custom_price = NULL WHERE id = ?').bind(checkout.tenant_id),
        this.plans.applyStatement({ id: checkout.tenant_id, custom_price: null }, resolved),
        this.auditStatement('plan_cambiado', checkout.tenant_id, { to: resolved.selection, pago: reference }, null),
      ]);
    }
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
