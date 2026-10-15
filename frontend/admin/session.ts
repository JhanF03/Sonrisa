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
    favicon: string | null;
    isShowcase: boolean;
    utcOffsetMinutes: number;
  };
  subscription: SubscriptionStatus & { monthlyPrice: number; onTrial: boolean };
  plan: { id: string; modules: string[]; lockedPermissions: string[] };
  /** Solo en demos: vencimiento, usuario para volver a entrar y si ya creó su consultorio. */
  demo: { expiresAt: string | null; loginEmail: string; convertedTenantId: string | null } | null;
}

let currentSession: SessionInfo | null = null;
let permissionSet = new Set<string>();
let lockedSet = new Set<string>();

export async function loadSession(): Promise<SessionInfo | null> {
  try {
    currentSession = await api.get<SessionInfo>('/api/auth/me');
    permissionSet = new Set(currentSession.permissions);
    lockedSet = new Set(currentSession.plan.lockedPermissions);
    return currentSession;
  } catch {
    currentSession = null;
    permissionSet = new Set();
    lockedSet = new Set();
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

/** true si el rol lo permite pero el plan del consultorio no lo incluye. */
export function lockedByPlan(...permissions: string[]): boolean {
  return !can(...permissions) && permissions.some((permission) => lockedSet.has(permission));
}

export function clinicOffset(): number {
  return currentSession?.clinic.utcOffsetMinutes ?? -300;
}
