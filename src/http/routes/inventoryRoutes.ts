/**
 * Fase 2: proveedores, compras, cuentas por pagar, insumos, inventario y
 * costo por servicio.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { SUPPLY_UNITS } from '../../modules/inventory/inventoryService.js';
import { SUPPLIER_PAYMENT_METHODS } from '../../modules/inventory/purchaseService.js';
import { addDays, localToUtcIso, todayLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import { idSchema, localDateSchema, moneySchema, optionalText, positiveMoneySchema, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';

const quantitySchema = z.number().positive('La cantidad debe ser mayor a cero.').max(1_000_000);
const unitSchema = z.enum(SUPPLY_UNITS, { error: 'Unidad inválida.' });
const voidSchema = z.object({ reason: requiredText(200, 'El motivo de anulación') });

const supplierSchema = z.object({
  name: requiredText(150, 'El nombre'),
  nit: optionalText(20),
  phone: optionalText(30),
  email: z.email('Correo inválido.').max(200).nullable().default(null),
  contactName: optionalText(120),
  notes: optionalText(500),
  isActive: z.boolean().default(true),
});

const supplySchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'Código inválido (letras, números y guiones).').nullable().default(null),
  name: requiredText(150, 'El nombre'),
  unit: unitSchema,
  minStock: z.number().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true),
});

const purchaseSchema = z.object({
  supplierId: idSchema.nullable().default(null),
  newSupplier: z.object({ name: requiredText(150, 'El nombre del proveedor'), nit: optionalText(20) }).nullable().default(null),
  invoiceNumber: requiredText(40, 'El número de factura'),
  cufe: z.string().trim().regex(/^[A-Za-z0-9]{20,128}$/, 'CUFE inválido.').nullable().default(null),
  issueDate: localDateSchema,
  dueDate: localDateSchema.nullable().default(null),
  notes: optionalText(500),
  source: z.enum(['manual', 'xml']).default('manual'),
  lines: z
    .array(
      z.object({
        supplyId: idSchema.nullable().default(null),
        newSupply: z.object({ name: requiredText(150, 'El nombre del insumo'), unit: unitSchema }).nullable().default(null),
        description: requiredText(300, 'La descripción'),
        supplierCode: optionalText(60),
        quantity: quantitySchema,
        conversionFactor: z.number().positive().max(100_000).default(1),
        lineTotal: moneySchema,
        taxAmount: moneySchema.default(0),
      }),
    )
    .min(1, 'Agrega al menos una línea.')
    .max(200),
});

export function registerInventoryRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    // ─── Proveedores ───
    {
      method: 'GET',
      path: '/api/suppliers',
      access: requiresAny('compras.ver', 'compras.gestionar'),
      handler: async (context) => context.json(await context.get('services').purchases.listSuppliers(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/suppliers',
      access: requiresAny('compras.gestionar'),
      handler: async (context) =>
        context.json(await context.get('services').purchases.createSupplier(actorOf(context), await readJsonBody(context, supplierSchema)), 201),
    },
    {
      method: 'PUT',
      path: '/api/suppliers/:id',
      access: requiresAny('compras.gestionar'),
      handler: async (context) =>
        context.json(await context.get('services').purchases.updateSupplier(actorOf(context), readIdParam(context), await readJsonBody(context, supplierSchema))),
    },
    {
      method: 'GET',
      path: '/api/suppliers/:id/item-links',
      access: requiresAny('compras.gestionar'),
      handler: async (context) => context.json(await context.get('services').purchases.getItemLinks(requireAuth(context).tenant.id, readIdParam(context))),
    },

    // ─── Compras y cuentas por pagar ───
    {
      method: 'GET',
      path: '/api/purchases',
      access: requiresAny('compras.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const today = todayLocal(auth.tenant.utc_offset_minutes);
        const query = readQuery(
          context,
          z.object({
            from: localDateSchema.default(addDays(today, -30)),
            to: localDateSchema.default(today),
            supplierId: idSchema.optional(),
            pending: z.enum(['1']).optional(),
          }),
        );
        return context.json(
          await context.get('services').purchases.listPurchases(auth.tenant.id, { ...query, onlyPending: query.pending === '1' }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/purchases/:id',
      access: requiresAny('compras.ver'),
      handler: async (context) => context.json(await context.get('services').purchases.getPurchase(requireAuth(context).tenant.id, readIdParam(context))),
    },
    {
      method: 'POST',
      path: '/api/purchases',
      access: requiresAny('compras.gestionar'),
      handler: async (context) =>
        context.json(await context.get('services').purchases.createPurchase(actorOf(context), await readJsonBody(context, purchaseSchema)), 201),
    },
    {
      method: 'POST',
      path: '/api/purchases/:id/void',
      access: requiresAny('compras.gestionar'),
      handler: async (context) => {
        const { reason } = await readJsonBody(context, voidSchema);
        return context.json(await context.get('services').purchases.voidPurchase(actorOf(context), readIdParam(context), reason));
      },
    },
    {
      method: 'POST',
      path: '/api/purchases/:id/payments',
      access: requiresAny('compras.pagar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            amount: positiveMoneySchema,
            method: z.enum(SUPPLIER_PAYMENT_METHODS),
            paymentDate: localDateSchema,
            reference: optionalText(80),
          }),
        );
        return context.json(await context.get('services').purchases.registerPayment(actorOf(context), readIdParam(context), input), 201);
      },
    },
    {
      method: 'POST',
      path: '/api/supplier-payments/:id/void',
      access: requiresAny('compras.pagar'),
      handler: async (context) => {
        const { reason } = await readJsonBody(context, voidSchema);
        return context.json(await context.get('services').purchases.voidPayment(actorOf(context), readIdParam(context), reason));
      },
    },

    // ─── Insumos e inventario ───
    {
      method: 'GET',
      path: '/api/supplies',
      access: requiresAny('inventario.ver', 'inventario.gestionar', 'compras.gestionar'),
      handler: async (context) => {
        const { all } = readQuery(context, z.object({ all: z.enum(['1']).optional() }));
        return context.json(await context.get('services').inventory.listSupplies(requireAuth(context).tenant.id, { includeInactive: all === '1' }));
      },
    },
    {
      method: 'POST',
      path: '/api/supplies',
      access: requiresAny('inventario.gestionar'),
      handler: async (context) =>
        context.json(await context.get('services').inventory.createSupply(actorOf(context), await readJsonBody(context, supplySchema)), 201),
    },
    {
      method: 'PUT',
      path: '/api/supplies/:id',
      access: requiresAny('inventario.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(context, supplySchema.extend({ code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'Código inválido.') }));
        return context.json(await context.get('services').inventory.updateSupply(actorOf(context), readIdParam(context), input));
      },
    },
    {
      method: 'POST',
      path: '/api/supplies/:id/adjust',
      access: requiresAny('inventario.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            quantity: z.number().min(-1_000_000).max(1_000_000),
            reason: requiredText(200, 'El motivo del ajuste'),
            unitCost: z.number().min(0).max(100_000_000).nullable().default(null),
          }),
        );
        return context.json(await context.get('services').inventory.adjustStock(actorOf(context), readIdParam(context), input));
      },
    },
    {
      method: 'GET',
      path: '/api/stock-movements',
      access: requiresAny('inventario.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const today = todayLocal(auth.tenant.utc_offset_minutes);
        const query = readQuery(
          context,
          z.object({ from: localDateSchema.default(addDays(today, -30)), to: localDateSchema.default(today), supplyId: idSchema.optional() }),
        );
        return context.json(
          await context.get('services').inventory.listMovements(auth.tenant.id, {
            supplyId: query.supplyId,
            fromUtc: localToUtcIso(`${query.from}T00:00`, auth.tenant.utc_offset_minutes),
            toUtc: localToUtcIso(`${addDays(query.to, 1)}T00:00`, auth.tenant.utc_offset_minutes),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/inventory/summary',
      access: requiresAny('inventario.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const today = todayLocal(auth.tenant.utc_offset_minutes);
        const monthStart = `${today.slice(0, 8)}01`;
        return context.json(
          await context.get('services').inventory.getSummary(
            auth.tenant.id,
            localToUtcIso(`${monthStart}T00:00`, auth.tenant.utc_offset_minutes),
            localToUtcIso(`${addDays(today, 1)}T00:00`, auth.tenant.utc_offset_minutes),
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/service-costs',
      access: requiresAny('inventario.ver'),
      handler: async (context) => context.json(await context.get('services').inventory.getServiceCosts(requireAuth(context).tenant.id)),
    },
    {
      method: 'GET',
      path: '/api/services/:id/recipe',
      access: requiresAny('inventario.ver', 'inventario.gestionar'),
      handler: async (context) => context.json(await context.get('services').inventory.getRecipe(requireAuth(context).tenant.id, readIdParam(context))),
    },
    {
      method: 'PUT',
      path: '/api/services/:id/recipe',
      access: requiresAny('inventario.gestionar'),
      handler: async (context) => {
        const { items } = await readJsonBody(
          context,
          z.object({ items: z.array(z.object({ supplyId: idSchema, quantity: quantitySchema })).max(60) }),
        );
        return context.json(await context.get('services').inventory.setRecipe(actorOf(context), readIdParam(context), items));
      },
    },
  ]);
}
