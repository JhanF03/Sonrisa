/**
 * Rutas de plataforma (solo para ti, el proveedor del software):
 * • Crear un consultorio real para un cliente nuevo.
 * • Modo vitrina: crear en segundos una demo personalizada para un prospecto.
 *
 * Protegidas con la clave PLATFORM_ADMIN_KEY (secreto de Cloudflare / .env),
 * comparada en tiempo constante y con límite de intentos por IP.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { seedDemoData } from '../../modules/platform/demoDataService.js';
import { constantTimeEqualText, generateSecureToken } from '../../security/crypto.js';
import { RATE_LIMIT_RULES } from '../../security/rateLimiter.js';
import type { AppContext, AppEnv } from '../context.js';
import { AppError } from '../errors.js';
import { defineRoutes, publicAccess } from '../routeRegistry.js';
import { hexColorSchema, httpsUrlSchema, optionalText, readJsonBody, requiredText } from '../validation.js';
import { PASSWORD_POLICY } from './authRoutes.js';

export const PLATFORM_KEY_HEADER = 'X-Platform-Key';
const MIN_PLATFORM_KEY_LENGTH = 24;

const clinicBaseSchema = z.object({
  clinicName: requiredText(120, 'El nombre del consultorio'),
  city: optionalText(80),
  phone: optionalText(30),
  brandColor: hexColorSchema.default('#3f6f68'),
  logoUrl: httpsUrlSchema.nullable().optional().transform((value) => value ?? null),
});

export function registerPlatformRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'POST',
      path: '/api/platform/showcase',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatformKey(context);
        const input = await readJsonBody(context, clinicBaseSchema);
        const services = context.get('services');

        const demoPassword = `Demo-${generateSecureToken(9)}1`;
        const demoEmail = `demo-${generateSecureToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}@vitrina.agenda`;
        const { tenantId, slug, adminUserId } = await services.tenants.createTenant(
          { name: input.clinicName, city: input.city, phone: input.phone, brandColor: input.brandColor, logoUrl: input.logoUrl, isShowcase: true },
          { fullName: 'Administrador demo', email: demoEmail, passwordHash: await services.auth.hashNewPassword(demoPassword) },
        );
        const tenant = await services.tenants.getById(tenantId);
        await seedDemoData(context.get('db'), tenantId, tenant.utc_offset_minutes, adminUserId);

        const origin = new URL(context.req.url).origin;
        return context.json(
          {
            slug,
            bookingUrl: `${origin}/c/${slug}`,
            panelUrl: `${origin}/app`,
            login: { email: demoEmail, password: demoPassword },
          },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/api/platform/clinics',
      access: publicAccess,
      handler: async (context) => {
        await assertPlatformKey(context);
        const input = await readJsonBody(
          context,
          clinicBaseSchema.extend({
            adminFullName: requiredText(120, 'El nombre del administrador'),
            adminEmail: z.email('Correo inválido.').max(200),
            adminPassword: PASSWORD_POLICY,
          }),
        );
        const services = context.get('services');
        const { slug } = await services.tenants.createTenant(
          { name: input.clinicName, city: input.city, phone: input.phone, brandColor: input.brandColor, logoUrl: input.logoUrl },
          {
            fullName: input.adminFullName,
            email: input.adminEmail,
            passwordHash: await services.auth.hashNewPassword(input.adminPassword),
          },
        );
        const origin = new URL(context.req.url).origin;
        return context.json({ slug, bookingUrl: `${origin}/c/${slug}`, panelUrl: `${origin}/app` }, 201);
      },
    },
  ]);
}

async function assertPlatformKey(context: AppContext): Promise<void> {
  await context.get('services').rateLimiter.consume(`platform:${context.get('clientIp')}`, RATE_LIMIT_RULES.platformPerIp);

  const configuredKey = context.get('config').platformAdminKey;
  if (configuredKey.length < MIN_PLATFORM_KEY_LENGTH) {
    throw new AppError('La plataforma no está habilitada en este servidor.', 403, 'PLATFORM_DISABLED');
  }
  const providedKey = context.req.header(PLATFORM_KEY_HEADER) ?? '';
  if (!(await constantTimeEqualText(providedKey, configuredKey))) {
    throw new AppError('Clave de plataforma incorrecta.', 403, 'PLATFORM_FORBIDDEN');
  }
}
