/**
 * Rutas públicas (sin sesión) para pacientes: ver el consultorio, consultar
 * horarios, reservar (con verificación o pago si aplica) y gestionar su cita
 * con un enlace firmado.
 *
 * Protecciones: límite de peticiones por IP, campo trampa contra bots,
 * Turnstile opcional, límite de reservas activas por persona, validación
 * estricta y respuestas con datos mínimos (privacidad).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { isHoldExpired, isTenantSuspended, type AppointmentRow } from '../../modules/appointments/appointmentService.js';
import { MAX_AVAILABILITY_RANGE_DAYS } from '../../modules/appointments/availabilityService.js';
import { computePrepaymentAmount } from '../../modules/catalog/catalogService.js';
import { createAppointmentToken, verifyAppointmentToken } from '../../security/appointmentLinks.js';
import { RATE_LIMIT_RULES } from '../../security/rateLimiter.js';
import { spanishDate, spanishTime } from '../../shared/messageTemplate.js';
import { buildWhatsappLink } from '../../utils/phone.js';
import { daysBetween, minutesBetween } from '../../utils/time.js';
import type { AppContext, AppEnv, TenantRow } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { defineRoutes, publicAccess } from '../routeRegistry.js';
import {
  documentTypeSchema,
  idSchema,
  localDateSchema,
  localDateTimeSchema,
  readJsonBody,
  readQuery,
  requiredText,
  whatsappPhoneSchema,
} from '../validation.js';
import { buildManageUrl } from './appointmentRoutes.js';

const slugSchema = z.string().regex(/^[a-z0-9-]{2,60}$/, 'Consultorio inválido.');

const bookingSchema = z.object({
  serviceId: idSchema,
  professionalId: idSchema.nullable().default(null),
  startAt: localDateTimeSchema,
  patient: z.object({
    documentType: documentTypeSchema,
    documentNumber: z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/, 'Número de documento inválido.'),
    fullName: requiredText(120, 'El nombre'),
    // Celular obligatorio: es el canal de confirmación y verificación.
    phone: whatsappPhoneSchema,
    email: z.email('Correo inválido.').max(200).nullable().optional().transform((value) => value ?? null),
  }),
  consentGiven: z.literal(true, { error: 'Debes autorizar el tratamiento de tus datos para reservar.' }),
  /** Campo trampa: invisible para personas; los bots suelen llenarlo. */
  website: z.string().max(0, 'Solicitud inválida.').optional(),
  turnstileToken: z.string().max(2048).optional(),
});

export function registerPublicRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/public/clinics/:slug',
      access: publicAccess,
      handler: async (context) => {
        const tenant = await loadPublicTenant(context);
        const services = context.get('services');
        const [catalog, professionals, paymentsEnabled, policyText] = await Promise.all([
          services.catalog.list(tenant.id, { onlyActive: true, onlyBookableOnline: true }),
          services.professionals.list(tenant.id, { onlyActive: true }),
          services.payments.isEnabled(tenant.id),
          services.payments.getPolicyText(tenant.id),
        ]);
        return context.json({
          name: tenant.name,
          slug: tenant.slug,
          brandColor: tenant.brand_color,
          logoUrl: tenant.logo_url,
          favicon: tenant.favicon,
          phone: tenant.phone,
          whatsappNumber: tenant.whatsapp_number,
          address: tenant.address,
          city: tenant.city,
          onlineBookingEnabled: tenant.online_booking_enabled === 1 && !isTenantSuspended(tenant),
          bookingWindowDays: tenant.booking_window_days,
          privacyPolicyVersion: tenant.privacy_policy_version,
          isShowcase: tenant.is_showcase === 1,
          verificationMode: tenant.online_verification_mode,
          verificationWindowMinutes: tenant.verification_window_minutes,
          paymentWindowMinutes: tenant.payment_window_minutes,
          paymentPolicyText: paymentsEnabled ? policyText : null,
          turnstileSiteKey: context.get('config').turnstileSiteKey || null,
          // Los servicios con anticipo solo se ofrecen si el pago en línea está activo.
          services: catalog
            .map((service) => ({ service, prepaymentAmount: computePrepaymentAmount(service) }))
            .filter(({ prepaymentAmount }) => prepaymentAmount === 0 || paymentsEnabled)
            .map(({ service, prepaymentAmount }) => ({
              id: service.id,
              name: service.name,
              category: service.category,
              price: service.price,
              durationMinutes: service.duration_minutes,
              prepaymentAmount,
            })),
          professionals: professionals.map((professional) => ({
            id: professional.id,
            fullName: professional.full_name,
            specialty: professional.specialty,
          })),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/public/clinics/:slug/availability',
      access: publicAccess,
      handler: async (context) => {
        const tenant = await loadPublicTenant(context);
        const query = readQuery(
          context,
          z.object({ from: localDateSchema, to: localDateSchema, serviceId: idSchema, professionalId: idSchema.optional() }),
        );
        assertPublicRange(query.from, query.to);
        const services = context.get('services');
        const service = await services.catalog.getById(tenant.id, query.serviceId);
        if (service.is_active !== 1 || service.is_bookable_online !== 1) throw notFound('El servicio');

        const slots = await services.availability.findSlots(tenant, {
          fromDate: query.from,
          toDate: query.to,
          durationMinutes: service.duration_minutes,
          professionalId: query.professionalId,
          applyPublicRules: true,
        });
        return context.json(slots);
      },
    },
    {
      method: 'POST',
      path: '/api/public/clinics/:slug/appointments',
      access: publicAccess,
      handler: async (context) => {
        const services = context.get('services');
        const clientIp = context.get('clientIp');
        await services.rateLimiter.consume(`booking:${clientIp}`, RATE_LIMIT_RULES.publicBookingPerIp);
        const tenant = await loadPublicTenant(context);
        const input = await readJsonBody(context, bookingSchema);
        // Turnstile después de validar: el token es de un solo uso.
        await services.turnstile.assertHuman(input.turnstileToken, clientIp);

        const onlinePaymentsEnabled = await services.payments.isEnabled(tenant.id);
        const appointment = await services.appointments.bookOnline(tenant, input, clientIp, { onlinePaymentsEnabled });
        const origin = new URL(context.req.url).origin;
        const token = await createAppointmentToken(context.get('config').appSecret, appointment.id);
        const manageUrl = buildManageUrl(context, tenant.slug, token);

        if (appointment.hold_reason === 'pago') {
          try {
            const { checkoutUrl, statusToken, amount, holdExpiresAt } = await services.payments.createCheckout(tenant, appointment.id, origin);
            return context.json({ appointment: toPublicAppointment(appointment), payment: { checkoutUrl, statusToken, amount, holdExpiresAt } }, 201);
          } catch (error) {
            // Si no se pudo preparar el pago, se libera el horario de inmediato.
            await services.appointments.releasePaymentHold(tenant, appointment.id, clientIp, 'No se pudo iniciar el pago en línea');
            throw error;
          }
        }

        return context.json(
          {
            appointment: toPublicAppointment(appointment),
            token,
            manageUrl,
            verification: appointment.hold_reason === 'verificacion' ? buildVerification(tenant, appointment) : null,
          },
          201,
        );
      },
    },
    {
      method: 'GET',
      path: '/api/public/appointments/:token',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        return context.json({
          clinic: toPublicClinic(tenant),
          appointment: toPublicAppointment(appointment),
          verification: appointment.hold_reason === 'verificacion' && !isHoldExpired(appointment) ? buildVerification(tenant, appointment) : null,
          paymentUrl: appointment.hold_reason === 'pago' && !isHoldExpired(appointment) ? await latestPaymentUrl(context, tenant, appointment.id) : null,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/public/appointments/:token/confirm',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        const updated = await context.get('services').appointments.confirmByPatient(tenant, appointment.id, context.get('clientIp'));
        return context.json({ appointment: toPublicAppointment(updated) });
      },
    },
    {
      method: 'POST',
      path: '/api/public/appointments/:token/cancel',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        const updated = await context.get('services').appointments.cancelByPatient(tenant, appointment.id, context.get('clientIp'));
        return context.json({ appointment: toPublicAppointment(updated) });
      },
    },
    {
      method: 'POST',
      path: '/api/public/appointments/:token/reschedule',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        const { startAt } = await readJsonBody(context, z.object({ startAt: localDateTimeSchema }));
        const updated = await context
          .get('services')
          .appointments.rescheduleByPatient(tenant, appointment.id, startAt, context.get('clientIp'));
        return context.json({ appointment: toPublicAppointment(updated) });
      },
    },
    {
      method: 'GET',
      path: '/api/public/appointments/:token/availability',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        const query = readQuery(context, z.object({ from: localDateSchema, to: localDateSchema }));
        assertPublicRange(query.from, query.to);
        const slots = await context.get('services').availability.findSlots(tenant, {
          fromDate: query.from,
          toDate: query.to,
          durationMinutes: minutesBetween(appointment.start_at, appointment.end_at),
          professionalId: appointment.professional_id,
          excludeAppointmentId: appointment.id,
          applyPublicRules: true,
        });
        return context.json(slots);
      },
    },
    {
      method: 'GET',
      path: '/api/public/appointments/:token/calendar.ics',
      access: publicAccess,
      handler: async (context) => {
        const { tenant, appointment } = await loadAppointmentFromToken(context);
        return new Response(buildIcsFile(tenant, appointment), {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': 'attachment; filename="cita.ics"',
          },
        });
      },
    },
  ]);
}

function assertPublicRange(from: string, to: string): void {
  const rangeDays = daysBetween(from, to);
  if (rangeDays < 0 || rangeDays > MAX_AVAILABILITY_RANGE_DAYS) {
    throw new AppError('Rango de fechas inválido.', 400, 'INVALID_RANGE');
  }
}

export async function loadPublicTenant(context: AppContext): Promise<TenantRow> {
  await context.get('services').rateLimiter.consume(`public:${context.get('clientIp')}`, RATE_LIMIT_RULES.publicLookupPerIp);
  const slug = slugSchema.parse(context.req.param('slug'));
  const tenant = await context.get('services').tenants.getBySlug(slug);
  if (!tenant) throw notFound('El consultorio');
  return tenant;
}

async function loadAppointmentFromToken(context: AppContext): Promise<{ tenant: TenantRow; appointment: AppointmentRow }> {
  const services = context.get('services');
  await services.rateLimiter.consume(`public:${context.get('clientIp')}`, RATE_LIMIT_RULES.publicLookupPerIp);

  const appointmentId = await verifyAppointmentToken(context.get('config').appSecret, context.req.param('token') ?? '');
  if (!appointmentId) throw notFound('La cita');

  const ownerRow = await context
    .get('db')
    .prepare('SELECT tenant_id FROM appointments WHERE id = ?')
    .bind(appointmentId)
    .first<{ tenant_id: string }>();
  if (!ownerRow) throw notFound('La cita');

  const tenant = await services.tenants.getById(ownerRow.tenant_id);
  const appointment = await services.appointments.getById(tenant.id, appointmentId);
  return { tenant, appointment };
}

async function latestPaymentUrl(context: AppContext, tenant: TenantRow, appointmentId: string): Promise<string | null> {
  const intent = await context
    .get('db')
    .prepare('SELECT id FROM payment_intents WHERE tenant_id = ? AND appointment_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(tenant.id, appointmentId)
    .first<{ id: string }>();
  if (!intent) return null;
  const token = await context.get('services').payments.createStatusToken(intent.id);
  return `${new URL(context.req.url).origin}/c/${encodeURIComponent(tenant.slug)}/pago/${encodeURIComponent(token)}`;
}

/** Mensaje con código que el paciente envía al WhatsApp del consultorio. */
function buildVerification(tenant: TenantRow, appointment: AppointmentRow) {
  const message =
    `Hola ${tenant.name}, soy ${appointment.patient_name}. Confirmo mi cita del ${spanishDate(appointment.start_at.slice(0, 10))} ` +
    `a las ${spanishTime(appointment.start_at)} (${appointment.service_name}). Mi código es ${appointment.verification_code}.`;
  return {
    code: appointment.verification_code,
    expiresAt: appointment.hold_expires_at,
    whatsappUrl: tenant.whatsapp_number ? buildWhatsappLink(tenant.whatsapp_number, message) : null,
  };
}

/** Solo lo necesario para el paciente: sin teléfono ni datos de otros. */
export function toPublicAppointment(appointment: AppointmentRow) {
  const holdIsActive = appointment.hold_reason !== null && !isHoldExpired(appointment);
  return {
    startAt: appointment.start_at,
    endAt: appointment.end_at,
    // Una retención vencida se muestra como cancelada aunque la limpieza no haya pasado aún.
    status: appointment.hold_reason !== null && !holdIsActive && appointment.status === 'pendiente' ? 'cancelada' : appointment.status,
    serviceName: appointment.service_name,
    professionalName: appointment.professional_name,
    patientFirstName: appointment.patient_name.split(' ')[0],
    holdReason: holdIsActive ? appointment.hold_reason : null,
    holdExpiresAt: holdIsActive ? appointment.hold_expires_at : null,
    prepaymentAmount: appointment.prepayment_amount,
  };
}

export function toPublicClinic(tenant: TenantRow) {
  return {
    name: tenant.name,
    slug: tenant.slug,
    brandColor: tenant.brand_color,
    logoUrl: tenant.logo_url,
    favicon: tenant.favicon,
    phone: tenant.phone,
    whatsappNumber: tenant.whatsapp_number,
    address: tenant.address,
    city: tenant.city,
  };
}

/** Archivo .ics estándar para agregar la cita a Google Calendar, Outlook o el celular. */
export function buildIcsFile(tenant: TenantRow, appointment: AppointmentRow): string {
  const toUtcStamp = (localDateTime: string) => {
    const utcMs = new Date(`${localDateTime}:00Z`).getTime() - tenant.utc_offset_minutes * 60_000;
    return new Date(utcMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const escapeIcs = (value: string) => value.replace(/[\\;,]/g, (character) => `\\${character}`).replace(/\r?\n/g, '\\n');
  const location = [tenant.address, tenant.city].filter(Boolean).join(', ');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agenda Sonrisa//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@agenda-sonrisa`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${toUtcStamp(appointment.start_at)}`,
    `DTEND:${toUtcStamp(appointment.end_at)}`,
    `SUMMARY:${escapeIcs(`${appointment.service_name} - ${tenant.name}`)}`,
    `DESCRIPTION:${escapeIcs(`Cita con ${appointment.professional_name}.${tenant.phone ? ` Teléfono: ${tenant.phone}` : ''}`)}`,
    location ? `LOCATION:${escapeIcs(location)}` : '',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Recordatorio de cita',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}
