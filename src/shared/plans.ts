/**
 * Planes y módulos (lo usan el servidor y la interfaz).
 *
 *   Precio mensual = plan + módulos extra + profesionales extra + usuarios extra
 *
 * • El plan define qué módulos se pueden usar y cuántos profesionales con
 *   agenda y cuántos usuarios activos admite.
 * • Lo básico (agenda, pacientes, servicios, reservas en línea, recordatorios,
 *   usuarios y configuración) va en todos los planes.
 * • Los módulos se aplican sobre los permisos: si el plan no incluye un
 *   módulo, sus permisos no llegan al usuario y el servidor responde 403
 *   aunque el rol los tenga. Así no hay que tocar cada ruta.
 *
 * Todo es puro (sin base de datos) para poder probarlo y mostrar el mismo
 * cálculo en pantalla antes de pagar.
 */

export const PLAN_MODULES = {
  finanzas: { name: 'Caja y finanzas', description: 'Caja, recibos, cartera, indicadores y anticipos en línea con Wompi', icon: 'wallet' },
  inventario: { name: 'Compras e inventario', description: 'Proveedores, facturas de compra, cuentas por pagar, insumos y consumo por servicio', icon: 'package' },
  facturacion: { name: 'Facturación electrónica', description: 'Facturas electrónicas DIAN con tu proveedor tecnológico (requiere Caja y finanzas)', icon: 'file-text' },
  auditoria: { name: 'Auditoría', description: 'Registro de quién hizo qué y cuándo', icon: 'scroll-text' },
} as const;

export type PlanModule = keyof typeof PLAN_MODULES;
export const ALL_PLAN_MODULES = Object.keys(PLAN_MODULES) as PlanModule[];

/** Incluido en todos los planes. */
export const BASE_FEATURES = [
  'Agenda por profesional',
  'Pacientes e historial',
  'Página de reservas en línea',
  'Recordatorios por WhatsApp',
  'Servicios y precios',
  'Usuarios y roles',
] as const;

/** Módulo que necesita otro para funcionar. */
const MODULE_REQUIRES: Partial<Record<PlanModule, PlanModule>> = { facturacion: 'finanzas' };

const PERMISSION_PREFIXES: ReadonlyArray<readonly [string, PlanModule]> = [
  ['caja.', 'finanzas'],
  ['cartera.', 'finanzas'],
  ['pagos.', 'finanzas'],
  ['reportes.', 'finanzas'],
  ['compras.', 'inventario'],
  ['inventario.', 'inventario'],
  ['facturacion.', 'facturacion'],
  ['auditoria.', 'auditoria'],
];

/** Módulo al que pertenece un permiso (null = incluido en todos los planes). */
export function moduleOfPermission(permission: string): PlanModule | null {
  return PERMISSION_PREFIXES.find(([prefix]) => permission.startsWith(prefix))?.[1] ?? null;
}

export function isPlanModule(value: string): value is PlanModule {
  return Object.hasOwn(PLAN_MODULES, value);
}

/** "finanzas,inventario" → ['finanzas', 'inventario'] (ignora valores desconocidos). */
export function parseModules(value: string | null | undefined): PlanModule[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(isPlanModule))];
}

export const serializeModules = (modules: readonly PlanModule[]): string => ALL_PLAN_MODULES.filter((module) => modules.includes(module)).join(',');

export interface PlanDefinition {
  id: string;
  name: string;
  description: string;
  monthlyPrice: number;
  maxProfessionals: number;
  maxUsers: number;
  modules: PlanModule[];
  sortOrder: number;
  isActive: boolean;
}

export type AddonId = PlanModule | 'profesional' | 'usuario';

export interface AddonDefinition {
  id: AddonId;
  name: string;
  monthlyPrice: number;
  isActive: boolean;
}

export interface PlanCatalog {
  plans: PlanDefinition[];
  addons: AddonDefinition[];
  /** Meses de regalo al pagar 12 (ej. 2 = pagas 10, usas 12). */
  annualFreeMonths: number;
}

export interface PlanSelection {
  planId: string;
  addonModules: PlanModule[];
  extraProfessionals: number;
  extraUsers: number;
}

export interface PriceLine {
  label: string;
  amount: number;
}

export interface ResolvedPlan {
  plan: PlanDefinition;
  selection: PlanSelection;
  /** Módulos habilitados (los del plan + los extra). */
  modules: PlanModule[];
  maxProfessionals: number;
  maxUsers: number;
  monthlyPrice: number;
  lines: PriceLine[];
}

export class PlanSelectionError extends Error {}

export const MAX_EXTRA_SEATS = 50;

/**
 * Valida la selección y calcula módulos, límites y precio.
 * Un módulo extra que ya viene en el plan no se cobra (se ignora).
 */
export function resolvePlan(catalog: PlanCatalog, selection: PlanSelection, options: { allowInactivePlan?: boolean } = {}): ResolvedPlan {
  const plan = catalog.plans.find((candidate) => candidate.id === selection.planId);
  if (!plan || (!plan.isActive && !options.allowInactivePlan)) throw new PlanSelectionError('El plan elegido no está disponible.');
  const addonById = new Map(catalog.addons.map((addon) => [addon.id, addon]));
  const extraProfessionals = clampSeats(selection.extraProfessionals);
  const extraUsers = clampSeats(selection.extraUsers);
  const addonModules = [...new Set(selection.addonModules)].filter((module) => !plan.modules.includes(module));

  const lines: PriceLine[] = [{ label: `Plan ${plan.name}`, amount: plan.monthlyPrice }];
  for (const module of ALL_PLAN_MODULES.filter((candidate) => addonModules.includes(candidate))) {
    const addon = addonById.get(module);
    if (!addon?.isActive) throw new PlanSelectionError(`El módulo "${PLAN_MODULES[module].name}" no se vende por separado.`);
    lines.push({ label: `Módulo ${addon.name}`, amount: addon.monthlyPrice });
  }
  const seat = (id: 'profesional' | 'usuario', count: number, singular: string, plural: string) => {
    if (count === 0) return;
    const addon = addonById.get(id);
    if (!addon?.isActive) throw new PlanSelectionError(`No se venden ${plural} adicionales; elige un plan más grande.`);
    lines.push({ label: `${count} ${count === 1 ? singular : plural} adicional${count === 1 ? '' : 'es'}`, amount: addon.monthlyPrice * count });
  };
  seat('profesional', extraProfessionals, 'profesional', 'profesionales');
  seat('usuario', extraUsers, 'usuario', 'usuarios');

  const modules = ALL_PLAN_MODULES.filter((module) => plan.modules.includes(module) || addonModules.includes(module));
  for (const module of modules) {
    const required = MODULE_REQUIRES[module];
    if (required && !modules.includes(required)) {
      throw new PlanSelectionError(`"${PLAN_MODULES[module].name}" necesita "${PLAN_MODULES[required].name}". Agrégalo o elige un plan que lo incluya.`);
    }
  }
  return {
    plan,
    selection: { planId: plan.id, addonModules, extraProfessionals, extraUsers },
    modules,
    maxProfessionals: plan.maxProfessionals + extraProfessionals,
    maxUsers: plan.maxUsers + extraUsers,
    monthlyPrice: lines.reduce((sum, line) => sum + line.amount, 0),
    lines,
  };
}

function clampSeats(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_EXTRA_SEATS) throw new PlanSelectionError(`Los adicionales van de 0 a ${MAX_EXTRA_SEATS}.`);
  return value;
}

/** Opciones de pago: 1, 3, 6 meses o 12 con meses de regalo. */
export const PAYMENT_MONTH_OPTIONS = [1, 3, 6, 12] as const;

/** Valor a pagar por N meses (12 meses = descuento anual). */
export function priceForMonths(monthlyPrice: number, months: number, annualFreeMonths: number): number {
  if (months === 12) return monthlyPrice * (12 - Math.min(Math.max(annualFreeMonths, 0), 6));
  return monthlyPrice * months;
}

/**
 * Diferencia a pagar al subir de plan a mitad de periodo:
 * (precio nuevo − precio actual) × días que quedan / 30, redondeado hacia arriba a 100 COP.
 */
export function prorateUpgrade(currentMonthly: number, newMonthly: number, daysLeft: number): number {
  const difference = newMonthly - currentMonthly;
  if (difference <= 0 || daysLeft <= 0) return 0;
  return Math.ceil((difference * daysLeft) / 30 / 100) * 100;
}

/** Valor mínimo que Wompi acepta cobrar; por debajo, el cambio se aplica sin cobro. */
export const MIN_ONLINE_CHARGE = 1500;
