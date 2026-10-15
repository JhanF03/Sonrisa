/**
 * Citas: creación (interna y en línea), retenciones anti-fantasma,
 * reprogramación, estados, cancelación, recordatorios y reactivación.
 *
 * ── Garantía de "cero dobles reservas" (tres capas) ──────────────────────
 * 1. La inserción/actualización verifica cruces EN LA MISMA SENTENCIA SQL
 *    (INSERT … SELECT … WHERE NOT EXISTS): dos reservas simultáneas no pueden
 *    pasar ambas porque la base ejecuta las escrituras una por una.
 * 2. Triggers en la base de datos (migración 0002) rechazan cualquier cruce
 *    aunque un error futuro del código se saltara la capa 1.
 * 3. La regla "esta cita ocupa el horario" es una sola (sqlFragments.ts) y
 *    se usa en disponibilidad, inserciones, movimientos y triggers.
 *
 * ── Retenciones (hold) contra reservas fantasma ──────────────────────────
 *   'pago'          la cita espera el anticipo; si vence, libera el cupo.
 *   'verificacion'  espera el mensaje de WhatsApp con el código.
 *   'confirmacion'  se libera si no se confirma antes del límite.
 * Una retención vencida deja de ocupar el horario AL INSTANTE (regla SQL),
 * y la limpieza programada la marca como cancelada después.
 */
import type { SqlDatabase, SqlStatement, SqlValue } from '../../db/database.js';
import { subscriptionOfTenant } from '../../shared/subscription.js';
import { isSlotTakenError, occupiesSlot, SQL_NOW_UTC } from '../../db/sqlFragments.js';
import type { Actor, TenantRow } from '../../http/context.js';
import { AppError, conflict, notFound } from '../../http/errors.js';
import { constantTimeEqualText } from '../../security/crypto.js';
import { phoneKey } from '../../utils/phone.js';
import { addDays, addMinutes, isoNow, localToUtcIso, nowLocal, subtractMonths, todayLocal } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';
import { computePrepaymentAmount, type CatalogService } from '../catalog/catalogService.js';
import type { PatientService } from '../patients/patientService.js';
import type { ProfessionalService } from '../professionals/professionalService.js';
import type { AvailabilityService } from './availabilityService.js';

export type AppointmentStatus = 'pendiente' | 'confirmada' | 'atendida' | 'no_asistio' | 'cancelada';
export type ManualStatus = Exclude<AppointmentStatus, 'cancelada'>;
export type HoldReason = 'pago' | 'verificacion' | 'confirmacion';

export interface AppointmentRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  professional_id: string;
  professional_name: string;
  professional_color: string;
  service_id: string;
  service_name: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: 'online' | 'manual';
  price: number;
  notes: string | null;
  recurrence_group_id: string | null;
  reminder_sent_at: string | null;
  confirmed_at: string | null;
  cancel_reason: string | null;
  hold_reason: HoldReason | null;
  hold_expires_at: string | null;
  verification_code: string | null;
  prepayment_amount: number;
}

export interface NewAppointmentInput {
  patientId: string;
  professionalId: string;
  serviceId: string;
  startAt: string;
  notes: string | null;
  recurrence: { occurrences: number; intervalWeeks: number } | null;
}

export interface OnlineBookingInput {
  serviceId: string;
  professionalId: string | null;
  startAt: string;
  patient: {
    documentType: string;
    documentNumber: string;
    fullName: string;
    phone: string;
    email: string | null;
  };
}

export interface ReactivationCandidate {
  patient_id: string;
  full_name: string;
  phone: string;
  last_visit: string;
}

/** Transiciones de estado permitidas desde el panel. */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  pendiente: ['confirmada', 'atendida', 'no_asistio'],
  confirmada: ['pendiente', 'atendida', 'no_asistio'],
  no_asistio: ['atendida'],
  atendida: [],
  cancelada: [],
};

const APPOINTMENT_SELECT = `
  SELECT a.id, a.patient_id, pa.full_name AS patient_name, pa.phone AS patient_phone,
         a.professional_id, pr.full_name AS professional_name, pr.color AS professional_color,
         a.service_id, s.name AS service_name, a.start_at, a.end_at, a.status, a.source, a.price, a.notes,
         a.recurrence_group_id, a.reminder_sent_at, a.confirmed_at, a.cancel_reason,
         a.hold_reason, a.hold_expires_at, a.verification_code, a.prepayment_amount
  FROM appointments a
  JOIN patients pa ON pa.id = a.patient_id
  JOIN professionals pr ON pr.id = a.professional_id
  JOIN services s ON s.id = a.service_id`;

const MAX_RECURRENCE = 24;
const MINUTE_MS = 60_000;
/** La liberación automática no aplica si la cita es muy próxima (el paciente acaba de reservar). */
const MIN_CONFIRMATION_LEAD_MS = 60 * MINUTE_MS;

const HOLD_MESSAGES: Record<HoldReason, string> = {
  pago: 'Esta reserva está esperando el pago anticipado.',
  verificacion: 'Esta reserva está esperando la verificación por WhatsApp.',
  confirmacion: 'Esta reserva está esperando la confirmación del paciente.',
};

interface InsertRow {
  appointmentId: string;
  tenantId: string;
  patientId: string;
  professionalId: string;
  serviceId: string;
  startAt: string;
  endAt: string;
  source: 'online' | 'manual';
  price: number;
  notes: string | null;
  recurrenceGroupId: string | null;
  createdBy: string | null;
  holdReason: HoldReason | null;
  holdExpiresAt: string | null;
  verificationCode: string | null;
  prepaymentAmount: number;
  /** Límite de reservas en línea activas por paciente o celular (verificado atómicamente). */
  patientLimit: { max: number; phoneKey: string; nowLocal: string } | null;
}

/** true si la cita tiene una retención que ya venció (no ocupa el horario). */
export function isHoldExpired(appointment: Pick<AppointmentRow, 'hold_reason' | 'hold_expires_at'>, nowMs = Date.now()): boolean {
  return Boolean(appointment.hold_reason && appointment.hold_expires_at && appointment.hold_expires_at <= new Date(nowMs).toISOString());
}

export class AppointmentService {
  /** Se ejecuta al marcar una cita como atendida (aplica anticipos pagados en línea). */
  onAttended: ((tenantId: string, appointmentId: string) => Promise<void>) | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
    private readonly availability: AvailabilityService,
    private readonly catalog: CatalogService,
    private readonly patients: PatientService,
    private readonly professionals: ProfessionalService,
  ) {}

  // ─── Consultas ────────────────────────────────────────────────────────────

  async list(tenantId: string, options: { fromDate: string; toDate: string; professionalId?: string }): Promise<AppointmentRow[]> {
    const params: SqlValue[] = [tenantId, `${options.fromDate}T00:00`, `${addDays(options.toDate, 1)}T00:00`];
    let professionalFilter = '';
    if (options.professionalId) {
      professionalFilter = 'AND a.professional_id = ?';
      params.push(options.professionalId);
    }
    const { results } = await this.db
      .prepare(`${APPOINTMENT_SELECT} WHERE a.tenant_id = ? AND a.start_at >= ? AND a.start_at < ? ${professionalFilter} ORDER BY a.start_at`)
      .bind(...params)
      .all<AppointmentRow>();
    return results;
  }

  async getById(tenantId: string, appointmentId: string, restrictToProfessionalId?: string): Promise<AppointmentRow> {
    const appointment = await this.db
      .prepare(`${APPOINTMENT_SELECT} WHERE a.id = ? AND a.tenant_id = ?`)
      .bind(appointmentId, tenantId)
      .first<AppointmentRow>();
    if (!appointment) throw notFound('La cita');
    if (restrictToProfessionalId && appointment.professional_id !== restrictToProfessionalId) {
      throw notFound('La cita');
    }
    return appointment;
  }

  async listForPatient(tenantId: string, patientId: string): Promise<AppointmentRow[]> {
    const { results } = await this.db
      .prepare(`${APPOINTMENT_SELECT} WHERE a.tenant_id = ? AND a.patient_id = ? ORDER BY a.start_at DESC LIMIT 100`)
      .bind(tenantId, patientId)
      .all<AppointmentRow>();
    return results;
  }

  // ─── Creación interna (panel) ─────────────────────────────────────────────

  async create(actor: Actor, input: NewAppointmentInput): Promise<{ created: AppointmentRow[]; conflicts: string[] }> {
    const [service, professional] = await Promise.all([
      this.catalog.getById(actor.tenantId, input.serviceId),
      this.professionals.getById(actor.tenantId, input.professionalId),
      this.patients.getById(actor.tenantId, input.patientId),
    ]);
    if (service.is_active !== 1) throw new AppError('El servicio está inactivo.', 422, 'INACTIVE_SERVICE');
    if (professional.is_active !== 1) throw new AppError('El profesional está inactivo.', 422, 'INACTIVE_PROFESSIONAL');

    const occurrences = input.recurrence ? Math.min(input.recurrence.occurrences, MAX_RECURRENCE) : 1;
    const intervalDays = (input.recurrence?.intervalWeeks ?? 1) * 7;
    const recurrenceGroupId = occurrences > 1 ? crypto.randomUUID() : null;

    const createdIds: string[] = [];
    const conflicts: string[] = [];

    for (let index = 0; index < occurrences; index++) {
      const startAt = addMinutes(input.startAt, index * intervalDays * 24 * 60);
      const appointmentId = crypto.randomUUID();
      const wasInserted = await this.insertIfFree({
        appointmentId,
        tenantId: actor.tenantId,
        patientId: input.patientId,
        professionalId: input.professionalId,
        serviceId: input.serviceId,
        startAt,
        endAt: addMinutes(startAt, service.duration_minutes),
        source: 'manual',
        price: service.price,
        notes: input.notes,
        recurrenceGroupId,
        createdBy: actor.userId,
        holdReason: null,
        holdExpiresAt: null,
        verificationCode: null,
        prepaymentAmount: 0,
        patientLimit: null,
      });
      if (wasInserted) createdIds.push(appointmentId);
      else conflicts.push(startAt);
    }

    if (createdIds.length === 0) {
      throw conflict('El horario elegido ya está ocupado o bloqueado.');
    }

    await this.audit.record(actor, {
      action: 'cita_creada',
      entity: 'cita',
      entityId: createdIds[0],
      details: { total: createdIds.length, conflicts },
    });

    const created = await Promise.all(createdIds.map((id) => this.getById(actor.tenantId, id)));
    return { created, conflicts };
  }

  async reschedule(
    actor: Actor,
    appointmentId: string,
    input: { startAt: string; professionalId: string },
    restrictToProfessionalId?: string,
  ): Promise<AppointmentRow> {
    const appointment = await this.getById(actor.tenantId, appointmentId, restrictToProfessionalId);
    assertIsActive(appointment);
    assertNotAwaitingPatient(appointment);
    await this.professionals.getById(actor.tenantId, input.professionalId);

    const service = await this.catalog.getById(actor.tenantId, appointment.service_id);
    const wasUpdated = await this.moveIfFree(
      actor.tenantId, appointmentId, input.professionalId, input.startAt, addMinutes(input.startAt, service.duration_minutes), 'pendiente',
    );
    if (!wasUpdated) throw conflict('El nuevo horario ya está ocupado o bloqueado.');

    await this.audit.record(actor, {
      action: 'cita_reprogramada',
      entity: 'cita',
      entityId: appointmentId,
      details: { from: appointment.start_at, to: input.startAt },
    });
    return this.getById(actor.tenantId, appointmentId);
  }

  async changeStatus(actor: Actor, appointmentId: string, newStatus: ManualStatus, restrictToProfessionalId?: string): Promise<AppointmentRow> {
    const appointment = await this.getById(actor.tenantId, appointmentId, restrictToProfessionalId);
    assertHoldNotExpired(appointment);
    if (!ALLOWED_TRANSITIONS[appointment.status].includes(newStatus)) {
      throw new AppError(`No se puede pasar una cita de "${appointment.status}" a "${newStatus}".`, 422, 'INVALID_TRANSITION');
    }

    const now = isoNow();
    // Confirmar, atender o marcar inasistencia desde el panel resuelve cualquier retención
    // (ej. el paciente pagó en recepción o confirmó por teléfono).
    const clearsHold = newStatus !== 'pendiente';
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `UPDATE appointments SET status = ?, updated_at = ?,
             confirmed_at = CASE WHEN ? = 'confirmada' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
             hold_reason = CASE WHEN ? = 1 THEN NULL ELSE hold_reason END,
             hold_expires_at = CASE WHEN ? = 1 THEN NULL ELSE hold_expires_at END,
             verification_code = CASE WHEN ? = 1 THEN NULL ELSE verification_code END
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(newStatus, now, newStatus, now, clearsHold ? 1 : 0, clearsHold ? 1 : 0, clearsHold ? 1 : 0, appointmentId, actor.tenantId),
      this.audit.buildStatement(actor, {
        action: 'cita_estado',
        entity: 'cita',
        entityId: appointmentId,
        details: { from: appointment.status, to: newStatus, ...(appointment.hold_reason && clearsHold ? { retencionResuelta: appointment.hold_reason } : {}) },
      }),
    ];

    // Al atender, el servicio se convierte automáticamente en cuenta por cobrar.
    if (newStatus === 'atendida') {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO charges (id, tenant_id, patient_id, appointment_id, service_id, description, quantity, amount, status, created_by, created_at)
             SELECT ?, a.tenant_id, a.patient_id, a.id, a.service_id, s.name, 1, a.price, 'activo', ?, ?
             FROM appointments a JOIN services s ON s.id = a.service_id
             WHERE a.id = ? AND a.tenant_id = ? AND a.price > 0`,
          )
          .bind(crypto.randomUUID(), actor.userId, now, appointmentId, actor.tenantId),
      );
    }

    await this.db.batch(statements);
    if (newStatus === 'atendida' && this.onAttended) await this.onAttended(actor.tenantId, appointmentId);
    return this.getById(actor.tenantId, appointmentId);
  }

  async cancel(actor: Actor, appointmentId: string, reason: string, restrictToProfessionalId?: string): Promise<AppointmentRow> {
    const appointment = await this.getById(actor.tenantId, appointmentId, restrictToProfessionalId);
    assertIsActive(appointment);
    await this.db.batch([
      this.cancelStatement(actor.tenantId, appointmentId, reason),
      this.audit.buildStatement(actor, { action: 'cita_cancelada', entity: 'cita', entityId: appointmentId, details: { reason } }),
    ]);
    return this.getById(actor.tenantId, appointmentId);
  }

  async markReminderSent(actor: Actor, appointmentId: string): Promise<void> {
    await this.getById(actor.tenantId, appointmentId);
    await this.db.batch([
      this.db
        .prepare('UPDATE appointments SET reminder_sent_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .bind(isoNow(), isoNow(), appointmentId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'recordatorio_enviado', entity: 'cita', entityId: appointmentId }),
    ]);
  }

  /**
   * Citas de un día para recordar. Excluye las que esperan pago o verificación
   * (aún no son reservas reales) y las retenciones vencidas.
   */
  async listForReminders(tenantId: string, date: string): Promise<AppointmentRow[]> {
    const { results } = await this.db
      .prepare(
        `${APPOINTMENT_SELECT}
         WHERE a.tenant_id = ? AND a.start_at >= ? AND a.start_at < ? AND a.status IN ('pendiente', 'confirmada')
           AND ${occupiesSlot('a')} AND (a.hold_reason IS NULL OR a.hold_reason = 'confirmacion')
         ORDER BY a.start_at`,
      )
      .bind(tenantId, `${date}T00:00`, `${addDays(date, 1)}T00:00`)
      .all<AppointmentRow>();
    return results;
  }

  /** Reservas en línea que esperan el mensaje de WhatsApp con su código. */
  async listPendingVerifications(tenantId: string): Promise<AppointmentRow[]> {
    const { results } = await this.db
      .prepare(`${APPOINTMENT_SELECT} WHERE a.tenant_id = ? AND a.hold_reason = 'verificacion' AND a.status = 'pendiente' AND ${occupiesSlot('a')} ORDER BY a.hold_expires_at`)
      .bind(tenantId)
      .all<AppointmentRow>();
    return results;
  }

  /** Recepción confirma que recibió por WhatsApp el código correcto desde el celular del paciente. */
  async verifyWithCode(actor: Actor, appointmentId: string, code: string): Promise<AppointmentRow> {
    const appointment = await this.getById(actor.tenantId, appointmentId);
    if (appointment.hold_reason !== 'verificacion' || appointment.status !== 'pendiente') {
      throw new AppError('Esta reserva no está esperando verificación.', 422, 'NOT_AWAITING_VERIFICATION');
    }
    assertHoldNotExpired(appointment);
    if (!appointment.verification_code || !(await constantTimeEqualText(code.trim(), appointment.verification_code))) {
      throw new AppError('El código no coincide. Revisa el mensaje de WhatsApp del paciente.', 422, 'WRONG_CODE');
    }

    const now = isoNow();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE appointments SET status = 'confirmada', confirmed_at = COALESCE(confirmed_at, ?), hold_reason = NULL,
             hold_expires_at = NULL, verification_code = NULL, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND hold_reason = 'verificacion' AND status = 'pendiente'`,
        )
        .bind(now, now, appointmentId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'reserva_verificada', entity: 'cita', entityId: appointmentId }),
    ]);
    if (result[0].meta.changes !== 1) throw conflict('La reserva cambió mientras la verificabas. Actualiza la lista.');
    return this.getById(actor.tenantId, appointmentId);
  }

  /** Pacientes sin visita en N meses y sin cita futura. */
  async listReactivationCandidates(tenant: TenantRow): Promise<ReactivationCandidate[]> {
    const today = todayLocal(tenant.utc_offset_minutes);
    const cutoffDate = subtractMonths(today, tenant.reactivation_months);
    const { results } = await this.db
      .prepare(
        `SELECT p.id AS patient_id, p.full_name, p.phone, MAX(a.start_at) AS last_visit
         FROM patients p JOIN appointments a ON a.patient_id = p.id AND a.status = 'atendida'
         WHERE p.tenant_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM appointments f WHERE f.patient_id = p.id AND f.status IN ('pendiente', 'confirmada')
               AND ${occupiesSlot('f')} AND f.start_at >= ?
           )
         GROUP BY p.id
         HAVING MAX(a.start_at) < ?
         ORDER BY last_visit
         LIMIT 200`,
      )
      .bind(tenant.id, `${today}T00:00`, `${cutoffDate}T00:00`)
      .all<ReactivationCandidate>();
    return results;
  }

  // ─── Reserva en línea (paciente) ──────────────────────────────────────────

  async bookOnline(
    tenant: TenantRow,
    input: OnlineBookingInput,
    clientIp: string,
    options: { onlinePaymentsEnabled: boolean },
    nowMs = Date.now(),
  ): Promise<AppointmentRow> {
    if (tenant.online_booking_enabled !== 1 || isTenantSuspended(tenant)) {
      throw new AppError('Este consultorio no tiene la reserva en línea activa.', 422, 'BOOKING_DISABLED');
    }

    const service = await this.catalog.getById(tenant.id, input.serviceId);
    if (service.is_active !== 1 || service.is_bookable_online !== 1) {
      throw new AppError('Este servicio no se puede reservar en línea.', 422, 'SERVICE_NOT_BOOKABLE');
    }
    const prepaymentAmount = computePrepaymentAmount(service);
    if (prepaymentAmount > 0 && !options.onlinePaymentsEnabled) {
      throw new AppError('Este servicio requiere pago anticipado y el pago en línea no está disponible. Comunícate con el consultorio.', 422, 'PREPAYMENT_UNAVAILABLE');
    }

    const professionalId = input.professionalId ?? (await this.pickFreeProfessional(tenant, input.startAt, service.duration_minutes));
    const isAvailable =
      professionalId !== null &&
      (await this.availability.isSlotAvailable(tenant, {
        start: input.startAt,
        professionalId,
        durationMinutes: service.duration_minutes,
        applyPublicRules: true,
      }));
    if (!isAvailable || !professionalId) {
      throw conflict('Ese horario ya no está disponible. Por favor elige otro.');
    }

    const actor: Actor = { tenantId: tenant.id, userId: null, ip: clientIp };
    const { patientId, phoneNote } = await this.resolveOnlinePatient(tenant, actor, input.patient);
    const limit = {
      max: tenant.max_pending_online_per_patient,
      phoneKey: phoneKey(input.patient.phone),
      nowLocal: nowLocal(tenant.utc_offset_minutes, nowMs),
    };
    await this.assertBelowPersonLimit(tenant.id, patientId, limit);

    const hold = this.computeOnlineHold(tenant, input.startAt, prepaymentAmount, nowMs);
    const appointmentId = crypto.randomUUID();
    const wasInserted = await this.insertIfFree({
      appointmentId,
      tenantId: tenant.id,
      patientId,
      professionalId,
      serviceId: service.id,
      startAt: input.startAt,
      endAt: addMinutes(input.startAt, service.duration_minutes),
      source: 'online',
      price: service.price,
      notes: phoneNote,
      recurrenceGroupId: null,
      createdBy: null,
      holdReason: hold.reason,
      holdExpiresAt: hold.expiresAt,
      verificationCode: hold.verificationCode,
      prepaymentAmount,
      patientLimit: limit,
    });
    if (!wasInserted) {
      // Distingue el motivo para dar un mensaje correcto.
      await this.assertBelowPersonLimit(tenant.id, patientId, limit);
      throw conflict('Ese horario acaba de ser tomado. Por favor elige otro.');
    }

    await this.audit.record(actor, {
      action: 'cita_reservada_en_linea',
      entity: 'cita',
      entityId: appointmentId,
      details: hold.reason ? { retencion: hold.reason, vence: hold.expiresAt } : undefined,
    });
    return this.getById(tenant.id, appointmentId);
  }

  async confirmByPatient(tenant: TenantRow, appointmentId: string, clientIp: string): Promise<AppointmentRow> {
    const appointment = await this.getById(tenant.id, appointmentId);
    assertIsActive(appointment);
    assertHoldNotExpired(appointment);
    assertInFuture(tenant, appointment);
    assertNotAwaitingPatient(appointment);

    if (appointment.status === 'pendiente') {
      const now = isoNow();
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE appointments SET status = 'confirmada', confirmed_at = ?, hold_reason = NULL, hold_expires_at = NULL, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
          )
          .bind(now, now, appointmentId, tenant.id),
        this.audit.buildStatement({ tenantId: tenant.id, userId: null, ip: clientIp }, {
          action: 'cita_confirmada_por_paciente', entity: 'cita', entityId: appointmentId,
        }),
      ]);
    }
    return this.getById(tenant.id, appointmentId);
  }

  async cancelByPatient(tenant: TenantRow, appointmentId: string, clientIp: string): Promise<AppointmentRow> {
    const appointment = await this.getById(tenant.id, appointmentId);
    assertIsActive(appointment);
    assertInFuture(tenant, appointment);
    await this.db.batch([
      this.cancelStatement(tenant.id, appointmentId, 'Cancelada por el paciente'),
      this.audit.buildStatement({ tenantId: tenant.id, userId: null, ip: clientIp }, {
        action: 'cita_cancelada_por_paciente', entity: 'cita', entityId: appointmentId,
      }),
    ]);
    return this.getById(tenant.id, appointmentId);
  }

  async rescheduleByPatient(tenant: TenantRow, appointmentId: string, newStartAt: string, clientIp: string): Promise<AppointmentRow> {
    const appointment = await this.getById(tenant.id, appointmentId);
    assertIsActive(appointment);
    assertHoldNotExpired(appointment);
    assertInFuture(tenant, appointment);
    assertNotAwaitingPatient(appointment);

    const service = await this.catalog.getById(tenant.id, appointment.service_id);
    const isAvailable = await this.availability.isSlotAvailable(tenant, {
      start: newStartAt,
      professionalId: appointment.professional_id,
      durationMinutes: service.duration_minutes,
      applyPublicRules: true,
      excludeAppointmentId: appointmentId,
    });
    if (!isAvailable) throw conflict('Ese horario no está disponible. Por favor elige otro.');

    // Reprogramar él mismo demuestra que es un paciente real: queda confirmada.
    const wasUpdated = await this.moveIfFree(
      tenant.id, appointmentId, appointment.professional_id, newStartAt, addMinutes(newStartAt, service.duration_minutes), 'confirmada',
    );
    if (!wasUpdated) throw conflict('Ese horario acaba de ser tomado. Por favor elige otro.');

    await this.audit.record({ tenantId: tenant.id, userId: null, ip: clientIp }, {
      action: 'cita_reprogramada_por_paciente', entity: 'cita', entityId: appointmentId,
      details: { from: appointment.start_at, to: newStartAt },
    });
    return this.getById(tenant.id, appointmentId);
  }

  // ─── Pago anticipado ──────────────────────────────────────────────────────

  /**
   * Confirma una cita cuyo anticipo fue aprobado. Si la retención venció y la
   * limpieza ya la canceló, la "revive" SOLO si el horario sigue libre y la
   * cita no ha pasado. Devuelve true si la cita quedó confirmada.
   */
  async confirmPaidAppointment(tenant: TenantRow, appointmentId: string): Promise<boolean> {
    const now = isoNow();
    try {
      const result = await this.db
        .prepare(
          `UPDATE appointments AS target SET status = 'confirmada', confirmed_at = COALESCE(target.confirmed_at, ?), cancelled_at = NULL,
             cancel_reason = NULL, hold_reason = NULL, hold_expires_at = NULL, verification_code = NULL, updated_at = ?
           WHERE target.id = ? AND target.tenant_id = ? AND target.hold_reason = 'pago'
             AND target.status IN ('pendiente', 'cancelada') AND target.start_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM appointments o WHERE o.tenant_id = target.tenant_id AND o.professional_id = target.professional_id
                 AND o.id <> target.id AND ${occupiesSlot('o')} AND o.start_at < target.end_at AND o.end_at > target.start_at
             )
             AND NOT EXISTS (
               SELECT 1 FROM time_blocks b WHERE b.tenant_id = target.tenant_id
                 AND (b.professional_id IS NULL OR b.professional_id = target.professional_id)
                 AND b.start_at < target.end_at AND b.end_at > target.start_at
             )`,
        )
        .bind(now, now, appointmentId, tenant.id, nowLocal(tenant.utc_offset_minutes))
        .run();
      if (result.meta.changes === 1) return true;
    } catch (error) {
      if (!isSlotTakenError(error)) throw error;
    }

    // Puede que ya estuviera confirmada (pago repetido o recepción la confirmó).
    const current = await this.getById(tenant.id, appointmentId);
    return current.hold_reason === null && ['pendiente', 'confirmada', 'atendida'].includes(current.status);
  }

  /** Libera una reserva que esperaba pago (el paciente desistió). */
  async releasePaymentHold(tenant: TenantRow, appointmentId: string, clientIp: string, reason: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE appointments SET status = 'cancelada', cancelled_at = ?, cancel_reason = ?, hold_reason = NULL,
             hold_expires_at = NULL, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND status = 'pendiente' AND hold_reason = 'pago'`,
        )
        .bind(isoNow(), reason, isoNow(), appointmentId, tenant.id),
      this.audit.buildStatement({ tenantId: tenant.id, userId: null, ip: clientIp }, {
        action: 'reserva_liberada', entity: 'cita', entityId: appointmentId, details: { reason },
      }),
    ]);
  }

  // ─── Mantenimiento ────────────────────────────────────────────────────────

  /**
   * Cancela las retenciones vencidas. El cupo ya estaba libre desde que
   * venció (regla SQL); esto solo deja el registro ordenado y auditado.
   * Se conserva hold_reason para saber que fue una liberación automática.
   */
  async expireStaleHolds(tenantId?: string): Promise<number> {
    const tenantFilter = tenantId ? 'AND tenant_id = ?' : '';
    const tenantParams = tenantId ? [tenantId] : [];
    const staleCondition = `status = 'pendiente' AND hold_reason IS NOT NULL AND hold_expires_at <= ${SQL_NOW_UTC} ${tenantFilter}`;
    const now = isoNow();

    const [, update] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audit_log (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
           SELECT lower(hex(randomblob(16))), tenant_id, NULL, 'reserva_liberada', 'cita', id,
                  json_object('motivo', hold_reason, 'vencio', hold_expires_at), 'sistema', ?
           FROM appointments WHERE ${staleCondition}`,
        )
        .bind(now, ...tenantParams),
      this.db
        .prepare(
          `UPDATE appointments SET status = 'cancelada', cancelled_at = ?, updated_at = ?,
             cancel_reason = CASE hold_reason
               WHEN 'pago' THEN 'Liberada: el pago anticipado no se completó a tiempo'
               WHEN 'verificacion' THEN 'Liberada: no se verificó por WhatsApp a tiempo'
               ELSE 'Liberada: el paciente no confirmó a tiempo' END
           WHERE ${staleCondition}`,
        )
        .bind(now, now, ...tenantParams),
    ]);
    return update.meta.changes;
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private computeOnlineHold(
    tenant: TenantRow,
    startAt: string,
    prepaymentAmount: number,
    nowMs: number,
  ): { reason: HoldReason | null; expiresAt: string | null; verificationCode: string | null } {
    if (prepaymentAmount > 0) {
      return { reason: 'pago', expiresAt: new Date(nowMs + tenant.payment_window_minutes * MINUTE_MS).toISOString(), verificationCode: null };
    }
    if (tenant.online_verification_mode === 'whatsapp') {
      return {
        reason: 'verificacion',
        expiresAt: new Date(nowMs + tenant.verification_window_minutes * MINUTE_MS).toISOString(),
        verificationCode: generateVerificationCode(),
      };
    }
    if (tenant.auto_release_hours > 0) {
      const deadlineMs = new Date(localToUtcIso(startAt, tenant.utc_offset_minutes)).getTime() - tenant.auto_release_hours * 60 * MINUTE_MS;
      if (deadlineMs > nowMs + MIN_CONFIRMATION_LEAD_MS) {
        return { reason: 'confirmacion', expiresAt: new Date(deadlineMs).toISOString(), verificationCode: null };
      }
    }
    return { reason: null, expiresAt: null, verificationCode: null };
  }

  private async assertBelowPersonLimit(tenantId: string, patientId: string, limit: { max: number; phoneKey: string; nowLocal: string }): Promise<void> {
    const row = await this.db
      .prepare(`SELECT ${personActiveCountSql()} AS total`)
      .bind(tenantId, limit.nowLocal, patientId, limit.phoneKey)
      .first<{ total: number }>();
    if ((row?.total ?? 0) >= limit.max) {
      throw new AppError(
        `Ya tienes ${row?.total} ${row?.total === 1 ? 'reserva activa' : 'reservas activas'} en línea. Para agendar otra, comunícate con el consultorio.`,
        409,
        'BOOKING_LIMIT',
      );
    }
  }

  private async insertIfFree(row: InsertRow): Promise<boolean> {
    const now = isoNow();
    const limitCondition = row.patientLimit ? `AND ${personActiveCountSql()} < ?` : '';
    const limitParams: SqlValue[] = row.patientLimit
      ? [row.tenantId, row.patientLimit.nowLocal, row.patientId, row.patientLimit.phoneKey, row.patientLimit.max]
      : [];

    try {
      const result = await this.db
        .prepare(
          `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, start_at, end_at, status, source,
             price, notes, recurrence_group_id, created_by, created_at, updated_at,
             hold_reason, hold_expires_at, verification_code, prepayment_amount)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM appointments o WHERE o.tenant_id = ? AND o.professional_id = ? AND ${occupiesSlot('o')}
               AND o.start_at < ? AND o.end_at > ?
           ) AND NOT EXISTS (
             SELECT 1 FROM time_blocks WHERE tenant_id = ? AND (professional_id IS NULL OR professional_id = ?)
               AND start_at < ? AND end_at > ?
           ) ${limitCondition}`,
        )
        .bind(
          row.appointmentId, row.tenantId, row.patientId, row.professionalId, row.serviceId, row.startAt, row.endAt,
          row.source, row.price, row.notes, row.recurrenceGroupId, row.createdBy, now, now,
          row.holdReason, row.holdExpiresAt, row.verificationCode, row.prepaymentAmount,
          row.tenantId, row.professionalId, row.endAt, row.startAt,
          row.tenantId, row.professionalId, row.endAt, row.startAt,
          ...limitParams,
        )
        .run();
      return result.meta.changes === 1;
    } catch (error) {
      // El trigger de la base detectó un cruce: se trata igual que "ocupado".
      if (isSlotTakenError(error)) return false;
      throw error;
    }
  }

  private async moveIfFree(
    tenantId: string,
    appointmentId: string,
    professionalId: string,
    startAt: string,
    endAt: string,
    targetStatus: 'pendiente' | 'confirmada',
  ): Promise<boolean> {
    const now = isoNow();
    try {
      const result = await this.db
        .prepare(
          `UPDATE appointments SET professional_id = ?, start_at = ?, end_at = ?, status = ?,
             confirmed_at = CASE WHEN ? = 'confirmada' THEN ? ELSE NULL END,
             reminder_sent_at = NULL, hold_reason = NULL, hold_expires_at = NULL, verification_code = NULL, updated_at = ?
           WHERE id = ? AND tenant_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM appointments o WHERE o.tenant_id = ? AND o.professional_id = ? AND ${occupiesSlot('o')}
                 AND o.id <> ? AND o.start_at < ? AND o.end_at > ?
             ) AND NOT EXISTS (
               SELECT 1 FROM time_blocks b WHERE b.tenant_id = ? AND (b.professional_id IS NULL OR b.professional_id = ?)
                 AND b.start_at < ? AND b.end_at > ?
             )`,
        )
        .bind(
          professionalId, startAt, endAt, targetStatus, targetStatus, now, now, appointmentId, tenantId,
          tenantId, professionalId, appointmentId, endAt, startAt,
          tenantId, professionalId, endAt, startAt,
        )
        .run();
      return result.meta.changes === 1;
    } catch (error) {
      if (isSlotTakenError(error)) return false;
      throw error;
    }
  }

  private cancelStatement(tenantId: string, appointmentId: string, reason: string): SqlStatement {
    const now = isoNow();
    // hold_reason en NULL: una cancelación manual nunca se "revive" con un pago tardío.
    return this.db
      .prepare(
        `UPDATE appointments SET status = 'cancelada', cancelled_at = ?, cancel_reason = ?, hold_reason = NULL,
           hold_expires_at = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(now, reason, now, appointmentId, tenantId);
  }

  private async pickFreeProfessional(tenant: TenantRow, startAt: string, durationMinutes: number): Promise<string | null> {
    const date = startAt.slice(0, 10);
    const slots = await this.availability.findSlots(tenant, {
      fromDate: date,
      toDate: date,
      durationMinutes,
      applyPublicRules: true,
    });
    return slots.find((slot) => slot.start === startAt)?.professionalId ?? null;
  }

  /**
   * Busca al paciente por documento o lo crea.
   * Seguridad: un formulario público NUNCA modifica los datos de un paciente
   * existente (cualquiera podría cambiar el teléfono de otro). Si el teléfono
   * no coincide, se deja una nota para que recepción lo verifique.
   */
  private async resolveOnlinePatient(
    tenant: TenantRow,
    actor: Actor,
    patientInput: OnlineBookingInput['patient'],
  ): Promise<{ patientId: string; phoneNote: string | null }> {
    const existing = await this.patients.findByDocument(tenant.id, patientInput.documentType, patientInput.documentNumber);
    if (existing) return this.useExistingPatient(tenant, existing, patientInput.phone);

    try {
      const created = await this.patients.create(
        actor,
        {
          documentType: patientInput.documentType,
          documentNumber: patientInput.documentNumber,
          fullName: patientInput.fullName,
          phone: patientInput.phone,
          email: patientInput.email,
          birthDate: null,
          guardianName: null,
          guardianPhone: null,
          adminNotes: null,
        },
        { version: tenant.privacy_policy_version, channel: 'en_linea' },
      );
      return { patientId: created.id, phoneNote: null };
    } catch (error) {
      // Dos reservas simultáneas de la misma persona nueva: la otra ya creó el paciente.
      const isDuplicate = (error instanceof AppError && error.statusCode === 409) || (error instanceof Error && /UNIQUE constraint failed/i.test(error.message));
      if (!isDuplicate) throw error;
      const createdMeanwhile = await this.patients.findByDocument(tenant.id, patientInput.documentType, patientInput.documentNumber);
      if (!createdMeanwhile) throw error;
      return this.useExistingPatient(tenant, createdMeanwhile, patientInput.phone);
    }
  }

  private async useExistingPatient(
    tenant: TenantRow,
    existing: { id: string; phone: string; consent_at: string | null },
    bookingPhone: string,
  ): Promise<{ patientId: string; phoneNote: string | null }> {
    if (!existing.consent_at) {
      await this.patients.recordConsent(tenant.id, existing.id, tenant.privacy_policy_version, 'en_linea');
    }
    const phoneDiffers = phoneKey(existing.phone) !== phoneKey(bookingPhone);
    return {
      patientId: existing.id,
      phoneNote: phoneDiffers ? `Verificar: en la reserva en línea indicó el teléfono ${bookingPhone}.` : null,
    };
  }
}

/**
 * Cuenta las reservas EN LÍNEA activas y futuras de la misma persona
 * (mismo paciente o mismo celular). Parámetros: tenantId, ahoraLocal, patientId, phoneKey.
 */
function personActiveCountSql(): string {
  return `(SELECT COUNT(*) FROM appointments x JOIN patients px ON px.id = x.patient_id
    WHERE x.tenant_id = ? AND x.source = 'online' AND x.status IN ('pendiente', 'confirmada')
      AND ${occupiesSlot('x')} AND x.start_at >= ?
      AND (x.patient_id = ? OR substr(replace(px.phone, '+', ''), -10) = ?))`;
}

function generateVerificationCode(): string {
  const [randomValue] = crypto.getRandomValues(new Uint32Array(1));
  return String(100_000 + (randomValue % 900_000));
}

function assertIsActive(appointment: AppointmentRow): void {
  if (appointment.status !== 'pendiente' && appointment.status !== 'confirmada') {
    throw new AppError('Esta cita ya no se puede modificar.', 422, 'APPOINTMENT_CLOSED');
  }
}

function assertHoldNotExpired(appointment: AppointmentRow): void {
  if (isHoldExpired(appointment)) {
    throw new AppError('Esta reserva venció sin completarse y ya no ocupa el horario.', 422, 'HOLD_EXPIRED');
  }
}

/** Las reservas que esperan pago o verificación no se reprograman ni se confirman con el enlace. */
function assertNotAwaitingPatient(appointment: AppointmentRow): void {
  if (appointment.hold_reason === 'pago' || appointment.hold_reason === 'verificacion') {
    throw new AppError(HOLD_MESSAGES[appointment.hold_reason], 422, 'AWAITING_PATIENT');
  }
}

function assertInFuture(tenant: TenantRow, appointment: AppointmentRow): void {
  if (appointment.start_at <= nowLocal(tenant.utc_offset_minutes)) {
    throw new AppError('Esta cita ya pasó. Comunícate con el consultorio.', 422, 'APPOINTMENT_PAST');
  }
}

/** Suscripción suspendida por falta de pago: no se reciben reservas en línea nuevas. */
export function isTenantSuspended(tenant: TenantRow): boolean {
  return subscriptionOfTenant(tenant).blocked;
}
