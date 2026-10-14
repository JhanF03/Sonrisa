/**
 * Planes del consultorio: catálogo (lo edita el dueño), límites de
 * profesionales y usuarios, y aplicar un plan a un consultorio.
 *
 * El cálculo de precio y módulos está en shared/plans.ts (puro, también lo
 * usa la interfaz). Aquí solo se lee y escribe la base de datos.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { TenantRow } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import {
  isPlanModule,
  parseModules,
  PlanSelectionError,
  resolvePlan,
  serializeModules,
  type AddonDefinition,
  type AddonId,
  type PlanCatalog,
  type PlanDefinition,
  type PlanSelection,
  type ResolvedPlan,
} from '../../shared/plans.js';
import { isoNow } from '../../utils/time.js';

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  monthly_price: number;
  max_professionals: number;
  max_users: number;
  modules: string;
  sort_order: number;
  is_active: number;
}

export type SeatKind = 'profesional' | 'usuario';

export interface PlanUsage {
  professionals: number;
  users: number;
}

export class PlanService {
  constructor(private readonly db: SqlDatabase) {}

  async getCatalog(): Promise<PlanCatalog> {
    const [plans, addons, settings] = await Promise.all([
      this.db.prepare('SELECT * FROM plans ORDER BY sort_order, monthly_price').all<PlanRow>(),
      this.db.prepare('SELECT id, name, monthly_price, is_active FROM plan_addons').all<{ id: AddonId; name: string; monthly_price: number; is_active: number }>(),
      this.db.prepare('SELECT annual_free_months FROM platform_settings WHERE id = 1').first<{ annual_free_months: number }>(),
    ]);
    return {
      plans: plans.results.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        monthlyPrice: row.monthly_price,
        maxProfessionals: row.max_professionals,
        maxUsers: row.max_users,
        modules: parseModules(row.modules),
        sortOrder: row.sort_order,
        isActive: row.is_active === 1,
      })),
      addons: addons.results.map((row) => ({ id: row.id, name: row.name, monthlyPrice: row.monthly_price, isActive: row.is_active === 1 })),
      annualFreeMonths: settings?.annual_free_months ?? 0,
    };
  }

  /** Guarda precios, límites y módulos. Los consultorios sin precio especial toman el precio nuevo. */
  async saveCatalog(input: { plans: PlanDefinition[]; addons: AddonDefinition[]; annualFreeMonths: number }, ip: string): Promise<PlanCatalog> {
    const current = await this.getCatalog();
    for (const plan of input.plans) {
      if (!current.plans.some((existing) => existing.id === plan.id)) throw new AppError('Plan desconocido.', 422, 'UNKNOWN_PLAN');
      if (plan.modules.some((module) => !isPlanModule(module))) throw new AppError('Módulo desconocido.', 422, 'UNKNOWN_MODULE');
    }
    if (!input.plans.some((plan) => plan.isActive)) throw new AppError('Deja al menos un plan activo.', 422, 'NO_ACTIVE_PLAN');

    const statements: SqlStatement[] = [
      ...input.plans.map((plan) =>
        this.db
          .prepare('UPDATE plans SET name = ?, description = ?, monthly_price = ?, max_professionals = ?, max_users = ?, modules = ?, is_active = ? WHERE id = ?')
          .bind(plan.name, plan.description || null, plan.monthlyPrice, plan.maxProfessionals, plan.maxUsers, serializeModules(plan.modules), plan.isActive ? 1 : 0, plan.id),
      ),
      ...input.addons.map((addon) =>
        this.db.prepare('UPDATE plan_addons SET name = ?, monthly_price = ?, is_active = ? WHERE id = ?').bind(addon.name, addon.monthlyPrice, addon.isActive ? 1 : 0, addon.id),
      ),
      this.db.prepare('UPDATE platform_settings SET annual_free_months = ?, updated_at = ? WHERE id = 1').bind(input.annualFreeMonths, isoNow()),
      this.db
        .prepare('INSERT INTO platform_audit (id, action, tenant_id, details, ip, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'planes_editados', JSON.stringify({ plans: input.plans.map((plan) => [plan.id, plan.monthlyPrice]) }), ip, isoNow()),
    ];
    await this.db.batch(statements);

    // Recalcula módulos, límites y precio de cada consultorio con el catálogo nuevo.
    const catalog = await this.getCatalog();
    const { results: tenants } = await this.db.prepare('SELECT * FROM tenants WHERE is_showcase = 0').all<TenantRow>();
    const updates = tenants.flatMap((tenant) => {
      try {
        return [this.applyStatement(tenant, resolvePlan(catalog, selectionOf(tenant), { allowInactivePlan: true }))];
      } catch {
        return []; // Selección que ya no es válida: se conserva como estaba hasta que el cliente cambie de plan.
      }
    });
    if (updates.length) await this.db.batch(updates);
    return catalog;
  }

  /** Valida una selección contra el catálogo actual (422 con mensaje claro si no es válida). */
  async resolve(selection: PlanSelection, options: { allowInactivePlan?: boolean } = {}): Promise<ResolvedPlan> {
    const catalog = await this.getCatalog();
    try {
      return resolvePlan(catalog, selection, options);
    } catch (error) {
      if (error instanceof PlanSelectionError) throw new AppError(error.message, 422, 'INVALID_PLAN');
      throw error;
    }
  }

  /** Sentencia que deja el consultorio con el plan resuelto (y borra un cambio programado). */
  applyStatement(tenant: Pick<TenantRow, 'id' | 'custom_price'>, resolved: ResolvedPlan): SqlStatement {
    return this.db
      .prepare(
        `UPDATE tenants SET plan_id = ?, addon_modules = ?, extra_professionals = ?, extra_users = ?, enabled_modules = ?,
           max_professionals = ?, max_users = ?, monthly_price = COALESCE(custom_price, ?), pending_plan = NULL WHERE id = ?`,
      )
      .bind(
        resolved.plan.id, serializeModules(resolved.selection.addonModules), resolved.selection.extraProfessionals, resolved.selection.extraUsers,
        serializeModules(resolved.modules), resolved.maxProfessionals, resolved.maxUsers, resolved.monthlyPrice, tenant.id,
      );
  }

  async usage(tenantId: string): Promise<PlanUsage> {
    const row = await this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM professionals WHERE tenant_id = ? AND is_active = 1) AS professionals,
                (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND is_active = 1) AS users`,
      )
      .bind(tenantId, tenantId)
      .first<PlanUsage>();
    return { professionals: row?.professionals ?? 0, users: row?.users ?? 0 };
  }

  /** Comprueba que una selección alcance para lo que el consultorio ya tiene activo. */
  async assertFits(tenantId: string, resolved: ResolvedPlan): Promise<void> {
    const usage = await this.usage(tenantId);
    const problems: string[] = [];
    if (usage.professionals > resolved.maxProfessionals) problems.push(`${usage.professionals} profesionales activos (el plan permite ${resolved.maxProfessionals})`);
    if (usage.users > resolved.maxUsers) problems.push(`${usage.users} usuarios activos (el plan permite ${resolved.maxUsers})`);
    if (problems.length) {
      throw new AppError(`Tienes ${problems.join(' y ')}. Desactiva los que sobran o agrega adicionales.`, 409, 'PLAN_TOO_SMALL');
    }
  }

  /**
   * Antes de crear o reactivar un profesional o usuario. Si hay una bajada de
   * plan programada, cuenta el límite menor (para que la bajada siga siendo válida).
   */
  async assertSeatAvailable(tenantId: string, kind: SeatKind): Promise<void> {
    const tenant = await this.db
      .prepare('SELECT is_showcase, plan_id, max_professionals, max_users, pending_plan FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<Pick<TenantRow, 'is_showcase' | 'plan_id' | 'max_professionals' | 'max_users' | 'pending_plan'>>();
    if (!tenant || tenant.is_showcase === 1) return;
    const pending = parsePending(tenant.pending_plan);
    const limit = Math.min(
      kind === 'profesional' ? tenant.max_professionals : tenant.max_users,
      pending ? (kind === 'profesional' ? pending.maxProfessionals : pending.maxUsers) : Number.POSITIVE_INFINITY,
    );
    const usage = await this.usage(tenantId);
    const used = kind === 'profesional' ? usage.professionals : usage.users;
    if (used >= limit) {
      const what = kind === 'profesional' ? 'profesionales con agenda' : 'usuarios activos';
      throw new AppError(
        `Tu plan permite ${limit} ${what} y ya los tienes todos. Desactiva uno o agrega más en "Mi plan".`,
        409,
        'PLAN_LIMIT',
      );
    }
  }
}

/** Selección guardada en el consultorio. */
export function selectionOf(tenant: Pick<TenantRow, 'plan_id' | 'addon_modules' | 'extra_professionals' | 'extra_users'>): PlanSelection {
  return {
    planId: tenant.plan_id,
    addonModules: parseModules(tenant.addon_modules),
    extraProfessionals: tenant.extra_professionals,
    extraUsers: tenant.extra_users,
  };
}

/** Cambio de plan programado (bajadas: aplican al terminar el periodo pagado). */
export interface PendingPlan extends PlanSelection {
  monthlyPrice: number;
  maxProfessionals: number;
  maxUsers: number;
  effectiveOn: string;
}

export function parsePending(value: string | null): PendingPlan | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as PendingPlan;
  } catch {
    return null;
  }
}
