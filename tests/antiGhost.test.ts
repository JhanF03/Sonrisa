/**
 * Pruebas de blindaje de reservas:
 *   • Triggers de la base contra dobles reservas (aunque se salte el código).
 *   • Retenciones que vencen y liberan el cupo al instante.
 *   • Verificación por WhatsApp con código.
 *   • Límite de reservas activas por persona (también en carreras).
 *   • Liberación automática por falta de confirmación.
 *   • Turnstile (anti-robots) y teléfonos para WhatsApp.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { DEFAULT_REMINDER_TEMPLATE, renderTemplate, validateReminderTemplate } from '../src/shared/messageTemplate.js';
import { normalizePhone, phoneKey, whatsappDigits } from '../src/utils/phone.js';
import { todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, nextBusinessDay, type TestClinic } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

let documentCounter = 50_000_000;
const nextDocument = () => String(documentCounter++);
const pastIso = () => new Date(Date.now() - 60_000).toISOString();

/** Días hábiles distintos dentro de la ventana de reservas en línea (30 días). */
let dayCursor = 2;
function nextDistinctDay(): string {
  const day = nextBusinessDay(dayCursor);
  dayCursor = Math.round((new Date(`${day}T00:00:00Z`).getTime() - new Date(`${todayLocal(-300)}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (dayCursor > 28) dayCursor = 2;
  return day;
}

function bookingBody(clinic: TestClinic, startAt: string, overrides: { document?: string; phone?: string; professionalId?: string | null } = {}) {
  return {
    serviceId: clinic.serviceId,
    professionalId: overrides.professionalId === undefined ? clinic.professionalId : overrides.professionalId,
    startAt,
    consentGiven: true,
    patient: {
      documentType: 'CC',
      documentNumber: overrides.document ?? nextDocument(),
      fullName: 'Paciente En Línea',
      phone: overrides.phone ?? `310${String(documentCounter).slice(-7)}`,
    },
  };
}

const defaultRules = { onlineVerificationMode: 'ninguna', verificationWindowMinutes: 60, maxPendingOnlinePerPatient: 2, autoReleaseHours: 0, paymentWindowMinutes: 30 };

describe('Blindaje de dobles reservas en la base de datos', () => {
  let env: TestEnvironment;
  let clinic: TestClinic;

  before(async () => {
    env = await createTestEnvironment();
    clinic = await env.createClinic('Consultorio Triggers', 'triggers@prueba.co');
  });

  const rawInsert = (id: string, startAt: string, endAt: string, holdExpiresAt: string | null = null) =>
    env.db
      .prepare(
        `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, start_at, end_at, hold_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x', 'x')`,
      )
      .bind(id, clinic.tenantId, clinic.patientId, clinic.professionalId, clinic.serviceId, startAt, endAt, holdExpiresAt)
      .run();

  it('rechaza una cita cruzada insertada directamente en la base (sin pasar por el código)', async () => {
    const date = nextBusinessDay(30);
    await rawInsert(crypto.randomUUID(), `${date}T08:00`, `${date}T09:00`);
    await assert.rejects(rawInsert(crypto.randomUUID(), `${date}T08:30`, `${date}T09:30`), /HORARIO_OCUPADO/);
    // Bordes que se tocan sin cruzarse sí se permiten.
    await rawInsert(crypto.randomUUID(), `${date}T09:00`, `${date}T10:00`);
  });

  it('rechaza mover una cita encima de otra con un UPDATE directo', async () => {
    const date = nextBusinessDay(31);
    const movingId = crypto.randomUUID();
    await rawInsert(crypto.randomUUID(), `${date}T14:00`, `${date}T15:00`);
    await rawInsert(movingId, `${date}T16:00`, `${date}T17:00`);
    await assert.rejects(
      env.db.prepare('UPDATE appointments SET start_at = ?, end_at = ? WHERE id = ?').bind(`${date}T14:30`, `${date}T15:30`, movingId).run(),
      /HORARIO_OCUPADO/,
    );
  });

  it('una retención vencida no ocupa el horario', async () => {
    const date = nextBusinessDay(32);
    await rawInsert(crypto.randomUUID(), `${date}T10:00`, `${date}T11:00`, pastIso());
    await rawInsert(crypto.randomUUID(), `${date}T10:00`, `${date}T11:00`);
  });

  it('el error del trigger se traduce en 409 legible, nunca en 500', async () => {
    const { Hono } = await import('hono');
    const { errorHandler } = await import('../src/http/middleware.js');
    const probe = new Hono();
    probe.get('/d1', () => {
      throw new Error('D1_ERROR: HORARIO_OCUPADO: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)');
    });
    probe.get('/sqlite', async () => {
      await rawInsert(crypto.randomUUID(), '2031-01-06T08:00', '2031-01-06T09:00');
      await rawInsert(crypto.randomUUID(), '2031-01-06T08:15', '2031-01-06T08:45');
      return new Response('no debería llegar');
    });
    probe.onError(errorHandler as never);
    for (const path of ['/d1', '/sqlite']) {
      const response = await probe.request(path);
      assert.equal(response.status, 409, path);
      assert.match(((await response.json()) as { error: { message: string } }).error.message, /ocupado/);
    }
  });
});

describe('Reservas fantasma', () => {
  let env: TestEnvironment;
  let clinic: TestClinic;
  let admin: string;

  before(async () => {
    env = await createTestEnvironment();
    clinic = await env.createClinic('Consultorio Fantasma', 'fantasma@prueba.co');
    admin = await env.login(clinic.adminEmail);
  });

  const setRules = (rules: Partial<typeof defaultRules>) =>
    env.request('PUT', '/api/settings/booking-rules', { cookie: admin, body: { ...defaultRules, ...rules } });
  const book = (body: unknown, ip = `ip-${Math.random()}`) =>
    env.request('POST', `/api/public/clinics/${clinic.slug}/appointments`, { headers: { 'X-Real-IP': ip }, body });
  const expireHolds = () => env.db.prepare('UPDATE appointments SET hold_expires_at = ? WHERE hold_expires_at IS NOT NULL').bind(pastIso()).run();

  describe('Verificación por WhatsApp', () => {
    it('exige el número de WhatsApp del consultorio antes de activarla', async () => {
      const response = await setRules({ onlineVerificationMode: 'whatsapp' });
      assert.equal(response.status, 422);
      assert.equal(response.json.error.code, 'WHATSAPP_REQUIRED');
    });

    it('rechaza números de WhatsApp que no son celulares', async () => {
      const landline = await env.request('PUT', '/api/settings/whatsapp', { cookie: admin, body: { whatsappNumber: '604 444 5555', reminderTemplate: null } });
      assert.equal(landline.status, 400);
      const mobile = await env.request('PUT', '/api/settings/whatsapp', { cookie: admin, body: { whatsappNumber: '300 765 4321', reminderTemplate: null } });
      assert.equal(mobile.status, 200);
      assert.equal(mobile.json.whatsapp_number, '+573007654321');
    });

    it('la reserva queda retenida con un código y un enlace al WhatsApp del consultorio', async () => {
      assert.equal((await setRules({ onlineVerificationMode: 'whatsapp', verificationWindowMinutes: 30 })).status, 200);
      const date = nextDistinctDay();
      const response = await book(bookingBody(clinic, `${date}T09:00`));
      assert.equal(response.status, 201, response.text);

      const { verification, appointment } = response.json;
      assert.match(verification.code, /^\d{6}$/);
      assert.equal(appointment.holdReason, 'verificacion');
      const whatsappUrl = new URL(verification.whatsappUrl);
      assert.equal(whatsappUrl.origin + whatsappUrl.pathname, 'https://wa.me/573007654321');
      assert.match(whatsappUrl.searchParams.get('text') ?? '', new RegExp(verification.code));

      // No aparece en recordatorios (aún no es una reserva real), sí en "por verificar".
      const reminders = await env.request('GET', `/api/reminders?date=${date}`, { cookie: admin });
      assert.equal(reminders.json.appointments.length, 0);
      const pending = await env.request('GET', '/api/verifications', { cookie: admin });
      assert.equal(pending.json.length, 1);

      // El paciente no puede "confirmar" con el enlace sin verificar por WhatsApp.
      const confirm = await env.request('POST', `/api/public/appointments/${encodeURIComponent(response.json.token)}/confirm`, { headers: { 'X-Real-IP': 'v1' } });
      assert.equal(confirm.status, 422);

      const wrong = await env.request('POST', `/api/appointments/${pending.json[0].id}/verify`, { cookie: admin, body: { code: '000000' === verification.code ? '111111' : '000000' } });
      assert.equal(wrong.status, 422);
      const right = await env.request('POST', `/api/appointments/${pending.json[0].id}/verify`, { cookie: admin, body: { code: verification.code } });
      assert.equal(right.status, 200, right.text);
      assert.equal(right.json.status, 'confirmada');
      assert.equal(right.json.hold_reason, null);
    });

    it('limita los intentos de código para que no se pueda adivinar', async () => {
      const response = await book(bookingBody(clinic, `${nextDistinctDay()}T09:00`));
      const pending = await env.request('GET', '/api/verifications', { cookie: admin });
      const target = pending.json.find((item: { verification_code: string }) => item.verification_code === response.json.verification.code);
      const wrongCode = response.json.verification.code === '123456' ? '654321' : '123456';
      let lastStatus = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        lastStatus = (await env.request('POST', `/api/appointments/${target.id}/verify`, { cookie: admin, body: { code: wrongCode } })).status;
      }
      assert.equal(lastStatus, 429);
    });

    it('si no se verifica a tiempo, el horario se libera al instante', async () => {
      const startAt = `${nextDistinctDay()}T10:00`;
      assert.equal((await book(bookingBody(clinic, startAt))).status, 201);
      assert.equal((await book(bookingBody(clinic, startAt))).status, 409, 'Mientras está retenida, el horario está ocupado');
      await expireHolds();
      assert.equal((await book(bookingBody(clinic, startAt))).status, 201, 'Vencida la retención, el horario vuelve a estar libre');
    });

    it('recepción no puede reprogramar una reserva que espera verificación', async () => {
      const response = await book(bookingBody(clinic, `${nextDistinctDay()}T11:00`));
      const pending = await env.request('GET', '/api/verifications', { cookie: admin });
      const target = pending.json.find((item: { verification_code: string }) => item.verification_code === response.json.verification.code);
      const move = await env.request('PUT', `/api/appointments/${target.id}/reschedule`, {
        cookie: admin,
        body: { startAt: `${nextDistinctDay()}T14:00`, professionalId: clinic.professionalId },
      });
      assert.equal(move.status, 422);
      assert.equal(move.json.error.code, 'AWAITING_PATIENT');
      await setRules({ onlineVerificationMode: 'ninguna' });
    });
  });

  describe('Límite de reservas activas por persona', () => {
    it('bloquea la tercera reserva del mismo documento y también la del mismo celular con otro documento', async () => {
      await setRules({ maxPendingOnlinePerPatient: 2 });
      const document = nextDocument();
      const phone = '3151112233';
      const day = nextDistinctDay();
      assert.equal((await book(bookingBody(clinic, `${day}T08:00`, { document, phone }))).status, 201);
      assert.equal((await book(bookingBody(clinic, `${day}T09:00`, { document, phone }))).status, 201);

      const third = await book(bookingBody(clinic, `${day}T10:00`, { document, phone }));
      assert.equal(third.status, 409);
      assert.equal(third.json.error.code, 'BOOKING_LIMIT');

      const samePhoneOtherDocument = await book(bookingBody(clinic, `${day}T11:00`, { phone: '+57 315 111 2233' }));
      assert.equal(samePhoneOtherDocument.status, 409, 'Mismo celular en otro formato también cuenta');
      assert.equal(samePhoneOtherDocument.json.error.code, 'BOOKING_LIMIT');
    });

    it('en reservas simultáneas de la misma persona respeta el límite exacto (atómico)', async () => {
      await setRules({ maxPendingOnlinePerPatient: 2 });
      const document = nextDocument();
      const phone = '3164445566';
      const day = nextDistinctDay();
      const times = ['08:00', '09:00', '10:00', '11:00', '14:00', '15:00'];
      const results = await Promise.all(times.map((time, index) => book(bookingBody(clinic, `${day}T${time}`, { document, phone }), `carrera-${index}`)));
      assert.equal(results.filter((result) => result.status === 201).length, 2);
      assert.ok(results.every((result) => result.status === 201 || result.json.error.code === 'BOOKING_LIMIT'));
    });

    it('las citas canceladas o vencidas no cuentan para el límite', async () => {
      await setRules({ maxPendingOnlinePerPatient: 1 });
      const document = nextDocument();
      const phone = '3177778899';
      const day = nextDistinctDay();
      const first = await book(bookingBody(clinic, `${day}T08:00`, { document, phone }));
      assert.equal(first.status, 201);
      assert.equal((await book(bookingBody(clinic, `${day}T09:00`, { document, phone }))).status, 409);
      await env.request('POST', `/api/public/appointments/${encodeURIComponent(first.json.token)}/cancel`, { headers: { 'X-Real-IP': 'cancela' } });
      assert.equal((await book(bookingBody(clinic, `${day}T09:00`, { document, phone }))).status, 201);
      await setRules({ maxPendingOnlinePerPatient: 2 });
    });
  });

  describe('Liberación automática por falta de confirmación', () => {
    it('retiene la cita hasta el límite, la confirma con el enlace y libera las no confirmadas', async () => {
      await setRules({ autoReleaseHours: 24 });
      const day = nextDistinctDay();
      const confirmed = await book(bookingBody(clinic, `${day}T14:00`));
      const ghost = await book(bookingBody(clinic, `${day}T15:00`));
      assert.equal(confirmed.json.appointment.holdReason, 'confirmacion');

      // Las retenciones por confirmación SÍ aparecen en recordatorios (son el objetivo).
      const reminders = await env.request('GET', `/api/reminders?date=${day}`, { cookie: admin });
      assert.equal(reminders.json.appointments.filter((item: { hold_reason: string }) => item.hold_reason === 'confirmacion').length, 2);

      const confirmResponse = await env.request('POST', `/api/public/appointments/${encodeURIComponent(confirmed.json.token)}/confirm`, { headers: { 'X-Real-IP': 'c1' } });
      assert.equal(confirmResponse.json.appointment.status, 'confirmada');
      assert.equal(confirmResponse.json.appointment.holdReason, null);

      await expireHolds();
      const released = await env.app.services.maintenance.runScheduled();
      assert.ok(released.releasedHolds >= 1);

      const ghostView = await env.request('GET', `/api/public/appointments/${encodeURIComponent(ghost.json.token)}`, { headers: { 'X-Real-IP': 'c2' } });
      assert.equal(ghostView.json.appointment.status, 'cancelada');
      const confirmedView = await env.request('GET', `/api/public/appointments/${encodeURIComponent(confirmed.json.token)}`, { headers: { 'X-Real-IP': 'c3' } });
      assert.equal(confirmedView.json.appointment.status, 'confirmada', 'La confirmada no se libera');

      const audit = await env.request('GET', '/api/audit', { cookie: admin });
      assert.ok(audit.json.some((entry: { action: string }) => entry.action === 'reserva_liberada'));
      await setRules({ autoReleaseHours: 0 });
    });
  });

  describe('Otros refuerzos', () => {
    it('la reserva en línea exige un celular (WhatsApp), no un fijo', async () => {
      const response = await book(bookingBody(clinic, `${nextDistinctDay()}T08:00`, { phone: '604 444 5555' }));
      assert.equal(response.status, 400);
    });

    it('crear un bloqueo avisa cuántas citas quedan afectadas', async () => {
      const day = nextDistinctDay();
      await book(bookingBody(clinic, `${day}T09:00`));
      const block = await env.request('POST', '/api/time-blocks', {
        cookie: admin,
        body: { professionalId: clinic.professionalId, startAt: `${day}T08:00`, endAt: `${day}T12:00`, reason: 'Congreso' },
      });
      assert.equal(block.status, 201);
      assert.equal(block.json.affectedAppointments, 1);
    });

    it('los recordatorios traen el mensaje listo y no ofrecen WhatsApp a teléfonos fijos', async () => {
      const day = nextDistinctDay();
      const landlinePatient = await env.request('POST', '/api/patients', {
        cookie: admin,
        body: { documentType: 'CC', documentNumber: nextDocument(), fullName: 'Fijo Paciente', phone: '6044445555', consentGiven: true },
      });
      await env.request('POST', '/api/appointments', {
        cookie: admin,
        body: { patientId: landlinePatient.json.id, professionalId: clinic.secondProfessionalId, serviceId: clinic.serviceId, startAt: `${day}T08:00` },
      });
      await env.request('POST', '/api/appointments', {
        cookie: admin,
        body: { patientId: clinic.patientId, professionalId: clinic.secondProfessionalId, serviceId: clinic.serviceId, startAt: `${day}T10:00` },
      });
      const reminders = await env.request('GET', `/api/reminders?date=${day}`, { cookie: admin });
      const landline = reminders.json.appointments.find((item: { patient_name: string }) => item.patient_name === 'Fijo Paciente');
      const mobile = reminders.json.appointments.find((item: { patient_id: string }) => item.patient_id === clinic.patientId);
      assert.equal(landline.whatsappUrl, null);
      assert.match(mobile.whatsappUrl, /^https:\/\/wa\.me\/573001234567\?text=/);
      assert.ok(mobile.whatsappMessage.includes(mobile.manageUrl));
    });

    it('valida la plantilla de recordatorio (debe incluir {enlace} y solo variables conocidas)', async () => {
      const missingLink = await env.request('PUT', '/api/settings/whatsapp', { cookie: admin, body: { whatsappNumber: '3007654321', reminderTemplate: 'Hola {nombre}' } });
      assert.equal(missingLink.status, 400);
      const unknown = await env.request('PUT', '/api/settings/whatsapp', { cookie: admin, body: { whatsappNumber: '3007654321', reminderTemplate: '{nombre} {enlace} {precio}' } });
      assert.equal(unknown.status, 400);
      const ok = await env.request('PUT', '/api/settings/whatsapp', {
        cookie: admin,
        body: { whatsappNumber: '3007654321', reminderTemplate: 'Hola {nombre}, tu cita es el {fecha} a las {hora}. Confirma: {enlace}' },
      });
      assert.equal(ok.status, 200);
    });
  });
});

describe('Turnstile (anti-robots opcional)', () => {
  it('exige y verifica el token cuando está activo', async () => {
    const verifyRequests: Array<Record<string, string>> = [];
    let nextResult = false;
    const env = await createTestEnvironment({
      turnstile: { siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' },
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
        verifyRequests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: nextResult }), { status: 200 });
      },
    });
    const clinic = await env.createClinic('Consultorio Turnstile', 'turnstile@prueba.co');
    const publicClinic = await env.request('GET', `/api/public/clinics/${clinic.slug}`);
    assert.equal(publicClinic.json.turnstileSiteKey, '1x00000000000000000000AA');

    const startAt = `${nextDistinctDay()}T09:00`;
    const book = (token?: string) =>
      env.request('POST', `/api/public/clinics/${clinic.slug}/appointments`, {
        headers: { 'X-Real-IP': `t-${Math.random()}` },
        body: { ...bookingBody(clinic, startAt), turnstileToken: token },
      });

    assert.equal((await book()).status, 400, 'Sin token');
    assert.equal((await book('token-falso')).status, 400, 'Token rechazado por Cloudflare');
    nextResult = true;
    assert.equal((await book('XXXX.DUMMY.TOKEN.XXXX')).status, 201);
    assert.equal(verifyRequests.at(-1)?.secret, '1x0000000000000000000000000000000AA');
    assert.equal(verifyRequests.at(-1)?.response, 'XXXX.DUMMY.TOKEN.XXXX');
  });
});

describe('Teléfonos y plantillas', () => {
  it('normaliza números colombianos y detecta si pueden recibir WhatsApp', () => {
    assert.deepEqual(normalizePhone('300 123 4567'), { e164: '+573001234567', isMobile: true });
    assert.deepEqual(normalizePhone('(604) 444-5555'), { e164: '+576044445555', isMobile: false });
    assert.deepEqual(normalizePhone('+57 300 123 4567'), { e164: '+573001234567', isMobile: true });
    assert.deepEqual(normalizePhone('573001234567'), { e164: '+573001234567', isMobile: true });
    assert.deepEqual(normalizePhone('+1 305 555 0101'), { e164: '+13055550101', isMobile: true });
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('+57 123'), null);
    assert.equal(whatsappDigits('6044445555'), null);
    assert.equal(phoneKey('+573001234567'), phoneKey('300 123 4567'));
  });

  it('valida y llena las plantillas', () => {
    assert.deepEqual(validateReminderTemplate(DEFAULT_REMINDER_TEMPLATE), []);
    assert.ok(validateReminderTemplate('sin enlace').length > 0);
    const message = renderTemplate('Hola {nombre}: {enlace} {otra}', {
      nombre: 'Ana', consultorio: 'C', fecha: 'f', hora: 'h', profesional: 'p', servicio: 's', enlace: 'https://x',
    });
    assert.equal(message, 'Hola Ana: https://x {otra}');
  });
});
