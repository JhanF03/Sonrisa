/**
 * Configuración del consultorio, profesionales, horarios y bloqueos.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { validateReminderTemplate } from '../../shared/messageTemplate.js';
import { getColombianHolidays } from '../../utils/colombianHolidays.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { authenticatedAccess, defineRoutes, requiresAny } from '../routeRegistry.js';
import {
  faviconSchema,
  hexColorSchema,
  httpsUrlSchema,
  idSchema,
  localDateSchema,
  localDateTimeSchema,
  optionalText,
  readIdParam,
  readJsonBody,
  readQuery,
  requiredText,
  timeSchema,
  whatsappPhoneSchema,
} from '../validation.js';

const tenantSettingsSchema = z.object({
  name: requiredText(120, 'El nombre'),
  phone: optionalText(30),
  address: optionalText(200),
  city: optionalText(80),
  brandColor: hexColorSchema,
  logoUrl: httpsUrlSchema.nullable().optional().transform((value) => value ?? null),
  slotIntervalMinutes: z.number().int().refine((value) => [10, 15, 20, 30, 45, 60].includes(value), 'Intervalo inválido.'),
  minBookingNoticeHours: z.number().int().min(0).max(168),
  bookingWindowDays: z.number().int().min(1).max(180),
  reactivationMonths: z.number().int().min(1).max(36),
  onlineBookingEnabled: z.boolean(),
  closeOnHolidays: z.boolean(),
});

const bookingRulesSchema = z.object({
  onlineVerificationMode: z.enum(['ninguna', 'whatsapp']),
  verificationWindowMinutes: z.number().int().min(10, 'Mínimo 10 minutos.').max(1440, 'Máximo 24 horas.'),
  maxPendingOnlinePerPatient: z.number().int().min(1).max(20),
  autoReleaseHours: z.number().int().min(0).max(72),
  paymentWindowMinutes: z.number().int().min(20, 'Mínimo 20 minutos (el paciente necesita tiempo para pagar).').max(120),
});

const whatsappSettingsSchema = z.object({
  whatsappNumber: whatsappPhoneSchema.nullable(),
  reminderTemplate: z
    .string()
    .nullable()
    .transform((value, context) => {
      if (value === null || !value.trim()) return null;
      const errors = validateReminderTemplate(value);
      if (errors.length > 0) {
        context.addIssue({ code: 'custom', message: errors.join(' ') });
        return z.NEVER;
      }
      return value.trim();
    }),
});

const professionalSchema = z.object({
  fullName: requiredText(120, 'El nombre'),
  specialty: optionalText(120),
  color: hexColorSchema,
  userId: idSchema.nullable().default(null),
  isActive: z.boolean().default(true),
});

const scheduleSchema = z.object({
  blocks: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), startTime: timeSchema, endTime: timeSchema }))
    .max(42),
});

const timeBlockSchema = z.object({
  professionalId: idSchema.nullable().default(null),
  startAt: localDateTimeSchema,
  endAt: localDateTimeSchema,
  reason: optionalText(200),
});

const canSeeAgenda = requiresAny('agenda.ver_todas', 'agenda.ver_propia');

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/settings/clinic',
      access: authenticatedAccess,
      handler: async (context) => context.json(await context.get('services').tenants.getById(requireAuth(context).tenant.id)),
    },
    {
      method: 'PUT',
      path: '/api/settings/clinic',
      access: requiresAny('configuracion.consultorio'),
      handler: async (context) => {
        const input = await readJsonBody(context, tenantSettingsSchema);
        return context.json(await context.get('services').tenants.updateSettings(actorOf(context), input));
      },
    },
    {
      method: 'PUT',
      path: '/api/settings/favicon',
      access: requiresAny('configuracion.consultorio'),
      handler: async (context) => {
        const { favicon } = await readJsonBody(context, z.object({ favicon: faviconSchema.nullable() }));
        return context.json(await context.get('services').tenants.updateFavicon(actorOf(context), favicon));
      },
    },
    {
      method: 'PUT',
      path: '/api/settings/booking-rules',
      access: requiresAny('configuracion.consultorio'),
      handler: async (context) => {
        const input = await readJsonBody(context, bookingRulesSchema);
        return context.json(await context.get('services').tenants.updateBookingRules(actorOf(context), input));
      },
    },
    {
      method: 'PUT',
      path: '/api/settings/whatsapp',
      access: requiresAny('configuracion.consultorio'),
      handler: async (context) => {
        const input = await readJsonBody(context, whatsappSettingsSchema);
        return context.json(await context.get('services').tenants.updateWhatsappSettings(actorOf(context), input));
      },
    },
    {
      method: 'GET',
      path: '/api/holidays/:year',
      access: authenticatedAccess,
      handler: (context) => {
        const year = z.coerce.number().int().min(2000).max(2100).parse(context.req.param('year'));
        return context.json([...getColombianHolidays(year)].sort());
      },
    },
    {
      method: 'GET',
      path: '/api/professionals',
      access: authenticatedAccess,
      handler: async (context) =>
        context.json(await context.get('services').professionals.list(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/professionals',
      access: requiresAny('configuracion.profesionales'),
      handler: async (context) => {
        const input = await readJsonBody(context, professionalSchema);
        return context.json(await context.get('services').professionals.create(actorOf(context), input), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/professionals/:id',
      access: requiresAny('configuracion.profesionales'),
      handler: async (context) => {
        const input = await readJsonBody(context, professionalSchema);
        return context.json(await context.get('services').professionals.update(actorOf(context), readIdParam(context), input));
      },
    },
    {
      method: 'GET',
      path: '/api/professionals/:id/schedule',
      access: authenticatedAccess,
      handler: async (context) =>
        context.json(
          await context.get('services').professionals.listSchedules(requireAuth(context).tenant.id, readIdParam(context)),
        ),
    },
    {
      method: 'PUT',
      path: '/api/professionals/:id/schedule',
      access: requiresAny('configuracion.profesionales'),
      handler: async (context) => {
        const { blocks } = await readJsonBody(context, scheduleSchema);
        return context.json(
          await context.get('services').professionals.replaceSchedule(actorOf(context), readIdParam(context), blocks),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/time-blocks',
      access: canSeeAgenda,
      handler: async (context) => {
        const query = readQuery(context, z.object({ from: localDateSchema, to: localDateSchema }));
        return context.json(
          await context.get('services').professionals.listTimeBlocks(requireAuth(context).tenant.id, query.from, query.to),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/time-blocks',
      access: requiresAny('agenda.bloquear'),
      handler: async (context) => {
        const input = await readJsonBody(context, timeBlockSchema);
        return context.json(await context.get('services').professionals.createTimeBlock(actorOf(context), input), 201);
      },
    },
    {
      method: 'DELETE',
      path: '/api/time-blocks/:id',
      access: requiresAny('agenda.bloquear'),
      handler: async (context) => {
        await context.get('services').professionals.deleteTimeBlock(actorOf(context), readIdParam(context));
        return context.json({ ok: true });
      },
    },
  ]);
}
