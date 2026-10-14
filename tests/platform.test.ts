/**
 * Plataforma del dueño y suscripciones: suspensión automática por falta de
 * pago, reactivación inmediata al pagar (manual o Wompi) y panel del dueño.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { addMonthsToDate, computeSubscription, extendPaidUntil } from '../src/shared/subscription.js';
import { addDays, todayLocal } from '../src/utils/time.js';
import { currentTotpStep, totpCode } from '../src/security/totp.js';
import { createTestEnvironment, PLATFORM_KEY, TEST_PASSWORD } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

describe('Reglas de la suscripción', () => {
  const base = { isShowcase: false, billingMode: 'auto', graceDays: 3 };
  it('calcula al día, por vencer, en gracia y suspendido', () => {
    assert.equal(computeSubscription({ ...base, paidUntil: '2026-11-30' }, '2026-11-01').state, 'al_dia');
    assert.equal(computeSubscription({ ...base, paidUntil: '2026-11-05' }, '2026-11-01').state, 'por_vencer');
    const grace = computeSubscription({ ...base, paidUntil: '2026-11-01' }, '2026-11-04');
    assert.equal(grace.state, 'en_gracia');
    assert.equal(grace.blocked, false);
    assert.equal(grace.suspendOn, '2026-11-05');
    const suspended = computeSubscription({ ...base, paidUntil: '2026-11-01' }, '2026-11-05');
    assert.equal(suspended.state, 'suspendido');
    assert.equal(suspended.blocked, true);
  });

  it('demos y cortesías nunca se bloquean; la suspensión manual sí', () => {
    assert.equal(computeSubscription({ ...base, isShowcase: true, paidUntil: null }, '2026-11-01').blocked, false);
    assert.equal(computeSubscription({ ...base, billingMode: 'exento', paidUntil: '2020-01-01' }, '2026-11-01').blocked, false);
    assert.equal(computeSubscription({ ...base, billingMode: 'suspendido', paidUntil: '2030-01-01' }, '2026-11-01').blocked, true);
  });

  it('suma meses de calendario y extiende desde hoy si ya venció', () => {
    assert.equal(addMonthsToDate('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsToDate('2027-12-15', 1), '2028-01-15');
    assert.equal(extendPaidUntil('2026-12-10', '2026-11-20', 1), '2027-01-10', 'Al día: suma desde el vencimiento');
    assert.equal(extendPaidUntil('2026-10-01', '2026-11-20', 1), '2026-12-19', 'Vencido: un mes desde hoy');
  });
});

describe('Códigos de verificación (TOTP)', () => {
  it('reproduce los vectores oficiales del RFC 6238', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    assert.equal(await totpCode(secret, Math.floor(59 / 30)), '287082');
    assert.equal(await totpCode(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(await totpCode(secret, Math.floor(2000000000 / 30)), '279037');
  });
});

describe('Plataforma y suscripciones (API)', () => {
  let env: TestEnvironment;
  let platformCookie: string;
  const today = todayLocal(-300);
  const wompiTransactions = new Map<string, Record<string, unknown>>();

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    const transactionMatch = url.match(/^https:\/\/sandbox\.wompi\.co\/v1\/transactions\/(.+)$/);
    if (transactionMatch) {
      const transaction = wompiTransactions.get(decodeURIComponent(transactionMatch[1] ?? ''));
      return transaction ? Response.json({ data: transaction }) : new Response('{}', { status: 404 });
    }
    if (url.startsWith('https://sandbox.wompi.co/v1/merchants/')) return Response.json({ data: { name: 'Software Dueño' } });
    throw new Error(`Llamada no simulada: ${url}`);
  };

  const platform = (method: string, path: string, body?: unknown) => env.request(method, path, { cookie: platformCookie, body });

  const createRealClinic = async (email: string, paidUntil: string, extra: Record<string, unknown> = {}) => {
    const created = await platform('POST', '/api/platform/clinics', {
      clinicName: `Consultorio ${email}`,
      adminFullName: 'Dra. Dueña',
      adminEmail: email,
      adminPassword: TEST_PASSWORD,
      paidUntil,
      monthlyPrice: 99000,
      ...extra,
    });
    assert.equal(created.status, 201, created.text);
    const tenants = (await platform('GET', '/api/platform/tenants')).json;
    const tenant = tenants.find((row: { slug: string }) => row.slug === created.json.slug);
    return { tenantId: tenant.id as string, slug: created.json.slug as string, cookie: await env.login(email) };
  };

  before(async () => {
    env = await createTestEnvironment({ fetch: fakeFetch });
  });

  it('crea la cuenta del dueño una sola vez con la clave maestra e ingresa con correo y contraseña', async () => {
    assert.equal((await env.request('GET', '/api/platform/tenants')).status, 401);
    assert.equal((await env.request('GET', '/api/platform/session')).json.needsSetup, true);

    const badKey = await env.request('POST', '/api/platform/setup', { body: { masterKey: 'incorrecta', fullName: 'Jhan', email: 'dueno@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'setup-1' } });
    assert.equal(badKey.status, 403);
    const setup = await env.request('POST', '/api/platform/setup', { body: { masterKey: PLATFORM_KEY, fullName: 'Jhan', email: 'dueno@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'setup-2' } });
    assert.equal(setup.status, 201, setup.text);
    const again = await env.request('POST', '/api/platform/setup', { body: { masterKey: PLATFORM_KEY, fullName: 'Otro', email: 'otro@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'setup-3' } });
    assert.equal(again.status, 409, 'Solo la primera cuenta se crea con la clave');

    const wrongPassword = await env.request('POST', '/api/platform/login', { body: { email: 'dueno@agenda.co', password: 'Incorrecta123' }, headers: { 'X-Real-IP': 'dueno-1' } });
    const unknownUser = await env.request('POST', '/api/platform/login', { body: { email: 'nadie@agenda.co', password: 'Incorrecta123' }, headers: { 'X-Real-IP': 'dueno-1' } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.json.error.message, unknownUser.json.error.message, 'Mismo mensaje: no revela qué correos existen');

    const login = await env.request('POST', '/api/platform/login', { body: { email: 'DUENO@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'dueno-2' } });
    assert.equal(login.status, 200, login.text);
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    platformCookie = setCookie.split(';')[0] ?? '';
    const session = (await platform('GET', '/api/platform/session')).json;
    assert.equal(session.authenticated, true);
    assert.equal(session.admin.email, 'dueno@agenda.co');
    assert.equal((await platform('GET', '/api/platform/tenants')).status, 200);
  });

  it('verificación en dos pasos: exige el código y no permite reutilizarlo', async () => {
    const start = await platform('POST', '/api/platform/account/2fa/start');
    assert.match(start.json.otpauthUrl, /^otpauth:\/\/totp\/Agenda%20Sonrisa%3Adueno%40agenda\.co\?secret=/);
    const step = currentTotpStep();
    assert.equal((await platform('POST', '/api/platform/account/2fa/confirm', { code: '000000' })).status, 422);
    const confirm = await platform('POST', '/api/platform/account/2fa/confirm', { code: await totpCode(start.json.secret, step) });
    assert.equal(confirm.status, 200, confirm.text);

    const withoutCode = await env.request('POST', '/api/platform/login', { body: { email: 'dueno@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'dueno-3' } });
    assert.equal(withoutCode.json.error.code, 'TOTP_REQUIRED');
    const reused = await env.request('POST', '/api/platform/login', { body: { email: 'dueno@agenda.co', password: TEST_PASSWORD, code: await totpCode(start.json.secret, step) }, headers: { 'X-Real-IP': 'dueno-3' } });
    assert.equal(reused.json.error.code, 'TOTP_INVALID', 'Un código ya usado no sirve');
    const fresh = await env.request('POST', '/api/platform/login', { body: { email: 'dueno@agenda.co', password: TEST_PASSWORD, code: await totpCode(start.json.secret, step + 1) }, headers: { 'X-Real-IP': 'dueno-3' } });
    assert.equal(fresh.status, 200, fresh.text);
  });

  it('recupera el acceso con la clave maestra (quita la verificación en dos pasos)', async () => {
    const recovered = await env.request('POST', '/api/platform/recover', { body: { masterKey: PLATFORM_KEY, email: 'dueno@agenda.co', newPassword: 'NuevaClave2026' }, headers: { 'X-Real-IP': 'recover-1' } });
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal((await platform('GET', '/api/platform/session')).json.authenticated, false, 'Cierra las sesiones anteriores');
    const login = await env.request('POST', '/api/platform/login', { body: { email: 'dueno@agenda.co', password: 'NuevaClave2026' }, headers: { 'X-Real-IP': 'dueno-4' } });
    assert.equal(login.status, 200, 'Entra sin código porque se reinició la verificación en dos pasos');
    platformCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  it('gestiona otras cuentas de dueño sin dejar la plataforma sin acceso', async () => {
    const created = await platform('POST', '/api/platform/admins', { fullName: 'Socia', email: 'socia@agenda.co', password: TEST_PASSWORD });
    assert.equal(created.status, 201);
    const me = (await platform('GET', '/api/platform/session')).json.admin;
    assert.equal((await platform('PUT', `/api/platform/admins/${me.id}/active`, { isActive: false })).status, 409, 'No se desactiva a sí mismo');
    assert.equal((await platform('PUT', `/api/platform/admins/${created.json.id}/active`, { isActive: false })).status, 200);
    const socia = await env.request('POST', '/api/platform/login', { body: { email: 'socia@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'socia-1' } });
    assert.equal(socia.status, 401, 'Una cuenta desactivada no entra');
  });

  it('una sesión de un consultorio no sirve para la plataforma', async () => {
    const clinic = await createRealClinic('dueno-aislado@prueba.co', addDays(today, 30));
    assert.equal((await env.request('GET', '/api/platform/tenants', { cookie: clinic.cookie })).status, 401);
  });

  it('sin pago: suspende el panel y las reservas en línea, pero deja ver cómo pagar', async () => {
    const clinic = await createRealClinic('vencido@prueba.co', addDays(today, -10));
    const blocked = await env.request('GET', '/api/patients', { cookie: clinic.cookie });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.json.error.code, 'SUBSCRIPTION_SUSPENDED');

    const me = await env.request('GET', '/api/auth/me', { cookie: clinic.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.subscription.state, 'suspendido');
    const subscription = await env.request('GET', '/api/subscription', { cookie: clinic.cookie });
    assert.equal(subscription.status, 200);
    assert.equal(subscription.json.monthlyPrice, 99000);

    const publicInfo = await env.request('GET', `/api/public/clinics/${clinic.slug}`);
    assert.equal(publicInfo.json.onlineBookingEnabled, false, 'No recibe reservas nuevas');

    // Pago registrado por el dueño → acceso de inmediato.
    const paid = await platform('POST', `/api/platform/tenants/${clinic.tenantId}/payments`, { amount: 99000, months: 1, method: 'transferencia', reference: 'TRX-1' });
    assert.equal(paid.status, 201, paid.text);
    assert.equal(paid.json.subscription.blocked, false);
    assert.equal(paid.json.subscription.paidUntil, addMonthsToDate(addDays(today, -1), 1), 'Vencido: el mes cuenta desde hoy');
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 200);

    // Anular ese pago (el más reciente) vuelve a suspender.
    const payments = (await platform('GET', `/api/platform/tenants/${clinic.tenantId}/payments`)).json;
    assert.equal((await platform('POST', `/api/platform/subscription-payments/${payments[0].id}/void`, { reason: 'Transferencia rebotada' })).status, 200);
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 402);
  });

  it('periodo de gracia: avisa pero no bloquea; solo se anula el último pago', async () => {
    const clinic = await createRealClinic('gracia@prueba.co', addDays(today, -1), { graceDays: 3 });
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 200);
    assert.equal((await env.request('GET', '/api/auth/me', { cookie: clinic.cookie })).json.subscription.state, 'en_gracia');

    await platform('POST', `/api/platform/tenants/${clinic.tenantId}/payments`, { amount: 99000, months: 1, method: 'nequi' });
    await platform('POST', `/api/platform/tenants/${clinic.tenantId}/payments`, { amount: 99000, months: 1, method: 'nequi' });
    const payments = (await platform('GET', `/api/platform/tenants/${clinic.tenantId}/payments`)).json;
    assert.equal(payments.length, 2);
    const older = payments[1];
    assert.equal((await platform('POST', `/api/platform/subscription-payments/${older.id}/void`, { reason: 'x' })).status, 409);
  });

  it('el dueño puede suspender a mano, dar cortesía y cambiar fechas', async () => {
    const clinic = await createRealClinic('manual@prueba.co', addDays(today, 30));
    const suspend = await platform('PUT', `/api/platform/tenants/${clinic.tenantId}/subscription`, { monthlyPrice: 99000, graceDays: 3, billingMode: 'suspendido', paidUntil: addDays(today, 30), ownerNotes: 'No contesta' });
    assert.equal(suspend.json.subscription.state, 'suspendido');
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 402);
    const courtesy = await platform('PUT', `/api/platform/tenants/${clinic.tenantId}/subscription`, { monthlyPrice: 0, graceDays: 3, billingMode: 'exento', paidUntil: null, ownerNotes: null });
    assert.equal(courtesy.json.subscription.state, 'exento');
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 200);
  });

  it('restablece la clave del administrador y cierra sus sesiones', async () => {
    const clinic = await createRealClinic('olvido@prueba.co', addDays(today, 30));
    const reset = await platform('POST', `/api/platform/tenants/${clinic.tenantId}/reset-admin-password`);
    assert.equal(reset.status, 200);
    assert.equal(reset.json.email, 'olvido@prueba.co');
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 401, 'La sesión anterior se cerró');
    assert.ok(await env.login('olvido@prueba.co', reset.json.temporaryPassword));
    const audit = (await platform('GET', '/api/platform/audit')).json;
    assert.ok(audit.some((row: { action: string }) => row.action === 'clave_admin_restablecida'));
  });

  describe('Pago en línea con el Wompi del dueño', () => {
    const eventsSecret = 'test_events_dueno123';
    const eventFor = (transaction: Record<string, unknown>) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const checksum = createHash('sha256').update(`${transaction.id}${transaction.status}${transaction.amount_in_cents}${timestamp}${eventsSecret}`).digest('hex');
      return {
        event: 'transaction.updated',
        data: { transaction },
        environment: 'test',
        signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum },
        timestamp,
      };
    };

    it('configura Wompi del dueño validando las llaves y sin exponer secretos', async () => {
      const wrongKeys = await platform('PUT', '/api/platform/settings', {
        ownerName: 'Jhan', ownerWhatsapp: '3001112233', paymentInstructions: 'Nequi 3001112233', defaultMonthlyPrice: 99000,
        defaultGraceDays: 3, defaultTrialDays: 15, wompiEnvironment: 'sandbox', wompiPublicKey: 'pub_prod_x', wompiIntegritySecret: 'test_integrity_x', wompiEventsSecret: eventsSecret,
      });
      assert.equal(wrongKeys.status, 422);
      const saved = await platform('PUT', '/api/platform/settings', {
        ownerName: 'Jhan', ownerWhatsapp: '3001112233', paymentInstructions: 'Nequi 3001112233', defaultMonthlyPrice: 99000,
        defaultGraceDays: 3, defaultTrialDays: 15, wompiEnvironment: 'sandbox', wompiPublicKey: 'pub_test_dueno', wompiIntegritySecret: 'test_integrity_dueno123', wompiEventsSecret: eventsSecret,
      });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json.wompiConfigured, true);
      assert.ok(!saved.text.includes('test_integrity_dueno123') && !saved.text.includes(eventsSecret));
      assert.equal((await platform('POST', '/api/platform/settings/test-wompi')).status, 200);
    });

    it('el pago aprobado reactiva solo, una sola vez, y rechaza montos alterados', async () => {
      const clinic = await createRealClinic('wompi-sub@prueba.co', addDays(today, -20));
      const view = await env.request('GET', '/api/subscription', { cookie: clinic.cookie });
      assert.equal(view.json.onlinePaymentAvailable, true);
      assert.match(view.json.ownerWhatsappUrl, /^https:\/\/wa\.me\/573001112233\?text=/);

      const checkout = await env.request('POST', '/api/subscription/checkout', { cookie: clinic.cookie, body: { months: 3 } });
      assert.equal(checkout.status, 201, checkout.text);
      const url = new URL(checkout.json.checkoutUrl);
      assert.equal(url.searchParams.get('amount-in-cents'), String(99000 * 3 * 100));
      assert.ok(url.searchParams.get('signature:integrity'));
      const reference = checkout.json.reference as string;

      // Monto alterado: Wompi dice APPROVED pero por otro valor → no reactiva.
      wompiTransactions.set('tx-alterada', { id: 'tx-alterada', status: 'APPROVED', amount_in_cents: 100, currency: 'COP', reference });
      const tampered = await env.request('POST', '/api/webhooks/wompi-plataforma', { body: eventFor(wompiTransactions.get('tx-alterada')!), skipCsrf: true });
      assert.equal(tampered.json.status, 'rechazado');
      assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 402);

      // Firma falsa → 401.
      const forged = { ...eventFor({ id: 'tx-ok', status: 'APPROVED', amount_in_cents: 29700000, currency: 'COP', reference }), signature: { properties: ['transaction.id'], checksum: 'f'.repeat(64) } };
      assert.equal((await env.request('POST', '/api/webhooks/wompi-plataforma', { body: forged, skipCsrf: true })).status, 401);

      // Pago real: evento repetido + verificación por redirección → un solo pago.
      wompiTransactions.set('tx-ok', { id: 'tx-ok', status: 'APPROVED', amount_in_cents: 99000 * 3 * 100, currency: 'COP', reference });
      const event = eventFor(wompiTransactions.get('tx-ok')!);
      assert.equal((await env.request('POST', '/api/webhooks/wompi-plataforma', { body: event, skipCsrf: true })).json.status, 'aprobado');
      await env.request('POST', '/api/webhooks/wompi-plataforma', { body: event, skipCsrf: true });
      const verify = await env.request('POST', '/api/subscription/verify', { cookie: clinic.cookie, body: { reference, transactionId: 'tx-ok' } });
      assert.equal(verify.json.result, 'aprobado');

      const payments = (await platform('GET', `/api/platform/tenants/${clinic.tenantId}/payments`)).json;
      assert.equal(payments.filter((row: { status: string }) => row.status === 'aprobado').length, 1, 'Un solo pago aunque llegue 3 veces');
      assert.equal((await env.request('GET', '/api/patients', { cookie: clinic.cookie })).status, 200, 'Reactivado automáticamente');
      const me = (await env.request('GET', '/api/auth/me', { cookie: clinic.cookie })).json;
      assert.equal(me.subscription.paidUntil, addMonthsToDate(addDays(today, -1), 3));
    });

    it('un consultorio no puede verificar el pago de otro', async () => {
      const first = await createRealClinic('sub-a@prueba.co', addDays(today, 10));
      const second = await createRealClinic('sub-b@prueba.co', addDays(today, 10));
      const checkout = await env.request('POST', '/api/subscription/checkout', { cookie: first.cookie, body: { months: 1 } });
      const steal = await env.request('POST', '/api/subscription/verify', { cookie: second.cookie, body: { reference: checkout.json.reference, transactionId: 'tx-ok' } });
      assert.equal(steal.status, 404);
    });
  });

  it('el dueño abre el panel de administración de una demo (solo demos)', async () => {
    const demo = await platform('POST', '/api/platform/showcase', { clinicName: 'Demo Para Abrir' });
    const tenants = (await platform('GET', '/api/platform/tenants')).json;
    const demoRow = tenants.find((row: { slug: string }) => row.slug === demo.json.slug);
    assert.equal((await env.request('POST', `/api/platform/tenants/${demoRow.id}/demo-session`)).status, 401, 'Sin sesión de dueño');
    const opened = await platform('POST', `/api/platform/tenants/${demoRow.id}/demo-session`);
    assert.equal(opened.status, 200, opened.text);
    const clinicCookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.match(clinicCookie, /^sid=/);
    const me = await env.request('GET', '/api/auth/me', { cookie: clinicCookie });
    assert.equal(me.json.clinic.name, 'Demo Para Abrir');
    assert.ok(me.json.permissions.includes('agenda.ver_todas'), 'Entra como administrador de la demo');
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinicCookie })).status, 200);

    const real = tenants.find((row: { isShowcase: boolean }) => !row.isShowcase);
    assert.equal((await platform('POST', `/api/platform/tenants/${real.id}/demo-session`)).status, 403, 'Nunca a un consultorio real');
  });

  it('el panel muestra reales y demos con sus indicadores', async () => {
    const demo = await platform('POST', '/api/platform/showcase', { clinicName: 'Demo Panel' });
    assert.equal(demo.status, 201);
    const tenants = (await platform('GET', '/api/platform/tenants')).json;
    assert.ok(tenants.some((row: { isShowcase: boolean; name: string }) => row.isShowcase && row.name === 'Demo Panel'));
    const demoRow = tenants.find((row: { name: string }) => row.name === 'Demo Panel');
    assert.ok(demoRow.patients > 0, 'La demo trae pacientes de ejemplo');
    assert.equal(demoRow.subscription.state, 'exento');
    const summary = (await platform('GET', '/api/platform/summary')).json;
    assert.ok(summary.realClinics >= 5);
    assert.ok(summary.demos >= 1);
    assert.ok(summary.collectedThisMonth >= 99000 * 3);
    assert.equal((await platform('PUT', `/api/platform/tenants/${demoRow.id}/subscription`, { monthlyPrice: 1, graceDays: 1, billingMode: 'auto', paidUntil: null, ownerNotes: null })).status, 422);
  });
});
