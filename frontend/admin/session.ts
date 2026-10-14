/**
 * Estado de la sesión en el navegador: usuario, consultorio y permisos.
 * Los permisos aquí solo deciden qué se MUESTRA; el servidor los vuelve a
 * validar en cada petición.
 */
import { api } from '../core/api.js';
import type { SubscriptionStatus } from '../../src/shared/subscription.js';

export interface SessionInfo {
  user: { id: string; email: string; fullName: string; professionalId: string | null };
  permissions: string[];
  clinic: {
    id: string;
    slug: string;
    name: string;
    brandColor: string;
    logoUrl: string | null;
    isShowcase: boolean;
    utcOffsetMinutes: number;
  };
  subscription: SubscriptionStatus & { monthlyPrice: number };
}

let currentSession: SessionInfo | null = null;
let permissionSet = new Set<string>();

export async function loadSession(): Promise<SessionInfo | null> {
  try {
    currentSession = await api.get<SessionInfo>('/api/auth/me');
    permissionSet = new Set(currentSession.permissions);
    return currentSession;
  } catch {
    currentSession = null;
    permissionSet = new Set();
    return null;
  }
}

export function session(): SessionInfo {
  if (!currentSession) throw new Error('No hay sesión activa');
  return currentSession;
}

/** true si el usuario tiene AL MENOS uno de los permisos indicados. */
export function can(...permissions: string[]): boolean {
  return permissions.some((permission) => permissionSet.has(permission));
}

export function clinicOffset(): number {
  return currentSession?.clinic.utcOffsetMinutes ?? -300;
}
