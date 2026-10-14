/**
 * Pagos en línea (Wompi):
 *   • Configuración de la cuenta del consultorio (solo con 'pagos.configurar').
 *   • Lista de pagos en línea y alertas ('pagos.ver').
 *   • Estado del pago para el paciente (enlace firmado, sin sesión).
 *   • Webhook de eventos de Wompi (autenticado con el checksum).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { WompiEvent } from '../../modules/payments/wompiClient.js';
import { RATE_LIMIT_RULES } from '../../security/rateLimiter.js';
import { actorOf, requireAuth, type AppContext, type AppEnv } from '../context.js';
import { notFound } from '../errors.js';
import { defineRoutes, publicAccess, requiresAny } from '../routeRegistry.js';
import { optionalText, paginationSchema, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';
import { buildManageUrl } from './appointmentRoutes.js';
import { toPublicAppointment, toPublicClinic } from './publicRoutes.js';
import { createAppointmentToken } from '../../security/appointmentLinks.js';

const secretField = (pattern: RegExp, label: string) =>
  z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || pattern.test(value), `${label} tiene un formato inválido.`);

const gatewaySchema = z.object({
  environment: z.enum(['sandbox', 'production']),
  publicKey: z.string().trim().regex(/^pub_(test|prod)_[A-Za-z0-9]{8,120}$/, 'La llave pública tiene un formato inválido.'),
  integritySecret: secretField(/^(test|prod)_integrity_[A-Za-z0-9]{8,120}$/, 'El secreto de integridad'),
  eventsSecret: secretField(/^(test|prod)_events_[A-Za-z0-9]{8,120}$/, 'El secreto de eventos'),
  isEnabled: z.boolean(),
  policyText: optionalText(500),
});

const originOf = (context: AppContext) => new URL(context.req.url).origin;

export function registerPaymentRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    // ─── Configuración ─────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/settings/payments',
      access: requiresAny('pagos.configurar'),
      handler: async (context) =>
        context.json(await context.get('services').payments.getGatewayView(requireAuth(context).tenant.id, originOf(context))),
    },
    {
      method: 'PUT',
      path: '/api/settings/payments',
      access: requiresAny('pagos.configurar'),
      handler: async (context) => {
        const input = await readJsonBody(context, gatewaySchema);
        return context.json(await context.get('services').payments.saveGateway(actorOf(context), input, originOf(context)));
      },
    },
    {
      method: 'POST',
      path: '/api/settings/payments/test',
      access: requiresAny('pagos.configurar'),
      handler: async (context) => context.json(await context.get('services').payments.testConnection(actorOf(context))),
    },

    // ─── Panel: pagos en línea ─────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/online-payments',
      access: requiresAny('pagos.ver'),
      handler: async (context) => {
        const query = readQuery(context, paginationSchema.extend({ attention: z.enum(['true', 'false']).default('false') }));
        return context.json(
          await context.get('services').payments.listIntents(requireAuth(context).tenant.id, {
            attentionOnly: query.attention === 'true',
            limit: query.limit,
            offset: query.offset,
          }),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/online-payments/:id/resolve',
      access: requiresAny('pagos.ver'),
      handler: async (context) => {
        const { note } = await readJsonBody(context, z.object({ note: requiredText(300, 'La nota') }));
        await context.get('services').payments.resolveAttention(
          { ...actorOf(context), userId: requireAuth(context).userId },
          readIdParam(context),
          note,
        );
        return context.json({ ok: true });
      },
    },

    // ─── Paciente: estado del pago ─────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/public/payments/:token',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, intent: storedIntent } = await loadIntentFromToken(context);
        const services = context.get('services');
        // "id" lo agrega Wompi al redirigir: se verifica contra la API de Wompi.
        const transactionId = context.req.query('id');
        const intent = transactionId ? await services.payments.verifyRedirect(tenant, storedIntent, transactionId) : storedIntent;

        const { state, appointment, canRetry } = await services.payments.getPublicState(tenant, intent);
        const manageToken = await createAppointmentToken(context.get('config').appSecret, appointment.id);
        return context.json({
          state,
          canRetry,
          amount: intent.amount_in_cents / 100,
          clinic: toPublicClinic(tenant),
          appointment: toPublicAppointment(appointment),
          manageUrl: state === 'aprobado' ? buildManageUrl(context, tenant.slug, manageToken) : null,
          calendarUrl: state === 'aprobado' ? `/api/public/appointments/${encodeURIComponent(manageToken)}/calendar.ics` : null,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/public/payments/:token/resume',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, intent } = await loadIntentFromToken(context);
        const { checkoutUrl, statusToken, amount, holdExpiresAt } = await context
          .get('services')
          .payments.resumeCheckout(tenant, intent, originOf(context));
        return context.json({ checkoutUrl, statusToken, amount, holdExpiresAt });
      },
    },
    {
      method: 'POST',
      path: '/api/public/payments/:token/cancel',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, intent } = await loadIntentFromToken(context);
        await context.get('services').payments.cancelPendingPayment(tenant, intent, context.get('clientIp'));
        return context.json({ ok: true });
      },
    },

    // ─── Webhook de Wompi ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/webhooks/wompi/:webhookKey',
      access: publicAccess,
      handler: async (context) => {
        const webhookKey = z.string().regex(/^[A-Za-z0-9_-]{20,60}$/).safeParse(context.req.param('webhookKey'));
        if (!webhookKey.success) return context.json({ ok: false }, 404);

        let event: WompiEvent;
        try {
          event = (await context.req.json()) as WompiEvent;
        } catch {
          return context.json({ ok: false, result: 'json_invalido' }, 400);
        }
        const outcome = await context
          .get('services')
          .payments.handleWebhook(webhookKey.data, event, context.req.header('X-Event-Checksum') ?? null);
        return context.json({ ok: outcome.httpStatus === 200, result: outcome.result }, outcome.httpStatus);
      },
    },
  ]);
}

async function loadIntentFromToken(context: AppContext) {
  await context.get('services').rateLimiter.consume(`public:${context.get('clientIp')}`, RATE_LIMIT_RULES.publicLookupPerIp);
  const found = await context.get('services').payments.findIntentByToken(context.req.param('token') ?? '');
  if (!found) throw notFound('El pago');
  return found;
}
