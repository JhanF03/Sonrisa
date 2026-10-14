/**
 * Estado de la suscripción de un consultorio (lo usan el servidor y la interfaz).
 *
 *   paid_until (incluido) ──► días de gracia ──► suspendido
 *
 * El cálculo es puro y se hace en cada petición: no hay que esperar a ningún
 * proceso programado para suspender ni para reactivar.
 */

export type SubscriptionState = 'exento' | 'al_dia' | 'por_vencer' | 'en_gracia' | 'suspendido';

export interface SubscriptionInput {
  isShowcase: boolean;
  billingMode: string;
  paidUntil: string | null;
  graceDays: number;
}

export interface SubscriptionStatus {
  state: SubscriptionState;
  paidUntil: string | null;
  /** Días hasta paid_until (negativo si ya pasó). */
  daysLeft: number | null;
  /** Primer día sin acceso (paid_until + gracia + 1). */
  suspendOn: string | null;
  /** true si el personal NO puede usar el sistema. */
  blocked: boolean;
}

/** Aviso previo al vencimiento. */
export const RENEWAL_NOTICE_DAYS = 5;

const DAY_MS = 86_400_000;

export function addDaysToDate(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Suma meses de calendario (31-ene + 1 mes = 28/29-feb). */
export function addMonthsToDate(localDate: string, months: number): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Nuevo paid_until al pagar N meses: desde hoy si ya venció, o desde el vencimiento si está al día. */
export function extendPaidUntil(currentPaidUntil: string | null, today: string, months: number): string {
  const base = currentPaidUntil && currentPaidUntil >= today ? currentPaidUntil : addDaysToDate(today, -1);
  return addMonthsToDate(base, months);
}

export function computeSubscription(input: SubscriptionInput, today: string): SubscriptionStatus {
  if (input.isShowcase || input.billingMode === 'exento') {
    return { state: 'exento', paidUntil: input.paidUntil, daysLeft: null, suspendOn: null, blocked: false };
  }
  if (input.billingMode === 'suspendido') {
    return { state: 'suspendido', paidUntil: input.paidUntil, daysLeft: input.paidUntil ? daysBetweenDates(today, input.paidUntil) : null, suspendOn: today, blocked: true };
  }
  if (!input.paidUntil) {
    return { state: 'suspendido', paidUntil: null, daysLeft: null, suspendOn: today, blocked: true };
  }
  const daysLeft = daysBetweenDates(today, input.paidUntil);
  const suspendOn = addDaysToDate(input.paidUntil, Math.max(0, input.graceDays) + 1);
  if (today >= suspendOn) return { state: 'suspendido', paidUntil: input.paidUntil, daysLeft, suspendOn, blocked: true };
  if (daysLeft < 0) return { state: 'en_gracia', paidUntil: input.paidUntil, daysLeft, suspendOn, blocked: false };
  if (daysLeft <= RENEWAL_NOTICE_DAYS) return { state: 'por_vencer', paidUntil: input.paidUntil, daysLeft, suspendOn, blocked: false };
  return { state: 'al_dia', paidUntil: input.paidUntil, daysLeft, suspendOn, blocked: false };
}

export const SUBSCRIPTION_LABELS: Record<SubscriptionState, string> = {
  exento: 'Sin cobro',
  al_dia: 'Al día',
  por_vencer: 'Por vencer',
  en_gracia: 'Vencida (en gracia)',
  suspendido: 'Suspendida',
};
