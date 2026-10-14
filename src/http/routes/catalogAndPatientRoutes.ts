/**
 * Catálogo de servicios y pacientes.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { nowLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { agendaRestriction } from '../scope.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import {
  colombianPhoneSchema,
  documentTypeSchema,
  localDateSchema,
  moneySchema,
  optionalText,
  paginationSchema,
  readIdParam,
  readJsonBody,
  readQuery,
  requiredText,
} from '../validation.js';

const serviceSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/, 'Código inválido (letras, números o guiones; máx. 12).'),
  name: requiredText(120, 'El nombre'),
  category: optionalText(60),
  price: moneySchema,
  durationMinutes: z.number().int().min(5).max(480),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  isBookableOnline: z.boolean().default(true),
  isActive: z.boolean().default(true),
  prepaymentMode: z.enum(['ninguno', 'porcentaje', 'valor']).default('ninguno'),
  prepaymentValue: moneySchema.default(0),
});

export const patientSchema = z.object({
  documentType: documentTypeSchema,
  documentNumber: z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/, 'Número de documento inválido.'),
  fullName: requiredText(120, 'El nombre'),
  phone: colombianPhoneSchema,
  email: z.email('Correo inválido.').max(200).nullable().optional().transform((value) => value ?? null),
  birthDate: localDateSchema.nullable().optional().transform((value) => value ?? null),
  guardianName: optionalText(120),
  guardianPhone: optionalText(30),
  adminNotes: optionalText(1000),
});

export function registerCatalogAndPatientRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/services',
      access: requiresAny('servicios.ver', 'agenda.crear', 'cartera.cargo.crear'),
      handler: async (context) =>
        context.json(await context.get('services').catalog.list(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/services',
      access: requiresAny('servicios.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(context, serviceSchema);
        return context.json(await context.get('services').catalog.create(actorOf(context), input), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/services/:id',
      access: requiresAny('servicios.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(context, serviceSchema);
        return context.json(await context.get('services').catalog.update(actorOf(context), readIdParam(context), input));
      },
    },
    {
      method: 'GET',
      path: '/api/patients',
      access: requiresAny('pacientes.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const query = readQuery(context, paginationSchema.extend({ q: z.string().max(100).optional() }));
        return context.json(
          await context.get('services').patients.search(auth.tenant.id, {
            query: query.q,
            limit: query.limit,
            offset: query.offset,
            nowLocal: nowLocal(auth.tenant.utc_offset_minutes),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/patients/export',
      access: requiresAny('pacientes.exportar'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const patients = await context.get('services').patients.search(auth.tenant.id, {
          limit: 10_000,
          offset: 0,
          nowLocal: nowLocal(auth.tenant.utc_offset_minutes),
        });
        await context.get('services').audit.record(actorOf(context), {
          action: 'pacientes_exportados', entity: 'paciente', details: { total: patients.length },
        });
        return context.json(patients);
      },
    },
    {
      method: 'POST',
      path: '/api/patients',
      access: requiresAny('pacientes.crear'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          patientSchema.extend({ consentGiven: z.literal(true, { error: 'Registra la autorización de tratamiento de datos.' }) }),
        );
        const auth = requireAuth(context);
        const patient = await context.get('services').patients.create(actorOf(context), input, {
          version: auth.tenant.privacy_policy_version,
          channel: 'presencial',
        });
        return context.json(patient, 201);
      },
    },
    {
      method: 'GET',
      path: '/api/patients/:id',
      access: requiresAny('pacientes.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const patientId = readIdParam(context);
        const services = context.get('services');
        const [patient, appointments] = await Promise.all([
          services.patients.getById(auth.tenant.id, patientId),
          services.appointments.listForPatient(auth.tenant.id, patientId),
        ]);
        // Un odontólogo con agenda propia solo ve las citas que atiende.
        const restriction = agendaRestriction(auth);
        const visibleAppointments = restriction
          ? appointments.filter((appointment) => appointment.professional_id === restriction)
          : appointments;
        return context.json({ patient, appointments: visibleAppointments });
      },
    },
    {
      method: 'PUT',
      path: '/api/patients/:id',
      access: requiresAny('pacientes.editar'),
      handler: async (context) => {
        const input = await readJsonBody(context, patientSchema);
        return context.json(await context.get('services').patients.update(actorOf(context), readIdParam(context), input));
      },
    },
  ]);
}
