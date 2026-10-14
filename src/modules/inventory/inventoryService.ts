/**
 * Inventario de insumos.
 *
 * • La existencia de cada insumo es la SUMA de sus movimientos (compra +,
 *   consumo −, ajuste ±, anulación de compra −). No hay un campo "stock" que
 *   se pueda descuadrar.
 * • El costo es promedio ponderado: se recalcula en cada compra.
 * • Cada servicio puede tener una "receta" (insumos que gasta). Al marcar una
 *   cita como atendida se descuenta automáticamente; el índice único
 *   (cita, insumo) impide descontar dos veces la misma cita.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';

export const SUPPLY_UNITS = ['unidad', 'caja', 'paquete', 'par', 'ml', 'l', 'g', 'kg', 'cm', 'm', 'rollo', 'tubo', 'frasco', 'carpule', 'jeringa', 'sobre'] as const;

export interface SupplyRow {
  id: string;
  code: string;
  name: string;
  unit: string;
  min_stock: number;
  avg_cost: number;
  is_active: number;
  stock: number;
  /** Valor del inventario = existencia × costo promedio. */
  stock_value: number;
  is_low: number;
}

export interface MovementRow {
  id: string;
  supply_id: string;
  supply_name: string;
  supply_unit: string;
  kind: 'compra' | 'consumo' | 'ajuste' | 'anulacion_compra';
  quantity: number;
  unit_cost: number;
  reason: string | null;
  purchase_id: string | null;
  invoice_number: string | null;
  appointment_id: string | null;
  patient_name: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface RecipeItem {
  supply_id: string;
  supply_name: string;
  unit: string;
  quantity: number;
  avg_cost: number;
  line_cost: number;
}

export interface ServiceCostRow {
  service_id: string;
  code: string;
  name: string;
  price: number;
  supplies_cost: number;
  margin: number;
  margin_percent: number | null;
  recipe_items: number;
}

const SUPPLY_SELECT = `
  SELECT s.id, s.code, s.name, s.unit, s.min_stock, s.avg_cost, s.is_active,
         COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.supply_id = s.id), 0) AS stock
  FROM supplies s`;

/** Redondeo para cantidades (evita 0.30000000000000004). */
export const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

function withComputed(row: Omit<SupplyRow, 'stock_value' | 'is_low'>): SupplyRow {
  const stock = roundQuantity(row.stock);
  return {
    ...row,
    stock,
    stock_value: Math.round(Math.max(stock, 0) * row.avg_cost),
    is_low: row.is_active && stock <= row.min_stock && row.min_stock > 0 ? 1 : 0,
  };
}

export class InventoryService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
  ) {}

  // ─── Insumos ──────────────────────────────────────────────────────────────

  async listSupplies(tenantId: string, options: { includeInactive?: boolean } = {}): Promise<SupplyRow[]> {
    const { results } = await this.db
      .prepare(`${SUPPLY_SELECT} WHERE s.tenant_id = ? ${options.includeInactive ? '' : 'AND s.is_active = 1'} ORDER BY s.name`)
      .bind(tenantId)
      .all<Omit<SupplyRow, 'stock_value' | 'is_low'>>();
    return results.map(withComputed);
  }

  async getSupply(tenantId: string, supplyId: string): Promise<SupplyRow> {
    const row = await this.db
      .prepare(`${SUPPLY_SELECT} WHERE s.tenant_id = ? AND s.id = ?`)
      .bind(tenantId, supplyId)
      .first<Omit<SupplyRow, 'stock_value' | 'is_low'>>();
    if (!row) throw notFound('El insumo');
    return withComputed(row);
  }

  /** Sentencias para crear un insumo con código consecutivo (INS-0001…) dentro de otra transacción. */
  buildCreateSupplyStatements(tenantId: string, supplyId: string, input: { name: string; unit: string; minStock?: number; code?: string | null }): SqlStatement[] {
    if (input.code) {
      return [
        this.db
          .prepare('INSERT INTO supplies (id, tenant_id, code, name, unit, min_stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(supplyId, tenantId, input.code.toUpperCase(), input.name, input.unit, input.minStock ?? 0, isoNow()),
      ];
    }
    return [
      this.db.prepare("UPDATE counters SET value = value + 1 WHERE tenant_id = ? AND name = 'insumo'").bind(tenantId),
      this.db
        .prepare(
          `INSERT INTO supplies (id, tenant_id, code, name, unit, min_stock, created_at)
           SELECT ?, ?, 'INS-' || printf('%04d', value), ?, ?, ?, ? FROM counters WHERE tenant_id = ? AND name = 'insumo'`,
        )
        .bind(supplyId, tenantId, input.name, input.unit, input.minStock ?? 0, isoNow(), tenantId),
    ];
  }

  async createSupply(actor: Actor, input: { code: string | null; name: string; unit: string; minStock: number }): Promise<SupplyRow> {
    await this.assertCodeAvailable(actor.tenantId, input.code, null);
    const supplyId = crypto.randomUUID();
    await this.db.batch([
      ...this.buildCreateSupplyStatements(actor.tenantId, supplyId, input),
      this.audit.buildStatement(actor, { action: 'insumo_creado', entity: 'insumo', entityId: supplyId, details: { name: input.name } }),
    ]);
    return this.getSupply(actor.tenantId, supplyId);
  }

  async updateSupply(
    actor: Actor,
    supplyId: string,
    input: { code: string; name: string; unit: string; minStock: number; isActive: boolean },
  ): Promise<SupplyRow> {
    await this.getSupply(actor.tenantId, supplyId);
    await this.assertCodeAvailable(actor.tenantId, input.code, supplyId);
    await this.db.batch([
      this.db
        .prepare('UPDATE supplies SET code = ?, name = ?, unit = ?, min_stock = ?, is_active = ? WHERE id = ? AND tenant_id = ?')
        .bind(input.code.toUpperCase(), input.name, input.unit, input.minStock, input.isActive ? 1 : 0, supplyId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'insumo_editado', entity: 'insumo', entityId: supplyId }),
    ]);
    return this.getSupply(actor.tenantId, supplyId);
  }

  private async assertCodeAvailable(tenantId: string, code: string | null, exceptId: string | null): Promise<void> {
    if (!code) return;
    const existing = await this.db
      .prepare('SELECT id FROM supplies WHERE tenant_id = ? AND code = ? AND id != ?')
      .bind(tenantId, code.toUpperCase(), exceptId ?? '')
      .first();
    if (existing) throw new AppError(`Ya existe un insumo con el código ${code.toUpperCase()}.`, 409, 'DUPLICATE_CODE');
  }

  /** Ajuste manual (conteo físico, vencidos, daños…). Cantidad positiva entra, negativa sale. */
  async adjustStock(actor: Actor, supplyId: string, input: { quantity: number; reason: string; unitCost: number | null }): Promise<SupplyRow> {
    const supply = await this.getSupply(actor.tenantId, supplyId);
    if (input.quantity === 0) throw new AppError('La cantidad del ajuste no puede ser cero.', 422, 'INVALID_QUANTITY');
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `INSERT INTO stock_movements (id, tenant_id, supply_id, kind, quantity, unit_cost, reason, created_by, created_at)
           VALUES (?, ?, ?, 'ajuste', ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), actor.tenantId, supplyId, input.quantity, input.unitCost ?? supply.avg_cost, input.reason, actor.userId, isoNow()),
      this.audit.buildStatement(actor, { action: 'inventario_ajustado', entity: 'insumo', entityId: supplyId, details: { quantity: input.quantity, reason: input.reason } }),
    ];
    // Una entrada con costo (ej. inventario inicial) participa del costo promedio.
    if (input.quantity > 0 && input.unitCost !== null) {
      statements.unshift(this.buildAverageCostUpdate(actor.tenantId, supplyId, input.quantity, input.unitCost));
    }
    await this.db.batch(statements);
    return this.getSupply(actor.tenantId, supplyId);
  }

  /**
   * Recalcula el costo promedio con una entrada nueva. Debe ejecutarse ANTES
   * de insertar el movimiento (usa la existencia previa).
   */
  buildAverageCostUpdate(tenantId: string, supplyId: string, addedQuantity: number, unitCost: number): SqlStatement {
    return this.db
      .prepare(
        `UPDATE supplies SET avg_cost = (
           SELECT CASE WHEN prev.stock <= 0 THEN ?
                       ELSE ((prev.stock * supplies.avg_cost) + (? * ?)) / (prev.stock + ?) END
           FROM (SELECT COALESCE(SUM(quantity), 0) AS stock FROM stock_movements WHERE supply_id = ?) AS prev)
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(unitCost, addedQuantity, unitCost, addedQuantity, supplyId, supplyId, tenantId);
  }

  async listMovements(tenantId: string, filters: { supplyId?: string; fromUtc: string; toUtc: string }): Promise<MovementRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.id, m.supply_id, s.name AS supply_name, s.unit AS supply_unit, m.kind, m.quantity, m.unit_cost, m.reason,
                m.purchase_id, pu.invoice_number, m.appointment_id, pt.full_name AS patient_name,
                u.full_name AS created_by_name, m.created_at
         FROM stock_movements m
         JOIN supplies s ON s.id = m.supply_id
         LEFT JOIN purchases pu ON pu.id = m.purchase_id
         LEFT JOIN appointments a ON a.id = m.appointment_id
         LEFT JOIN patients pt ON pt.id = a.patient_id
         LEFT JOIN users u ON u.id = m.created_by
         WHERE m.tenant_id = ? AND m.created_at >= ? AND m.created_at < ? ${filters.supplyId ? 'AND m.supply_id = ?' : ''}
         ORDER BY m.created_at DESC LIMIT 1000`,
      )
      .bind(tenantId, filters.fromUtc, filters.toUtc, ...(filters.supplyId ? [filters.supplyId] : []))
      .all<MovementRow>();
    return results.map((row) => ({ ...row, quantity: roundQuantity(row.quantity) }));
  }

  // ─── Recetas (consumo por servicio) ───────────────────────────────────────

  async getRecipe(tenantId: string, serviceId: string): Promise<RecipeItem[]> {
    await this.assertService(tenantId, serviceId);
    const { results } = await this.db
      .prepare(
        `SELECT ss.supply_id, s.name AS supply_name, s.unit, ss.quantity, s.avg_cost
         FROM service_supplies ss JOIN supplies s ON s.id = ss.supply_id
         WHERE ss.tenant_id = ? AND ss.service_id = ? ORDER BY s.name`,
      )
      .bind(tenantId, serviceId)
      .all<Omit<RecipeItem, 'line_cost'>>();
    return results.map((item) => ({ ...item, line_cost: Math.round(item.quantity * item.avg_cost) }));
  }

  async setRecipe(actor: Actor, serviceId: string, items: Array<{ supplyId: string; quantity: number }>): Promise<RecipeItem[]> {
    await this.assertService(actor.tenantId, serviceId);
    const uniqueIds = new Set(items.map((item) => item.supplyId));
    if (uniqueIds.size !== items.length) throw new AppError('Un insumo aparece dos veces en la receta.', 422, 'DUPLICATE_SUPPLY');
    if (uniqueIds.size > 0) {
      const placeholders = [...uniqueIds].map(() => '?').join(',');
      const found = await this.db
        .prepare(`SELECT COUNT(*) AS total FROM supplies WHERE tenant_id = ? AND id IN (${placeholders})`)
        .bind(actor.tenantId, ...uniqueIds)
        .first<{ total: number }>();
      if ((found?.total ?? 0) !== uniqueIds.size) throw notFound('Uno de los insumos');
    }
    await this.db.batch([
      this.db.prepare('DELETE FROM service_supplies WHERE tenant_id = ? AND service_id = ?').bind(actor.tenantId, serviceId),
      ...items.map((item) =>
        this.db
          .prepare('INSERT INTO service_supplies (tenant_id, service_id, supply_id, quantity) VALUES (?, ?, ?, ?)')
          .bind(actor.tenantId, serviceId, item.supplyId, item.quantity),
      ),
      this.audit.buildStatement(actor, { action: 'receta_actualizada', entity: 'servicio', entityId: serviceId, details: { items: items.length } }),
    ]);
    return this.getRecipe(actor.tenantId, serviceId);
  }

  private async assertService(tenantId: string, serviceId: string): Promise<void> {
    const service = await this.db.prepare('SELECT id FROM services WHERE id = ? AND tenant_id = ?').bind(serviceId, tenantId).first();
    if (!service) throw notFound('El servicio');
  }

  /** Costo de insumos y margen de cada servicio según su receta y el costo promedio actual. */
  async getServiceCosts(tenantId: string): Promise<ServiceCostRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT sv.id AS service_id, sv.code, sv.name, sv.price,
                COALESCE(SUM(ss.quantity * su.avg_cost), 0) AS supplies_cost,
                COUNT(ss.supply_id) AS recipe_items
         FROM services sv
         LEFT JOIN service_supplies ss ON ss.service_id = sv.id
         LEFT JOIN supplies su ON su.id = ss.supply_id
         WHERE sv.tenant_id = ? AND sv.is_active = 1
         GROUP BY sv.id ORDER BY sv.name`,
      )
      .bind(tenantId)
      .all<Omit<ServiceCostRow, 'margin' | 'margin_percent'>>();
    return results.map((row) => {
      const suppliesCost = Math.round(row.supplies_cost);
      const margin = row.price - suppliesCost;
      return { ...row, supplies_cost: suppliesCost, margin, margin_percent: row.price > 0 ? Math.round((margin / row.price) * 1000) / 10 : null };
    });
  }

  /**
   * Descuenta los insumos de la receta del servicio de una cita atendida.
   * Idempotente: si la cita ya se descontó, no hace nada.
   */
  async consumeForAppointment(tenantId: string, appointmentId: string): Promise<number> {
    const { results: recipe } = await this.db
      .prepare(
        `SELECT ss.supply_id, ss.quantity, su.avg_cost
         FROM appointments a
         JOIN service_supplies ss ON ss.service_id = a.service_id AND ss.tenant_id = a.tenant_id
         JOIN supplies su ON su.id = ss.supply_id
         WHERE a.id = ? AND a.tenant_id = ? AND a.status = 'atendida'`,
      )
      .bind(appointmentId, tenantId)
      .all<{ supply_id: string; quantity: number; avg_cost: number }>();
    if (recipe.length === 0) return 0;
    const now = isoNow();
    const outcome = await this.db.batch(
      recipe.map((item) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO stock_movements (id, tenant_id, supply_id, kind, quantity, unit_cost, appointment_id, reason, created_at)
             VALUES (?, ?, ?, 'consumo', ?, ?, ?, 'Cita atendida', ?)`,
          )
          .bind(crypto.randomUUID(), tenantId, item.supply_id, -item.quantity, item.avg_cost, appointmentId, now),
      ),
    );
    return outcome.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
  }

  /** Resumen para el tablero de inventario. */
  async getSummary(tenantId: string, monthFromUtc: string, monthToUtc: string): Promise<{ inventoryValue: number; lowStockCount: number; monthConsumptionCost: number }> {
    const supplies = await this.listSupplies(tenantId);
    const consumption = await this.db
      .prepare(
        `SELECT COALESCE(SUM(-quantity * unit_cost), 0) AS cost FROM stock_movements
         WHERE tenant_id = ? AND kind = 'consumo' AND created_at >= ? AND created_at < ?`,
      )
      .bind(tenantId, monthFromUtc, monthToUtc)
      .first<{ cost: number }>();
    return {
      inventoryValue: supplies.reduce((total, supply) => total + supply.stock_value, 0),
      lowStockCount: supplies.filter((supply) => supply.is_low).length,
      monthConsumptionCost: Math.round(consumption?.cost ?? 0),
    };
  }
}
