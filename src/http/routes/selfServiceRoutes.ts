/**
 * Autogestión (sin intervención del dueño del software):
 *  • /registro muestra planes y precios (GET /api/public/offer).
 *  • Demo con datos de ejemplo que dura N días (POST /api/public/demo).
 *  • Consultorio real con prueba gratis y el plan elegido (POST /api/public/signup).
 *    Si se crea desde una demo, la demo sigue abierta solo 24 horas más.
 *  • Cambio de plan desde el panel del consultorio (POST /api/subscription/plan).
 *  • Correos automáticos: bienvenida, datos de la demo y aviso al dueño.
 *  • Textos legales públicos (GET /api/public/legal) para /legal/terminos y /legal/privacidad.
 *
 * Protecciones: límite de intentos por IP, campo trampa para robots,
 * Cloudflare Turnstile si está configurado y un cupo de demos activas.
 */
import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { seedDemoData } from '../../modules/platform/demoDataService.js';
import { generateSecureToken } from '../../security/crypto.js';
import type { RateLimitRule } from '../../security/rateLimiter.js';
import { taxNotice } from '../../shared/legal.js';
import { ALL_PLAN_MODULES, MAX_EXTRA_SEATS } from '../../shared/plans.js';
import { requireAuth, type AppContext, type AppEnv } from '../context.js';
import { AppError } from '../errors.js';
import { getSessionCookieName } from '../middleware.js';
import { defineRoutes, publicAccess, requiresAny } from '../routeRegistry.js';
import { faviconSchema, optionalText, readJsonBody, requiredText } from '../validation.js';
import { PASSWORD_POLICY } from './authRoutes.js';

export const planSelectionSchema = z.object({
  planId: z.string().min(1).max(40),
  addonModules: z.array(z.enum(ALL_PLAN_MODULES as [string, ...string[]])).max(ALL_PLAN_MODULES.length).default([]),
  extraProfessionals: z.number().int().min(0).max(MAX_EXTRA_SEATS).default(0),
  extraUsers: z.number().int().min(0).max(MAX_EXTRA_SEATS).default(0),
}).transform((value) => ({ ...value, addonModules: value.addonModules as (typeof ALL_PLAN_MODULES)[number][] }));

const SELF_DEMO_PER_IP: RateLimitRule = { limit: 3, windowMs: 24 * 3_600_000, message: 'Ya creaste varias demos hoy. Intenta mañana o crea tu consultorio con la prueba gratis.' };
const SIGNUP_PER_IP: RateLimitRule = { limit: 5, windowMs: 60 * 60_000, message: 'Demasiados registros seguidos. Espera una hora.' };

const contactSchema = {
  fullName: requiredText(120, 'Tu nombre'),
  email: z.email('Correo inválido.').max(200),
  phone: optionalText(30),
  password: PASSWORD_POLICY,
  /** Campo trampa: las personas no lo ven; si llega con texto, es un robot. */
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(2048).optional(),
};

/** Deja la sesión del panel del consultorio (misma cookie que al ingresar). */
export function setClinicSessionCookie(context: AppContext, session: { token: string; expiresAt: number }): void {
  setCookie(context, getSessionCookieName(context.req.url), session.token, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    expires: new Date(session.expiresAt),
  });
}

function assertNotRobot(website: string | undefined): void {
  if (website) throw new AppError('No pudimos completar el registro.', 400, 'BOT_DETECTED');
}

export function registerSelfServiceRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/public/legal',
      access: publicAccess,
      handler: async (context) => {
        const legal = await context.get('services').platform.getLegalInfo();
        return context.json({ ...legal, taxNotice: taxNotice(legal) });
      },
    },
    {
      method: 'GET',
      path: '/api/public/offer',
      access: publicAccess,
      handler: async (context) => {
        const offer = await context.get('services').platform.getPublicOffer();
        const auth = context.get('auth');
        return context.json({
          ...offer,
          turnstileSiteKey: context.get('config').turnstileSiteKey || null,
          // Quien llega desde su demo: se le recuerda que la demo sigue 24 h tras registrarse.
          fromDemo: auth?.tenant.is_showcase === 1 && auth.tenant.signup_source === 'autoservicio'
            ? { clinicName: auth.tenant.name, contactName: auth.tenant.contact_name, contactEmail: auth.tenant.contact_email, contactPhone: auth.tenant.contact_phone }
            : null,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/public/demo',
      access: publicAccess,
      handler: async (context) => {
        const services = context.get('services');
        const clientIp = context.get('clientIp');
        const input = await readJsonBody(
          context,
          z.object({ ...contactSchema, clinicName: optionalText(120), acceptTerms: z.literal(true, { error: 'Debes aceptar los términos y la política de datos.' }) }),
        );
        assertNotRobot(input.website);
        await services.turnstile.assertHuman(input.turnstileToken, clientIp);
        const { demoDays } = await services.platform.assertSelfDemoAllowed(input.email);
        await services.rateLimiter.consume(`selfdemo:${clientIp}`, SELF_DEMO_PER_IP);

        const loginEmail = `demo-${generateSecureToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}@vitrina.agenda`;
        const { tenantId, adminUserId } = await services.tenants.createTenant(
          { name: input.clinicName ?? `Consultorio de ${input.fullName.split(' ')[0]}`, phone: input.phone, isShowcase: true },
          { fullName: input.fullName, email: loginEmail, passwordHash: await services.auth.hashNewPassword(input.password) },
        );
        const tenant = await services.tenants.getById(tenantId);
        await seedDemoData(context.get('db'), tenantId, tenant.utc_offset_minutes, adminUserId);
        const expiresAt = await services.platform.markSelfDemo(tenantId, { name: input.fullName, email: input.email, phone: input.phone }, demoDays, clientIp);
        setClinicSessionCookie(context, await services.platform.openSelfDemo(tenantId, adminUserId, clientIp, context.req.header('User-Agent') ?? ''));
        services.mail.queue(
          services.notifications.demoCreated(
            { tenantId, name: input.fullName, contactEmail: input.email, phone: input.phone, loginEmail, expiresAt },
            new URL(context.req.url).origin,
          ),
        );
        return context.json({ panelUrl: '/app', loginEmail, expiresAt, demoDays }, 201);
      },
    },
    {
      method: 'POST',
      path: '/api/public/signup',
      access: publicAccess,
      handler: async (context) => {
        const services = context.get('services');
        const clientIp = context.get('clientIp');
        const input = await readJsonBody(
          context,
          z.object({
            ...contactSchema,
            clinicName: requiredText(120, 'El nombre del consultorio'),
            city: optionalText(80),
            planId: z.string().min(1).max(40),
            favicon: faviconSchema.nullable().optional(),
            acceptTerms: z.literal(true, { error: 'Debes aceptar los términos y la política de datos.' }),
          }),
        );
        assertNotRobot(input.website);
        await services.turnstile.assertHuman(input.turnstileToken, clientIp);
        const { resolved, trialUntil, graceDays } = await services.platform.prepareSelfSignup(input.planId);
        await services.rateLimiter.consume(`signup:${clientIp}`, SIGNUP_PER_IP);

        const auth = context.get('auth');
        const fromDemo = auth?.tenant.is_showcase === 1 && auth.tenant.signup_source === 'autoservicio' ? auth.tenant : null;
        const { tenantId, adminUserId } = await services.tenants
          .createTenant(
            { name: input.clinicName, city: input.city, phone: input.phone, paidUntil: trialUntil, monthlyPrice: resolved.monthlyPrice, graceDays, favicon: input.favicon ?? null },
            { fullName: input.fullName, email: input.email, passwordHash: await services.auth.hashNewPassword(input.password) },
          )
          .catch((error: unknown) => {
            // Mensaje neutro: no confirma a un extraño qué correos tienen cuenta.
            if (error instanceof AppError && error.statusCode === 409) {
              throw new AppError('No pudimos crear la cuenta con ese correo. Si ya tienes una, ingresa con ella; si no, usa otro correo.', 409, 'SIGNUP_UNAVAILABLE');
            }
            throw error;
          });
        const result = await services.platform.completeSelfSignup(
          tenantId, adminUserId, resolved, { name: input.fullName, email: input.email, phone: input.phone }, fromDemo?.id ?? null, clientIp, context.req.header('User-Agent') ?? '',
        );
        setClinicSessionCookie(context, result);
        services.mail.queue(services.notifications.welcome(tenantId, resolved.plan.name, new URL(context.req.url).origin));
        return context.json(
          { panelUrl: '/app', trialUntil, demoAvailableUntil: result.demoAvailableUntil, demoLoginEmail: fromDemo && result.demoAvailableUntil ? auth?.email : null },
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/api/subscription/plan',
      access: requiresAny('suscripcion.pagar'),
      allowWhenSuspended: true,
      handler: async (context) => {
        const auth = requireAuth(context);
        const selection = await readJsonBody(context, planSelectionSchema);
        return context.json(
          await context.get('services').platform.requestPlanChange(
            auth.tenant, selection, new URL(context.req.url).origin, { fullName: auth.fullName, email: auth.email }, context.get('clientIp'),
          ),
        );
      },
    },
  ]);
}
