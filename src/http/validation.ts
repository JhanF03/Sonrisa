/**
 * Esquemas de validación reutilizables (Zod).
 * Toda entrada del usuario pasa por aquí antes de llegar a la lógica de negocio.
 */
import { z } from 'zod';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { normalizePhone } from '../utils/phone.js';
import { isValidLocalDate, isValidLocalDateTime, TIME_PATTERN } from '../utils/time.js';

export const idSchema = z.uuid('Identificador inválido.');

export const localDateSchema = z.string().refine(isValidLocalDate, 'Fecha inválida (usa AAAA-MM-DD).');
export const localDateTimeSchema = z
  .string()
  .refine(isValidLocalDateTime, 'Fecha y hora inválidas (usa AAAA-MM-DDTHH:MM).');
export const timeSchema = z.string().regex(TIME_PATTERN, 'Hora inválida (usa HH:MM).');

/** Pesos colombianos enteros, sin centavos. */
export const moneySchema = z.number().int('El valor no puede tener decimales.').min(0).max(10_000_000_000);
export const positiveMoneySchema = moneySchema.min(1, 'El valor debe ser mayor a cero.');

/** Teléfono normalizado a formato internacional (+57…). Acepta fijos y celulares. */
export const colombianPhoneSchema = z
  .string()
  .trim()
  .max(30)
  .transform((value, context) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      context.addIssue({ code: 'custom', message: 'Teléfono inválido. Usa un celular de 10 dígitos (ej. 300 123 4567) o un número con indicativo (+…).' });
      return z.NEVER;
    }
    return normalized.e164;
  });

/** Celular que pueda recibir WhatsApp (para reservas en línea y el número del consultorio). */
export const whatsappPhoneSchema = z
  .string()
  .trim()
  .max(30)
  .transform((value, context) => {
    const normalized = normalizePhone(value);
    if (!normalized?.isMobile) {
      context.addIssue({ code: 'custom', message: 'Escribe un celular con WhatsApp (10 dígitos, empieza por 3), ej. 300 123 4567.' });
      return z.NEVER;
    }
    return normalized.e164;
  });

export const documentTypeSchema = z.enum(['CC', 'TI', 'CE', 'PA', 'RC', 'PPT', 'NIT'], {
  error: 'Tipo de documento inválido.',
});

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (usa #RRGGBB).');

/** Solo URLs https (evita javascript:, data: y contenido mixto). */
export const httpsUrlSchema = z
  .url({ protocol: /^https$/, error: 'La URL debe empezar por https://' })
  .max(500);

export const optionalText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

export const requiredText = (maxLength: number, fieldLabel: string) =>
  z.string().trim().min(1, `${fieldLabel} es obligatorio.`).max(maxLength);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Lee y valida el cuerpo JSON; responde 400 con un mensaje claro si falla. */
export async function readJsonBody<TSchema extends z.ZodType>(
  context: AppContext,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new AppError('El cuerpo de la petición no es JSON válido.', 400, 'INVALID_JSON');
  }
  return schema.parse(body);
}

export function readQuery<TSchema extends z.ZodType>(context: AppContext, schema: TSchema): z.infer<TSchema> {
  return schema.parse(context.req.query());
}

export function readIdParam(context: AppContext, name = 'id'): string {
  return idSchema.parse(context.req.param(name));
}
