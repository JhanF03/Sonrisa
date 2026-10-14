/**
 * Pruebas de reglas de negocio: disponibilidad, dobles reservas, recurrencia,
 * cartera (cargos, abonos, anticipos, anulaciones), festivos e indicadores.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { calculateEasterSunday, getColombianHolidays } from '../src/utils/colombianHolidays.js';
import { addDays, todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, nextBusinessDay, type TestClinic } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

describe('Reglas de negocio', () => {
  let env: TestEnvironment;
  let clinic: TestClinic;
  let admin: string;

  before(async () => {
    env = await createTestEnvironment();
    clinic = await env.createClinic('Consultorio Negocio', 'admin-negocio@prueba.co');
    admin = await env.login(clinic.adminEmail);
  });

  const createAppointment = (startAt: string, professionalId = clinic.professionalId) =>
    env.request('POST', '/api/appointments', {
      cookie: admin,
      body: { patientId: clinic.patientId, professionalId, serviceId: clinic.serviceId, startAt },
    });

  describe('Festivos de Colombia', () => {
    it('calcula la Pascua y los festivos trasladables de 2026', () => {
      assert.equal(calculateEasterSunday(2026), '2026-04-05');
      const holidays = getColombianHolidays(2026);
      for (const expected of ['2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03', '2026-05-18', '2026-06-08', '2026-06-15', '2026-07-20', '2026-08-07', '2026-10-12', '2026-12-08', '2026-12-25']) {
        assert.ok(holidays.has(expected), `Falta el festivo ${expected}`);
      }
      assert.equal(holidays.size, 18);
    });
  });

  describe('Disponibilidad', () => {
    it('respeta el horario, la pausa de almuerzo y las citas existentes', async () => {
      const date = nextBusinessDay(14);
      await createAppointment(`${date}T08:00`);

      const response = await env.request(
        'GET',
        `/api/availability?from=${date}&to=${date}&serviceId=${clinic.serviceId}&professionalId=${clinic.professionalId}`,
        { cookie: admin },
      );
      const starts = response.json.map((slot: { start: string }) => slot.start.slice(11));
      assert.ok(!starts.includes('08:00'), 'El espacio ocupado no debe aparecer');
      assert.ok(!starts.includes('08:30'), 'Un servicio de 60 min no cabe a las 08:30 si hay cita a las 08:00');
      assert.ok(starts.includes('09:00'));
      assert.ok(!starts.includes('11:30'), 'Un servicio de 60 min no cabe a las 11:30 (cierra a las 12:00)');
      assert.ok(!starts.includes('12:00') && !starts.includes('13:00'), 'La pausa de almuerzo no debe ofrecerse');
      assert.ok(starts.includes('14:00'));
    });

    it('excluye bloqueos (vacaciones) y fines de semana', async () => {
      const date = nextBusinessDay(15);
      await env.request('POST', '/api/time-blocks', {
        cookie: admin,
        body: { professionalId: clinic.professionalId, startAt: `${date}T00:00`, endAt: `${date}T23:59`, reason: 'Vacaciones' },
      });
      const blocked = await env.request(
        'GET',
        `/api/availability?from=${date}&to=${date}&serviceId=${clinic.serviceId}&professionalId=${clinic.professionalId}`,
        { cookie: admin },
      );
      assert.equal(blocked.json.length, 0);

      const blockedBooking = await createAppointment(`${date}T09:00`);
      assert.equal(blockedBooking.status, 409, 'No se debe poder agendar sobre un bloqueo');
    });

    it('la reserva pública respeta el margen mínimo de anticipación', async () => {
      const today = todayLocal(-300);
      const response = await env.request(
        'GET',
        `/api/public/clinics/${clinic.slug}/availability?from=${today}&to=${today}&serviceId=${clinic.serviceId}`,
        { headers: { 'X-Real-IP': 'margen' } },
      );
      const nowLocal = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 16);
      for (const slot of response.json as Array<{ start: string }>) {
        assert.ok(slot.start > nowLocal, 'No debe ofrecer horas pasadas');
      }
    });
  });

  describe('Cero dobles reservas', () => {
    it('de 8 reservas simultáneas al mismo horario solo una tiene éxito', async () => {
      const startAt = `${nextBusinessDay(16)}T10:00`;
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          env.request('POST', `/api/public/clinics/${clinic.slug}/appointments`, {
            headers: { 'X-Real-IP': `simultaneo-${index}` },
            body: {
              serviceId: clinic.serviceId,
              professionalId: clinic.professionalId,
              startAt,
              consentGiven: true,
              patient: { documentType: 'CC', documentNumber: `90000${index}`, fullName: `Paciente ${index}`, phone: `30000000${index}0` },
            },
          }),
        ),
      );
      const successful = attempts.filter((attempt) => attempt.status === 201);
      assert.equal(successful.length, 1, `Se esperaba 1 éxito, hubo ${successful.length}`);
      assert.ok(attempts.filter((attempt) => attempt.status === 409).length === 7);
    });

    it('no permite citas que se crucen parcialmente', async () => {
      const date = nextBusinessDay(17);
      assert.equal((await createAppointment(`${date}T14:00`)).status, 201);
      assert.equal((await createAppointment(`${date}T14:30`)).status, 409);
      assert.equal((await createAppointment(`${date}T14:30`, clinic.secondProfessionalId)).status, 201, 'Otro profesional sí puede');
    });

    it('crea citas recurrentes y reporta las que chocan', async () => {
      const firstDate = nextBusinessDay(21);
      await createAppointment(`${addDays(firstDate, 14)}T16:00`);
      const response = await env.request('POST', '/api/appointments', {
        cookie: admin,
        body: {
          patientId: clinic.patientId,
          professionalId: clinic.professionalId,
          serviceId: clinic.serviceId,
          startAt: `${firstDate}T16:00`,
          recurrence: { occurrences: 4, intervalWeeks: 1 },
        },
      });
      assert.equal(response.status, 201);
      assert.equal(response.json.created.length, 3);
      assert.deepEqual(response.json.conflicts, [`${addDays(firstDate, 14)}T16:00`]);
      assert.ok(response.json.created.every((appointment: { recurrence_group_id: string }) => appointment.recurrence_group_id));
    });
  });

  describe('Estados de cita', () => {
    it('al marcar "atendida" crea el cargo una sola vez y bloquea transiciones inválidas', async () => {
      const created = await createAppointment(`${nextBusinessDay(18)}T09:00`);
      const appointmentId = created.json.created[0].id;

      assert.equal((await env.request('POST', `/api/appointments/${appointmentId}/status`, { cookie: admin, body: { status: 'atendida' } })).status, 200);
      const again = await env.request('POST', `/api/appointments/${appointmentId}/status`, { cookie: admin, body: { status: 'atendida' } });
      assert.equal(again.status, 422);

      const statement = await env.request('GET', `/api/patients/${clinic.patientId}/statement`, { cookie: admin });
      const charges = statement.json.charges.filter((charge: { appointment_id: string }) => charge.appointment_id === appointmentId);
      assert.equal(charges.length, 1);
      assert.equal(charges[0].amount, 120000);

      const cancelAttended = await env.request('POST', `/api/appointments/${appointmentId}/cancel`, { cookie: admin, body: { reason: 'x' } });
      assert.equal(cancelAttended.status, 422);
    });

    it('el paciente puede confirmar y cancelar con su enlace', async () => {
      const booking = await env.request('POST', `/api/public/clinics/${clinic.slug}/appointments`, {
        headers: { 'X-Real-IP': 'enlace' },
        body: {
          serviceId: clinic.serviceId,
          startAt: `${nextBusinessDay(19)}T11:00`,
          consentGiven: true,
          patient: { documentType: 'CC', documentNumber: '4445556667', fullName: 'Lucía Enlace', phone: '3014445566' },
        },
      });
      const token = encodeURIComponent(booking.json.token);
      const confirmed = await env.request('POST', `/api/public/appointments/${token}/confirm`, { headers: { 'X-Real-IP': 'enlace' } });
      assert.equal(confirmed.json.appointment.status, 'confirmada');
      const cancelled = await env.request('POST', `/api/public/appointments/${token}/cancel`, { headers: { 'X-Real-IP': 'enlace' } });
      assert.equal(cancelled.json.appointment.status, 'cancelada');

      const ics = await env.request('GET', `/api/public/appointments/${token}/calendar.ics`, { headers: { 'X-Real-IP': 'enlace' } });
      assert.match(ics.text, /BEGIN:VCALENDAR/);
      assert.match(ics.text, /DTSTART:\d{8}T\d{6}Z/);
    });
  });

  describe('Caja y cartera', () => {
    let patientId: string;

    before(async () => {
      const patient = await env.request('POST', '/api/patients', {
        cookie: admin,
        body: { documentType: 'CC', documentNumber: '700700700', fullName: 'Cartera Prueba', phone: '3027007000', consentGiven: true },
      });
      patientId = patient.json.id;
    });

    const statement = async () => (await env.request('GET', `/api/patients/${patientId}/statement`, { cookie: admin })).json;
    const charge = (description: string, unitPrice: number) =>
      env.request('POST', '/api/charges', { cookie: admin, body: { patientId, description, unitPrice } });
    const pay = (amount: number, extra: Record<string, unknown> = {}) =>
      env.request('POST', '/api/payments', { cookie: admin, body: { patientId, amount, method: 'efectivo', ...extra } });

    it('aplica abonos a los cargos más antiguos y deja el excedente como anticipo', async () => {
      await charge('Resina', 150_000);
      await charge('Limpieza', 120_000);

      const firstPayment = await pay(100_000);
      assert.equal(firstPayment.status, 201);
      assert.equal(firstPayment.json.allocated, 100_000);

      const afterFirst = await statement();
      const [limpieza, resina] = afterFirst.charges; // orden: más reciente primero
      assert.equal(resina.balance, 50_000);
      assert.equal(limpieza.balance, 120_000);

      const secondPayment = await pay(200_000);
      assert.equal(secondPayment.json.allocated, 170_000);
      assert.equal(secondPayment.json.available, 30_000, 'El excedente queda como saldo a favor');

      const totals = (await statement()).totals;
      assert.equal(totals.pendingDebt, 0);
      assert.equal(totals.availableCredit, 30_000);
      assert.equal(totals.balance, -30_000);
    });

    it('los recibos tienen consecutivo sin saltos', async () => {
      const first = await pay(1_000, { applyToCharges: false });
      const second = await pay(1_000, { applyToCharges: false });
      assert.equal(second.json.receipt_number, first.json.receipt_number + 1);
    });

    it('un anticipo se cruza después con un cargo nuevo', async () => {
      await charge('Control', 25_000);
      const applied = await env.request('POST', `/api/patients/${patientId}/apply-credit`, { cookie: admin });
      assert.equal(applied.status, 200);
      assert.equal(applied.json.totals.pendingDebt, 0);
      assert.equal(applied.json.totals.availableCredit, 30_000 + 2_000 - 25_000);
    });

    it('anular un recibo devuelve la deuda y queda auditado', async () => {
      const newCharge = await charge('Extracción', 180_000);
      const payment = await pay(180_000, { chargeIds: [newCharge.json.id] });
      assert.equal((await statement()).totals.pendingDebt, 0);

      const voided = await env.request('POST', `/api/payments/${payment.json.id}/void`, { cookie: admin, body: { reason: 'Error de digitación' } });
      assert.equal(voided.json.status, 'anulado');
      assert.equal((await statement()).totals.pendingDebt, 180_000);

      const voidAgain = await env.request('POST', `/api/payments/${payment.json.id}/void`, { cookie: admin, body: { reason: 'otra vez' } });
      assert.equal(voidAgain.status, 422);

      const audit = await env.request('GET', '/api/audit', { cookie: admin });
      assert.ok(audit.json.some((entry: { action: string; entity_id: string }) => entry.action === 'recaudo_anulado' && entry.entity_id === payment.json.id));
    });

    it('anular un cargo pagado libera el dinero como saldo a favor', async () => {
      const before = (await statement()).totals;
      const toVoid = await charge('Blanqueamiento', 50_000);
      await pay(50_000, { chargeIds: [toVoid.json.id] });
      await env.request('POST', `/api/charges/${toVoid.json.id}/void`, { cookie: admin, body: { reason: 'Tratamiento no realizado' } });
      const after = (await statement()).totals;
      assert.equal(after.availableCredit, before.availableCredit + 50_000);
    });

    it('la cartera por edades agrupa por paciente y el cierre de caja suma por medio de pago', async () => {
      const aging = await env.request('GET', '/api/receivables/aging', { cookie: admin });
      const row = aging.json.find((item: { patient_id: string }) => item.patient_id === patientId);
      assert.ok(row);
      assert.equal(row.total, row.current + row.days31to60 + row.days61to90 + row.over90);

      const closing = await env.request('GET', '/api/cash-closing', { cookie: admin });
      assert.equal(closing.status, 200);
      assert.equal(closing.json.total, Object.values(closing.json.totalsByMethod as Record<string, number>).reduce((a, b) => a + b, 0));
      assert.ok(closing.json.voidedPayments.length >= 1);
    });

    it('rechaza montos con decimales o negativos', async () => {
      assert.equal((await pay(1000.5)).status, 400);
      assert.equal((await pay(-100)).status, 400);
    });
  });

  describe('Indicadores y recordatorios', () => {
    it('calcula indicadores del mes sin errores', async () => {
      const response = await env.request('GET', '/api/reports/monthly', { cookie: admin });
      assert.equal(response.status, 200);
      assert.ok(response.json.appointments.total >= 0);
      assert.ok(response.json.outstandingBalance >= 0);
    });

    it('la lista de recordatorios incluye un enlace firmado de gestión', async () => {
      const date = nextBusinessDay(20);
      await createAppointment(`${date}T15:00`, clinic.secondProfessionalId);
      const response = await env.request('GET', `/api/reminders?date=${date}`, { cookie: admin });
      assert.ok(response.json.appointments.length >= 1);
      assert.match(response.json.appointments[0].manageUrl, new RegExp(`/c/${clinic.slug}/cita/`));
    });
  });
});
