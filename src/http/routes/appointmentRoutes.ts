/**
 * Agenda interna, disponibilidad, recordatorios, reactivación y lista de espera.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { MAX_AVAILABILITY_RANGE_DAYS } from '../../modules/appointments/availabilityService.js';
import { createAppointmentToken } from '../../security/appointmentLinks.js';
import { DEFAULT_REMINDER_TEMPLATE, renderTemplate, spanishDate, spanishTime } from '../../shared/messageTemplate.js';
import { buildWhatsappLink } from '../../utils/phone.js';
import { addDays, daysBetween, todayLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppContext, type AppEnv } from '../context.js';
import { AppError } from '../errors.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import { agendaRestriction } from '../scope.js';
import { idSchema, localDateSchema, localDateTimeSchema, optionalText, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';

const MAX_AGENDA_RANGE_DAYS = 62;

const newAppointmentSchema = z.object({
  patientId: idSchema,
  professionalId: idSchema,
  serviceId: idSchema,
  startAt: localDateTimeSchema,
  notes: optionalText(500),
  recurrence: z
    .object({ occurrences: z.number().int().min(2).max(24), intervalWeeks: z.number().int().min(1).max(12) })
    .nullable()
    .default(null),
});

const canSeeAgenda = requiresAny('agenda.ver_todas', 'agenda.ver_propia');

/** Máximo de intentos de código por reserva (evita adivinarlo). */
const VERIFY_RATE_LIMIT = { limit: 6, windowMs: 15 * 60_000, message: 'Demasiados intentos con códigos incorrectos. Espera 15 minutos.' };

export function registerAppointmentRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/appointments',
      access: canSeeAgenda,
      handler: async (context) => {
        const auth = requireAuth(context);
        const query = readQuery(context, z.object({ from: localDateSchema, to: localDateSchema, professionalId: idSchema.optional() }));
        assertRange(query.from, query.to, MAX_AGENDA_RANGE_DAYS);
        await context.get('services').maintenance.releaseExpiredHolds(auth.tenant.id);
        const restriction = agendaRestriction(auth);
        return context.json(
          await context.get('services').appointments.list(auth.tenant.id, {
            fromDate: query.from,
            toDate: query.to,
            professionalId: restriction ?? query.professionalId,
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/availability',
      access: requiresAny('agenda.crear', 'agenda.editar'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const query = readQuery(
          context,
          z.object({ from: localDateSchema, to: localDateSchema, serviceId: idSchema, professionalId: idSchema.optional() }),
        );
        assertRange(query.from, query.to, MAX_AVAILABILITY_RANGE_DAYS);
        const services = context.get('services');
        const service = await services.catalog.getById(auth.tenant.id, query.serviceId);
        return context.json(
          await services.availability.findSlots(auth.tenant, {
            fromDate: query.from,
            toDate: query.to,
            durationMinutes: service.duration_minutes,
            professionalId: query.professionalId,
            applyPublicRules: false,
          }),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/appointments',
      access: requiresAny('agenda.crear'),
      handler: async (context) => {
        const input = await readJsonBody(context, newAppointmentSchema);
        return context.json(await context.get('services').appointments.create(actorOf(context), input), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/appointments/:id/reschedule',
      access: requiresAny('agenda.editar'),
      handler: async (context) => {
        const input = await readJsonBody(context, z.object({ startAt: localDateTimeSchema, professionalId: idSchema }));
        return context.json(
          await context
            .get('services')
            .appointments.reschedule(actorOf(context), readIdParam(context), input, agendaRestriction(requireAuth(context))),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/appointments/:id/status',
      access: requiresAny('agenda.cambiar_estado'),
      handler: async (context) => {
        const { status } = await readJsonBody(
          context,
          z.object({ status: z.enum(['pendiente', 'confirmada', 'atendida', 'no_asistio']) }),
        );
        return context.json(
          await context
            .get('services')
            .appointments.changeStatus(actorOf(context), readIdParam(context), status, agendaRestriction(requireAuth(context))),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/appointments/:id/cancel',
      access: requiresAny('agenda.cancelar'),
      handler: async (context) => {
        const { reason } = await readJsonBody(context, z.object({ reason: requiredText(200, 'El motivo') }));
        return context.json(
          await context
            .get('services')
            .appointments.cancel(actorOf(context), readIdParam(context), reason, agendaRestriction(requireAuth(context))),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/reminders',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const { date } = readQuery(
          context,
          z.object({ date: localDateSchema.default(addDays(todayLocal(auth.tenant.utc_offset_minutes), 1)) }),
        );
        const services = context.get('services');
        await services.maintenance.releaseExpiredHolds(auth.tenant.id);
        const appointments = await services.appointments.listForReminders(auth.tenant.id, date);
        const appSecret = context.get('config').appSecret;
        const template = auth.tenant.whatsapp_reminder_template || DEFAULT_REMINDER_TEMPLATE;
        const withLinks = await Promise.all(
          appointments.map(async (appointment) => {
            const manageUrl = buildManageUrl(context, auth.tenant.slug, await createAppointmentToken(appSecret, appointment.id));
            const whatsappMessage = renderTemplate(template, {
              nombre: appointment.patient_name.split(' ')[0],
              consultorio: auth.tenant.name,
              fecha: spanishDate(appointment.start_at.slice(0, 10)),
              hora: spanishTime(appointment.start_at),
              profesional: appointment.professional_name,
              servicio: appointment.service_name,
              enlace: manageUrl,
            });
            return {
              ...appointment,
              manageUrl,
              whatsappMessage,
              // null si el número no es un celular (no puede recibir WhatsApp).
              whatsappUrl: buildWhatsappLink(appointment.patient_phone, whatsappMessage),
            };
          }),
        );
        return context.json({ date, appointments: withLinks });
      },
    },
    {
      method: 'GET',
      path: '/api/verifications',
      access: requiresAny('agenda.verificar'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const services = context.get('services');
        await services.maintenance.releaseExpiredHolds(auth.tenant.id);
        return context.json(await services.appointments.listPendingVerifications(auth.tenant.id));
      },
    },
    {
      method: 'POST',
      path: '/api/appointments/:id/verify',
      access: requiresAny('agenda.verificar'),
      handler: async (context) => {
        const appointmentId = readIdParam(context);
        const { code } = await readJsonBody(context, z.object({ code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos.') }));
        await context.get('services').rateLimiter.consume(`verify:${appointmentId}`, VERIFY_RATE_LIMIT);
        return context.json(await context.get('services').appointments.verifyWithCode(actorOf(context), appointmentId, code));
      },
    },
    {
      method: 'POST',
      path: '/api/appointments/:id/reminder-sent',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) => {
        await context.get('services').appointments.markReminderSent(actorOf(context), readIdParam(context));
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/reactivation',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) =>
        context.json(await context.get('services').appointments.listReactivationCandidates(requireAuth(context).tenant)),
    },
    {
      method: 'GET',
      path: '/api/waitlist',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) => context.json(await context.get('services').waitlist.listActive(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/waitlist',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            patientId: idSchema,
            serviceId: idSchema.nullable().default(null),
            professionalId: idSchema.nullable().default(null),
            notes: optionalText(300),
          }),
        );
        return context.json({ id: await context.get('services').waitlist.add(actorOf(context), input) }, 201);
      },
    },
    {
      method: 'POST',
      path: '/api/waitlist/:id/resolve',
      access: requiresAny('recordatorios.gestionar'),
      handler: async (context) => {
        await context.get('services').waitlist.resolve(actorOf(context), readIdParam(context));
        return context.json({ ok: true });
      },
    },
  ]);
}

function assertRange(fromDate: string, toDate: string, maxDays: number): void {
  const rangeDays = daysBetween(fromDate, toDate);
  if (rangeDays < 0 || rangeDays > maxDays) {
    throw new AppError(`El rango de fechas debe ser de máximo ${maxDays} días.`, 400, 'INVALID_RANGE');
  }
}

export function buildManageUrl(context: AppContext, clinicSlug: string, token: string): string {
  return `${new URL(context.req.url).origin}/c/${encodeURIComponent(clinicSlug)}/cita/${encodeURIComponent(token)}`;
}
