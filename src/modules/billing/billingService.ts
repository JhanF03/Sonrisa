/**
 * Caja y cartera.
 *
 * Conceptos:
 * • Cargo: lo que el paciente debe (servicio atendido o ítem de un tratamiento).
 * • Recaudo: dinero recibido, con recibo de caja consecutivo.
 * • Abono: la parte de un recaudo aplicada a un cargo (payment_allocations).
 * • Anticipo / saldo a favor: la parte de un recaudo que aún no se aplica.
 *
 * Reglas:
 * • Nada se borra: cargos y recaudos se ANULAN con motivo (auditable).
 * • Un recaudo anulado deja de contar; sus abonos quedan sin efecto.
 * • Un cargo anulado libera sus abonos: ese dinero vuelve a ser saldo a favor.
 * • El consecutivo del recibo se asigna en la misma transacción del pago.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor, TenantRow } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { addDays, daysBetween, isoNow, localToUtcIso, todayLocal, utcIsoToLocalDate } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';
import type { CatalogService } from '../catalog/catalogService.js';
import type { PatientService } from '../patients/patientService.js';

export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'nequi', 'daviplata', 'tarjeta', 'otro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface ChargeWithBalance {
  id: string;
  patient_id: string;
  description: string;
  quantity: number;
  amount: number;
  paid: number;
  balance: number;
  status: 'activo' | 'anulado';
  appointment_id: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface PaymentWithAvailable {
  id: string;
  patient_id: string;
  patient_name: string;
  receipt_number: number;
  amount: number;
  allocated: number;
  available: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  status: 'activo' | 'anulado';
  void_reason: string | null;
  created_by_name: string | null;
  created_at: string;
  source: 'caja' | 'wompi';
  appointment_id: string | null;
}

export interface PatientStatement {
  charges: ChargeWithBalance[];
  payments: PaymentWithAvailable[];
  totals: {
    charged: number;
    paid: number;
    /** Positivo = el paciente debe. Negativo = saldo a favor. */
    balance: number;
    pendingDebt: number;
    availableCredit: number;
  };
}

export interface AgingRow {
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  current: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
  oldestDays: number;
}

const CHARGE_WITH_BALANCE_SELECT = `
  SELECT c.id, c.patient_id, c.description, c.quantity, c.amount, c.status, c.appointment_id, c.void_reason, c.created_at,
         COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                   JOIN payments p ON p.id = pa.payment_id AND p.status = 'activo'
                   WHERE pa.charge_id = c.id), 0) AS paid
  FROM charges c`;

const PAYMENT_WITH_AVAILABLE_SELECT = `
  SELECT p.id, p.patient_id, p.receipt_number, p.amount, p.method, p.reference, p.notes, p.status, p.void_reason,
         p.source, p.appointment_id,
         p.created_at, u.full_name AS created_by_name, pt.full_name AS patient_name,
         COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                   JOIN charges c ON c.id = pa.charge_id AND c.status = 'activo'
                   WHERE pa.payment_id = p.id), 0) AS allocated
  FROM payments p
  JOIN patients pt ON pt.id = p.patient_id
  LEFT JOIN users u ON u.id = p.created_by`;

type ChargeQueryRow = Omit<ChargeWithBalance, 'balance'>;
type PaymentQueryRow = Omit<PaymentWithAvailable, 'available'>;

export class BillingService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
    private readonly patients: PatientService,
    private readonly catalog: CatalogService,
  ) {}

  // ─── Cargos ───────────────────────────────────────────────────────────────

  async createCharge(
    actor: Actor,
    input: { patientId: string; serviceId: string | null; description: string | null; quantity: number; unitPrice: number | null },
  ): Promise<ChargeWithBalance> {
    await this.patients.getById(actor.tenantId, input.patientId);
    const service = input.serviceId ? await this.catalog.getById(actor.tenantId, input.serviceId) : null;

    const unitPrice = input.unitPrice ?? service?.price;
    const description = input.description ?? service?.name;
    if (!unitPrice || unitPrice <= 0) throw new AppError('Indica el valor del cargo.', 422, 'MISSING_AMOUNT');
    if (!description) throw new AppError('Indica la descripción del cargo.', 422, 'MISSING_DESCRIPTION');

    const chargeId = crypto.randomUUID();
    const amount = unitPrice * input.quantity;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO charges (id, tenant_id, patient_id, service_id, description, quantity, amount, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?)`,
        )
        .bind(chargeId, actor.tenantId, input.patientId, service?.id ?? null, description, input.quantity, amount, actor.userId, isoNow()),
      this.audit.buildStatement(actor, { action: 'cargo_creado', entity: 'cargo', entityId: chargeId, details: { amount } }),
    ]);
    return this.getCharge(actor.tenantId, chargeId);
  }

  async voidCharge(actor: Actor, chargeId: string, reason: string): Promise<ChargeWithBalance> {
    const charge = await this.getCharge(actor.tenantId, chargeId);
    if (charge.status === 'anulado') throw new AppError('El cargo ya está anulado.', 422, 'ALREADY_VOIDED');

    await this.db.batch([
      this.db
        .prepare("UPDATE charges SET status = 'anulado', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND tenant_id = ?")
        .bind(reason, actor.userId, isoNow(), chargeId, actor.tenantId),
      this.audit.buildStatement(actor, {
        action: 'cargo_anulado', entity: 'cargo', entityId: chargeId, details: { reason, amount: charge.amount, paid: charge.paid },
      }),
    ]);
    return this.getCharge(actor.tenantId, chargeId);
  }

  async getCharge(tenantId: string, chargeId: string): Promise<ChargeWithBalance> {
    const row = await this.db
      .prepare(`${CHARGE_WITH_BALANCE_SELECT} WHERE c.id = ? AND c.tenant_id = ?`)
      .bind(chargeId, tenantId)
      .first<ChargeQueryRow>();
    if (!row) throw notFound('El cargo');
    return withChargeBalance(row);
  }

  // ─── Recaudos ─────────────────────────────────────────────────────────────

  async registerPayment(
    actor: Actor,
    input: {
      patientId: string;
      amount: number;
      method: PaymentMethod;
      reference: string | null;
      notes: string | null;
      /** Cargos específicos a abonar (en orden). Si se omite, se abona a los más antiguos. */
      chargeIds: string[] | null;
      /** false = todo queda como anticipo (saldo a favor). */
      applyToCharges: boolean;
    },
  ): Promise<PaymentWithAvailable> {
    await this.patients.getById(actor.tenantId, input.patientId);

    const paymentId = crypto.randomUUID();
    const now = isoNow();
    const pendingCharges = input.applyToCharges ? await this.listPendingCharges(actor.tenantId, input.patientId) : [];
    const targetCharges = input.chargeIds
      ? input.chargeIds.map((chargeId) => {
          const charge = pendingCharges.find((pending) => pending.id === chargeId);
          if (!charge) throw new AppError('Uno de los cargos elegidos no existe o ya está pagado.', 422, 'INVALID_CHARGE');
          return charge;
        })
      : pendingCharges;

    const statements: SqlStatement[] = [
      this.db
        .prepare("UPDATE counters SET value = value + 1 WHERE tenant_id = ? AND name = 'recibo_caja'")
        .bind(actor.tenantId),
      this.db
        .prepare(
          `INSERT INTO payments (id, tenant_id, patient_id, receipt_number, amount, method, reference, notes, status, created_by, created_at)
           SELECT ?, ?, ?, value, ?, ?, ?, ?, 'activo', ?, ? FROM counters WHERE tenant_id = ? AND name = 'recibo_caja'`,
        )
        .bind(paymentId, actor.tenantId, input.patientId, input.amount, input.method, input.reference, input.notes, actor.userId, now, actor.tenantId),
      ...this.buildAllocationStatements(actor.tenantId, paymentId, input.amount, targetCharges, now),
      this.audit.buildStatement(actor, {
        action: 'recaudo_registrado', entity: 'recaudo', entityId: paymentId, details: { amount: input.amount, method: input.method },
      }),
    ];

    await this.db.batch(statements);
    return this.getPayment(actor.tenantId, paymentId);
  }

  /**
   * Aplica los anticipos pagados para una cita específica al cargo de esa cita
   * (se llama al marcarla como atendida). Idempotente: usa saldos disponibles.
   */
  async applyAppointmentPrepayments(tenantId: string, appointmentId: string): Promise<void> {
    const [chargeResult, paymentResult] = await Promise.all([
      this.db
        .prepare(`${CHARGE_WITH_BALANCE_SELECT} WHERE c.tenant_id = ? AND c.appointment_id = ? AND c.status = 'activo'`)
        .bind(tenantId, appointmentId)
        .all<ChargeQueryRow>(),
      this.db
        .prepare(`${PAYMENT_WITH_AVAILABLE_SELECT} WHERE p.tenant_id = ? AND p.appointment_id = ? AND p.status = 'activo' ORDER BY p.created_at`)
        .bind(tenantId, appointmentId)
        .all<PaymentQueryRow>(),
    ]);
    const charges = chargeResult.results.map(withChargeBalance).filter((charge) => charge.balance > 0);
    const payments = paymentResult.results.map(withAvailable).filter((payment) => payment.available > 0);
    if (charges.length === 0 || payments.length === 0) return;

    const now = isoNow();
    const remainingByCharge = new Map(charges.map((charge) => [charge.id, charge.balance]));
    const statements = payments.flatMap((payment) =>
      this.buildAllocationStatements(tenantId, payment.id, payment.available, charges, now, remainingByCharge),
    );
    if (statements.length > 0) await this.db.batch(statements);
  }

  /** Aplica el saldo a favor (anticipos) a los cargos pendientes más antiguos. */
  async applyAvailableCredit(actor: Actor, patientId: string): Promise<PatientStatement> {
    await this.patients.getById(actor.tenantId, patientId);
    const [pendingCharges, payments] = await Promise.all([
      this.listPendingCharges(actor.tenantId, patientId),
      this.listPayments(actor.tenantId, { patientId }),
    ]);
    const paymentsWithCredit = payments.filter((payment) => payment.status === 'activo' && payment.available > 0);
    if (pendingCharges.length === 0 || paymentsWithCredit.length === 0) {
      throw new AppError('No hay saldo a favor o cargos pendientes para cruzar.', 422, 'NOTHING_TO_APPLY');
    }

    const now = isoNow();
    const statements: SqlStatement[] = [];
    const remainingByCharge = new Map(pendingCharges.map((charge) => [charge.id, charge.balance]));

    for (const payment of [...paymentsWithCredit].reverse()) {
      const chargesWithBalance = pendingCharges
        .filter((charge) => (remainingByCharge.get(charge.id) ?? 0) > 0)
        .map((charge) => ({ ...charge, balance: remainingByCharge.get(charge.id) ?? 0 }));
      const allocationStatements = this.buildAllocationStatements(actor.tenantId, payment.id, payment.available, chargesWithBalance, now, remainingByCharge);
      statements.push(...allocationStatements);
    }

    statements.push(this.audit.buildStatement(actor, { action: 'saldo_a_favor_aplicado', entity: 'paciente', entityId: patientId }));
    await this.db.batch(statements);
    return this.getPatientStatement(actor.tenantId, patientId);
  }

  async voidPayment(actor: Actor, paymentId: string, reason: string): Promise<PaymentWithAvailable> {
    const payment = await this.getPayment(actor.tenantId, paymentId);
    if (payment.status === 'anulado') throw new AppError('El recibo ya está anulado.', 422, 'ALREADY_VOIDED');

    await this.db.batch([
      this.db
        .prepare("UPDATE payments SET status = 'anulado', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND tenant_id = ?")
        .bind(reason, actor.userId, isoNow(), paymentId, actor.tenantId),
      this.audit.buildStatement(actor, {
        action: 'recaudo_anulado',
        entity: 'recaudo',
        entityId: paymentId,
        details: { reason, amount: payment.amount, receipt: payment.receipt_number },
      }),
    ]);
    return this.getPayment(actor.tenantId, paymentId);
  }

  async getPayment(tenantId: string, paymentId: string): Promise<PaymentWithAvailable> {
    const row = await this.db
      .prepare(`${PAYMENT_WITH_AVAILABLE_SELECT} WHERE p.id = ? AND p.tenant_id = ?`)
      .bind(paymentId, tenantId)
      .first<PaymentQueryRow>();
    if (!row) throw notFound('El recibo');
    return withAvailable(row);
  }

  /** Datos para imprimir el recibo de caja. */
  async getReceipt(tenant: TenantRow, paymentId: string) {
    const payment = await this.getPayment(tenant.id, paymentId);
    const patient = await this.patients.getById(tenant.id, payment.patient_id);
    const { results: allocations } = await this.db
      .prepare(
        `SELECT c.description, pa.amount FROM payment_allocations pa
         JOIN charges c ON c.id = pa.charge_id
         WHERE pa.payment_id = ? AND pa.tenant_id = ? ORDER BY pa.created_at`,
      )
      .bind(paymentId, tenant.id)
      .all<{ description: string; amount: number }>();

    return {
      clinic: { name: tenant.name, address: tenant.address, city: tenant.city, phone: tenant.phone },
      payment,
      patient: { fullName: patient.full_name, documentType: patient.document_type, documentNumber: patient.document_number },
      allocations,
      issuedAtLocalDate: utcIsoToLocalDate(payment.created_at, tenant.utc_offset_minutes),
    };
  }

  async listPayments(
    tenantId: string,
    options: { patientId?: string; fromUtc?: string; toUtc?: string; limit?: number },
  ): Promise<PaymentWithAvailable[]> {
    const filters = ['p.tenant_id = ?'];
    const params: Array<string | number> = [tenantId];
    if (options.patientId) {
      filters.push('p.patient_id = ?');
      params.push(options.patientId);
    }
    if (options.fromUtc && options.toUtc) {
      filters.push('p.created_at >= ? AND p.created_at < ?');
      params.push(options.fromUtc, options.toUtc);
    }
    params.push(options.limit ?? 500);

    const { results } = await this.db
      .prepare(`${PAYMENT_WITH_AVAILABLE_SELECT} WHERE ${filters.join(' AND ')} ORDER BY p.created_at DESC LIMIT ?`)
      .bind(...params)
      .all<PaymentQueryRow>();
    return results.map(withAvailable);
  }

  // ─── Estados de cuenta y reportes ─────────────────────────────────────────

  async getPatientStatement(tenantId: string, patientId: string): Promise<PatientStatement> {
    await this.patients.getById(tenantId, patientId);
    const [chargeResult, payments] = await Promise.all([
      this.db
        .prepare(`${CHARGE_WITH_BALANCE_SELECT} WHERE c.tenant_id = ? AND c.patient_id = ? ORDER BY c.created_at DESC`)
        .bind(tenantId, patientId)
        .all<ChargeQueryRow>(),
      this.listPayments(tenantId, { patientId }),
    ]);

    const charges = chargeResult.results.map(withChargeBalance);
    const activeCharges = charges.filter((charge) => charge.status === 'activo');
    const activePayments = payments.filter((payment) => payment.status === 'activo');
    const charged = sum(activeCharges.map((charge) => charge.amount));
    const paid = sum(activePayments.map((payment) => payment.amount));

    return {
      charges,
      payments,
      totals: {
        charged,
        paid,
        balance: charged - paid,
        pendingDebt: sum(activeCharges.map((charge) => charge.balance)),
        availableCredit: sum(activePayments.map((payment) => payment.available)),
      },
    };
  }

  /** Cierre de caja de un día: totales por medio de pago y anulaciones. */
  async getCashClosing(tenant: TenantRow, localDate: string) {
    const fromUtc = localToUtcIso(`${localDate}T00:00`, tenant.utc_offset_minutes);
    const toUtc = localToUtcIso(`${addDays(localDate, 1)}T00:00`, tenant.utc_offset_minutes);
    const payments = await this.listPayments(tenant.id, { fromUtc, toUtc, limit: 2000 });

    const activePayments = payments.filter((payment) => payment.status === 'activo');
    const totalsByMethod = Object.fromEntries(
      PAYMENT_METHODS.map((method) => [
        method,
        sum(activePayments.filter((payment) => payment.method === method).map((payment) => payment.amount)),
      ]),
    ) as Record<PaymentMethod, number>;

    return {
      date: localDate,
      totalsByMethod,
      total: sum(activePayments.map((payment) => payment.amount)),
      receiptCount: activePayments.length,
      voidedPayments: payments.filter((payment) => payment.status === 'anulado'),
      payments,
    };
  }

  /** Edades de cartera por paciente (0–30, 31–60, 61–90, más de 90 días). */
  async getAgingReport(tenant: TenantRow): Promise<AgingRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM (
           ${CHARGE_WITH_BALANCE_SELECT.replace('SELECT c.id,', 'SELECT pa2.full_name AS patient_name, pa2.phone AS patient_phone, c.id,')}
           JOIN patients pa2 ON pa2.id = c.patient_id
           WHERE c.tenant_id = ? AND c.status = 'activo'
         ) WHERE amount > paid`,
      )
      .bind(tenant.id)
      .all<ChargeQueryRow & { patient_name: string; patient_phone: string }>();

    const today = todayLocal(tenant.utc_offset_minutes);
    const rowsByPatient = new Map<string, AgingRow>();

    for (const charge of results) {
      const balance = charge.amount - charge.paid;
      const ageDays = daysBetween(utcIsoToLocalDate(charge.created_at, tenant.utc_offset_minutes), today);
      const row = rowsByPatient.get(charge.patient_id) ?? {
        patient_id: charge.patient_id,
        patient_name: charge.patient_name,
        patient_phone: charge.patient_phone,
        current: 0,
        days31to60: 0,
        days61to90: 0,
        over90: 0,
        total: 0,
        oldestDays: 0,
      };
      if (ageDays <= 30) row.current += balance;
      else if (ageDays <= 60) row.days31to60 += balance;
      else if (ageDays <= 90) row.days61to90 += balance;
      else row.over90 += balance;
      row.total += balance;
      row.oldestDays = Math.max(row.oldestDays, ageDays);
      rowsByPatient.set(charge.patient_id, row);
    }

    return [...rowsByPatient.values()].sort((first, second) => second.total - first.total);
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async listPendingCharges(tenantId: string, patientId: string): Promise<ChargeWithBalance[]> {
    const { results } = await this.db
      .prepare(`${CHARGE_WITH_BALANCE_SELECT} WHERE c.tenant_id = ? AND c.patient_id = ? AND c.status = 'activo' ORDER BY c.created_at`)
      .bind(tenantId, patientId)
      .all<ChargeQueryRow>();
    return results.map(withChargeBalance).filter((charge) => charge.balance > 0);
  }

  /** Reparte un monto entre cargos (FIFO) y devuelve las sentencias de abono. */
  private buildAllocationStatements(
    tenantId: string,
    paymentId: string,
    amountToAllocate: number,
    charges: ChargeWithBalance[],
    now: string,
    remainingByCharge?: Map<string, number>,
  ): SqlStatement[] {
    const statements: SqlStatement[] = [];
    let remaining = amountToAllocate;

    for (const charge of charges) {
      if (remaining <= 0) break;
      const chargeBalance = remainingByCharge?.get(charge.id) ?? charge.balance;
      const allocation = Math.min(remaining, chargeBalance);
      if (allocation <= 0) continue;

      statements.push(
        this.db
          .prepare('INSERT INTO payment_allocations (id, tenant_id, payment_id, charge_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), tenantId, paymentId, charge.id, allocation, now),
      );
      remaining -= allocation;
      remainingByCharge?.set(charge.id, chargeBalance - allocation);
    }
    return statements;
  }
}

function withChargeBalance(row: ChargeQueryRow): ChargeWithBalance {
  return { ...row, balance: row.status === 'activo' ? Math.max(0, row.amount - row.paid) : 0 };
}

function withAvailable(row: PaymentQueryRow): PaymentWithAvailable {
  return { ...row, available: row.status === 'activo' ? Math.max(0, row.amount - row.allocated) : 0 };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
