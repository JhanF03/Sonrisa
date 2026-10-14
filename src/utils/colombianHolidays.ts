/**
 * Festivos de Colombia calculados sin servicios externos (costo cero).
 *
 * - Fijos: 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic.
 * - Ley Emiliani (se trasladan al lunes siguiente): 6 ene, 19 mar, 29 jun,
 *   15 ago, 12 oct, 1 nov, 11 nov.
 * - Según la Pascua: Jueves y Viernes Santo; Ascensión (+43 días),
 *   Corpus Christi (+64) y Sagrado Corazón (+71), ya trasladados a lunes.
 */
import { addDays, weekdayOf } from './time.js';

const holidayCache = new Map<number, Set<string>>();

export function getColombianHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const pad = (value: number) => String(value).padStart(2, '0');
  const dateOf = (month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

  const fixedHolidays = [dateOf(1, 1), dateOf(5, 1), dateOf(7, 20), dateOf(8, 7), dateOf(12, 8), dateOf(12, 25)];

  const emilianiHolidays = [
    dateOf(1, 6), dateOf(3, 19), dateOf(6, 29), dateOf(8, 15), dateOf(10, 12), dateOf(11, 1), dateOf(11, 11),
  ].map(moveToNextMonday);

  const easterSunday = calculateEasterSunday(year);
  const easterBasedHolidays = [-3, -2, 43, 64, 71].map((offsetDays) => addDays(easterSunday, offsetDays));

  const holidays = new Set([...fixedHolidays, ...emilianiHolidays, ...easterBasedHolidays]);
  holidayCache.set(year, holidays);
  return holidays;
}

export function isColombianHoliday(localDate: string): boolean {
  return getColombianHolidays(Number(localDate.slice(0, 4))).has(localDate);
}

function moveToNextMonday(localDate: string): string {
  const weekday = weekdayOf(localDate);
  if (weekday === 1) return localDate;
  const daysUntilMonday = (8 - weekday) % 7;
  return addDays(localDate, daysUntilMonday);
}

/** Algoritmo de Meeus/Jones/Butcher para el domingo de Pascua (calendario gregoriano). */
export function calculateEasterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
