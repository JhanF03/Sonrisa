/**
 * Formatos para Colombia: pesos, fechas y horas en español.
 */
import { buildWhatsappLink } from '../../src/utils/phone.js';

const currencyFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

export const formatMoney = (value: number) => currencyFormatter.format(value);

export function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

/** "mar 14 oct" */
export function formatShortDate(localDate: string): string {
  const [, month, day] = localDate.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekdayOf(localDate)]} ${day} ${MONTHS[month - 1]}`;
}

/** "martes 14 de octubre de 2026" */
export function formatLongDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(localDate)]} ${day} de ${MONTHS_LONG[month - 1]} de ${year}`;
}

/** "2:30 p. m." */
export function formatTime(localDateTimeOrTime: string): string {
  const time = localDateTimeOrTime.length > 5 ? localDateTimeOrTime.slice(11, 16) : localDateTimeOrTime;
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'p. m.' : 'a. m.';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${MONTHS_LONG[monthNumber - 1]} ${year}`;
}

/** Fecha/hora UTC (auditoría) mostrada en hora del consultorio. */
export function formatUtcAsLocal(utcIso: string, utcOffsetMinutes: number): string {
  const local = new Date(new Date(utcIso).getTime() + utcOffsetMinutes * 60_000).toISOString();
  return `${formatShortDate(local.slice(0, 10))} · ${formatTime(local.slice(0, 16))}`;
}

export function todayLocal(utcOffsetMinutes = -300): string {
  return new Date(Date.now() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} %`;
}

/** Número para WhatsApp: solo dígitos, con indicativo 57 si falta. */
export function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
}

/** Enlace wa.me o null si el número no es un celular (no puede recibir WhatsApp). */
export function whatsappLink(phone: string | null | undefined, message: string): string | null {
  return phone ? buildWhatsappLink(phone, message) : null;
}

export const STATUS_LABELS: Record<string, string> = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  atendida: 'Atendida',
  no_asistio: 'No asistió',
  cancelada: 'Cancelada',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
};

export const DOCUMENT_TYPES: Array<[string, string]> = [
  ['CC', 'Cédula de ciudadanía'],
  ['TI', 'Tarjeta de identidad'],
  ['CE', 'Cédula de extranjería'],
  ['PA', 'Pasaporte'],
  ['RC', 'Registro civil'],
  ['PPT', 'Permiso por protección temporal'],
];
