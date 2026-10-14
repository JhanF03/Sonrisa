/**
 * Plantillas de mensajes de WhatsApp con variables entre llaves.
 * Módulo compartido por el servidor y la interfaz (vista previa idéntica).
 */

export const REMINDER_PLACEHOLDERS = {
  nombre: 'Primer nombre del paciente',
  consultorio: 'Nombre del consultorio',
  fecha: 'Fecha de la cita (ej. martes 14 de octubre)',
  hora: 'Hora de la cita (ej. 9:30 a. m.)',
  profesional: 'Profesional que atiende',
  servicio: 'Servicio agendado',
  enlace: 'Enlace para confirmar, reprogramar o cancelar (obligatorio)',
} as const;

export type ReminderPlaceholder = keyof typeof REMINDER_PLACEHOLDERS;
export type TemplateValues = Record<ReminderPlaceholder, string>;

export const DEFAULT_REMINDER_TEMPLATE =
  'Hola {nombre} 👋 Te recordamos tu cita en {consultorio} el {fecha} a las {hora} con {profesional} ({servicio}).\n\n' +
  'Confirma, reprograma o cancela aquí: {enlace}\n\n¡Te esperamos!';

export const MAX_TEMPLATE_LENGTH = 700;

const PLACEHOLDER_PATTERN = /\{([a-záéíóúñ_]+)\}/gi;

/** Devuelve la lista de errores de la plantilla (vacía si es válida). */
export function validateReminderTemplate(template: string): string[] {
  const errors: string[] = [];
  if (!template.trim()) errors.push('La plantilla no puede estar vacía.');
  if (template.length > MAX_TEMPLATE_LENGTH) errors.push(`Máximo ${MAX_TEMPLATE_LENGTH} caracteres.`);
  if (!template.includes('{enlace}')) errors.push('Debe incluir {enlace} para que el paciente pueda confirmar.');

  const unknown = [...template.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .filter((name) => !Object.hasOwn(REMINDER_PLACEHOLDERS, name));
  if (unknown.length > 0) errors.push(`Variables desconocidas: ${[...new Set(unknown)].map((name) => `{${name}}`).join(', ')}.`);
  return errors;
}

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (fullMatch, name: string) =>
    Object.hasOwn(values, name) ? values[name as ReminderPlaceholder] : fullMatch,
  );
}

// ─── Fechas en español (sin depender de Intl) ──────────────────────────────

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "martes 14 de octubre" a partir de 'YYYY-MM-DD'. */
export function spanishDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} de ${MONTHS[month - 1]}`;
}

/** "9:30 a. m." a partir de 'YYYY-MM-DDTHH:MM' o 'HH:MM'. */
export function spanishTime(localDateTimeOrTime: string): string {
  const time = localDateTimeOrTime.length > 5 ? localDateTimeOrTime.slice(11, 16) : localDateTimeOrTime;
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'p. m.' : 'a. m.';
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, '0')} ${period}`;
}
