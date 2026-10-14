/**
 * Fase 3: facturación electrónica de venta.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { PAYMENT_METHOD_CODES } from '../../modules/einvoicing/providers.js';
import { addDays, localToUtcIso, todayLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import { idSchema, localDateSchema, optionalText, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';

const secretText = (maxLength: number) => z.string().trim().max(maxLength).nullable().default(null).transform((value) => value || null);

export function registerEInvoiceRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/settings/einvoicing',
      access: requiresAny('facturacion.configurar', 'facturacion.emitir'),
      handler: async (context) => context.json(await context.get('services').einvoices.getSettings(requireAuth(context).tenant.id)),
    },
    {
      method: 'PUT',
      path: '/api/settings/einvoicing',
      access: requiresAny('facturacion.configurar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            provider: z.enum(['externo', 'factus', 'webhook']),
            environment: z.enum(['pruebas', 'produccion']).default('pruebas'),
            isEnabled: z.boolean().default(true),
            clientId: secretText(200),
            clientSecret: secretText(300),
            username: secretText(200),
            password: secretText(300),
            numberingRangeId: z.number().int().positive().max(1_000_000_000).nullable().default(null),
            webhookUrl: secretText(500),
            webhookSecret: z.string().trim().min(16, 'El secreto debe tener al menos 16 caracteres.').max(200).nullable().default(null),
          }),
        );
        return context.json(await context.get('services').einvoices.saveSettings(actorOf(context), input));
      },
    },
    {
      method: 'POST',
      path: '/api/settings/einvoicing/test',
      access: requiresAny('facturacion.configurar'),
      handler: async (context) => context.json(await context.get('services').einvoices.testConnection(actorOf(context))),
    },
    {
      method: 'GET',
      path: '/api/einvoices',
      access: requiresAny('facturacion.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const today = todayLocal(auth.tenant.utc_offset_minutes);
        const query = readQuery(
          context,
          z.object({
            from: localDateSchema.default(addDays(today, -30)),
            to: localDateSchema.default(today),
            status: z.enum(['pendiente', 'emitida', 'rechazada', 'anulada']).optional(),
          }),
        );
        return context.json(
          await context.get('services').einvoices.listInvoices(auth.tenant.id, {
            status: query.status,
            fromUtc: localToUtcIso(`${query.from}T00:00`, auth.tenant.utc_offset_minutes),
            toUtc: localToUtcIso(`${addDays(query.to, 1)}T00:00`, auth.tenant.utc_offset_minutes),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/einvoices/:id',
      access: requiresAny('facturacion.ver'),
      handler: async (context) => context.json(await context.get('services').einvoices.getInvoice(requireAuth(context).tenant.id, readIdParam(context))),
    },
    {
      method: 'GET',
      path: '/api/patients/:id/billable-charges',
      access: requiresAny('facturacion.emitir'),
      handler: async (context) =>
        context.json(await context.get('services').einvoices.listBillableCharges(requireAuth(context).tenant.id, readIdParam(context))),
    },
    {
      method: 'POST',
      path: '/api/einvoices',
      access: requiresAny('facturacion.emitir'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            patientId: idSchema,
            chargeIds: z.array(idSchema).min(1, 'Selecciona al menos un cargo.').max(100),
            paymentForm: z.enum(['contado', 'credito']),
            paymentMethod: z.enum(Object.keys(PAYMENT_METHOD_CODES) as [string, ...string[]]),
            dueDate: localDateSchema.nullable().default(null),
            observation: optionalText(500),
            customerEmail: z.email('Correo inválido.').max(200).nullable().default(null),
            customerAddress: optionalText(200),
            externalNumber: z.string().trim().regex(/^[A-Za-z0-9-]{1,40}$/, 'Número de factura inválido.').nullable().default(null),
            externalCufe: z.string().trim().regex(/^[A-Fa-f0-9]{40,128}$/, 'CUFE inválido (hexadecimal).').nullable().default(null),
          }),
        );
        const auth = requireAuth(context);
        return context.json(await context.get('services').einvoices.createInvoice(actorOf(context), input, auth.tenant.utc_offset_minutes), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/einvoices/:id/retry',
      access: requiresAny('facturacion.emitir'),
      handler: async (context) =>
        context.json(await context.get('services').einvoices.issue(actorOf(context), readIdParam(context), requireAuth(context).tenant.utc_offset_minutes)),
    },
    {
      method: 'POST',
      path: '/api/einvoices/:id/void',
      access: requiresAny('facturacion.anular'),
      handler: async (context) => {
        const input = await readJsonBody(context, z.object({ reason: requiredText(200, 'El motivo'), creditNoteRef: optionalText(60) }));
        return context.json(await context.get('services').einvoices.voidInvoice(actorOf(context), readIdParam(context), input));
      },
    },
  ]);
}
