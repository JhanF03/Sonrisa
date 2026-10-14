/**
 * Consultorios (tenants): datos, reglas de agenda y aprovisionamiento.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor, TenantRow } from '../../http/context.js';
import { AppError, conflict, notFound } from '../../http/errors.js';
import { DEFAULT_ROLES } from '../../security/permissions.js';
import { addDays, isoNow, todayLocal } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';

export interface TenantSettingsInput {
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  brandColor: string;
  logoUrl: string | null;
  slotIntervalMinutes: number;
  minBookingNoticeHours: number;
  bookingWindowDays: number;
  reactivationMonths: number;
  onlineBookingEnabled: boolean;
  closeOnHolidays: boolean;
}

export interface BookingRulesInput {
  onlineVerificationMode: 'ninguna' | 'whatsapp';
  verificationWindowMinutes: number;
  maxPendingOnlinePerPatient: number;
  autoReleaseHours: number;
  paymentWindowMinutes: number;
}

export interface WhatsappSettingsInput {
  whatsappNumber: string | null;
  reminderTemplate: string | null;
}

export interface NewTenantInput {
  name: string;
  slug?: string;
  city?: string | null;
  phone?: string | null;
  brandColor?: string;
  logoUrl?: string | null;
  isShowcase?: boolean;
  /** Suscripción (solo consultorios reales). */
  paidUntil?: string | null;
  monthlyPrice?: number;
  graceDays?: number;
  billingMode?: 'auto' | 'exento';
}

/** Si no se indica, un consultorio real arranca con 30 días cubiertos. */
const DEFAULT_INITIAL_DAYS = 30;

export interface NewAdminInput {
  fullName: string;
  email: string;
  passwordHash: string;
}

export class TenantService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly audit: AuditService,
  ) {}

  async getBySlug(slug: string): Promise<TenantRow | null> {
    return this.db.prepare('SELECT * FROM tenants WHERE slug = ?').bind(slug).first<TenantRow>();
  }

  async getById(tenantId: string): Promise<TenantRow> {
    const tenant = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first<TenantRow>();
    if (!tenant) throw notFound('El consultorio');
    return tenant;
  }

  async updateSettings(actor: Actor, input: TenantSettingsInput): Promise<TenantRow> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE tenants SET name = ?, phone = ?, address = ?, city = ?, brand_color = ?, logo_url = ?,
             slot_interval_minutes = ?, min_booking_notice_hours = ?, booking_window_days = ?,
             reactivation_months = ?, online_booking_enabled = ?, close_on_holidays = ?
           WHERE id = ?`,
        )
        .bind(
          input.name, input.phone, input.address, input.city, input.brandColor, input.logoUrl,
          input.slotIntervalMinutes, input.minBookingNoticeHours, input.bookingWindowDays,
          input.reactivationMonths, input.onlineBookingEnabled ? 1 : 0, input.closeOnHolidays ? 1 : 0,
          actor.tenantId,
        ),
      this.audit.buildStatement(actor, { action: 'configuracion_actualizada', entity: 'consultorio', entityId: actor.tenantId }),
    ]);
    return this.getById(actor.tenantId);
  }

  async updateBookingRules(actor: Actor, input: BookingRulesInput): Promise<TenantRow> {
    const tenant = await this.getById(actor.tenantId);
    if (input.onlineVerificationMode === 'whatsapp' && !tenant.whatsapp_number) {
      throw new AppError('Para verificar por WhatsApp primero configura el número de WhatsApp del consultorio.', 422, 'WHATSAPP_REQUIRED');
    }
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE tenants SET online_verification_mode = ?, verification_window_minutes = ?, max_pending_online_per_patient = ?,
             auto_release_hours = ?, payment_window_minutes = ?
           WHERE id = ?`,
        )
        .bind(
          input.onlineVerificationMode, input.verificationWindowMinutes, input.maxPendingOnlinePerPatient,
          input.autoReleaseHours, input.paymentWindowMinutes, actor.tenantId,
        ),
      this.audit.buildStatement(actor, { action: 'reglas_reserva_actualizadas', entity: 'consultorio', entityId: actor.tenantId, details: { ...input } }),
    ]);
    return this.getById(actor.tenantId);
  }

  async updateWhatsappSettings(actor: Actor, input: WhatsappSettingsInput): Promise<TenantRow> {
    const tenant = await this.getById(actor.tenantId);
    if (!input.whatsappNumber && tenant.online_verification_mode === 'whatsapp') {
      throw new AppError('No puedes quitar el número mientras la verificación por WhatsApp esté activa.', 422, 'WHATSAPP_REQUIRED');
    }
    await this.db.batch([
      this.db
        .prepare('UPDATE tenants SET whatsapp_number = ?, whatsapp_reminder_template = ? WHERE id = ?')
        .bind(input.whatsappNumber, input.reminderTemplate, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'whatsapp_actualizado', entity: 'consultorio', entityId: actor.tenantId }),
    ]);
    return this.getById(actor.tenantId);
  }

  /**
   * Crea un consultorio con sus roles por defecto y su usuario administrador.
   * Todo en un solo batch atómico.
   */
  async createTenant(tenantInput: NewTenantInput, adminInput: NewAdminInput): Promise<{ tenantId: string; slug: string; adminUserId: string }> {
    const existingUser = await this.db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(adminInput.email.toLowerCase())
      .first();
    if (existingUser) throw conflict('Ya existe un usuario con ese correo.');

    const tenantId = crypto.randomUUID();
    const adminUserId = crypto.randomUUID();
    const slug = await this.buildUniqueSlug(tenantInput.slug ?? tenantInput.name);
    const now = isoNow();

    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `INSERT INTO tenants (id, slug, name, city, phone, brand_color, logo_url, is_showcase, paid_until, monthly_price, grace_days, billing_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tenantId, slug, tenantInput.name, tenantInput.city ?? null, tenantInput.phone ?? null,
          tenantInput.brandColor ?? '#3f6f68', tenantInput.logoUrl ?? null, tenantInput.isShowcase ? 1 : 0,
          tenantInput.isShowcase ? null : (tenantInput.paidUntil ?? addDays(todayLocal(-300), DEFAULT_INITIAL_DAYS)),
          tenantInput.monthlyPrice ?? 0, tenantInput.graceDays ?? 3, tenantInput.billingMode ?? 'auto', now,
        ),
      this.db
        .prepare(
          `INSERT INTO users (id, tenant_id, email, full_name, password_hash, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(adminUserId, tenantId, adminInput.email.toLowerCase(), adminInput.fullName, adminInput.passwordHash, now),
      this.db.prepare("INSERT INTO counters (tenant_id, name, value) VALUES (?, 'recibo_caja', 0)").bind(tenantId),
      this.db.prepare("INSERT INTO counters (tenant_id, name, value) VALUES (?, 'insumo', 0)").bind(tenantId),
    ];

    for (const roleTemplate of DEFAULT_ROLES) {
      const roleId = crypto.randomUUID();
      statements.push(
        this.db
          .prepare('INSERT INTO roles (id, tenant_id, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(roleId, tenantId, roleTemplate.name, roleTemplate.description, roleTemplate.isSystem ? 1 : 0, now),
      );
      for (const permission of roleTemplate.permissions) {
        statements.push(
          this.db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(roleId, permission),
        );
      }
      if (roleTemplate.isSystem) {
        statements.push(this.db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(adminUserId, roleId));
      }
    }

    statements.push(
      this.audit.buildStatement(
        { tenantId, userId: adminUserId, ip: 'sistema' },
        { action: 'consultorio_creado', entity: 'consultorio', entityId: tenantId, details: { slug } },
      ),
    );

    await this.db.batch(statements);
    return { tenantId, slug, adminUserId };
  }

  private async buildUniqueSlug(source: string): Promise<string> {
    const baseSlug =
      source
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40) || 'consultorio';

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${Math.floor(1000 + Math.random() * 9000)}`;
      const taken = await this.db.prepare('SELECT 1 FROM tenants WHERE slug = ?').bind(candidate).first();
      if (!taken) return candidate;
    }
    return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
  }
}
