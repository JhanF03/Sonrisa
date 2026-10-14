/**
 * Caja (recaudos, recibos, cierre) y cartera (cargos, estados de cuenta, edades).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { PAYMENT_METHODS } from '../../modules/billing/billingService.js';
import { addDays, localToUtcIso, todayLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import { idSchema, localDateSchema, optionalText, positiveMoneySchema, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';

const voidSchema = z.object({ reason: requiredText(200, 'El motivo de anulación') });

export function registerBillingRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/patients/:id/statement',
      access: requiresAny('cartera.ver', 'caja.recaudo.ver'),
      handler: async (context) =>
        context.json(await context.get('services').billing.getPatientStatement(requireAuth(context).tenant.id, readIdParam(context))),
    },
    {
      method: 'POST',
      path: '/api/charges',
      access: requiresAny('cartera.cargo.crear'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            patientId: idSchema,
            serviceId: idSchema.nullable().default(null),
            description: optionalText(200),
            quantity: z.number().int().min(1).max(100).default(1),
            unitPrice: positiveMoneySchema.nullable().default(null),
          }),
        );
        return context.json(await context.get('services').billing.createCharge(actorOf(context), input), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/charges/:id/void',
      access: requiresAny('cartera.cargo.anular'),
      handler: async (context) => {
        const { reason } = await readJsonBody(context, voidSchema);
        return context.json(await context.get('services').billing.voidCharge(actorOf(context), readIdParam(context), reason));
      },
    },
    {
      method: 'POST',
      path: '/api/payments',
      access: requiresAny('caja.recaudo.crear'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            patientId: idSchema,
            amount: positiveMoneySchema,
            method: z.enum(PAYMENT_METHODS),
            reference: optionalText(80),
            notes: optionalText(300),
            chargeIds: z.array(idSchema).max(50).nullable().default(null),
            applyToCharges: z.boolean().default(true),
          }),
        );
        return context.json(await context.get('services').billing.registerPayment(actorOf(context), input), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/patients/:id/apply-credit',
      access: requiresAny('caja.recaudo.crear'),
      handler: async (context) =>
        context.json(await context.get('services').billing.applyAvailableCredit(actorOf(context), readIdParam(context))),
    },
    {
      method: 'POST',
      path: '/api/payments/:id/void',
      access: requiresAny('caja.recaudo.anular'),
      handler: async (context) => {
        const { reason } = await readJsonBody(context, voidSchema);
        return context.json(await context.get('services').billing.voidPayment(actorOf(context), readIdParam(context), reason));
      },
    },
    {
      method: 'GET',
      path: '/api/payments/:id/receipt',
      access: requiresAny('caja.recaudo.ver', 'caja.recaudo.crear'),
      handler: async (context) =>
        context.json(await context.get('services').billing.getReceipt(requireAuth(context).tenant, readIdParam(context))),
    },
    {
      method: 'GET',
      path: '/api/payments',
      access: requiresAny('caja.recaudo.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const today = todayLocal(auth.tenant.utc_offset_minutes);
        const query = readQuery(context, z.object({ from: localDateSchema.default(today), to: localDateSchema.default(today) }));
        return context.json(
          await context.get('services').billing.listPayments(auth.tenant.id, {
            fromUtc: localToUtcIso(`${query.from}T00:00`, auth.tenant.utc_offset_minutes),
            toUtc: localToUtcIso(`${addDays(query.to, 1)}T00:00`, auth.tenant.utc_offset_minutes),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/cash-closing',
      access: requiresAny('caja.cierre.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const { date } = readQuery(context, z.object({ date: localDateSchema.default(todayLocal(auth.tenant.utc_offset_minutes)) }));
        return context.json(await context.get('services').billing.getCashClosing(auth.tenant, date));
      },
    },
    {
      method: 'GET',
      path: '/api/receivables/aging',
      access: requiresAny('cartera.ver'),
      handler: async (context) => context.json(await context.get('services').billing.getAgingReport(requireAuth(context).tenant)),
    },
  ]);
}
