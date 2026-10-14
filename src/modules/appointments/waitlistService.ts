/**
 * Lista de espera: pacientes que quieren una cita antes si se libera un espacio.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';
import type { PatientService } from '../patients/patientService.js';

export interface WaitlistRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  service_id: string | null;
  service_name: string | null;
  professional_id: string | null;
  professional_name: string | null;
  notes: string | null;
  created_at: string;
}

export class WaitlistService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
    private readonly patients: PatientService,
  ) {}

  async listActive(tenantId: string): Promise<WaitlistRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT w.id, w.patient_id, p.full_name AS patient_name, p.phone AS patient_phone,
                w.service_id, s.name AS service_name, w.professional_id, pr.full_name AS professional_name,
                w.notes, w.created_at
         FROM waitlist_entries w
         JOIN patients p ON p.id = w.patient_id
         LEFT JOIN services s ON s.id = w.service_id
         LEFT JOIN professionals pr ON pr.id = w.professional_id
         WHERE w.tenant_id = ? AND w.status = 'activa'
         ORDER BY w.created_at`,
      )
      .bind(tenantId)
      .all<WaitlistRow>();
    return results;
  }

  async add(
    actor: Actor,
    input: { patientId: string; serviceId: string | null; professionalId: string | null; notes: string | null },
  ): Promise<string> {
    await this.patients.getById(actor.tenantId, input.patientId);
    await this.assertBelongs('services', actor.tenantId, input.serviceId, 'El servicio');
    await this.assertBelongs('professionals', actor.tenantId, input.professionalId, 'El profesional');

    const entryId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO waitlist_entries (id, tenant_id, patient_id, service_id, professional_id, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'activa', ?)`,
        )
        .bind(entryId, actor.tenantId, input.patientId, input.serviceId, input.professionalId, input.notes, isoNow()),
      this.audit.buildStatement(actor, { action: 'lista_espera_agregado', entity: 'lista_espera', entityId: entryId }),
    ]);
    return entryId;
  }

  async resolve(actor: Actor, entryId: string): Promise<void> {
    const result = await this.db
      .prepare("UPDATE waitlist_entries SET status = 'resuelta' WHERE id = ? AND tenant_id = ? AND status = 'activa'")
      .bind(entryId, actor.tenantId)
      .run();
    if (result.meta.changes === 0) throw notFound('La entrada de la lista de espera');
  }

  private async assertBelongs(
    table: 'services' | 'professionals',
    tenantId: string,
    id: string | null,
    label: string,
  ): Promise<void> {
    if (!id) return;
    // El nombre de la tabla viene de un tipo cerrado, nunca del usuario.
    const row = await this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ?`).bind(id, tenantId).first();
    if (!row) throw notFound(label);
  }
}
