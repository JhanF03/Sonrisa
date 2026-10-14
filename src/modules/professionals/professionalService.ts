/**
 * Profesionales, sus horarios semanales y los bloqueos puntuales de agenda.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import { occupiesSlot } from '../../db/sqlFragments.js';
import type { Actor } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';

export interface ProfessionalRow {
  id: string;
  full_name: string;
  specialty: string | null;
  color: string;
  user_id: string | null;
  is_active: number;
}

export interface ScheduleRow {
  id: string;
  professional_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface TimeBlockRow {
  id: string;
  professional_id: string | null;
  professional_name: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
}

export interface ProfessionalInput {
  fullName: string;
  specialty: string | null;
  color: string;
  userId: string | null;
  isActive: boolean;
}

export interface ScheduleBlockInput {
  weekday: number;
  startTime: string;
  endTime: string;
}

export class ProfessionalService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, options: { onlyActive?: boolean } = {}): Promise<ProfessionalRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, full_name, specialty, color, user_id, is_active FROM professionals
         WHERE tenant_id = ? ${options.onlyActive ? 'AND is_active = 1' : ''}
         ORDER BY full_name`,
      )
      .bind(tenantId)
      .all<ProfessionalRow>();
    return results;
  }

  async getById(tenantId: string, professionalId: string): Promise<ProfessionalRow> {
    const professional = await this.db
      .prepare('SELECT id, full_name, specialty, color, user_id, is_active FROM professionals WHERE id = ? AND tenant_id = ?')
      .bind(professionalId, tenantId)
      .first<ProfessionalRow>();
    if (!professional) throw notFound('El profesional');
    return professional;
  }

  async create(actor: Actor, input: ProfessionalInput): Promise<ProfessionalRow> {
    await this.assertUserBelongsToTenant(actor.tenantId, input.userId);
    const professionalId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO professionals (id, tenant_id, full_name, specialty, color, user_id, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(professionalId, actor.tenantId, input.fullName, input.specialty, input.color, input.userId, input.isActive ? 1 : 0, isoNow()),
      this.audit.buildStatement(actor, { action: 'profesional_creado', entity: 'profesional', entityId: professionalId }),
    ]);
    return this.getById(actor.tenantId, professionalId);
  }

  async update(actor: Actor, professionalId: string, input: ProfessionalInput): Promise<ProfessionalRow> {
    await this.getById(actor.tenantId, professionalId);
    await this.assertUserBelongsToTenant(actor.tenantId, input.userId);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE professionals SET full_name = ?, specialty = ?, color = ?, user_id = ?, is_active = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(input.fullName, input.specialty, input.color, input.userId, input.isActive ? 1 : 0, professionalId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'profesional_actualizado', entity: 'profesional', entityId: professionalId }),
    ]);
    return this.getById(actor.tenantId, professionalId);
  }

  async listSchedules(tenantId: string, professionalId?: string): Promise<ScheduleRow[]> {
    const statement = professionalId
      ? this.db
          .prepare(
            `SELECT id, professional_id, weekday, start_time, end_time FROM schedules
             WHERE tenant_id = ? AND professional_id = ? ORDER BY weekday, start_time`,
          )
          .bind(tenantId, professionalId)
      : this.db
          .prepare(
            'SELECT id, professional_id, weekday, start_time, end_time FROM schedules WHERE tenant_id = ? ORDER BY weekday, start_time',
          )
          .bind(tenantId);
    return (await statement.all<ScheduleRow>()).results;
  }

  /** Reemplaza todo el horario semanal de un profesional (operación atómica). */
  async replaceSchedule(actor: Actor, professionalId: string, blocks: ScheduleBlockInput[]): Promise<ScheduleRow[]> {
    await this.getById(actor.tenantId, professionalId);
    assertNoOverlappingBlocks(blocks);

    const statements: SqlStatement[] = [
      this.db.prepare('DELETE FROM schedules WHERE professional_id = ? AND tenant_id = ?').bind(professionalId, actor.tenantId),
      ...blocks.map((block) =>
        this.db
          .prepare(
            'INSERT INTO schedules (id, tenant_id, professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(crypto.randomUUID(), actor.tenantId, professionalId, block.weekday, block.startTime, block.endTime),
      ),
      this.audit.buildStatement(actor, { action: 'horario_actualizado', entity: 'profesional', entityId: professionalId }),
    ];
    await this.db.batch(statements);
    return this.listSchedules(actor.tenantId, professionalId);
  }

  async listTimeBlocks(tenantId: string, fromDate: string, toDate: string): Promise<TimeBlockRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.id, b.professional_id, p.full_name AS professional_name, b.start_at, b.end_at, b.reason
         FROM time_blocks b LEFT JOIN professionals p ON p.id = b.professional_id
         WHERE b.tenant_id = ? AND b.end_at > ? AND b.start_at < ?
         ORDER BY b.start_at`,
      )
      .bind(tenantId, `${fromDate}T00:00`, `${toDate}T23:59`)
      .all<TimeBlockRow>();
    return results;
  }

  async createTimeBlock(
    actor: Actor,
    input: { professionalId: string | null; startAt: string; endAt: string; reason: string | null },
  ): Promise<{ id: string; affectedAppointments: number }> {
    if (input.startAt >= input.endAt) throw new AppError('El bloqueo debe terminar después de empezar.', 422, 'INVALID_RANGE');
    if (input.professionalId) await this.getById(actor.tenantId, input.professionalId);

    const blockId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO time_blocks (id, tenant_id, professional_id, start_at, end_at, reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(blockId, actor.tenantId, input.professionalId, input.startAt, input.endAt, input.reason, actor.userId, isoNow()),
      this.audit.buildStatement(actor, { action: 'bloqueo_creado', entity: 'bloqueo', entityId: blockId, details: input }),
    ]);

    // Las citas ya agendadas en ese rango NO se cancelan solas: se avisa para reprogramarlas.
    const affected = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM appointments a
         WHERE a.tenant_id = ? AND ${occupiesSlot('a')} AND a.start_at < ? AND a.end_at > ?
           ${input.professionalId ? 'AND a.professional_id = ?' : ''}`,
      )
      .bind(actor.tenantId, input.endAt, input.startAt, ...(input.professionalId ? [input.professionalId] : []))
      .first<{ total: number }>();
    return { id: blockId, affectedAppointments: affected?.total ?? 0 };
  }

  async deleteTimeBlock(actor: Actor, blockId: string): Promise<void> {
    const [deleteResult] = await this.db.batch([
      this.db.prepare('DELETE FROM time_blocks WHERE id = ? AND tenant_id = ?').bind(blockId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'bloqueo_eliminado', entity: 'bloqueo', entityId: blockId }),
    ]);
    if (deleteResult.meta.changes === 0) throw notFound('El bloqueo');
  }

  private async assertUserBelongsToTenant(tenantId: string, userId: string | null): Promise<void> {
    if (!userId) return;
    const user = await this.db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').bind(userId, tenantId).first();
    if (!user) throw notFound('El usuario vinculado');
  }
}

function assertNoOverlappingBlocks(blocks: ScheduleBlockInput[]): void {
  for (const block of blocks) {
    if (block.startTime >= block.endTime) {
      throw new AppError('Cada franja debe terminar después de empezar.', 422, 'INVALID_SCHEDULE');
    }
  }
  const sortedBlocks = [...blocks].sort((first, second) =>
    first.weekday - second.weekday || first.startTime.localeCompare(second.startTime),
  );
  for (let index = 1; index < sortedBlocks.length; index++) {
    const previous = sortedBlocks[index - 1];
    const current = sortedBlocks[index];
    if (previous.weekday === current.weekday && current.startTime < previous.endTime) {
      throw new AppError('Hay franjas de horario que se cruzan el mismo día.', 422, 'OVERLAPPING_SCHEDULE');
    }
  }
}
