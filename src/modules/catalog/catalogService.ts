/**
 * Catálogo de servicios (y, en la fase 2, insumos) como productos del sistema.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { AppError, conflict, notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import { diffFields, type AuditService } from '../audit/auditService.js';

export interface ServiceRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  item_type: 'servicio' | 'insumo';
  price: number;
  duration_minutes: number;
  tax_rate_bps: number;
  is_bookable_online: number;
  is_active: number;
  prepayment_mode: PrepaymentMode;
  prepayment_value: number;
}

export type PrepaymentMode = 'ninguno' | 'porcentaje' | 'valor';

/**
 * Valor del anticipo en pesos para un servicio (0 = no requiere).
 * Porcentaje: se redondea al peso más cercano. Valor fijo: nunca supera el precio.
 */
export function computePrepaymentAmount(service: Pick<ServiceRow, 'price' | 'prepayment_mode' | 'prepayment_value'>): number {
  if (service.price <= 0) return 0;
  if (service.prepayment_mode === 'porcentaje') return Math.round((service.price * service.prepayment_value) / 100);
  if (service.prepayment_mode === 'valor') return Math.min(service.prepayment_value, service.price);
  return 0;
}

export interface ServiceInput {
  code: string;
  name: string;
  category: string | null;
  price: number;
  durationMinutes: number;
  taxRateBps: number;
  isBookableOnline: boolean;
  isActive: boolean;
  prepaymentMode: PrepaymentMode;
  prepaymentValue: number;
}

/** Anticipo mínimo en pesos: evita cobros simbólicos que no aseguran la cita. */
export const MIN_PREPAYMENT_AMOUNT = 1000;

const SERVICE_COLUMNS =
  'id, code, name, category, item_type, price, duration_minutes, tax_rate_bps, is_bookable_online, is_active, prepayment_mode, prepayment_value';

function assertValidPrepayment(input: ServiceInput): void {
  if (input.prepaymentMode === 'ninguno') return;
  if (input.prepaymentMode === 'porcentaje' && (input.prepaymentValue < 1 || input.prepaymentValue > 100)) {
    throw new AppError('El porcentaje de anticipo debe estar entre 1 y 100.', 422, 'INVALID_PREPAYMENT');
  }
  if (input.prepaymentMode === 'valor' && input.prepaymentValue > input.price) {
    throw new AppError('El anticipo no puede ser mayor que el precio del servicio.', 422, 'INVALID_PREPAYMENT');
  }
  const amount = computePrepaymentAmount({ price: input.price, prepayment_mode: input.prepaymentMode, prepayment_value: input.prepaymentValue });
  if (amount < MIN_PREPAYMENT_AMOUNT) {
    throw new AppError('El anticipo debe ser de al menos $1.000.', 422, 'INVALID_PREPAYMENT');
  }
}

export class CatalogService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, options: { onlyActive?: boolean; onlyBookableOnline?: boolean } = {}): Promise<ServiceRow[]> {
    const filters = ['tenant_id = ?', "item_type = 'servicio'"];
    if (options.onlyActive) filters.push('is_active = 1');
    if (options.onlyBookableOnline) filters.push('is_bookable_online = 1');

    const { results } = await this.db
      .prepare(`SELECT ${SERVICE_COLUMNS} FROM services WHERE ${filters.join(' AND ')} ORDER BY category, name`)
      .bind(tenantId)
      .all<ServiceRow>();
    return results;
  }

  async getById(tenantId: string, serviceId: string): Promise<ServiceRow> {
    const service = await this.db
      .prepare(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = ? AND tenant_id = ?`)
      .bind(serviceId, tenantId)
      .first<ServiceRow>();
    if (!service) throw notFound('El servicio');
    return service;
  }

  async create(actor: Actor, input: ServiceInput): Promise<ServiceRow> {
    assertValidPrepayment(input);
    await this.assertCodeAvailable(actor.tenantId, input.code);
    const serviceId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO services (id, tenant_id, code, name, category, item_type, price, duration_minutes,
             tax_rate_bps, is_bookable_online, is_active, prepayment_mode, prepayment_value, created_at)
           VALUES (?, ?, ?, ?, ?, 'servicio', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          serviceId, actor.tenantId, input.code, input.name, input.category, input.price, input.durationMinutes,
          input.taxRateBps, input.isBookableOnline ? 1 : 0, input.isActive ? 1 : 0,
          input.prepaymentMode, input.prepaymentMode === 'ninguno' ? 0 : input.prepaymentValue, isoNow(),
        ),
      this.audit.buildStatement(actor, {
        action: 'servicio_creado', entity: 'servicio', entityId: serviceId, details: { code: input.code, price: input.price },
      }),
    ]);
    return this.getById(actor.tenantId, serviceId);
  }

  async update(actor: Actor, serviceId: string, input: ServiceInput): Promise<ServiceRow> {
    assertValidPrepayment(input);
    const previous = await this.getById(actor.tenantId, serviceId);
    if (previous.code !== input.code) await this.assertCodeAvailable(actor.tenantId, input.code);

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE services SET code = ?, name = ?, category = ?, price = ?, duration_minutes = ?, tax_rate_bps = ?,
             is_bookable_online = ?, is_active = ?, prepayment_mode = ?, prepayment_value = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          input.code, input.name, input.category, input.price, input.durationMinutes, input.taxRateBps,
          input.isBookableOnline ? 1 : 0, input.isActive ? 1 : 0,
          input.prepaymentMode, input.prepaymentMode === 'ninguno' ? 0 : input.prepaymentValue, serviceId, actor.tenantId,
        ),
      this.audit.buildStatement(actor, {
        action: 'servicio_actualizado',
        entity: 'servicio',
        entityId: serviceId,
        details: {
          cambios: diffFields(
            previous as unknown as Record<string, unknown>,
            {
              code: input.code, name: input.name, category: input.category, price: input.price, duration_minutes: input.durationMinutes,
              tax_rate_bps: input.taxRateBps, is_bookable_online: input.isBookableOnline ? 1 : 0, is_active: input.isActive ? 1 : 0,
              prepayment_mode: input.prepaymentMode, prepayment_value: input.prepaymentMode === 'ninguno' ? 0 : input.prepaymentValue,
            },
            ['code', 'name', 'category', 'price', 'duration_minutes', 'tax_rate_bps', 'is_bookable_online', 'is_active', 'prepayment_mode', 'prepayment_value'],
          ),
        },
      }),
    ]);
    return this.getById(actor.tenantId, serviceId);
  }

  private async assertCodeAvailable(tenantId: string, code: string): Promise<void> {
    const existing = await this.db.prepare('SELECT 1 FROM services WHERE tenant_id = ? AND code = ?').bind(tenantId, code).first();
    if (existing) throw conflict(`Ya existe un servicio con el código ${code}.`);
  }
}
