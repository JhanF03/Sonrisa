/**
 * Rutas de plataforma (solo para ti, el dueño del software):
 * • Ingreso con correo + contraseña (+ código de app autenticadora opcional).
 *   La clave maestra PLATFORM_ADMIN_KEY solo crea la primera cuenta y
 *   recupera el acceso; también se acepta en la cabecera X-Platform-Key
 *   para automatizaciones.
 * • Panel: consultorios reales y demos, suscripciones, pagos, restablecer la
 *   clave del administrador, configuración de cobro y registro de auditoría.
 */
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { seedDemoData } from '../../modules/platform/demoDataService.js';
import { SUBSCRIPTION_PAYMENT_METHODS } from '../../modules/platform/platformService.js';
import { generateSecureToken } from '../../security/crypto.js';
import type { PlatformAdmin } from '../../modules/platform/platformAuthService.js';
import type { AppContext, AppEnv } from '../context.js';
import { AppError } from '../errors.js';
import { getSessionCookieName } from '../middleware.js';
import { defineRoutes, publicAccess } from '../routeRegistry.js';
import { faviconSchema, hexColorSchema, httpsUrlSchema, localDateSchema, moneySchema, optionalText, positiveMoneySchema, readIdParam, readJsonBody, requiredText } from '../validation.js';
import { PASSWORD_POLICY } from './authRoutes.js';
import { planSelectionSchema } from './selfServiceRoutes.js';

export const PLATFORM_KEY_HEADER = 'X-Platform-Key';

const platformCookieName = (url: string) => (new URL(url).protocol === 'https:' ? '__Host-psid' : 'psid');

const clinicBaseSchema = z.object({
  clinicName: requiredText(120, 'El nombre del consultorio'),
  city: optionalText(80),
  phone: optionalText(30),
  brandColor: hexColorSchema.default('#2742a8'),
  logoUrl: httpsUrlSchema.nullable().optional().transform((value) => value ?? null),
  favicon: faviconSchema.nullable().optional().transform((value) => value ?? null),
});

export function registerPlatformRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    // ─── Cuenta y sesión del dueño ───
    {
      method: 'GET',
      path: '/api/platform/session',
      access: publicAccess,
      handler: async (context) => {
        const platformAuth = context.get('services').platformAuth;
        const admin = await platformAuth.resolveSession(getCookie(context, platformCookieName(context.req.url)));
        return context.json({ authenticated: Boolean(admin), admin, needsSetup: !admin && !(await platformAuth.hasAdmins()) });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/setup',
      access: publicAccess,
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({ masterKey: z.string().max(300), fullName: requiredText(120, 'Tu nombre'), email: z.email('Correo inválido.').max(200), password: PASSWORD_POLICY }),
        );
        await context.get('services').platformAuth.setupFirstAdmin(input, context.get('clientIp'));
        return context.json({ ok: true }, 201);
      },
    },
    {
      method: 'POST',
      path: '/api/platform/login',
      access: publicAccess,
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            email: z.string().trim().max(200),
            password: z.string().max(200),
            code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos.').nullable().default(null),
          }),
        );
        const { token, expiresAt, admin } = await context.get('services').platformAuth.login(input, context.get('clientIp'));
        setCookie(context, platformCookieName(context.req.url), token, {
          httpOnly: true,
          secure: new URL(context.req.url).protocol === 'https:',
          sameSite: 'Strict',
          path: '/',
          expires: new Date(expiresAt),
        });
        return context.json({ ok: true, admin });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/recover',
      access: publicAccess,
      handler: async (context) => {
        const input = await readJsonBody(context, z.object({ masterKey: z.string().max(300), email: z.email('Correo inválido.').max(200), newPassword: PASSWORD_POLICY }));
        await context.get('services').platformAuth.recoverAccess(input, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/logout',
      access: publicAccess,
      handler: async (context) => {
        const cookieName = platformCookieName(context.req.url);
        await context.get('services').platformAuth.logout(getCookie(context, cookieName));
        deleteCookie(context, cookieName, { path: '/', secure: cookieName.startsWith('__Host-') });
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/account/password',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        const input = await readJsonBody(context, z.object({ currentPassword: z.string().max(200), newPassword: PASSWORD_POLICY }));
        await context
          .get('services')
          .platformAuth.changePassword(admin.id, input.currentPassword, input.newPassword, getCookie(context, platformCookieName(context.req.url)), context.get('clientIp'));
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/account/2fa/start',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        return context.json(await context.get('services').platformAuth.startTwoFactor(admin.id));
      },
    },
    {
      method: 'POST',
      path: '/api/platform/account/2fa/confirm',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        const { code } = await readJsonBody(context, z.object({ code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos.') }));
        await context.get('services').platformAuth.confirmTwoFactor(admin.id, code, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/account/2fa/disable',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        const { password } = await readJsonBody(context, z.object({ password: z.string().max(200) }));
        await context.get('services').platformAuth.disableTwoFactor(admin.id, password, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/platform/admins',
      access: publicAccess,
      handler: async (context) => {
        await requirePlatformAdmin(context);
        return context.json(await context.get('services').platformAuth.listAdmins());
      },
    },
    {
      method: 'POST',
      path: '/api/platform/admins',
      access: publicAccess,
      handler: async (context) => {
        await requirePlatformAdmin(context);
        const input = await readJsonBody(context, z.object({ fullName: requiredText(120, 'El nombre'), email: z.email('Correo inválido.').max(200), password: PASSWORD_POLICY }));
        return context.json(await context.get('services').platformAuth.createAdmin(input, context.get('clientIp')), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/admins/:id/active',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        const { isActive } = await readJsonBody(context, z.object({ isActive: z.boolean() }));
        await context.get('services').platformAuth.setAdminActive(admin.id, readIdParam(context), isActive, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },

    // ─── Panel ───
    {
      method: 'GET',
      path: '/api/platform/summary',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.getSummary());
      },
    },
    {
      method: 'GET',
      path: '/api/platform/tenants',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.listTenants());
      },
    },
    {
      method: 'GET',
      path: '/api/platform/tenants/:id/payments',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.listPayments(readIdParam(context)));
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/tenants/:id/subscription',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const input = await readJsonBody(
          context,
          z.object({
            selection: planSelectionSchema,
            customPrice: moneySchema.max(100_000_000).nullable(),
            graceDays: z.number().int().min(0).max(60),
            billingMode: z.enum(['auto', 'exento', 'suspendido']),
            paidUntil: localDateSchema.nullable(),
            ownerNotes: optionalText(1000),
          }),
        );
        return context.json(await context.get('services').platform.updateSubscription(readIdParam(context), input, who));
      },
    },
    {
      method: 'POST',
      path: '/api/platform/tenants/:id/payments',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const input = await readJsonBody(
          context,
          z.object({
            amount: positiveMoneySchema.max(1_000_000_000),
            months: z.number().int().min(1).max(24),
            method: z.enum(SUBSCRIPTION_PAYMENT_METHODS),
            reference: optionalText(80),
            notes: optionalText(300),
          }),
        );
        const platform = context.get('services').platform;
        const tenantId = readIdParam(context);
        await platform.registerPayment(tenantId, input, who);
        return context.json(await platform.getTenantOverview(tenantId), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/platform/subscription-payments/:id/void',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const { reason } = await readJsonBody(context, z.object({ reason: requiredText(200, 'El motivo') }));
        await context.get('services').platform.voidPayment(readIdParam(context), reason, who);
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/platform/tenants/:id/demo-session',
      access: publicAccess,
      handler: async (context) => {
        const admin = await requirePlatformAdmin(context);
        const session = await context
          .get('services')
          .platform.createDemoSession(readIdParam(context), context.get('clientIp'), context.req.header('User-Agent') ?? '', admin.id);
        // Sesión normal del panel del consultorio (la misma cookie que al ingresar con usuario y contraseña).
        setCookie(context, getSessionCookieName(context.req.url), session.token, {
          httpOnly: true,
          secure: new URL(context.req.url).protocol === 'https:',
          sameSite: 'Strict',
          path: '/',
          expires: new Date(session.expiresAt),
        });
        return context.json({ ok: true, panelUrl: '/app' });
      },
    },
    {
      method: 'DELETE',
      path: '/api/platform/tenants/:id',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        await context.get('services').platform.deleteDemo(readIdParam(context), who, 'dueno');
        return context.json({ ok: true });
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/tenants/:id/demo-expiry',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const { days } = await readJsonBody(context, z.object({ days: z.number().int().min(1).max(365).nullable() }));
        const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
        return context.json(await context.get('services').platform.setDemoExpiry(readIdParam(context), expiresAt, who));
      },
    },
    {
      method: 'GET',
      path: '/api/platform/plans',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').plans.getCatalog());
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/plans',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const money = moneySchema.max(100_000_000);
        const input = await readJsonBody(
          context,
          z.object({
            plans: z.array(z.object({
              id: z.string().max(40),
              name: requiredText(40, 'El nombre del plan'),
              description: z.string().trim().max(300).default(''),
              monthlyPrice: money,
              maxProfessionals: z.number().int().min(1).max(500),
              maxUsers: z.number().int().min(1).max(1000),
              modules: z.array(z.enum(['finanzas', 'inventario', 'facturacion', 'auditoria'])).max(4),
              sortOrder: z.number().int().min(0).max(100),
              isActive: z.boolean(),
            })).min(1).max(10),
            addons: z.array(z.object({
              id: z.enum(['finanzas', 'inventario', 'facturacion', 'auditoria', 'profesional', 'usuario']),
              name: requiredText(60, 'El nombre del adicional'),
              monthlyPrice: money,
              isActive: z.boolean(),
            })).max(6),
            annualFreeMonths: z.number().int().min(0).max(6),
          }),
        );
        return context.json(await context.get('services').plans.saveCatalog(input, who));
      },
    },
    {
      method: 'POST',
      path: '/api/platform/tenants/:id/reset-admin-password',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        return context.json(await context.get('services').platform.resetAdminPassword(readIdParam(context), who));
      },
    },
    {
      method: 'GET',
      path: '/api/platform/settings',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        const platform = context.get('services').platform;
        const [settings, defaults] = await Promise.all([platform.getSettings(), platform.getDefaults()]);
        return context.json({ ...settings, webhookUrl: `${new URL(context.req.url).origin}/api/webhooks/wompi-plataforma`, defaults });
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/settings',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const optionalSecret = z.string().trim().max(300).nullable().default(null).transform((value) => value || null);
        const input = await readJsonBody(
          context,
          z.object({
            ownerName: optionalText(120),
            ownerWhatsapp: optionalText(30),
            paymentInstructions: optionalText(2000),
            defaultMonthlyPrice: moneySchema.max(100_000_000).default(0),
            defaultGraceDays: z.number().int().min(0).max(60),
            defaultTrialDays: z.number().int().min(0).max(365),
            wompiEnvironment: z.enum(['sandbox', 'production']).nullable(),
            wompiPublicKey: optionalSecret,
            wompiIntegritySecret: optionalSecret,
            wompiEventsSecret: optionalSecret,
            // Opcionales: si no llegan, se conserva lo guardado.
            demoDays: z.number().int().min(1).max(60).optional(),
            selfSignupEnabled: z.boolean().optional(),
            selfDemoEnabled: z.boolean().optional(),
            maxSelfDemos: z.number().int().min(0).max(500).optional(),
          }),
        );
        return context.json(await context.get('services').platform.saveSettings(input, who));
      },
    },
    {
      method: 'POST',
      path: '/api/platform/settings/test-wompi',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.testWompi());
      },
    },
    // ─── Correo (Gmail del dueño) ───
    {
      method: 'GET',
      path: '/api/platform/settings/mail',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').mail.getSettings());
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/settings/mail',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const input = await readJsonBody(
          context,
          z.object({
            smtpUser: z.email('Correo de Gmail inválido.').max(200).nullable(),
            // Contraseña de aplicación de Google: 16 letras (se aceptan con espacios). Vacía = conservar la guardada.
            smtpPassword: z.string().trim().max(64).nullable().default(null).transform((value) => value || null)
              .refine((value) => value === null || /^[a-z]{16}$/i.test(value.replace(/\s+/g, '')), 'La contraseña de aplicación de Google tiene 16 letras.'),
            smtpFromName: optionalText(80),
            notifyOwner: z.boolean().default(true),
          }),
        );
        const services = context.get('services');
        const saved = await services.mail.saveSettings(input);
        await services.platform.recordAudit('configuracion_correo', null, { smtpUser: input.smtpUser, passwordChanged: Boolean(input.smtpPassword) }, who);
        return context.json(saved);
      },
    },
    {
      method: 'POST',
      path: '/api/platform/settings/mail/test',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        const { to } = await readJsonBody(context, z.object({ to: z.email('Correo inválido.').max(200) }));
        await context.get('services').mail.sendTest(to);
        return context.json({ message: `Correo de prueba enviado a ${to}.` });
      },
    },
    {
      method: 'GET',
      path: '/api/platform/email-log',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').mail.listLog(200));
      },
    },

    // ─── Datos legales y tributarios ───
    {
      method: 'GET',
      path: '/api/platform/settings/legal',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.getLegalSettings());
      },
    },
    {
      method: 'PUT',
      path: '/api/platform/settings/legal',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const input = await readJsonBody(
          context,
          z.object({
            legalName: optionalText(120),
            legalId: optionalText(30),
            legalCity: optionalText(80),
            legalEmail: z.email('Correo inválido.').max(200).nullable(),
            taxRegime: z.enum(['no_responsable_iva', 'responsable_iva']),
            uvtValue: z.number().int().min(10_000).max(1_000_000),
            publicUrl: httpsUrlSchema.nullable(),
          }),
        );
        const services = context.get('services');
        const saved = await services.platform.saveLegalSettings(input, who);
        services.mail.forgetCachedSettings(); // El correo de contacto se usa como "Responder a".
        return context.json(saved);
      },
    },
    {
      method: 'GET',
      path: '/api/platform/subscription-payments/:id/receipt',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.getReceipt(readIdParam(context)));
      },
    },
    {
      method: 'POST',
      path: '/api/platform/subscription-payments/:id/resend',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        const services = context.get('services');
        await services.notifications.paymentReceived(readIdParam(context));
        return context.json({ message: 'Comprobante reenviado (revisa el registro de correos).' });
      },
    },
    {
      method: 'GET',
      path: '/api/platform/audit',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatform(context);
        return context.json(await context.get('services').platform.listAudit());
      },
    },

    // ─── Crear consultorios ───
    {
      method: 'POST',
      path: '/api/platform/showcase',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const input = await readJsonBody(context, clinicBaseSchema.extend({ expiresInDays: z.number().int().min(1).max(365).nullable().default(null) }));
        const services = context.get('services');

        const demoPassword = `Demo-${generateSecureToken(9)}1`;
        const demoEmail = `demo-${generateSecureToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}@vitrina.agenda`;
        const { tenantId, slug, adminUserId } = await services.tenants.createTenant(
          { name: input.clinicName, city: input.city, phone: input.phone, brandColor: input.brandColor, logoUrl: input.logoUrl, favicon: input.favicon, isShowcase: true },
          { fullName: 'Administrador demo', email: demoEmail, passwordHash: await services.auth.hashNewPassword(demoPassword) },
        );
        const tenant = await services.tenants.getById(tenantId);
        await seedDemoData(context.get('db'), tenantId, tenant.utc_offset_minutes, adminUserId);
        await services.platform.auditClinicCreated(tenantId, 'demo', who);
        if (input.expiresInDays) {
          await services.platform.setDemoExpiry(tenantId, new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(), who);
        }

        const origin = new URL(context.req.url).origin;
        return context.json({ slug, bookingUrl: `${origin}/c/${slug}`, panelUrl: `${origin}/app`, login: { email: demoEmail, password: demoPassword } }, 201);
      },
    },
    {
      method: 'POST',
      path: '/api/platform/clinics',
      access: publicAccess,
      handler: async (context) => {
        const who = await assertPlatform(context);
        const services = context.get('services');
        const defaults = await services.platform.getDefaults();
        const input = await readJsonBody(
          context,
          clinicBaseSchema.extend({
            adminFullName: requiredText(120, 'El nombre del administrador'),
            adminEmail: z.email('Correo inválido.').max(200),
            adminPassword: PASSWORD_POLICY,
            planId: z.string().max(40).default('completo'),
            customPrice: moneySchema.max(100_000_000).nullable().default(null),
            graceDays: z.number().int().min(0).max(60).default(defaults.graceDays),
            paidUntil: localDateSchema.default(defaults.trialUntil),
          }),
        );
        const resolved = await services.plans.resolve({ planId: input.planId, addonModules: [], extraProfessionals: 0, extraUsers: 0 }, { allowInactivePlan: true });
        const { slug, tenantId } = await services.tenants.createTenant(
          {
            name: input.clinicName, city: input.city, phone: input.phone, brandColor: input.brandColor, logoUrl: input.logoUrl, favicon: input.favicon,
            paidUntil: input.paidUntil, monthlyPrice: input.customPrice ?? resolved.monthlyPrice, graceDays: input.graceDays,
          },
          { fullName: input.adminFullName, email: input.adminEmail, passwordHash: await services.auth.hashNewPassword(input.adminPassword) },
        );
        await services.platform.setInitialPlan(tenantId, resolved, input.customPrice);
        await services.platform.auditClinicCreated(tenantId, 'real', who);
        const origin = new URL(context.req.url).origin;
        return context.json({ slug, bookingUrl: `${origin}/c/${slug}`, panelUrl: `${origin}/app`, paidUntil: input.paidUntil }, 201);
      },
    },
  ]);
}

/** Exige una sesión de dueño válida (cookie). */
async function requirePlatformAdmin(context: AppContext): Promise<PlatformAdmin> {
  const admin = await context.get('services').platformAuth.resolveSession(getCookie(context, platformCookieName(context.req.url)));
  if (!admin) throw new AppError('Ingresa a la plataforma con tu correo y contraseña.', 401, 'PLATFORM_LOGIN_REQUIRED');
  return admin;
}

/**
 * Acceso a las operaciones del panel: sesión de dueño, o la clave maestra en
 * la cabecera X-Platform-Key (solo para automatizaciones y scripts).
 */
async function assertPlatform(context: AppContext): Promise<{ ip: string; adminId: string | null }> {
  const platformAuth = context.get('services').platformAuth;
  const ip = context.get('clientIp');
  const admin = await platformAuth.resolveSession(getCookie(context, platformCookieName(context.req.url)));
  if (admin) return { ip, adminId: admin.id };
  const headerKey = context.req.header(PLATFORM_KEY_HEADER);
  if (headerKey !== undefined) {
    await platformAuth.assertMasterKey(headerKey, ip);
    return { ip, adminId: null }; // Automatización con la clave maestra.
  }
  throw new AppError('Ingresa a la plataforma con tu correo y contraseña.', 401, 'PLATFORM_LOGIN_REQUIRED');
}
