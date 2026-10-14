/**
 * Registro de auditoría: quién hizo qué, cuándo y desde dónde.
 * Se usa para acciones sensibles (anulaciones, permisos, precios, accesos).
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { isoNow } from '../../utils/time.js';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: string | null;
  ip: string | null;
  created_at: string;
}

export class AuditService {
  constructor(private readonly db: SqlDatabase) {}

  /** Sentencia lista para incluir dentro de un batch atómico. */
  buildStatement(actor: Actor, entry: AuditEntry): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO audit_log (id, tenant_id, user_id, action, entity, entity_id, details, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor.tenantId,
        actor.userId,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        actor.ip,
        isoNow(),
      );
  }

  async record(actor: Actor, entry: AuditEntry): Promise<void> {
    await this.buildStatement(actor, entry).run();
  }

  async list(tenantId: string, options: { limit: number; offset: number }): Promise<AuditLogRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.user_id, u.full_name AS user_name, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.tenant_id = ?
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tenantId, options.limit, options.offset)
      .all<AuditLogRow>();
    return results;
  }
}
