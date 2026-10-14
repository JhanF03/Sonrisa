/**
 * Rutas de sesión: ingreso, salida, perfil actual y cambio de clave propia.
 */
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
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
        if (sessionToken) await context.get('services').auth.logout(sessionToken);
        deleteCookie(context, cookieName, { path: '/', secure: cookieName.startsWith('__Host-') });
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/auth/me',
      access: authenticatedAccess,
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
            isShowcase: auth.tenant.is_showcase === 1,
            utcOffsetMinutes: auth.tenant.utc_offset_minutes,
          },
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
      access: authenticatedAccess,
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({ currentPassword: z.string().min(1).max(128), newPassword: PASSWORD_POLICY }),
        );
        const actor = actorOf(context);
        await context.get('services').users.changeOwnPassword(
          { ...actor, userId: requireAuth(context).userId },
          input.currentPassword,
          input.newPassword,
        );
        return context.json({ ok: true });
      },
    },
  ]);
}
