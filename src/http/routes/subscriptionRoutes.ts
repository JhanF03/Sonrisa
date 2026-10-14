/**
 * Suscripción vista desde el consultorio: estado, cómo pagar, pago en línea
 * con el Wompi del dueño y verificación del pago. Disponibles aunque el
 * acceso esté suspendido (es justamente cuando más se necesitan).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { WompiEvent } from '../../modules/payments/wompiClient.js';
import { requireAuth, type AppEnv } from '../context.js';
import { authenticatedAccess, defineRoutes, publicAccess, requiresAny } from '../routeRegistry.js';
import { readJsonBody } from '../validation.js';

export function registerSubscriptionRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/subscription',
      access: authenticatedAccess,
      allowWhenSuspended: true,
      handler: async (context) => {
        const auth = requireAuth(context);
        return context.json(await context.get('services').platform.getTenantSubscriptionView(auth.tenant, auth.permissions.has('suscripcion.pagar')));
      },
    },
    {
      method: 'POST',
      path: '/api/subscription/checkout',
      access: requiresAny('suscripcion.pagar'),
      allowWhenSuspended: true,
      handler: async (context) => {
        const auth = requireAuth(context);
        const { months } = await readJsonBody(context, z.object({ months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]) }));
        return context.json(
          await context.get('services').platform.createCheckout(auth.tenant, months, new URL(context.req.url).origin, { fullName: auth.fullName, email: auth.email }),
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/api/subscription/verify',
      access: requiresAny('suscripcion.pagar'),
      allowWhenSuspended: true,
      handler: async (context) => {
        const auth = requireAuth(context);
        const input = await readJsonBody(
          context,
          z.object({ reference: z.string().regex(/^SUB-[A-Z0-9-]{4,60}$/, 'Referencia inválida.'), transactionId: z.string().regex(/^[A-Za-z0-9-]{5,80}$/, 'Transacción inválida.') }),
        );
        return context.json(await context.get('services').platform.verifyCheckout(auth.tenant.id, input.reference, input.transactionId));
      },
    },
    {
      method: 'POST',
      path: '/api/webhooks/wompi-plataforma',
      access: publicAccess,
      handler: async (context) => {
        const event = (await context.req.json().catch(() => null)) as WompiEvent | null;
        if (!event || typeof event !== 'object') return context.json({ status: 'ignorado' });
        return context.json(await context.get('services').platform.handleWebhook(event, context.req.header('X-Event-Checksum') ?? null));
      },
    },
  ]);
}
