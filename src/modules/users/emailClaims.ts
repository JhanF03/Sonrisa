/**
 * Los correos de usuario son únicos en todo el sistema (con el correo se
 * ingresa). Para que nadie "ocupe" el correo de otra persona creando usuarios
 * dentro de una demo, un correo usado solo en una DEMO se libera cuando
 * alguien lo necesita para una cuenta real: al usuario de la demo se le
 * asigna un correo interno de demo.
 */
import type { SqlDatabase } from '../../db/database.js';
import { AppError, conflict } from '../../http/errors.js';
import { generateSecureToken } from '../../security/crypto.js';

/** Dominio interno de los usuarios de demo: nadie puede registrarse con él. */
export const DEMO_EMAIL_DOMAIN = '@vitrina.agenda';

export function assertNotDemoDomain(email: string): void {
  if (email.trim().toLowerCase().endsWith(DEMO_EMAIL_DOMAIN)) {
    throw new AppError('Ese correo es interno de las demos. Usa tu correo real.', 422, 'RESERVED_EMAIL');
  }
}

/**
 * Deja el correo disponible para una cuenta nueva.
 * @param forShowcase true si la cuenta nueva es de una demo (no libera correos de otras demos).
 */
export async function claimEmail(db: SqlDatabase, email: string, forShowcase: boolean): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .prepare('SELECT u.id, t.is_showcase FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?')
    .bind(normalized)
    .first<{ id: string; is_showcase: number }>();
  if (!existing) return;
  if (existing.is_showcase === 1 && !forShowcase) {
    const replacement = `liberado-${generateSecureToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}${DEMO_EMAIL_DOMAIN}`;
    await db.prepare('UPDATE users SET email = ? WHERE id = ? AND email = ?').bind(replacement, existing.id, normalized).run();
    return;
  }
  throw conflict('Ya existe un usuario con ese correo.');
}
