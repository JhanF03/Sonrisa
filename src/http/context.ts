/**
 * Tipos compartidos del contexto HTTP (Hono).
 */
import type { Context } from 'hono';
import type { SqlDatabase } from '../db/database.js';
import type { Permission } from '../security/permissions.js';
import type { AppServices } from '../services.js';

export interface AppConfig {
  /** Iteraciones de PBKDF2 (máximo 100.000 en Cloudflare Workers). */
  readonly passwordHashIterations: number;
  readonly sessionTtlHours: number;
  /** Clave para crear consultorios y demos (modo vitrina). Vacía = deshabilitado. */
  readonly platformAdminKey: string;
  /** Secreto para firmar los enlaces de las citas (mínimo 32 caracteres). */
  readonly appSecret: string;
  /** Cloudflare Turnstile (opcional). Ambos vacíos = desactivado. */
  readonly turnstileSiteKey: string;
  readonly turnstileSecretKey: string;
  readonly environment: 'production' | 'development' | 'test';
  /**
   * Confiar en X-Real-IP / X-Forwarded-For. Solo debe activarse detrás de un
   * proxy propio (Nginx, balanceador). En Cloudflare se usa CF-Connecting-IP.
   */
  readonly trustProxyHeaders: boolean;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  brand_color: string;
  logo_url: string | null;
  utc_offset_minutes: number;
  slot_interval_minutes: number;
  min_booking_notice_hours: number;
  booking_window_days: number;
  reactivation_months: number;
  online_booking_enabled: number;
  close_on_holidays: number;
  privacy_policy_version: string;
  is_showcase: number;
  created_at: string;
  whatsapp_number: string | null;
  whatsapp_reminder_template: string | null;
  online_verification_mode: 'ninguna' | 'whatsapp';
  verification_window_minutes: number;
  max_pending_online_per_patient: number;
  auto_release_hours: number;
  payment_window_minutes: number;
  paid_until: string | null;
  monthly_price: number;
  grace_days: number;
  billing_mode: 'auto' | 'exento' | 'suspendido';
  // Plan (migración 0008). enabled_modules y max_* se recalculan al cambiar de plan.
  plan_id: string;
  addon_modules: string;
  extra_professionals: number;
  extra_users: number;
  custom_price: number | null;
  enabled_modules: string;
  max_professionals: number;
  max_users: number;
  pending_plan: string | null;
  on_trial: number;
  signup_source: 'dueno' | 'registro' | 'autoservicio';
  demo_expires_at: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  converted_tenant_id: string | null;
}

/** Quién está haciendo la petición (usuario autenticado). */
export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
  tenant: TenantRow;
  permissions: ReadonlySet<Permission>;
  /** Permisos que el rol tiene pero el plan no incluye (para ofrecer mejorar el plan). */
  lockedPermissions: ReadonlySet<Permission>;
  /** Profesional vinculado al usuario (para "ver solo su propia agenda"). */
  professionalId: string | null;
}

/** Datos mínimos para auditar y aislar por consultorio. */
export interface Actor {
  tenantId: string;
  userId: string | null;
  ip: string;
}

export type AppEnv = {
  Variables: {
    db: SqlDatabase;
    config: AppConfig;
    services: AppServices;
    auth: AuthContext | undefined;
    clientIp: string;
  };
};

export type AppContext = Context<AppEnv>;

export function requireAuth(context: AppContext): AuthContext {
  const auth = context.get('auth');
  if (!auth) throw new Error('requireAuth llamado en una ruta sin autenticación');
  return auth;
}

export function actorOf(context: AppContext): Actor {
  const auth = requireAuth(context);
  return { tenantId: auth.tenant.id, userId: auth.userId, ip: context.get('clientIp') };
}
