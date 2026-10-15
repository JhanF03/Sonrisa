/**
 * Rutas de sesión: ingreso, salida, perfil actual y cambio de clave propia.
 */
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { subscriptionOfTenant } from '../../shared/subscription.js';
import { ALL_PLAN_MODULES, parseModules } from '../../shared/plans.js';
import { PERMISSION_CATALOG } from '../../security/permissions.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { getSessionCookieName } from '../middleware.js';
import { authenticatedAccess, defineRoutes, publicAccess } from '../routeRegistry.js';
import { readJsonBody } from '../validation.js';

export const PASSWORD_POLICY = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres.')
  .max(128)
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), 'La contraseña debe combinar letras y números.');

const loginSchema = z.object({
  email: z.email('Correo inválido.').max(200),
  password: z.string().min(1, 'Escribe tu contraseña.').max(128),
});

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      // "¿Olvidaste tu contraseña?": responde igual exista o no el correo.
      method: 'POST',
      path: '/api/auth/forgot',
      access: publicAccess,
      handler: async (context) => {
        const { email } = await readJsonBody(context, z.object({ email: z.email('Correo inválido.').max(200) }));
        await context.get('services').passwordResets.request(email, context.get('clientIp'), new URL(context.req.url).origin);
        return context.json({ ok: true, message: 'Si el correo tiene una cuenta, te enviamos un enlace para crear una contraseña nueva. Revisa también la carpeta de spam.' });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/reset',
      access: publicAccess,
      handler: async (context) => {
        const input = await readJsonBody(context, z.object({ token: z.string().min(20).max(200), password: PASSWORD_POLICY }));
        await context.get('services').passwordResets.reset(input.token, input.password, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/login',
      access: publicAccess,
      handler: async (context) => {
        const { email, password } = await readJsonBody(context, loginSchema);
        const { sessionToken, expiresAt } = await context
          .get('services')
          .auth.login(email, password, context.get('clientIp'), context.req.header('User-Agent') ?? '');

        const isSecure = new URL(context.req.url).protocol === 'https:';
        setCookie(context, getSessionCookieName(context.req.url), sessionToken, {
          httpOnly: true,
          secure: isSecure,
          sameSite: 'Strict',
          path: '/',
          expires: new Date(expiresAt),
        });
        return context.json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      access: publicAccess,
      handler: async (context) => {
        const cookieName = getSessionCookieName(context.req.url);
        const sessionToken = getCookie(context, cookieName);
        const auth = context.get('auth');
        if (auth) await context.get('services').audit.record(actorOf(context), { action: 'logout', entity: 'usuario', entityId: auth.userId });
        if (sessionToken) await context.get('services').auth.logout(sessionToken);
        deleteCookie(context, cookieName, { path: '/', secure: cookieName.startsWith('__Host-') });
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/auth/me',
      access: authenticatedAccess,
      allowWhenSuspended: true,
      handler: (context) => {
        const auth = requireAuth(context);
        return context.json({
          user: { id: auth.userId, email: auth.email, fullName: auth.fullName, professionalId: auth.professionalId },
          permissions: [...auth.permissions],
          clinic: {
            id: auth.tenant.id,
            slug: auth.tenant.slug,
            name: auth.tenant.name,
            brandColor: auth.tenant.brand_color,
            logoUrl: auth.tenant.logo_url,
            favicon: auth.tenant.favicon,
            isShowcase: auth.tenant.is_showcase === 1,
            utcOffsetMinutes: auth.tenant.utc_offset_minutes,
          },
          subscription: {
            ...subscriptionOfTenant(auth.tenant),
            monthlyPrice: auth.tenant.monthly_price,
            onTrial: auth.tenant.on_trial === 1,
          },
          plan: {
            id: auth.tenant.plan_id,
            modules: auth.tenant.is_showcase === 1 ? ALL_PLAN_MODULES : parseModules(auth.tenant.enabled_modules),
            lockedPermissions: [...auth.lockedPermissions],
          },
          demo: auth.tenant.is_showcase === 1
            ? { expiresAt: auth.tenant.demo_expires_at, loginEmail: auth.email, convertedTenantId: auth.tenant.converted_tenant_id }
            : null,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/auth/permission-catalog',
      access: authenticatedAccess,
      handler: (context) =>
        context.json(
          Object.entries(PERMISSION_CATALOG).map(([key, value]) => ({ key, module: value.module, label: value.label })),
        ),
    },
    {
      method: 'POST',
      path: '/api/auth/change-password',
      allowWhenSuspended: true,
      access: authenticatedAccess,
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({ currentPassword: z.string().min(1).max(128), newPassword: PASSWORD_POLICY }),
        );
        const actor = actorOf(context);
        const services = context.get('services');
        const userId = requireAuth(context).userId;
        // Con una sesión robada no se puede adivinar la clave actual a fuerza de intentos.
        await services.rateLimiter.consume(`password-change:${userId}`, { limit: 5, windowMs: 15 * 60_000, message: 'Demasiados intentos. Espera 15 minutos.' });
        await services.users.changeOwnPassword({ ...actor, userId }, input.currentPassword, input.newPassword);
        // Cambiar la clave cierra las sesiones abiertas en otros dispositivos (no la actual).
        await services.auth.revokeOtherSessions(userId, getCookie(context, getSessionCookieName(context.req.url)) ?? '');
        return context.json({ ok: true });
      },
    },
  ]);
}
