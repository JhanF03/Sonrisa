/**
 * Pago anticipado en línea con Wompi.
 *
 * Flujo:
 *   1. El paciente reserva un servicio con anticipo → la cita queda RETENIDA
 *      ('pago') durante la ventana configurada y se crea un intento de pago.
 *   2. Se le envía al Web Checkout de Wompi con firma de integridad (el monto
 *      no se puede alterar) y una hora de expiración.
 *   3. Wompi confirma por DOS vías independientes, ambas verificadas:
 *        • Evento (webhook) con checksum del secreto de eventos.
 *        • Redirección: se consulta la transacción a la API de Wompi.
 *   4. Al aprobarse: se registra el recibo de caja (anticipo) y se confirma la
 *      cita. Todo es IDEMPOTENTE: el mismo pago nunca crea dos recibos (índice
 *      único en la base) aunque llegue el evento varias veces.
 *
 * Casos borde cubiertos: pago tardío con cupo libre (se reactiva la cita),
 * pago tardío sin cupo (queda como saldo a favor y se alerta), pago doble,
 * anulación en Wompi, monto o moneda que no coinciden, eventos de otro
 * ambiente u otras ventas del mismo comercio.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { Actor, AppConfig, TenantRow } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { createSignedToken, verifySignedToken } from '../../security/appointmentLinks.js';
import { generateSecureToken } from '../../security/crypto.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../security/secretBox.js';
import { normalizePhone } from '../../utils/phone.js';
import { isoNow } from '../../utils/time.js';
import { isHoldExpired, type AppointmentRow, type AppointmentService } from '../appointments/appointmentService.js';
import type { AuditService } from '../audit/auditService.js';
import type { PatientService } from '../patients/patientService.js';
import {
  buildCheckoutUrl,
  EVENT_ENVIRONMENT,
  KEY_PREFIXES,
  mapPaymentMethod,
  verifyEventChecksum,
  type WompiApi,
  type WompiEnvironment,
  type WompiEvent,
  type WompiTransaction,
} from './wompiClient.js';

const MINUTE_MS = 60_000;
/** Tiempo mínimo que el pago puede tardar en procesarse tras cerrar el checkout (PSE, Nequi). */
const PROCESSING_GRACE_MINUTES = 10;
const MAX_INTENTS_PER_APPOINTMENT = 5;
export const REFERENCE_PREFIX = 'AGS-';

interface GatewayRow {
  tenant_id: string;
  environment: WompiEnvironment;
  public_key: string;
  integrity_secret_enc: string;
  events_secret_enc: string;
  webhook_key: string;
  is_enabled: number;
  policy_text: string | null;
  last_verified_at: string | null;
  last_event_at: string | null;
  updated_at: string;
}

export interface PaymentIntentRow {
  id: string;
  tenant_id: string;
  appointment_id: string;
  patient_id: string;
  reference: string;
  amount_in_cents: number;
  currency: string;
  environment: WompiEnvironment;
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'EXPIRED';
  outcome: 'cita_confirmada' | 'sin_cupo' | 'pago_duplicado' | 'anulado_en_wompi' | 'monto_no_coincide' | null;
  needs_attention: number;
  attention_resolved_at: string | null;
  wompi_transaction_id: string | null;
  payment_method_type: string | null;
  payment_id: string | null;
  checkout_expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayView {
  configured: boolean;
  environment: WompiEnvironment | null;
  publicKey: string | null;
  integritySecretMasked: string | null;
  eventsSecretMasked: string | null;
  isEnabled: boolean;
  policyText: string | null;
  webhookUrl: string | null;
  lastVerifiedAt: string | null;
  lastEventAt: string | null;
}

export interface GatewayInput {
  environment: WompiEnvironment;
  publicKey: string;
  /** Vacío = conservar el actual. */
  integritySecret: string | null;
  eventsSecret: string | null;
  isEnabled: boolean;
  policyText: string | null;
}

export interface CheckoutSession {
  intentId: string;
  checkoutUrl: string;
  statusToken: string;
  amount: number;
  holdExpiresAt: string | null;
}

export type PublicPaymentState = 'aprobado' | 'pendiente' | 'rechazado' | 'vencido' | 'sin_cupo' | 'cancelado';

export interface WebhookResult {
  httpStatus: 200 | 401 | 404;
  result: string;
}

export class PaymentService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly appointments: AppointmentService,
    private readonly patients: PatientService,
    private readonly wompiApi: WompiApi,
  ) {}

  // ─── Configuración del comercio ───────────────────────────────────────────

  async getGatewayView(tenantId: string, origin: string): Promise<GatewayView> {
    const gateway = await this.findGateway(tenantId);
    if (!gateway) {
      return {
        configured: false, environment: null, publicKey: null, integritySecretMasked: null, eventsSecretMasked: null,
        isEnabled: false, policyText: null, webhookUrl: null, lastVerifiedAt: null, lastEventAt: null,
      };
    }
    const [integritySecret, eventsSecret] = await this.decryptSecrets(gateway);
    return {
      configured: true,
      environment: gateway.environment,
      publicKey: gateway.public_key,
      integritySecretMasked: maskSecret(integritySecret),
      eventsSecretMasked: maskSecret(eventsSecret),
      isEnabled: gateway.is_enabled === 1,
      policyText: gateway.policy_text,
      webhookUrl: buildWebhookUrl(origin, gateway.webhook_key),
      lastVerifiedAt: gateway.last_verified_at,
      lastEventAt: gateway.last_event_at,
    };
  }

  async saveGateway(actor: Actor, input: GatewayInput, origin: string): Promise<GatewayView> {
    const existing = await this.findGateway(actor.tenantId);
    const prefixes = KEY_PREFIXES[input.environment];
    const environmentLabel = input.environment === 'sandbox' ? 'pruebas (Sandbox)' : 'producción';

    const [currentIntegrity, currentEvents] = existing ? await this.decryptSecrets(existing) : [null, null];
    const integritySecret = input.integritySecret ?? currentIntegrity;
    const eventsSecret = input.eventsSecret ?? currentEvents;

    if (!integritySecret || !eventsSecret) {
      throw new AppError('Escribe el secreto de integridad y el secreto de eventos.', 422, 'MISSING_SECRETS');
    }
    const problems: string[] = [];
    if (!input.publicKey.startsWith(prefixes.publicKey)) problems.push(`la llave pública debe empezar por "${prefixes.publicKey}"`);
    if (!integritySecret.startsWith(prefixes.integrity)) problems.push(`el secreto de integridad debe empezar por "${prefixes.integrity}"`);
    if (!eventsSecret.startsWith(prefixes.events)) problems.push(`el secreto de eventos debe empezar por "${prefixes.events}"`);
    if (problems.length > 0) {
      throw new AppError(`Para el ambiente de ${environmentLabel}, ${problems.join('; ')}.`, 422, 'KEY_ENVIRONMENT_MISMATCH');
    }

    const now = isoNow();
    const [integrityEncrypted, eventsEncrypted] = await Promise.all([
      encryptSecret(this.config.appSecret, integritySecret, `${actor.tenantId}:integrity`),
      encryptSecret(this.config.appSecret, eventsSecret, `${actor.tenantId}:events`),
    ]);
    const webhookKey = existing?.webhook_key ?? generateSecureToken(24);
    const keysChanged =
      !existing || existing.environment !== input.environment || existing.public_key !== input.publicKey ||
      currentIntegrity !== integritySecret || currentEvents !== eventsSecret;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO payment_gateways (tenant_id, provider, environment, public_key, integrity_secret_enc, events_secret_enc,
             webhook_key, is_enabled, policy_text, last_verified_at, updated_by, updated_at)
           VALUES (?, 'wompi', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET environment = excluded.environment, public_key = excluded.public_key,
             integrity_secret_enc = excluded.integrity_secret_enc, events_secret_enc = excluded.events_secret_enc,
             is_enabled = excluded.is_enabled, policy_text = excluded.policy_text,
             last_verified_at = CASE WHEN ? = 1 THEN NULL ELSE payment_gateways.last_verified_at END,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(
          actor.tenantId, input.environment, input.publicKey, integrityEncrypted, eventsEncrypted, webhookKey,
          input.isEnabled ? 1 : 0, input.policyText, actor.userId, now, keysChanged ? 1 : 0,
        ),
      this.audit.buildStatement(actor, {
        action: 'pagos_configurados',
        entity: 'pasarela',
        entityId: actor.tenantId,
        details: { environment: input.environment, enabled: input.isEnabled, keysChanged },
      }),
    ]);
    return this.getGatewayView(actor.tenantId, origin);
  }

  /** Comprueba con Wompi que la llave pública existe en el ambiente elegido. */
  async testConnection(actor: Actor): Promise<{ merchantName: string }> {
    const gateway = await this.findGateway(actor.tenantId);
    if (!gateway) throw new AppError('Primero guarda la configuración de Wompi.', 422, 'NOT_CONFIGURED');

    let merchant: { name: string } | null;
    try {
      merchant = await this.wompiApi.getMerchant(gateway.environment, gateway.public_key);
    } catch {
      throw new AppError('No se pudo conectar con Wompi. Intenta de nuevo en un momento.', 422, 'WOMPI_UNREACHABLE');
    }
    if (!merchant) {
      throw new AppError('Wompi no reconoce esa llave pública en el ambiente elegido. Revisa la llave y el ambiente.', 422, 'WOMPI_KEY_REJECTED');
    }
    await this.db.batch([
      this.db.prepare('UPDATE payment_gateways SET last_verified_at = ? WHERE tenant_id = ?').bind(isoNow(), actor.tenantId),
      this.audit.buildStatement(actor, { action: 'pagos_conexion_verificada', entity: 'pasarela', entityId: actor.tenantId }),
    ]);
    return { merchantName: merchant.name };
  }

  async isEnabled(tenantId: string): Promise<boolean> {
    const gateway = await this.findGateway(tenantId);
    return gateway?.is_enabled === 1;
  }

  async getPolicyText(tenantId: string): Promise<string | null> {
    return (await this.findGateway(tenantId))?.policy_text ?? null;
  }

  // ─── Checkout ─────────────────────────────────────────────────────────────

  /** Crea un intento de pago para una cita retenida y devuelve la URL firmada de Wompi. */
  async createCheckout(tenant: TenantRow, appointmentId: string, origin: string, nowMs = Date.now()): Promise<CheckoutSession> {
    const gateway = await this.findGateway(tenant.id);
    if (!gateway || gateway.is_enabled !== 1) {
      throw new AppError('El pago en línea no está disponible en este momento.', 422, 'PAYMENTS_DISABLED');
    }
    const appointment = await this.appointments.getById(tenant.id, appointmentId);
    this.assertAwaitingPayment(appointment);

    const attempts = await this.db
      .prepare('SELECT COUNT(*) AS total FROM payment_intents WHERE tenant_id = ? AND appointment_id = ?')
      .bind(tenant.id, appointmentId)
      .first<{ total: number }>();
    if ((attempts?.total ?? 0) >= MAX_INTENTS_PER_APPOINTMENT) {
      throw new AppError('Superaste el número de intentos de pago. Comunícate con el consultorio.', 429, 'TOO_MANY_ATTEMPTS');
    }

    const holdExpiresMs = new Date(appointment.hold_expires_at as string).getTime();
    const checkoutExpiresMs = Math.min(holdExpiresMs - PROCESSING_GRACE_MINUTES * MINUTE_MS, nowMs + tenant.payment_window_minutes * MINUTE_MS);
    if (checkoutExpiresMs <= nowMs + 2 * MINUTE_MS) {
      throw new AppError('El tiempo para pagar esta reserva ya casi termina. Haz una nueva reserva.', 422, 'PAYMENT_WINDOW_CLOSED');
    }

    const intentId = crypto.randomUUID();
    const reference = generateReference();
    const now = isoNow();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO payment_intents (id, tenant_id, appointment_id, patient_id, reference, amount_in_cents, currency, environment,
             status, checkout_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'COP', ?, 'PENDING', ?, ?, ?)`,
        )
        .bind(
          intentId, tenant.id, appointmentId, appointment.patient_id, reference, appointment.prepayment_amount * 100,
          gateway.environment, new Date(checkoutExpiresMs).toISOString(), now, now,
        ),
      this.audit.buildStatement({ tenantId: tenant.id, userId: null, ip: 'paciente' }, {
        action: 'pago_iniciado', entity: 'pago_en_linea', entityId: intentId, details: { reference, amount: appointment.prepayment_amount },
      }),
    ]);

    const intent = await this.getIntent(tenant.id, intentId);
    return this.buildSession(tenant, gateway, intent, appointment, origin);
  }

  /** Vuelve a abrir el checkout del mismo intento (si no ha vencido) o crea uno nuevo. */
  async resumeCheckout(tenant: TenantRow, intent: PaymentIntentRow, origin: string): Promise<CheckoutSession> {
    const appointment = await this.appointments.getById(tenant.id, intent.appointment_id);
    this.assertAwaitingPayment(appointment);
    const gateway = await this.findGateway(tenant.id);
    if (!gateway || gateway.is_enabled !== 1) throw new AppError('El pago en línea no está disponible.', 422, 'PAYMENTS_DISABLED');

    const canReuse = intent.status === 'PENDING' && intent.checkout_expires_at > new Date(Date.now() + 2 * MINUTE_MS).toISOString();
    if (canReuse && intent.environment === gateway.environment) return this.buildSession(tenant, gateway, intent, appointment, origin);
    return this.createCheckout(tenant, intent.appointment_id, origin);
  }

  async createStatusToken(intentId: string): Promise<string> {
    return createSignedToken(this.config.appSecret, 'pago', intentId);
  }

  async findIntentByToken(token: string): Promise<{ tenant: TenantRow; intent: PaymentIntentRow } | null> {
    const intentId = await verifySignedToken(this.config.appSecret, 'pago', token);
    if (!intentId) return null;
    const intent = await this.db.prepare('SELECT * FROM payment_intents WHERE id = ?').bind(intentId).first<PaymentIntentRow>();
    if (!intent) return null;
    const tenant = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(intent.tenant_id).first<TenantRow>();
    return tenant ? { tenant, intent } : null;
  }

  /**
   * Al volver de Wompi: consulta la transacción en la API de Wompi (nunca se
   * confía en los parámetros de la URL) y procesa el resultado.
   */
  async verifyRedirect(tenant: TenantRow, intent: PaymentIntentRow, transactionId: string): Promise<PaymentIntentRow> {
    if (intent.status === 'APPROVED') return intent;
    const gateway = await this.findGateway(tenant.id);
    if (!gateway || gateway.environment !== intent.environment) return intent;

    let transaction: WompiTransaction | null;
    try {
      transaction = await this.wompiApi.getTransaction(intent.environment, gateway.public_key, transactionId);
    } catch {
      return intent; // Wompi no respondió: el evento (webhook) lo resolverá.
    }
    if (!transaction || transaction.reference !== intent.reference) return intent;

    await this.processTransaction(tenant, intent, transaction, 'redireccion');
    return this.getIntent(tenant.id, intent.id);
  }

  /** Estado simplificado para la página del paciente. */
  async getPublicState(tenant: TenantRow, intent: PaymentIntentRow): Promise<{ state: PublicPaymentState; appointment: AppointmentRow; canRetry: boolean }> {
    const appointment = await this.appointments.getById(tenant.id, intent.appointment_id);
    const isAwaitingPayment = appointment.status === 'pendiente' && appointment.hold_reason === 'pago' && !isHoldExpired(appointment);

    if (intent.status === 'APPROVED') {
      return { state: intent.outcome === 'sin_cupo' ? 'sin_cupo' : 'aprobado', appointment, canRetry: false };
    }
    if (appointment.status === 'cancelada' && appointment.hold_reason === null) {
      return { state: 'cancelado', appointment, canRetry: false };
    }
    if (!isAwaitingPayment) {
      // ¿Otro intento de la misma cita ya la pagó?
      if (appointment.hold_reason === null && ['pendiente', 'confirmada', 'atendida'].includes(appointment.status)) {
        return { state: 'aprobado', appointment, canRetry: false };
      }
      return { state: 'vencido', appointment, canRetry: false };
    }
    if (intent.status === 'PENDING') return { state: 'pendiente', appointment, canRetry: true };
    return { state: 'rechazado', appointment, canRetry: true };
  }

  /** El paciente desiste del pago: se libera el horario. */
  async cancelPendingPayment(tenant: TenantRow, intent: PaymentIntentRow, clientIp: string): Promise<void> {
    const appointment = await this.appointments.getById(tenant.id, intent.appointment_id);
    if (appointment.status !== 'pendiente' || appointment.hold_reason !== 'pago') {
      throw new AppError('Esta reserva ya no está esperando pago.', 422, 'NOT_AWAITING_PAYMENT');
    }
    await this.appointments.releasePaymentHold(tenant, appointment.id, clientIp, 'Cancelada por el paciente antes de pagar');
  }

  // ─── Eventos (webhook) ────────────────────────────────────────────────────

  async handleWebhook(webhookKey: string, event: WompiEvent, headerChecksum: string | null): Promise<WebhookResult> {
    const gateway = await this.db
      .prepare('SELECT * FROM payment_gateways WHERE webhook_key = ?')
      .bind(webhookKey)
      .first<GatewayRow>();
    if (!gateway) return { httpStatus: 404, result: 'comercio_desconocido' };

    const [, eventsSecret] = await this.decryptSecrets(gateway);
    if (!(await verifyEventChecksum(event, eventsSecret, headerChecksum))) {
      return { httpStatus: 401, result: 'firma_invalida' };
    }

    await this.db.prepare('UPDATE payment_gateways SET last_event_at = ? WHERE tenant_id = ?').bind(isoNow(), gateway.tenant_id).run();

    // Desde aquí el evento es auténtico: respondemos 200 aunque no aplique,
    // para que Wompi no lo reintente.
    if (event.event !== 'transaction.updated' || !event.data?.transaction) return { httpStatus: 200, result: 'evento_ignorado' };
    if (event.environment !== EVENT_ENVIRONMENT[gateway.environment]) return { httpStatus: 200, result: 'otro_ambiente' };

    const transaction = event.data.transaction;
    if (typeof transaction.reference !== 'string' || !transaction.reference.startsWith(REFERENCE_PREFIX)) {
      return { httpStatus: 200, result: 'referencia_ajena' };
    }
    const intent = await this.db
      .prepare('SELECT * FROM payment_intents WHERE tenant_id = ? AND reference = ?')
      .bind(gateway.tenant_id, transaction.reference)
      .first<PaymentIntentRow>();
    if (!intent) return { httpStatus: 200, result: 'referencia_desconocida' };

    const tenant = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(gateway.tenant_id).first<TenantRow>();
    if (!tenant) return { httpStatus: 200, result: 'consultorio_desconocido' };

    const outcome = await this.processTransaction(tenant, intent, transaction, 'evento');
    return { httpStatus: 200, result: outcome };
  }

  // ─── Núcleo: procesar el estado de una transacción ────────────────────────

  async processTransaction(tenant: TenantRow, intent: PaymentIntentRow, transaction: WompiTransaction, via: 'evento' | 'redireccion'): Promise<string> {
    const actor: Actor = { tenantId: tenant.id, userId: null, ip: via === 'evento' ? 'wompi' : 'paciente' };
    const now = isoNow();

    if (transaction.amount_in_cents !== intent.amount_in_cents || transaction.currency !== 'COP') {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE payment_intents SET outcome = 'monto_no_coincide', needs_attention = 1, wompi_transaction_id = ?, updated_at = ?
             WHERE id = ? AND status <> 'APPROVED'`,
          )
          .bind(transaction.id, now, intent.id),
        this.audit.buildStatement(actor, {
          action: 'pago_en_linea_inconsistente',
          entity: 'pago_en_linea',
          entityId: intent.id,
          details: { expected: intent.amount_in_cents, received: transaction.amount_in_cents, currency: transaction.currency, status: transaction.status },
        }),
      ]);
      return 'monto_no_coincide';
    }

    switch (transaction.status) {
      case 'APPROVED':
        return this.approve(tenant, intent, transaction, actor);
      case 'VOIDED':
        return this.voidApproved(tenant, intent, transaction, actor);
      case 'DECLINED':
      case 'ERROR':
        await this.db
          .prepare(
            `UPDATE payment_intents SET status = ?, wompi_transaction_id = ?, payment_method_type = ?, updated_at = ?
             WHERE id = ? AND status IN ('PENDING', 'EXPIRED')`,
          )
          .bind(transaction.status, transaction.id, transaction.payment_method_type ?? null, now, intent.id)
          .run();
        return 'rechazado';
      default:
        return 'pendiente';
    }
  }

  private async approve(tenant: TenantRow, intent: PaymentIntentRow, transaction: WompiTransaction, actor: Actor): Promise<string> {
    const now = isoNow();
    const paymentId = crypto.randomUUID();
    const amount = Math.round(transaction.amount_in_cents / 100);
    const notExists = 'NOT EXISTS (SELECT 1 FROM payments WHERE tenant_id = ? AND external_id = ?)';

    // 1) Recibo de caja: los tres pasos tienen la misma guarda, en una transacción.
    //    Si el pago ya existe, ninguno se ejecuta (consecutivo sin saltos).
    await this.db.batch([
      this.db
        .prepare(`UPDATE counters SET value = value + 1 WHERE tenant_id = ? AND name = 'recibo_caja' AND ${notExists}`)
        .bind(tenant.id, tenant.id, transaction.id),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
           SELECT ?, ?, NULL, 'pago_en_linea_aprobado', 'recaudo', ?, ?, ?, ? WHERE ${notExists}`,
        )
        .bind(
          crypto.randomUUID(), tenant.id, paymentId,
          JSON.stringify({ reference: intent.reference, transaction: transaction.id, amount, method: transaction.payment_method_type ?? null }),
          actor.ip, now, tenant.id, transaction.id,
        ),
      this.db
        .prepare(
          `INSERT INTO payments (id, tenant_id, patient_id, receipt_number, amount, method, reference, notes, status, created_by,
             created_at, source, external_id, appointment_id)
           SELECT ?, ?, ?, value, ?, ?, ?, ?, 'activo', NULL, ?, 'wompi', ?, ?
           FROM counters WHERE tenant_id = ? AND name = 'recibo_caja' AND ${notExists}`,
        )
        .bind(
          paymentId, tenant.id, intent.patient_id, amount, mapPaymentMethod(transaction.payment_method_type),
          `Wompi ${transaction.id}`.slice(0, 80), 'Anticipo de cita (pago en línea)', now, transaction.id, intent.appointment_id,
          tenant.id, tenant.id, transaction.id,
        ),
      this.db
        .prepare(
          `UPDATE payment_intents SET status = 'APPROVED', wompi_transaction_id = ?, payment_method_type = ?, updated_at = ?
           WHERE id = ? AND status <> 'APPROVED'`,
        )
        .bind(transaction.id, transaction.payment_method_type ?? null, now, intent.id),
    ]);

    const payment = await this.db
      .prepare('SELECT id FROM payments WHERE tenant_id = ? AND external_id = ?')
      .bind(tenant.id, transaction.id)
      .first<{ id: string }>();
    if (!payment) throw new Error('El recibo del pago en línea no se registró');

    // 2) ¿Ya había otro pago en línea anterior para esta misma cita?
    const earlierPayment = await this.db
      .prepare(
        `SELECT 1 FROM payments WHERE tenant_id = ? AND appointment_id = ? AND source = 'wompi' AND status = 'activo'
           AND rowid < (SELECT rowid FROM payments WHERE id = ?)`,
      )
      .bind(tenant.id, intent.appointment_id, payment.id)
      .first();

    // 3) Confirmar la cita (en una sentencia aparte: si falla, el dinero ya quedó registrado).
    const isConfirmed = earlierPayment ? true : await this.appointments.confirmPaidAppointment(tenant, intent.appointment_id);
    const outcome = earlierPayment ? 'pago_duplicado' : isConfirmed ? 'cita_confirmada' : 'sin_cupo';
    const needsAttention = outcome !== 'cita_confirmada';

    if (outcome === 'sin_cupo') {
      // La reserva venció y el horario ya fue tomado: se deja cancelada; el dinero queda como saldo a favor.
      await this.db
        .prepare(
          `UPDATE appointments SET status = 'cancelada', cancelled_at = COALESCE(cancelled_at, ?), hold_reason = NULL, hold_expires_at = NULL,
             cancel_reason = CASE WHEN status = 'pendiente'
               THEN 'Pago recibido después de vencer la reserva; el horario ya no estaba disponible' ELSE cancel_reason END,
             updated_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('pendiente', 'cancelada')`,
        )
        .bind(now, now, intent.appointment_id, tenant.id)
        .run();
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE payment_intents SET outcome = ?, payment_id = ?, updated_at = ?,
             needs_attention = CASE WHEN attention_resolved_at IS NULL THEN ? ELSE needs_attention END
           WHERE id = ?`,
        )
        .bind(outcome, payment.id, now, needsAttention ? 1 : 0, intent.id),
      ...(needsAttention && intent.outcome !== outcome
        ? [
            this.audit.buildStatement(actor, {
              action: outcome === 'sin_cupo' ? 'pago_en_linea_sin_cupo' : 'pago_en_linea_duplicado',
              entity: 'pago_en_linea',
              entityId: intent.id,
              details: { appointmentId: intent.appointment_id, paymentId: payment.id },
            }),
          ]
        : []),
    ]);
    return outcome;
  }

  /** Wompi anuló una transacción que ya estaba aprobada: se anula el recibo y se alerta. */
  private async voidApproved(tenant: TenantRow, intent: PaymentIntentRow, transaction: WompiTransaction, actor: Actor): Promise<string> {
    const now = isoNow();
    const [voidResult] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE payments SET status = 'anulado', void_reason = 'Transacción anulada en Wompi', voided_at = ?
           WHERE tenant_id = ? AND external_id = ? AND status = 'activo'`,
        )
        .bind(now, tenant.id, transaction.id),
      this.db
        .prepare(
          `UPDATE payment_intents SET status = 'VOIDED', wompi_transaction_id = ?,
             outcome = CASE WHEN status = 'APPROVED' THEN 'anulado_en_wompi' ELSE outcome END,
             needs_attention = CASE WHEN status = 'APPROVED' THEN 1 ELSE needs_attention END, updated_at = ?
           WHERE id = ? AND status <> 'VOIDED'`,
        )
        .bind(transaction.id, now, intent.id),
    ]);
    if (voidResult.meta.changes > 0) {
      await this.audit.record(actor, {
        action: 'pago_en_linea_anulado', entity: 'pago_en_linea', entityId: intent.id, details: { transaction: transaction.id },
      });
    }
    return 'anulado';
  }

  // ─── Panel ────────────────────────────────────────────────────────────────

  async listIntents(tenantId: string, options: { attentionOnly: boolean; limit: number; offset: number }) {
    const { results } = await this.db
      .prepare(
        `SELECT i.id, i.reference, i.amount_in_cents, i.environment, i.status, i.outcome, i.needs_attention, i.attention_resolved_at,
                i.wompi_transaction_id, i.payment_method_type, i.payment_id, i.created_at, i.updated_at,
                p.full_name AS patient_name, p.phone AS patient_phone, i.patient_id,
                a.start_at AS appointment_start, a.status AS appointment_status, a.hold_reason AS appointment_hold, s.name AS service_name,
                pay.receipt_number
         FROM payment_intents i
         JOIN patients p ON p.id = i.patient_id
         JOIN appointments a ON a.id = i.appointment_id
         JOIN services s ON s.id = a.service_id
         LEFT JOIN payments pay ON pay.id = i.payment_id
         WHERE i.tenant_id = ? ${options.attentionOnly ? 'AND i.needs_attention = 1' : ''}
         ORDER BY i.needs_attention DESC, i.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tenantId, options.limit, options.offset)
      .all();
    return results;
  }

  async resolveAttention(actor: Actor & { userId: string }, intentId: string, note: string): Promise<void> {
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE payment_intents SET needs_attention = 0, attention_resolved_at = ?, attention_resolved_by = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND needs_attention = 1`,
        )
        .bind(isoNow(), actor.userId, isoNow(), intentId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'alerta_pago_resuelta', entity: 'pago_en_linea', entityId: intentId, details: { note } }),
    ]);
    if (result[0].meta.changes !== 1) throw notFound('La alerta de pago');
  }

  /** Marca como vencidos los intentos pendientes muy antiguos (informativo). */
  async expireStaleIntents(): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 60 * MINUTE_MS).toISOString();
    await this.db
      .prepare("UPDATE payment_intents SET status = 'EXPIRED', updated_at = ? WHERE status = 'PENDING' AND checkout_expires_at < ?")
      .bind(isoNow(), cutoff)
      .run();
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async buildSession(
    tenant: TenantRow,
    gateway: GatewayRow,
    intent: PaymentIntentRow,
    appointment: AppointmentRow,
    origin: string,
  ): Promise<CheckoutSession> {
    const [integritySecret] = await this.decryptSecrets(gateway);
    const patient = await this.patients.getById(tenant.id, appointment.patient_id);
    const statusToken = await this.createStatusToken(intent.id);
    const checkoutUrl = await buildCheckoutUrl({
      publicKey: gateway.public_key,
      integritySecret,
      reference: intent.reference,
      amountInCents: intent.amount_in_cents,
      redirectUrl: `${origin}/c/${encodeURIComponent(tenant.slug)}/pago/${encodeURIComponent(statusToken)}`,
      expirationTime: intent.checkout_expires_at,
      customer: {
        fullName: patient.full_name,
        email: patient.email,
        phoneE164: normalizePhone(patient.phone)?.e164 ?? null,
        legalId: patient.document_number,
        legalIdType: patient.document_type,
      },
    });
    return { intentId: intent.id, checkoutUrl, statusToken, amount: intent.amount_in_cents / 100, holdExpiresAt: appointment.hold_expires_at };
  }

  private assertAwaitingPayment(appointment: AppointmentRow): void {
    if (appointment.status !== 'pendiente' || appointment.hold_reason !== 'pago' || isHoldExpired(appointment)) {
      throw new AppError('Esta reserva ya no está esperando pago. Si necesitas ayuda, comunícate con el consultorio.', 422, 'NOT_AWAITING_PAYMENT');
    }
    if (appointment.prepayment_amount <= 0) throw new AppError('Esta reserva no requiere pago.', 422, 'NO_PREPAYMENT');
  }

  private async getIntent(tenantId: string, intentId: string): Promise<PaymentIntentRow> {
    const intent = await this.db
      .prepare('SELECT * FROM payment_intents WHERE id = ? AND tenant_id = ?')
      .bind(intentId, tenantId)
      .first<PaymentIntentRow>();
    if (!intent) throw notFound('El pago');
    return intent;
  }

  private findGateway(tenantId: string): Promise<GatewayRow | null> {
    return this.db.prepare('SELECT * FROM payment_gateways WHERE tenant_id = ?').bind(tenantId).first<GatewayRow>();
  }

  private decryptSecrets(gateway: GatewayRow): Promise<[string, string]> {
    return Promise.all([
      decryptSecret(this.config.appSecret, gateway.integrity_secret_enc, `${gateway.tenant_id}:integrity`),
      decryptSecret(this.config.appSecret, gateway.events_secret_enc, `${gateway.tenant_id}:events`),
    ]);
  }
}

export function buildWebhookUrl(origin: string, webhookKey: string): string {
  return `${origin}/api/webhooks/wompi/${webhookKey}`;
}

/** Referencia única y legible: AGS-<tiempo base36>-<aleatorio>. */
function generateReference(): string {
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${REFERENCE_PREFIX}${Date.now().toString(36).toUpperCase()}-${randomPart.toUpperCase()}`;
}
