/**
 * Alcance de datos según permisos: un odontólogo con "ver solo su agenda"
 * únicamente puede ver y modificar las citas de su propio perfil profesional.
 */
import type { AuthContext } from './context.js';

/** Id de profesional que no existe: hace que la consulta no devuelva nada. */
const NO_PROFESSIONAL = '00000000-0000-0000-0000-000000000000';

/**
 * Devuelve undefined si el usuario puede ver todas las agendas, o el id del
 * profesional al que debe restringirse.
 */
export function agendaRestriction(auth: AuthContext): string | undefined {
  if (auth.permissions.has('agenda.ver_todas')) return undefined;
  return auth.professionalId ?? NO_PROFESSIONAL;
}
