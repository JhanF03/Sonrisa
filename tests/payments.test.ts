/**
 * Pruebas del pago anticipado con Wompi.
 * Las llamadas a Wompi se simulan; las firmas se calculan con el algoritmo
 * oficial (y el vector oficial de integridad de la documentación de Wompi).
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  buildCheckoutUrl,
  integritySignature,
  verifyEventChecksum,
  type WompiEvent,
  type WompiTransaction,
} from '../src/modules/payments/wompiClient.js';
import { sha256Hex } from '../src/security/crypto.js';
import { decryptSecret, encryptSecret, maskSecret } from '../src/security/secretBox.js';
import { todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, nextBusinessDay, type TestClinic } from './helpers.js';

const PUBLIC_KEY = 'pub_test_Q5yDA9xoKdePzhSGeVe9HAez7HgGORGf';
const INTEGRITY_SECRET = 'test_integrity_nAIBuqayW70XpUqJS4qf4STYiISd89Fp';
const EVENTS_SECRET = 'test_events_Hs0zPZnHqrPNasxvPEoiGM8YUn7Qq9Kd';

async function signEvent(transaction: WompiTransaction, secret = EVENTS_SECRET, environment = 'test'): Promise<WompiEvent> {
  const timestamp = Math.floor(Date.now() / 1000);
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
  const checksum = await sha256Hex(`${transaction.id}${transaction.status}${transaction.amount_in_cents}${timestamp}${secret}`);
  return {
    event: 'transaction.updated',
    data: { transaction },
    environment,
    signature: { properties, checksum },
    timestamp,
    sent_at: new Date().toISOString(),
  };
}

describe('Wompi: firmas y cifrado', () => {
  it('reproduce el vector oficial de la firma de integridad de la documentación de Wompi', async () => {
    const signature = await integritySignature('sk8-438k4-xmxm392-sn2m2', 490000, 'COP', 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6');
    assert.equal(signature, '37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5');
  });

  it('incluye la fecha de expiración en la firma y en la URL del checkout', async () => {
    const expiration = '2030-06-09T20:28:50.000Z';
    const url = new URL(
      await buildCheckoutUrl({
        publicKey: PUBLIC_KEY,
        integritySecret: INTEGRITY_SECRET,
        reference: 'AGS-1',
        amountInCents: 5_000_000,
        redirectUrl: 'https://ejemplo.co/c/x/pago/t',
        expirationTime: expiration,
        customer: { fullName: 'Ana', email: 'ana@ejemplo.co', phoneE164: '+573001234567', legalId: '123', legalIdType: 'CC' },
      }),
    );
    assert.equal(url.origin + url.pathname, 'https://checkout.wompi.co/p/');
    assert.equal(url.searchParams.get('signature:integrity'), await sha256Hex(`AGS-15000000COP${expiration}${INTEGRITY_SECRET}`));
    assert.equal(url.searchParams.get('customer-data:phone-number'), '3001234567');
    assert.equal(url.searchParams.get('customer-data:legal-id-type'), 'CC');
    assert.equal(url.searchParams.get('expiration-time'), expiration);
  });

  it('verifica el checksum de los eventos y rechaza cualquier alteración', async () => {
    const transaction: WompiTransaction = { id: '1234-1610641025-49201', status: 'APPROVED', amount_in_cents: 4490000, currency: 'COP', reference: 'AGS-X' };
    const event = await signEvent(transaction);
    assert.equal(await verifyEventChecksum(event, EVENTS_SECRET), true);
    assert.equal(await verifyEventChecksum(event, EVENTS_SECRET, event.signature.checksum.toUpperCase()), true, 'Acepta hexadecimal en mayúsculas');
    assert.equal(await verifyEventChecksum(event, 'test_events_otro'), false, 'Otro secreto');
    assert.equal(await verifyEventChecksum({ ...event, data: { transaction: { ...transaction, amount_in_cents: 100 } } }, EVENTS_SECRET), false, 'Monto alterado');
    assert.equal(await verifyEventChecksum({ ...event, timestamp: event.timestamp + 1 }, EVENTS_SECRET), false, 'Timestamp alterado');
    assert.equal(await verifyEventChecksum({ ...event, signature: { ...event.signature, properties: [] } }, EVENTS_SECRET), false);
    assert.equal(await verifyEventChecksum({ ...event, signature: { ...event.signature, properties: ['transaction.__proto__'] } }, EVENTS_SECRET), false);
  });

  it('cifra los secretos atados al consultorio (no se pueden copiar a otro)', async () => {
    const appSecret = 'secreto-de-aplicacion-para-pruebas-0123456789';
    const encrypted = await encryptSecret(appSecret, INTEGRITY_SECRET, 'consultorio-a:integrity');
    assert.ok(!encrypted.includes('nAIBuq'));
    assert.equal(await decryptSecret(appSecret, encrypted, 'consultorio-a:integrity'), INTEGRITY_SECRET);
    await assert.rejects(decryptSecret(appSecret, encrypted, 'consultorio-b:integrity'));
    await assert.rejects(decryptSecret('otro-secreto-de-aplicacion-de-32-caracteres!!', encrypted, 'consultorio-a:integrity'));
    assert.equal(maskSecret(INTEGRITY_SECRET), 'test_integrity_••••89Fp');
  });
});

describe('Wompi: flujo completo de pago anticipado', () => {
  type Env = Awaited<ReturnType<typeof createTestEnvironment>>;
  let env: Env;
  let clinic: TestClinic;
  let admin: string;
  let prepaidServiceId: string;
  let webhookPath: string;
  /** Transacciones que la API simulada de Wompi devuelve al consultarlas. */
  const wompiTransactions = new Map<string, WompiTransaction>();
  const wompiCalls: string[] = [];
  let documentCounter = 70_000_000;
  let dayCursor = 2;

  const fakeWompiFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    wompiCalls.push(url.pathname);
    if (url.hostname !== 'sandbox.wompi.co') throw new Error(`Host inesperado ${url.hostname}`);
    const merchantMatch = /^\/v1\/merchants\/(.+)$/.exec(url.pathname);
    if (merchantMatch) {
      return merchantMatch[1] === PUBLIC_KEY
        ? Response.json({ data: { name: 'Clínica Dental Pruebas' } })
        : Response.json({ error: { type: 'NOT_FOUND_ERROR' } }, { status: 404 });
    }
    const transactionMatch = /^\/v1\/transactions\/(.+)$/.exec(url.pathname);
    if (transactionMatch) {
      const transaction = wompiTransactions.get(decodeURIComponent(transactionMatch[1]));
      return transaction ? Response.json({ data: transaction }) : Response.json({ error: {} }, { status: 404 });
    }
    throw new Error(`Ruta inesperada ${url.pathname}`);
  };

  const nextDay = () => {
    const day = nextBusinessDay(dayCursor);
    dayCursor = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${todayLocal(-300)}T00:00:00Z`)) / 86_400_000) + 1;
    if (dayCursor > 27) dayCursor = 2;
    return day;
  };

  const bookPrepaid = (startAt: string, professionalId = clinic.professionalId) =>
    env.request('POST', `/api/public/clinics/${clinic.slug}/appointments`, {
      headers: { 'X-Real-IP': `p-${documentCounter}` },
      body: {
        serviceId: prepaidServiceId,
        professionalId,
        startAt,
        consentGiven: true,
        patient: { documentType: 'CC', documentNumber: String(documentCounter++), fullName: 'Paciente Pago', phone: `311${String(documentCounter).slice(-7)}` },
      },
    });

  const referenceOf = (checkoutUrl: string) => new URL(checkoutUrl).searchParams.get('reference') as string;
  const amountOf = (checkoutUrl: string) => Number(new URL(checkoutUrl).searchParams.get('amount-in-cents'));
  const tokenOf = (checkoutUrl: string) => new URL(new URL(checkoutUrl).searchParams.get('redirect-url') as string).pathname.split('/').pop() as string;
  const transactionFor = (checkoutUrl: string, status: WompiTransaction['status'], id = `tx-${crypto.randomUUID()}`): WompiTransaction => ({
    id, status, amount_in_cents: amountOf(checkoutUrl), currency: 'COP', reference: referenceOf(checkoutUrl), payment_method_type: 'CARD',
  });
  const sendEvent = async (transaction: WompiTransaction, options: { secret?: string; environment?: string; csrf?: boolean } = {}) =>
    env.request('POST', webhookPath, { body: await signEvent(transaction, options.secret, options.environment), skipCsrf: options.csrf !== true });
  const paymentStatus = (statusToken: string, transactionId?: string) =>
    env.request('GET', `/api/public/payments/${encodeURIComponent(statusToken)}${transactionId ? `?id=${encodeURIComponent(transactionId)}` : ''}`, {
      headers: { 'X-Real-IP': `s-${Math.random()}` },
    });
  const countPayments = async () =>
    (await env.db.prepare("SELECT COUNT(*) AS total FROM payments WHERE tenant_id = ? AND source = 'wompi'").bind(clinic.tenantId).first<{ total: number }>())?.total ?? 0;
  const receiptCounter = async () =>
    (await env.db.prepare("SELECT value FROM counters WHERE tenant_id = ? AND name = 'recibo_caja'").bind(clinic.tenantId).first<{ value: number }>())?.value ?? 0;
  const appointmentOf = async (reference: string) =>
    env.db
      .prepare('SELECT a.* FROM appointments a JOIN payment_intents i ON i.appointment_id = a.id WHERE i.reference = ?')
      .bind(reference)
      .first<{ id: string; status: string; hold_reason: string | null; start_at: string; patient_id: string; professional_id: string }>();

  before(async () => {
    env = await createTestEnvironment({ fetch: fakeWompiFetch });
    clinic = await env.createClinic('Consultorio Pagos', 'pagos@prueba.co');
    admin = await env.login(clinic.adminEmail);
    const service = await env.request('POST', '/api/services', {
      cookie: admin,
      body: { code: 'BLA', name: 'Blanqueamiento', price: 600000, durationMinutes: 60, prepaymentMode: 'porcentaje', prepaymentValue: 30 },
    });
    assert.equal(service.status, 201, service.text);
    prepaidServiceId = service.json.id;
  });

  describe('Configuración del comercio', () => {
    it('valida los anticipos del servicio (porcentaje, valor máximo y mínimo)', async () => {
      const base = { code: 'X1', name: 'X', price: 100000, durationMinutes: 30 };
      for (const invalid of [
        { prepaymentMode: 'porcentaje', prepaymentValue: 150 },
        { prepaymentMode: 'valor', prepaymentValue: 200000 },
        { prepaymentMode: 'valor', prepaymentValue: 500 },
      ]) {
        const response = await env.request('POST', '/api/services', { cookie: admin, body: { ...base, ...invalid } });
        assert.equal(response.status, 422, JSON.stringify(invalid));
      }
    });

    it('mientras Wompi no esté activo, los servicios con anticipo no se ofrecen en línea', async () => {
      const publicClinic = await env.request('GET', `/api/public/clinics/${clinic.slug}`);
      assert.ok(!publicClinic.json.services.some((service: { id: string }) => service.id === prepaidServiceId));
      const booking = await bookPrepaid(`${nextDay()}T09:00`);
      assert.equal(booking.status, 422);
      assert.equal(booking.json.error.code, 'PREPAYMENT_UNAVAILABLE');
    });

    it('rechaza llaves que no corresponden al ambiente elegido', async () => {
      const response = await env.request('PUT', '/api/settings/payments', {
        cookie: admin,
        body: { environment: 'production', publicKey: PUBLIC_KEY, integritySecret: INTEGRITY_SECRET, eventsSecret: EVENTS_SECRET, isEnabled: true },
      });
      assert.equal(response.status, 422);
      assert.equal(response.json.error.code, 'KEY_ENVIRONMENT_MISMATCH');
    });

    it('guarda la configuración sin devolver nunca los secretos', async () => {
      const response = await env.request('PUT', '/api/settings/payments', {
        cookie: admin,
        body: {
          environment: 'sandbox', publicKey: PUBLIC_KEY, integritySecret: INTEGRITY_SECRET, eventsSecret: EVENTS_SECRET,
          isEnabled: true, policyText: 'El anticipo se descuenta del valor del tratamiento.',
        },
      });
      assert.equal(response.status, 200, response.text);
      assert.ok(!response.text.includes(INTEGRITY_SECRET) && !response.text.includes(EVENTS_SECRET));
      assert.equal(response.json.integritySecretMasked, 'test_integrity_••••89Fp');
      assert.match(response.json.webhookUrl, /\/api\/webhooks\/wompi\/[A-Za-z0-9_-]{20,}$/);
      webhookPath = new URL(response.json.webhookUrl).pathname;

      const stored = await env.db.prepare('SELECT integrity_secret_enc FROM payment_gateways WHERE tenant_id = ?').bind(clinic.tenantId).first<{ integrity_secret_enc: string }>();
      assert.ok(!stored?.integrity_secret_enc.includes('nAIBuq'), 'En la base queda cifrado');

      const withoutSecrets = await env.request('PUT', '/api/settings/payments', {
        cookie: admin,
        body: { environment: 'sandbox', publicKey: PUBLIC_KEY, isEnabled: true, policyText: 'El anticipo se descuenta del valor del tratamiento.' },
      });
      assert.equal(withoutSecrets.status, 200, 'Sin secretos nuevos conserva los actuales');
      assert.equal(withoutSecrets.json.eventsSecretMasked, 'test_events_••••q9Kd');
    });

    it('prueba la conexión con Wompi usando la llave pública', async () => {
      const response = await env.request('POST', '/api/settings/payments/test', { cookie: admin });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.merchantName, 'Clínica Dental Pruebas');
    });

    it('activo Wompi, el servicio aparece con su anticipo', async () => {
      const publicClinic = await env.request('GET', `/api/public/clinics/${clinic.slug}`);
      const service = publicClinic.json.services.find((item: { id: string }) => item.id === prepaidServiceId);
      assert.equal(service.prepaymentAmount, 180000);
      assert.equal(publicClinic.json.paymentPolicyText, 'El anticipo se descuenta del valor del tratamiento.');
    });
  });

  describe('Reserva con pago', () => {
    it('retiene el horario y genera un checkout firmado con el monto exacto', async () => {
      const startAt = `${nextDay()}T09:00`;
      const booking = await bookPrepaid(startAt);
      assert.equal(booking.status, 201, booking.text);
      const { checkoutUrl, statusToken, amount } = booking.json.payment;
      assert.equal(amount, 180000);
      assert.ok(checkoutUrl.startsWith('https://checkout.wompi.co/p/?'));
      assert.equal(amountOf(checkoutUrl), 18_000_000);
      const url = new URL(checkoutUrl);
      const expected = await sha256Hex(`${referenceOf(checkoutUrl)}18000000COP${url.searchParams.get('expiration-time')}${INTEGRITY_SECRET}`);
      assert.equal(url.searchParams.get('signature:integrity'), expected);
      const redirectUrl = new URL(url.searchParams.get('redirect-url') as string);
      assert.equal(redirectUrl.pathname.startsWith(`/c/${clinic.slug}/pago/`), true);
      assert.equal(decodeURIComponent(tokenOf(checkoutUrl)), statusToken);
      assert.ok(!checkoutUrl.includes(INTEGRITY_SECRET), 'El secreto nunca viaja al navegador');
      assert.equal(booking.json.appointment.holdReason, 'pago');

      // Mientras espera el pago, nadie más puede tomar el horario.
      assert.equal((await bookPrepaid(startAt)).status, 409);
      const status = await paymentStatus(statusToken);
      assert.equal(status.json.state, 'pendiente');
    });

    it('el evento aprobado confirma la cita y crea UN solo recibo aunque llegue repetido', async () => {
      const booking = await bookPrepaid(`${nextDay()}T10:00`);
      const { checkoutUrl, statusToken } = booking.json.payment;
      const transaction = transactionFor(checkoutUrl, 'APPROVED');
      const paymentsBefore = await countPayments();
      const counterBefore = await receiptCounter();

      for (let delivery = 0; delivery < 3; delivery++) {
        const response = await sendEvent(transaction);
        assert.equal(response.status, 200, response.text);
      }
      assert.equal(await countPayments(), paymentsBefore + 1);
      assert.equal(await receiptCounter(), counterBefore + 1, 'El consecutivo no salta números');

      const appointment = await appointmentOf(referenceOf(checkoutUrl));
      assert.equal(appointment?.status, 'confirmada');
      assert.equal(appointment?.hold_reason, null);

      const status = await paymentStatus(statusToken);
      assert.equal(status.json.state, 'aprobado');
      assert.ok(status.json.manageUrl);

      const payment = await env.db
        .prepare('SELECT amount, method, source, appointment_id FROM payments WHERE external_id = ?')
        .bind(transaction.id)
        .first<{ amount: number; method: string; source: string; appointment_id: string }>();
      assert.deepEqual(payment, { amount: 180000, method: 'tarjeta', source: 'wompi', appointment_id: appointment?.id });
    });

    it('webhook y redirección simultáneos producen un solo recibo', async () => {
      const booking = await bookPrepaid(`${nextDay()}T11:00`);
      const { checkoutUrl, statusToken } = booking.json.payment;
      const transaction = transactionFor(checkoutUrl, 'APPROVED');
      wompiTransactions.set(transaction.id, transaction);
      const before = await countPayments();

      const results = await Promise.all([
        sendEvent(transaction), paymentStatus(statusToken, transaction.id), sendEvent(transaction), paymentStatus(statusToken, transaction.id),
      ]);
      assert.ok(results.every((result) => result.status === 200));
      assert.equal(await countPayments(), before + 1);
      assert.equal(results[1].json.state, 'aprobado');
    });

    it('la redirección SIEMPRE consulta a Wompi: no basta con poner un id en la URL', async () => {
      const booking = await bookPrepaid(`${nextDay()}T14:00`);
      const { checkoutUrl, statusToken } = booking.json.payment;
      const fakeId = 'tx-inventado-12345';
      const status = await paymentStatus(statusToken, fakeId);
      assert.equal(status.json.state, 'pendiente');
      assert.ok(wompiCalls.includes(`/v1/transactions/${fakeId}`));

      // Una transacción real de OTRA referencia tampoco sirve.
      const other = { ...transactionFor(checkoutUrl, 'APPROVED'), reference: 'AGS-OTRA' };
      wompiTransactions.set(other.id, other);
      assert.equal((await paymentStatus(statusToken, other.id)).json.state, 'pendiente');
    });

    it('rechaza eventos falsos, de otro ambiente, ajenos o con monto distinto', async () => {
      const booking = await bookPrepaid(`${nextDay()}T15:00`);
      const { checkoutUrl } = booking.json.payment;
      const before = await countPayments();

      const forged = await sendEvent(transactionFor(checkoutUrl, 'APPROVED'), { secret: 'test_events_secreto_falso' });
      assert.equal(forged.status, 401);
      const otherEnvironment = await sendEvent(transactionFor(checkoutUrl, 'APPROVED'), { environment: 'prod' });
      assert.equal(otherEnvironment.json.result, 'otro_ambiente');
      const foreign = await sendEvent({ ...transactionFor(checkoutUrl, 'APPROVED'), reference: 'TIENDA-001' });
      assert.equal(foreign.status, 200, 'Ventas ajenas del mismo comercio: 200 para que Wompi no reintente');
      assert.equal(foreign.json.result, 'referencia_ajena');
      const wrongAmount = await sendEvent({ ...transactionFor(checkoutUrl, 'APPROVED'), amount_in_cents: 100 });
      assert.equal(wrongAmount.json.result, 'monto_no_coincide');
      const unknownKey = await env.request('POST', '/api/webhooks/wompi/llave-que-no-existe-123456', { body: {}, skipCsrf: true });
      assert.equal(unknownKey.status, 404);

      assert.equal(await countPayments(), before, 'Ninguno creó recibos');
      assert.equal((await appointmentOf(referenceOf(checkoutUrl)))?.hold_reason, 'pago', 'La cita sigue esperando pago');
      const alerts = await env.request('GET', '/api/online-payments?attention=true', { cookie: admin });
      assert.ok(alerts.json.some((item: { outcome: string }) => item.outcome === 'monto_no_coincide'));
    });

    it('pago rechazado: permite reintentar con una nueva referencia y luego aprobar', async () => {
      const booking = await bookPrepaid(`${nextDay()}T16:00`);
      const { checkoutUrl, statusToken } = booking.json.payment;
      await sendEvent(transactionFor(checkoutUrl, 'DECLINED'));
      const status = await paymentStatus(statusToken);
      assert.equal(status.json.state, 'rechazado');
      assert.equal(status.json.canRetry, true);

      const retry = await env.request('POST', `/api/public/payments/${encodeURIComponent(statusToken)}/resume`, { headers: { 'X-Real-IP': 'retry' } });
      assert.equal(retry.status, 200, retry.text);
      assert.notEqual(referenceOf(retry.json.checkoutUrl), referenceOf(checkoutUrl));
      await sendEvent(transactionFor(retry.json.checkoutUrl, 'APPROVED'));
      assert.equal((await appointmentOf(referenceOf(retry.json.checkoutUrl)))?.status, 'confirmada');
    });

    it('pago tardío con el horario libre: la cita vencida se reactiva', async () => {
      const booking = await bookPrepaid(`${nextDay()}T08:00`);
      const { checkoutUrl } = booking.json.payment;
      const appointment = await appointmentOf(referenceOf(checkoutUrl));
      await env.db.prepare('UPDATE appointments SET hold_expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 60_000).toISOString(), appointment?.id ?? '').run();
      await env.app.services.maintenance.runScheduled();
      assert.equal((await appointmentOf(referenceOf(checkoutUrl)))?.status, 'cancelada');

      await sendEvent(transactionFor(checkoutUrl, 'APPROVED'));
      const revived = await appointmentOf(referenceOf(checkoutUrl));
      assert.equal(revived?.status, 'confirmada');
      assert.equal(revived?.hold_reason, null);
    });

    it('pago tardío con el horario ocupado: el dinero queda como saldo a favor y se alerta', async () => {
      const startAt = `${nextDay()}T09:00`;
      const booking = await bookPrepaid(startAt);
      const { checkoutUrl } = booking.json.payment;
      const appointment = await appointmentOf(referenceOf(checkoutUrl));
      await env.db.prepare('UPDATE appointments SET hold_expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 60_000).toISOString(), appointment?.id ?? '').run();
      const otherPatient = await bookPrepaid(startAt);
      assert.equal(otherPatient.status, 201, 'Otro paciente tomó el horario liberado');

      await sendEvent(transactionFor(checkoutUrl, 'APPROVED'));
      const late = await appointmentOf(referenceOf(checkoutUrl));
      assert.equal(late?.status, 'cancelada');

      const statement = await env.request('GET', `/api/patients/${late?.patient_id}/statement`, { cookie: admin });
      assert.equal(statement.json.totals.availableCredit, 180000, 'El dinero no se pierde: queda a favor del paciente');

      const alerts = await env.request('GET', '/api/online-payments?attention=true', { cookie: admin });
      const alert = alerts.json.find((item: { reference: string }) => item.reference === referenceOf(checkoutUrl));
      assert.equal(alert.outcome, 'sin_cupo');
      const resolved = await env.request('POST', `/api/online-payments/${alert.id}/resolve`, { cookie: admin, body: { note: 'Se llamó al paciente y se reagendó' } });
      assert.equal(resolved.status, 200);
      const after = await env.request('GET', '/api/online-payments?attention=true', { cookie: admin });
      assert.ok(!after.json.some((item: { id: string }) => item.id === alert.id));
    });

    it('pago doble de la misma cita: el segundo se marca como duplicado', async () => {
      const booking = await bookPrepaid(`${nextDay()}T10:00`);
      const { checkoutUrl, statusToken } = booking.json.payment;
      await sendEvent(transactionFor(checkoutUrl, 'DECLINED'));
      const retry = await env.request('POST', `/api/public/payments/${encodeURIComponent(statusToken)}/resume`, { headers: { 'X-Real-IP': 'dup' } });
      await sendEvent(transactionFor(retry.json.checkoutUrl, 'APPROVED'));
      // El paciente también completó el primer intento con otra transacción.
      await sendEvent(transactionFor(checkoutUrl, 'APPROVED'));
      const intents = await env.db
        .prepare('SELECT reference, outcome FROM payment_intents WHERE reference IN (?, ?)')
        .bind(referenceOf(checkoutUrl), referenceOf(retry.json.checkoutUrl))
        .all<{ reference: string; outcome: string }>();
      const outcomes = Object.fromEntries(intents.results.map((row) => [row.reference, row.outcome]));
      assert.equal(outcomes[referenceOf(retry.json.checkoutUrl)], 'cita_confirmada');
      assert.equal(outcomes[referenceOf(checkoutUrl)], 'pago_duplicado');
    });

    it('si Wompi anula un pago aprobado, se anula el recibo y se alerta', async () => {
      const booking = await bookPrepaid(`${nextDay()}T11:00`);
      const { checkoutUrl } = booking.json.payment;
      const transaction = transactionFor(checkoutUrl, 'APPROVED');
      await sendEvent(transaction);
      await sendEvent({ ...transaction, status: 'VOIDED' });
      const payment = await env.db.prepare('SELECT status FROM payments WHERE external_id = ?').bind(transaction.id).first<{ status: string }>();
      assert.equal(payment?.status, 'anulado');
      const intent = await env.db.prepare('SELECT outcome, needs_attention FROM payment_intents WHERE reference = ?').bind(referenceOf(checkoutUrl)).first();
      assert.deepEqual(intent, { outcome: 'anulado_en_wompi', needs_attention: 1 });
    });

    it('al atender la cita, el anticipo se abona al cargo automáticamente', async () => {
      const booking = await bookPrepaid(`${nextDay()}T14:00`, clinic.secondProfessionalId);
      const { checkoutUrl } = booking.json.payment;
      await sendEvent(transactionFor(checkoutUrl, 'APPROVED'));
      const appointment = await appointmentOf(referenceOf(checkoutUrl));
      const attended = await env.request('POST', `/api/appointments/${appointment?.id}/status`, { cookie: admin, body: { status: 'atendida' } });
      assert.equal(attended.status, 200, attended.text);

      const statement = await env.request('GET', `/api/patients/${appointment?.patient_id}/statement`, { cookie: admin });
      assert.equal(statement.json.totals.pendingDebt, 600000 - 180000);
      assert.equal(statement.json.totals.availableCredit, 0);
    });

    it('el paciente puede desistir del pago y el horario se libera', async () => {
      const startAt = `${nextDay()}T15:00`;
      const booking = await bookPrepaid(startAt);
      const cancel = await env.request('POST', `/api/public/payments/${encodeURIComponent(booking.json.payment.statusToken)}/cancel`, { headers: { 'X-Real-IP': 'desiste' } });
      assert.equal(cancel.status, 200);
      assert.equal((await bookPrepaid(startAt)).status, 201);
    });

    it('si no se puede preparar el pago, la reserva se libera de inmediato', async () => {
      await env.db.prepare("UPDATE payment_gateways SET integrity_secret_enc = 'v1.dañado.dañado' WHERE tenant_id = ?").bind(clinic.tenantId).run();
      const startAt = `${nextDay()}T16:00`;
      const failed = await bookPrepaid(startAt);
      assert.equal(failed.status, 500);
      const occupied = await env.db
        .prepare("SELECT COUNT(*) AS total FROM appointments WHERE tenant_id = ? AND start_at = ? AND professional_id = ? AND status <> 'cancelada'")
        .bind(clinic.tenantId, startAt, clinic.professionalId)
        .first<{ total: number }>();
      assert.equal(occupied?.total, 0);
      // Restaura la configuración para no afectar otras pruebas.
      await env.request('PUT', '/api/settings/payments', {
        cookie: admin,
        body: { environment: 'sandbox', publicKey: PUBLIC_KEY, integritySecret: INTEGRITY_SECRET, eventsSecret: EVENTS_SECRET, isEnabled: true },
      });
    });

    it('un enlace de pago alterado no sirve', async () => {
      const response = await env.request('GET', `/api/public/payments/${crypto.randomUUID()}.firmafalsa`, { headers: { 'X-Real-IP': 'falso' } });
      assert.equal(response.status, 404);
    });
  });
});
