/**
 * Proveedores, compras (con su factura) y cuentas por pagar.
 *
 * • Una compra registra la factura del proveedor y sus líneas. Las líneas
 *   enlazadas a un insumo entran al inventario (y actualizan su costo
 *   promedio); las demás son gasto (ej. servicio técnico).
 * • La misma factura (proveedor + número, o CUFE) no se registra dos veces.
 * • Anular una compra saca del inventario lo que había entrado. Solo se
 *   puede si no tiene pagos activos.
 * • Pagos a proveedores = abonos; el saldo de la factura es total − pagos.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { isoNow } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';
import type { InventoryService } from './inventoryService.js';

export const SUPPLIER_PAYMENT_METHODS = ['transferencia', 'efectivo', 'tarjeta', 'cheque', 'nequi', 'daviplata', 'otro'] as const;

export interface SupplierRow {
  id: string;
  name: string;
  nit: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
  notes: string | null;
  is_active: number;
  balance: number;
}

export interface SupplierInput {
  name: string;
  nit: string | null;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface PurchaseLineInput {
  supplyId: string | null;
  /** Crear el insumo en el mismo registro (cuando viene de un XML con productos nuevos). */
  newSupply: { name: string; unit: string } | null;
  description: string;
  supplierCode: string | null;
  quantity: number;
  conversionFactor: number;
  lineTotal: number;
  taxAmount: number;
}

export interface PurchaseInput {
  supplierId: string | null;
  /** Si no hay supplierId: se busca por NIT o se crea (importación de XML). */
  newSupplier: { name: string; nit: string | null } | null;
  invoiceNumber: string;
  cufe: string | null;
  issueDate: string;
  dueDate: string | null;
  notes: string | null;
  source: 'manual' | 'xml';
  lines: PurchaseLineInput[];
}

export interface PurchaseRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_nit: string | null;
  invoice_number: string;
  cufe: string | null;
  issue_date: string;
  due_date: string | null;
  subtotal: number;
  tax_total: number;
  total: number;
  paid: number;
  balance: number;
  notes: string | null;
  source: 'manual' | 'xml';
  status: 'registrada' | 'anulada';
  void_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface PurchaseDetail extends PurchaseRow {
  lines: Array<{
    id: string;
    supply_id: string | null;
    supply_name: string | null;
    supply_unit: string | null;
    description: string;
    supplier_code: string | null;
    quantity: number;
    conversion_factor: number;
    line_total: number;
    tax_amount: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    method: string;
    payment_date: string;
    reference: string | null;
    status: 'activo' | 'anulado';
    void_reason: string | null;
    created_by_name: string | null;
  }>;
}

const PURCHASE_SELECT = `
  SELECT p.id, p.supplier_id, s.name AS supplier_name, s.nit AS supplier_nit, p.invoice_number, p.cufe, p.issue_date,
         p.due_date, p.subtotal, p.tax_total, p.total, p.notes, p.source, p.status, p.void_reason, p.created_at,
         u.full_name AS created_by_name,
         COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.purchase_id = p.id AND sp.status = 'activo'), 0) AS paid
  FROM purchases p
  JOIN suppliers s ON s.id = p.supplier_id
  LEFT JOIN users u ON u.id = p.created_by`;

const withBalance = (row: Omit<PurchaseRow, 'balance'>): PurchaseRow => ({
  ...row,
  balance: row.status === 'anulada' ? 0 : row.total - row.paid,
});

/** NIT solo con dígitos (sin puntos, guiones ni dígito de verificación separado). */
export function normalizeNit(nit: string | null | undefined): string | null {
  if (!nit) return null;
  const [base] = nit.split('-');
  const digits = (base ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits : null;
}

export class PurchaseService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  // ─── Proveedores ──────────────────────────────────────────────────────────

  async listSuppliers(tenantId: string): Promise<SupplierRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.id, s.name, s.nit, s.phone, s.email, s.contact_name, s.notes, s.is_active,
                COALESCE((SELECT SUM(p.total - COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
                                                        WHERE sp.purchase_id = p.id AND sp.status = 'activo'), 0))
                          FROM purchases p WHERE p.supplier_id = s.id AND p.status = 'registrada'), 0) AS balance
         FROM suppliers s WHERE s.tenant_id = ? ORDER BY s.is_active DESC, s.name`,
      )
      .bind(tenantId)
      .all<SupplierRow>();
    return results;
  }

  async getSupplier(tenantId: string, supplierId: string): Promise<SupplierRow> {
    const supplier = (await this.listSuppliers(tenantId)).find((row) => row.id === supplierId);
    if (!supplier) throw notFound('El proveedor');
    return supplier;
  }

  async createSupplier(actor: Actor, input: SupplierInput): Promise<SupplierRow> {
    const nit = normalizeNit(input.nit);
    await this.assertNitAvailable(actor.tenantId, nit, null);
    const supplierId = crypto.randomUUID();
    await this.db.batch([
      this.buildInsertSupplier(actor.tenantId, supplierId, { ...input, nit }),
      this.audit.buildStatement(actor, { action: 'proveedor_creado', entity: 'proveedor', entityId: supplierId, details: { name: input.name } }),
    ]);
    return this.getSupplier(actor.tenantId, supplierId);
  }

  async updateSupplier(actor: Actor, supplierId: string, input: SupplierInput): Promise<SupplierRow> {
    await this.getSupplier(actor.tenantId, supplierId);
    const nit = normalizeNit(input.nit);
    await this.assertNitAvailable(actor.tenantId, nit, supplierId);
    await this.db.batch([
      this.db
        .prepare('UPDATE suppliers SET name = ?, nit = ?, phone = ?, email = ?, contact_name = ?, notes = ?, is_active = ? WHERE id = ? AND tenant_id = ?')
        .bind(input.name, nit, input.phone, input.email, input.contactName, input.notes, input.isActive ? 1 : 0, supplierId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'proveedor_editado', entity: 'proveedor', entityId: supplierId }),
    ]);
    return this.getSupplier(actor.tenantId, supplierId);
  }

  private buildInsertSupplier(tenantId: string, supplierId: string, input: Partial<SupplierInput> & { name: string; nit: string | null }): SqlStatement {
    return this.db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, nit, phone, email, contact_name, notes, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(supplierId, tenantId, input.name, input.nit, input.phone ?? null, input.email ?? null, input.contactName ?? null, input.notes ?? null, input.isActive === false ? 0 : 1, isoNow());
  }

  private async assertNitAvailable(tenantId: string, nit: string | null, exceptId: string | null): Promise<void> {
    if (!nit) return;
    const existing = await this.db
      .prepare('SELECT name FROM suppliers WHERE tenant_id = ? AND nit = ? AND id != ?')
      .bind(tenantId, nit, exceptId ?? '')
      .first<{ name: string }>();
    if (existing) throw new AppError(`El NIT ${nit} ya está registrado para ${existing.name}.`, 409, 'DUPLICATE_NIT');
  }

  /** Códigos de producto del proveedor ya asociados a insumos (para importar XML). */
  async getItemLinks(tenantId: string, supplierId: string): Promise<Array<{ supplier_code: string; supply_id: string; conversion_factor: number }>> {
    const { results } = await this.db
      .prepare('SELECT supplier_code, supply_id, conversion_factor FROM supplier_item_links WHERE tenant_id = ? AND supplier_id = ?')
      .bind(tenantId, supplierId)
      .all<{ supplier_code: string; supply_id: string; conversion_factor: number }>();
    return results;
  }

  async findSupplierByNit(tenantId: string, nit: string): Promise<SupplierRow | null> {
    const normalized = normalizeNit(nit);
    if (!normalized) return null;
    const row = await this.db.prepare('SELECT id FROM suppliers WHERE tenant_id = ? AND nit = ?').bind(tenantId, normalized).first<{ id: string }>();
    return row ? this.getSupplier(tenantId, row.id) : null;
  }

  // ─── Compras ──────────────────────────────────────────────────────────────

  async listPurchases(tenantId: string, filters: { from: string; to: string; supplierId?: string; onlyPending?: boolean }): Promise<PurchaseRow[]> {
    const conditions = ['p.tenant_id = ?'];
    const params: string[] = [tenantId];
    if (filters.onlyPending) {
      conditions.push("p.status = 'registrada'");
    } else {
      conditions.push('p.issue_date >= ? AND p.issue_date <= ?');
      params.push(filters.from, filters.to);
    }
    if (filters.supplierId) {
      conditions.push('p.supplier_id = ?');
      params.push(filters.supplierId);
    }
    const { results } = await this.db
      .prepare(`${PURCHASE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ${filters.onlyPending ? "COALESCE(p.due_date, p.issue_date)" : 'p.issue_date DESC, p.created_at DESC'} LIMIT 1000`)
      .bind(...params)
      .all<Omit<PurchaseRow, 'balance'>>();
    const rows = results.map(withBalance);
    return filters.onlyPending ? rows.filter((row) => row.balance > 0) : rows;
  }

  async getPurchase(tenantId: string, purchaseId: string): Promise<PurchaseDetail> {
    const row = await this.db.prepare(`${PURCHASE_SELECT} WHERE p.tenant_id = ? AND p.id = ?`).bind(tenantId, purchaseId).first<Omit<PurchaseRow, 'balance'>>();
    if (!row) throw notFound('La compra');
    const [{ results: lines }, { results: payments }] = await Promise.all([
      this.db
        .prepare(
          `SELECT l.id, l.supply_id, s.name AS supply_name, s.unit AS supply_unit, l.description, l.supplier_code, l.quantity,
                  l.conversion_factor, l.line_total, l.tax_amount
           FROM purchase_lines l LEFT JOIN supplies s ON s.id = l.supply_id
           WHERE l.purchase_id = ? AND l.tenant_id = ? ORDER BY l.rowid`,
        )
        .bind(purchaseId, tenantId)
        .all<PurchaseDetail['lines'][number]>(),
      this.db
        .prepare(
          `SELECT sp.id, sp.amount, sp.method, sp.payment_date, sp.reference, sp.status, sp.void_reason, u.full_name AS created_by_name
           FROM supplier_payments sp LEFT JOIN users u ON u.id = sp.created_by
           WHERE sp.purchase_id = ? AND sp.tenant_id = ? ORDER BY sp.payment_date, sp.created_at`,
        )
        .bind(purchaseId, tenantId)
        .all<PurchaseDetail['payments'][number]>(),
    ]);
    return { ...withBalance(row), lines, payments };
  }

  async createPurchase(actor: Actor, input: PurchaseInput): Promise<PurchaseDetail> {
    if (input.lines.length === 0) throw new AppError('Agrega al menos una línea a la compra.', 422, 'EMPTY_PURCHASE');
    if (input.dueDate && input.dueDate < input.issueDate) {
      throw new AppError('La fecha de vencimiento no puede ser anterior a la de la factura.', 422, 'INVALID_DUE_DATE');
    }
    const statements: SqlStatement[] = [];

    // 1. Proveedor: existente, encontrado por NIT o nuevo.
    let supplierId = input.supplierId;
    if (supplierId) {
      await this.getSupplier(actor.tenantId, supplierId);
    } else if (input.newSupplier) {
      const existing = input.newSupplier.nit ? await this.findSupplierByNit(actor.tenantId, input.newSupplier.nit) : null;
      if (existing) {
        supplierId = existing.id;
      } else {
        supplierId = crypto.randomUUID();
        statements.push(this.buildInsertSupplier(actor.tenantId, supplierId, { name: input.newSupplier.name, nit: normalizeNit(input.newSupplier.nit) }));
      }
    } else {
      throw new AppError('Selecciona el proveedor.', 422, 'MISSING_SUPPLIER');
    }

    // 2. Factura duplicada (mensaje claro; el índice único es la garantía final).
    const invoiceNumber = input.invoiceNumber.trim().toUpperCase();
    const duplicate = await this.db
      .prepare(
        `SELECT invoice_number FROM purchases WHERE tenant_id = ? AND status = 'registrada'
         AND ((supplier_id = ? AND invoice_number = ?) OR (? IS NOT NULL AND cufe = ?))`,
      )
      .bind(actor.tenantId, supplierId, invoiceNumber, input.cufe, input.cufe)
      .first<{ invoice_number: string }>();
    if (duplicate) throw new AppError(`La factura ${duplicate.invoice_number} de este proveedor ya está registrada.`, 409, 'DUPLICATE_INVOICE');

    // 3. Insumos referenciados deben ser del consultorio.
    const referencedIds = [...new Set(input.lines.map((line) => line.supplyId).filter((id): id is string => Boolean(id)))];
    if (referencedIds.length > 0) {
      const found = await this.db
        .prepare(`SELECT COUNT(*) AS total FROM supplies WHERE tenant_id = ? AND id IN (${referencedIds.map(() => '?').join(',')})`)
        .bind(actor.tenantId, ...referencedIds)
        .first<{ total: number }>();
      if ((found?.total ?? 0) !== referencedIds.length) throw notFound('Uno de los insumos');
    }

    // 4. Compra, líneas, insumos nuevos, costo promedio y entrada al inventario.
    const purchaseId = crypto.randomUUID();
    const now = isoNow();
    const subtotal = input.lines.reduce((total, line) => total + line.lineTotal, 0);
    const taxTotal = input.lines.reduce((total, line) => total + line.taxAmount, 0);
    statements.push(
      this.db
        .prepare(
          `INSERT INTO purchases (id, tenant_id, supplier_id, invoice_number, cufe, issue_date, due_date, subtotal, tax_total, total, notes, source, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registrada', ?, ?)`,
        )
        .bind(purchaseId, actor.tenantId, supplierId, invoiceNumber, input.cufe, input.issueDate, input.dueDate, subtotal, taxTotal, subtotal + taxTotal, input.notes, input.source, actor.userId, now),
    );

    for (const line of input.lines) {
      let supplyId = line.supplyId;
      if (!supplyId && line.newSupply) {
        supplyId = crypto.randomUUID();
        statements.push(...this.inventory.buildCreateSupplyStatements(actor.tenantId, supplyId, line.newSupply));
      }
      statements.push(
        this.db
          .prepare(
            `INSERT INTO purchase_lines (id, tenant_id, purchase_id, supply_id, description, supplier_code, quantity, conversion_factor, line_total, tax_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), actor.tenantId, purchaseId, supplyId, line.description, line.supplierCode, line.quantity, line.conversionFactor, line.lineTotal, line.taxAmount),
      );
      if (!supplyId) continue;

      // El costo del inventario es sin IVA descontable; en salud normalmente el IVA es mayor costo.
      // Se usa el valor de la línea + su impuesto para no subestimar el costo real del consultorio.
      const stockQuantity = line.quantity * line.conversionFactor;
      const unitCost = (line.lineTotal + line.taxAmount) / stockQuantity;
      statements.push(
        this.inventory.buildAverageCostUpdate(actor.tenantId, supplyId, stockQuantity, unitCost),
        this.db
          .prepare(
            `INSERT INTO stock_movements (id, tenant_id, supply_id, kind, quantity, unit_cost, purchase_id, reason, created_by, created_at)
             VALUES (?, ?, ?, 'compra', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), actor.tenantId, supplyId, stockQuantity, unitCost, purchaseId, `Factura ${invoiceNumber}`, actor.userId, now),
      );
      if (line.supplierCode) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO supplier_item_links (tenant_id, supplier_id, supplier_code, supply_id, conversion_factor) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET supply_id = excluded.supply_id, conversion_factor = excluded.conversion_factor`,
            )
            .bind(actor.tenantId, supplierId, line.supplierCode, supplyId, line.conversionFactor),
        );
      }
    }
    statements.push(
      this.audit.buildStatement(actor, { action: 'compra_registrada', entity: 'compra', entityId: purchaseId, details: { invoiceNumber, total: subtotal + taxTotal, source: input.source } }),
    );

    await this.db.batch(statements);
    return this.getPurchase(actor.tenantId, purchaseId);
  }

  async voidPurchase(actor: Actor, purchaseId: string, reason: string): Promise<PurchaseDetail> {
    const purchase = await this.getPurchase(actor.tenantId, purchaseId);
    if (purchase.status === 'anulada') throw new AppError('La compra ya está anulada.', 409, 'ALREADY_VOIDED');
    if (purchase.paid > 0) throw new AppError('Primero anula los pagos de esta compra.', 409, 'HAS_PAYMENTS');
    const now = isoNow();
    await this.db.batch([
      this.db
        .prepare("UPDATE purchases SET status = 'anulada', void_reason = ? WHERE id = ? AND tenant_id = ? AND status = 'registrada'")
        .bind(reason, purchaseId, actor.tenantId),
      // Reversa exacta de lo que entró con esta compra.
      this.db
        .prepare(
          `INSERT INTO stock_movements (id, tenant_id, supply_id, kind, quantity, unit_cost, purchase_id, reason, created_by, created_at)
           SELECT lower(hex(randomblob(16))), tenant_id, supply_id, 'anulacion_compra', -quantity, unit_cost, purchase_id, ?, ?, ?
           FROM stock_movements WHERE purchase_id = ? AND tenant_id = ? AND kind = 'compra'`,
        )
        .bind(`Anulación: ${reason}`, actor.userId, now, purchaseId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'compra_anulada', entity: 'compra', entityId: purchaseId, details: { reason } }),
    ]);
    return this.getPurchase(actor.tenantId, purchaseId);
  }

  // ─── Pagos a proveedores ──────────────────────────────────────────────────

  async registerPayment(
    actor: Actor,
    purchaseId: string,
    input: { amount: number; method: string; paymentDate: string; reference: string | null },
  ): Promise<PurchaseDetail> {
    const purchase = await this.getPurchase(actor.tenantId, purchaseId);
    if (purchase.status === 'anulada') throw new AppError('La compra está anulada.', 409, 'PURCHASE_VOIDED');
    if (input.amount > purchase.balance) {
      throw new AppError(`El pago supera el saldo pendiente de la factura (${purchase.balance}).`, 422, 'OVERPAYMENT');
    }
    const paymentId = crypto.randomUUID();
    // Guarda atómica: solo inserta si el saldo sigue alcanzando (dos pagos simultáneos no sobrepagan).
    const outcome = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO supplier_payments (id, tenant_id, purchase_id, amount, method, payment_date, reference, status, created_by, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?
           WHERE (SELECT p.total - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE purchase_id = p.id AND status = 'activo'), 0)
                  FROM purchases p WHERE p.id = ? AND p.status = 'registrada') >= ?`,
        )
        .bind(paymentId, actor.tenantId, purchaseId, input.amount, input.method, input.paymentDate, input.reference, actor.userId, isoNow(), purchaseId, input.amount),
      this.audit.buildStatement(actor, { action: 'pago_proveedor_registrado', entity: 'compra', entityId: purchaseId, details: { amount: input.amount, method: input.method } }),
    ]);
    if ((outcome[0]?.meta?.changes ?? 0) === 0) throw new AppError('El saldo de la factura cambió. Actualiza e intenta de nuevo.', 409, 'BALANCE_CHANGED');
    return this.getPurchase(actor.tenantId, purchaseId);
  }

  async voidPayment(actor: Actor, paymentId: string, reason: string): Promise<PurchaseDetail> {
    const payment = await this.db
      .prepare('SELECT purchase_id, status FROM supplier_payments WHERE id = ? AND tenant_id = ?')
      .bind(paymentId, actor.tenantId)
      .first<{ purchase_id: string; status: string }>();
    if (!payment) throw notFound('El pago');
    if (payment.status === 'anulado') throw new AppError('El pago ya está anulado.', 409, 'ALREADY_VOIDED');
    await this.db.batch([
      this.db
        .prepare("UPDATE supplier_payments SET status = 'anulado', void_reason = ? WHERE id = ? AND tenant_id = ?")
        .bind(reason, paymentId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'pago_proveedor_anulado', entity: 'compra', entityId: payment.purchase_id, details: { reason } }),
    ]);
    return this.getPurchase(actor.tenantId, payment.purchase_id);
  }
}
