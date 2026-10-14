/**
 * Fragmentos SQL compartidos. Existen para que la regla "esta cita ocupa el
 * horario" sea EXACTAMENTE la misma en todo el sistema y en los triggers de
 * la base de datos (migración 0002). Si cambias la regla, cámbiala en ambos.
 */

/** Hora actual de la base de datos en UTC ISO 8601 (mismo formato que toISOString()). */
export const SQL_NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Una cita ocupa su horario si no está cancelada y su retención (si la tiene)
 * no ha vencido. Las retenciones vencidas liberan el cupo al instante.
 */
export function occupiesSlot(alias: string): string {
  return `${alias}.status <> 'cancelada' AND (${alias}.hold_expires_at IS NULL OR ${alias}.hold_expires_at > ${SQL_NOW_UTC})`;
}

/** Texto que lanzan los triggers cuando detectan un cruce de horario. */
export const SLOT_TAKEN_DB_ERROR = 'HORARIO_OCUPADO';

export function isSlotTakenError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SLOT_TAKEN_DB_ERROR);
}
