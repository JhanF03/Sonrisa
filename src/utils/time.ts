/**
 * Utilidades de fecha y hora.
 *
 * La agenda trabaja en "hora local del consultorio" con cadenas
 * 'YYYY-MM-DDTHH:MM'. Se comparan como texto (el formato es ordenable)
 * y se evita depender de la zona horaria del servidor (Cloudflare usa UTC).
 */

export const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const MINUTE_MS = 60_000;

/** Fecha/hora actual en la zona del consultorio. */
export function nowLocal(utcOffsetMinutes: number, nowMs = Date.now()): string {
  return new Date(nowMs + utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 16);
}

export function todayLocal(utcOffsetMinutes: number, nowMs = Date.now()): string {
  return nowLocal(utcOffsetMinutes, nowMs).slice(0, 10);
}

/** Suma minutos a una fecha local 'YYYY-MM-DDTHH:MM'. */
export function addMinutes(localDateTime: string, minutes: number): string {
  const asUtc = new Date(`${localDateTime}:00Z`).getTime() + minutes * MINUTE_MS;
  return new Date(asUtc).toISOString().slice(0, 16);
}

export function addDays(localDate: string, days: number): string {
  return addMinutes(`${localDate}T00:00`, days * 24 * 60).slice(0, 10);
}

/** 0 = domingo … 6 = sábado. */
export function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

export function minutesBetween(startLocal: string, endLocal: string): number {
  return (new Date(`${endLocal}:00Z`).getTime() - new Date(`${startLocal}:00Z`).getTime()) / MINUTE_MS;
}

export function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidLocalDateTime(value: string): boolean {
  return (
    LOCAL_DATETIME_PATTERN.test(value) &&
    isValidLocalDate(value.slice(0, 10)) &&
    TIME_PATTERN.test(value.slice(11))
  );
}

/** Marca de tiempo UTC para auditoría. */
export function isoNow(): string {
  return new Date().toISOString();
}

/** Resta meses a una fecha local (para reactivación de pacientes). */
export function subtractMonths(localDate: string, months: number): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

/** Convierte una fecha/hora local del consultorio a ISO UTC (para filtrar marcas de auditoría). */
export function localToUtcIso(localDateTime: string, utcOffsetMinutes: number): string {
  return new Date(new Date(`${localDateTime}:00Z`).getTime() - utcOffsetMinutes * MINUTE_MS).toISOString();
}

/** Convierte una marca ISO UTC a fecha local 'YYYY-MM-DD' del consultorio. */
export function utcIsoToLocalDate(utcIso: string, utcOffsetMinutes: number): string {
  return new Date(new Date(utcIso).getTime() + utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/** Días completos entre dos fechas locales 'YYYY-MM-DD'. */
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000);
}
