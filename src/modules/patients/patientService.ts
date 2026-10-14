/**
 * Pacientes: solo datos administrativos y de contacto (nada clínico).
 * La autorización de tratamiento de datos (Ley 1581 de 2012) queda registrada
 * con fecha, versión de la política y canal.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { conflict, notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';

export interface PatientRow {
  id: string;
  document_type: string;
  document_number: string;
  full_name: string;
  phone: string;
  email: string | null;
  birth_date: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  admin_notes: string | null;
  consent_at: string | null;
  consent_version: string | null;
  consent_channel: string | null;
  created_at: string;
}

export interface PatientListRow extends PatientRow {
  balance: number;
  last_visit: string | null;
  next_appointment: string | null;
}

export interface PatientInput {
  documentType: string;
  documentNumber: string;
  fullName: string;
  phone: string;
  email: string | null;
  birthDate: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  adminNotes: string | null;
}

const PATIENT_COLUMNS = `p.id, p.document_type, p.document_number, p.full_name, p.phone, p.email, p.birth_date,
  p.guardian_name, p.guardian_phone, p.admin_notes, p.consent_at, p.consent_version, p.consent_channel, p.created_at`;

/** Saldo = cargos activos − abonos de recaudos activos − anticipos sin aplicar. */
export const PATIENT_BALANCE_SQL = `(
  COALESCE((SELECT SUM(c.amount) FROM charges c WHERE c.patient_id = p.id AND c.status = 'activo'), 0)
  - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.patient_id = p.id AND pay.status = 'activo'), 0)
)`;

export class PatientService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
  ) {}

  async search(
    tenantId: string,
    options: { query?: string; limit: number; offset: number; nowLocal: string },
  ): Promise<PatientListRow[]> {
    const searchTerm = options.query?.trim();
    const filterSql = searchTerm ? 'AND (p.full_name LIKE ? ESCAPE \'\\\' OR p.document_number LIKE ? ESCAPE \'\\\' OR p.phone LIKE ? ESCAPE \'\\\')' : '';
    const likeValue = searchTerm ? `%${escapeLike(searchTerm)}%` : null;

    const { results } = await this.db
      .prepare(
        `SELECT ${PATIENT_COLUMNS},
           ${PATIENT_BALANCE_SQL} AS balance,
           (SELECT MAX(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'atendida') AS last_visit,
           (SELECT MIN(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.status IN ('pendiente', 'confirmada') AND a.start_at >= ?) AS next_appointment
         FROM patients p
         WHERE p.tenant_id = ? ${filterSql}
         ORDER BY p.full_name
         LIMIT ? OFFSET ?`,
      )
      .bind(
        options.nowLocal,
        tenantId,
        ...(likeValue ? [likeValue, likeValue, likeValue] : []),
        options.limit,
        options.offset,
      )
      .all<PatientListRow>();
    return results;
  }

  async getById(tenantId: string, patientId: string): Promise<PatientRow> {
    const patient = await this.db
      .prepare(`SELECT ${PATIENT_COLUMNS} FROM patients p WHERE p.id = ? AND p.tenant_id = ?`)
      .bind(patientId, tenantId)
      .first<PatientRow>();
    if (!patient) throw notFound('El paciente');
    return patient;
  }

  async findByDocument(tenantId: string, documentType: string, documentNumber: string): Promise<PatientRow | null> {
    return this.db
      .prepare(`SELECT ${PATIENT_COLUMNS} FROM patients p WHERE p.tenant_id = ? AND p.document_type = ? AND p.document_number = ?`)
      .bind(tenantId, documentType, documentNumber)
      .first<PatientRow>();
  }

  async create(
    actor: Actor,
    input: PatientInput,
    consent: { version: string; channel: 'presencial' | 'en_linea' } | null,
  ): Promise<PatientRow> {
    const existing = await this.findByDocument(actor.tenantId, input.documentType, input.documentNumber);
    if (existing) throw conflict('Ya existe un paciente con ese documento.');

    const patientId = crypto.randomUUID();
    const now = isoNow();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO patients (id, tenant_id, document_type, document_number, full_name, phone, email, birth_date,
             guardian_name, guardian_phone, admin_notes, consent_at, consent_version, consent_channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          patientId, actor.tenantId, input.documentType, input.documentNumber, input.fullName, input.phone, input.email,
          input.birthDate, input.guardianName, input.guardianPhone, input.adminNotes,
          consent ? now : null, consent?.version ?? null, consent?.channel ?? null, now, now,
        ),
      this.audit.buildStatement(actor, { action: 'paciente_creado', entity: 'paciente', entityId: patientId }),
    ]);
    return this.getById(actor.tenantId, patientId);
  }

  async update(actor: Actor, patientId: string, input: PatientInput): Promise<PatientRow> {
    const previous = await this.getById(actor.tenantId, patientId);
    const documentChanged =
      previous.document_type !== input.documentType || previous.document_number !== input.documentNumber;
    if (documentChanged && (await this.findByDocument(actor.tenantId, input.documentType, input.documentNumber))) {
      throw conflict('Ya existe un paciente con ese documento.');
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE patients SET document_type = ?, document_number = ?, full_name = ?, phone = ?, email = ?, birth_date = ?,
             guardian_name = ?, guardian_phone = ?, admin_notes = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          input.documentType, input.documentNumber, input.fullName, input.phone, input.email, input.birthDate,
          input.guardianName, input.guardianPhone, input.adminNotes, isoNow(), patientId, actor.tenantId,
        ),
      this.audit.buildStatement(actor, { action: 'paciente_actualizado', entity: 'paciente', entityId: patientId }),
    ]);
    return this.getById(actor.tenantId, patientId);
  }

  async recordConsent(tenantId: string, patientId: string, version: string, channel: string): Promise<void> {
    await this.db
      .prepare('UPDATE patients SET consent_at = ?, consent_version = ?, consent_channel = ? WHERE id = ? AND tenant_id = ?')
      .bind(isoNow(), version, channel, patientId, tenantId)
      .run();
  }
}

/** Escapa los comodines de LIKE para que el texto del usuario se busque literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
