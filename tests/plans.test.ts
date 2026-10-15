/**
 * Planes y autogestión: precios y módulos, límites de profesionales y
 * usuarios, demo de autoservicio con vencimiento, registro con prueba gratis,
 * cambio de plan (inmediato, con pago de diferencia o programado) y borrado
 * de demos vencidas.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { TENANT_DATA_TABLES } from '../src/modules/platform/platformService.js';
import { priceForMonths, prorateUpgrade, resolvePlan, type PlanCatalog } from '../src/shared/plans.js';
import { addDays, todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, PLATFORM_KEY, TEST_PASSWORD } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

const catalog: PlanCatalog = {
  plans: [
    { id: 'basico', name: 'Básico', description: '', monthlyPrice: 59000, maxProfessionals: 1, maxUsers: 2, modules: [], sortOrder: 1, isActive: true },
    { id: 'completo', name: 'Completo', description: '', monthlyPrice: 189000, maxProfessionals: 5, maxUsers: 12, modules: ['finanzas', 'inventario', 'facturacion', 'auditoria'], sortOrder: 3, isActive: true },
  ],
  addons: [
    { id: 'finanzas', name: 'Caja y finanzas', monthlyPrice: 45000, isActive: true },
    { id: 'facturacion', name: 'Facturación electrónica', monthlyPrice: 45000, isActive: true },
    { id: 'inventario', name: 'Compras e inventario', monthlyPrice: 35000, isActive: false },
    { id: 'profesional', name: 'Profesional adicional', monthlyPrice: 29000, isActive: true },
    { id: 'usuario', name: 'Usuario adicional', monthlyPrice: 9000, isActive: true },
  ],
  annualFreeMonths: 2,
};

describe('Cálculo de planes', () => {
  it('suma plan, módulos y puestos adicionales', () => {
    const resolved = resolvePlan(catalog, { planId: 'basico', addonModules: ['finanzas'], extraProfessionals: 2, extraUsers: 1 });
    assert.equal(resolved.monthlyPrice, 59000 + 45000 + 2 * 29000 + 9000);
    assert.deepEqual(resolved.modules, ['finanzas']);
    assert.equal(resolved.maxProfessionals, 3);
    assert.equal(resolved.maxUsers, 3);
  });

  it('no cobra un módulo que ya trae el plan y valida dependencias y disponibilidad', () => {
    assert.equal(resolvePlan(catalog, { planId: 'completo', addonModules: ['finanzas'], extraProfessionals: 0, extraUsers: 0 }).monthlyPrice, 189000);
    assert.throws(() => resolvePlan(catalog, { planId: 'basico', addonModules: ['facturacion'], extraProfessionals: 0, extraUsers: 0 }), /necesita/);
    assert.throws(() => resolvePlan(catalog, { planId: 'basico', addonModules: ['inventario'], extraProfessionals: 0, extraUsers: 0 }), /no se vende/);
    assert.throws(() => resolvePlan(catalog, { planId: 'premium', addonModules: [], extraProfessionals: 0, extraUsers: 0 }), /no está disponible/);
  });

  it('anual con meses de regalo y diferencia proporcional al subir de plan', () => {
    assert.equal(priceForMonths(100000, 12, 2), 1_000_000);
    assert.equal(priceForMonths(100000, 3, 2), 300000);
    assert.equal(prorateUpgrade(59000, 119000, 15), 30000);
    assert.equal(prorateUpgrade(119000, 59000, 15), 0, 'Bajar de plan no genera cobro');
  });
});

describe('Autogestión y planes (API)', () => {
  let env: TestEnvironment;
  let platformCookie: string;
  const today = todayLocal(-300);
  const wompiTransactions = new Map<string, Record<string, unknown>>();
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    const match = url.match(/^https:\/\/sandbox\.wompi\.co\/v1\/transactions\/(.+)$/);
    if (match) {
      const transaction = wompiTransactions.get(decodeURIComponent(match[1] ?? ''));
      return transaction ? Response.json({ data: transaction }) : new Response('{}', { status: 404 });
    }
    throw new Error(`Llamada no simulada: ${url}`);
  };
  const platform = (method: string, path: string, body?: unknown) => env.request(method, path, { cookie: platformCookie, body });
  const cookieOf = (response: { headers: Headers }) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  let ipCounter = 0;
  const publicPost = (path: string, body: unknown, cookie?: string) => env.request('POST', path, { body, cookie, headers: { 'X-Real-IP': `publico-${++ipCounter}` } });
  const tenantRow = async (tenantId: string) => (await platform('GET', '/api/platform/tenants')).json.find((row: { id: string }) => row.id === tenantId);

  before(async () => {
    env = await createTestEnvironment({ fetch: fakeFetch });
    await env.request('POST', '/api/platform/setup', { body: { masterKey: PLATFORM_KEY, fullName: 'Dueño', email: 'dueno-planes@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'setup' } });
    const login = await env.request('POST', '/api/platform/login', { body: { email: 'dueno-planes@agenda.co', password: TEST_PASSWORD }, headers: { 'X-Real-IP': 'dueno' } });
    platformCookie = cookieOf(login);
    const settings = await platform('PUT', '/api/platform/settings', {
      ownerName: 'Dueño', ownerWhatsapp: null, paymentInstructions: null, defaultGraceDays: 3, defaultTrialDays: 15,
      wompiEnvironment: 'sandbox', wompiPublicKey: 'pub_test_planes', wompiIntegritySecret: 'test_integrity_planes', wompiEventsSecret: 'test_events_planes',
    });
    assert.equal(settings.status, 200, settings.text);
  });

  it('la página pública muestra los planes activos con sus precios', async () => {
    const offer = await env.request('GET', '/api/public/offer');
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.json.plans.map((plan: { id: string }) => plan.id), ['basico', 'profesional', 'completo']);
    assert.equal(offer.json.demoDays, 5);
    assert.equal(offer.json.trialDays, 15);
    assert.equal(offer.json.fromDemo, null);
  });

  let demoCookie = '';
  let demoTenantId = '';
  it('crea una demo de autoservicio con datos que vence en 5 días', async () => {
    const robot = await publicPost('/api/public/demo', { acceptTerms: true, fullName: 'Robot', email: 'robot@spam.co', password: TEST_PASSWORD, website: 'http://spam' });
    assert.equal(robot.status, 400, 'El campo trampa detiene robots');

    const demo = await publicPost('/api/public/demo', { acceptTerms: true, fullName: 'Laura Gómez', email: 'laura@clinica.co', phone: '3001234567', password: TEST_PASSWORD, clinicName: 'Sonrisas Laura' });
    assert.equal(demo.status, 201, demo.text);
    assert.match(demo.json.loginEmail, /@vitrina\.agenda$/);
    demoCookie = cookieOf(demo);
    const me = (await env.request('GET', '/api/auth/me', { cookie: demoCookie })).json;
    assert.equal(me.clinic.isShowcase, true);
    assert.equal(me.clinic.name, 'Sonrisas Laura');
    const hoursLeft = (Date.parse(me.demo.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hoursLeft > 119 && hoursLeft <= 120, 'Vence en 5 días');
    assert.deepEqual(me.plan.lockedPermissions, [], 'La demo muestra todos los módulos');
    assert.ok((await env.request('GET', '/api/patients', { cookie: demoCookie })).json.length > 0, 'Trae datos de ejemplo');
    assert.ok(await env.login(demo.json.loginEmail), 'Puede volver a entrar con su usuario de demo');

    const again = await publicPost('/api/public/demo', { acceptTerms: true, fullName: 'Laura Gómez', email: 'LAURA@clinica.co', password: TEST_PASSWORD });
    assert.equal(again.status, 409, 'Una demo activa por correo');
    demoTenantId = me.clinic.id;
    const row = await tenantRow(demoTenantId);
    assert.equal(row.signupSource, 'autoservicio');
    assert.equal(row.contact.email, 'laura@clinica.co');
  });

  let clinicCookie = '';
  let clinicTenantId = '';
  it('desde la demo crea su consultorio con prueba gratis; la demo queda 24 horas', async () => {
    const offer = await env.request('GET', '/api/public/offer', { cookie: demoCookie });
    assert.equal(offer.json.fromDemo.contactEmail, 'laura@clinica.co', 'Se precargan sus datos');
    const noTerms = await publicPost('/api/public/signup', { clinicName: 'Clínica Laura', fullName: 'Laura Gómez', email: 'laura@clinica.co', password: TEST_PASSWORD, planId: 'basico' }, demoCookie);
    assert.equal(noTerms.status, 400, 'Debe aceptar los términos');

    const signup = await publicPost(
      '/api/public/signup',
      { clinicName: 'Clínica Laura', city: 'Cali', fullName: 'Laura Gómez', email: 'laura@clinica.co', phone: '3001234567', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true },
      demoCookie,
    );
    assert.equal(signup.status, 201, signup.text);
    assert.equal(signup.json.trialUntil, addDays(today, 15));
    const demoHours = (Date.parse(signup.json.demoAvailableUntil) - Date.now()) / 3_600_000;
    assert.ok(demoHours > 23.9 && demoHours <= 24, 'La demo sigue 24 horas');
    assert.match(signup.json.demoLoginEmail, /@vitrina\.agenda$/);

    clinicCookie = cookieOf(signup);
    const me = (await env.request('GET', '/api/auth/me', { cookie: clinicCookie })).json;
    clinicTenantId = me.clinic.id;
    assert.equal(me.clinic.isShowcase, false);
    assert.equal(me.subscription.onTrial, true);
    assert.equal(me.plan.id, 'basico');
    assert.deepEqual(me.plan.modules, []);
    assert.ok(me.plan.lockedPermissions.includes('caja.recaudo.ver'), 'Caja aparece bloqueada para ofrecer mejorar el plan');
    assert.ok(!me.permissions.includes('caja.recaudo.ver'));
    assert.equal((await env.request('GET', '/api/patients', { cookie: clinicCookie })).status, 200);
    assert.equal((await env.request('GET', '/api/reports/monthly', { cookie: clinicCookie })).status, 403, 'Indicadores no están en Básico');

    const demoRow = await tenantRow(demoTenantId);
    assert.equal(demoRow.convertedTenantId, clinicTenantId);
    const clinicRow = await tenantRow(clinicTenantId);
    assert.equal(clinicRow.signupSource, 'registro');
    assert.equal(clinicRow.monthlyPrice, 59000);
  });

  it('respeta el límite de profesionales y usuarios del plan', async () => {
    const professional = { fullName: 'Dra. Laura', specialty: 'General', color: '#3f6f68', userId: null, isActive: true };
    const first = await env.request('POST', '/api/professionals', { cookie: clinicCookie, body: professional });
    assert.equal(first.status, 201, first.text);
    const second = await env.request('POST', '/api/professionals', { cookie: clinicCookie, body: { ...professional, fullName: 'Dr. Otro' } });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'PLAN_LIMIT');

    const roles = (await env.request('GET', '/api/roles', { cookie: clinicCookie })).json;
    const reception = roles.find((role: { name: string }) => role.name === 'Recepción').id;
    const user = (email: string) => ({ email, fullName: email, password: TEST_PASSWORD, roleIds: [reception] });
    assert.equal((await env.request('POST', '/api/users', { cookie: clinicCookie, body: user('recepcion-laura@clinica.co') })).status, 201);
    const third = await env.request('POST', '/api/users', { cookie: clinicCookie, body: user('otro-laura@clinica.co') });
    assert.equal(third.json.error.code, 'PLAN_LIMIT', 'Básico: 2 usuarios');
  });

  it('en prueba, el cambio de plan es inmediato y abre los módulos', async () => {
    const tooSmall = await env.request('POST', '/api/subscription/plan', { cookie: clinicCookie, body: { planId: 'basico', extraUsers: 0, addonModules: ['facturacion'] } });
    assert.equal(tooSmall.status, 422, 'Facturación necesita Caja y finanzas');
    const change = await env.request('POST', '/api/subscription/plan', { cookie: clinicCookie, body: { planId: 'profesional' } });
    assert.equal(change.status, 200, change.text);
    assert.equal(change.json.mode, 'inmediato');
    assert.equal((await env.request('GET', '/api/reports/monthly', { cookie: clinicCookie })).status, 200, 'Indicadores habilitados');
    const view = (await env.request('GET', '/api/subscription', { cookie: clinicCookie })).json;
    assert.equal(view.monthlyPrice, 119000);
    assert.equal(view.paymentOptions.find((option: { months: number }) => option.months === 12).amount, 119000 * 10, 'Anual: pagas 10, usas 12');
  });

  it('al día: subir paga la diferencia y se activa con el pago; bajar se programa', async () => {
    // El dueño registra el primer pago: termina la prueba y queda al día 30 días.
    const paid = await platform('POST', `/api/platform/tenants/${clinicTenantId}/payments`, { amount: 119000, months: 1, method: 'nequi', reference: null, notes: null });
    assert.equal(paid.status, 201, paid.text);
    assert.equal(paid.json.onTrial, false);
    const daysLeft = paid.json.subscription.daysLeft as number;

    const upgrade = await env.request('POST', '/api/subscription/plan', { cookie: clinicCookie, body: { planId: 'completo' } });
    assert.equal(upgrade.json.mode, 'pago', upgrade.text);
    assert.equal(upgrade.json.amount, prorateUpgrade(119000, 189000, daysLeft + 1));
    assert.equal((await env.request('GET', '/api/inventory/summary', { cookie: clinicCookie })).status, 403, 'Aún no se activa');

    const reference = new URL(upgrade.json.checkoutUrl).searchParams.get('reference') as string;
    wompiTransactions.set('tx-plan', { id: 'tx-plan', status: 'APPROVED', amount_in_cents: upgrade.json.amount * 100, currency: 'COP', reference });
    const verify = await env.request('POST', '/api/subscription/verify', { cookie: clinicCookie, body: { reference, transactionId: 'tx-plan' } });
    assert.equal(verify.json.result, 'aprobado');
    const afterUpgrade = await tenantRow(clinicTenantId);
    assert.equal(afterUpgrade.planId, 'completo');
    assert.equal(afterUpgrade.subscription.paidUntil, paid.json.subscription.paidUntil, 'Pagar la diferencia no mueve la fecha');
    assert.equal((await env.request('GET', '/api/inventory/summary', { cookie: clinicCookie })).status, 200);

    const downgrade = await env.request('POST', '/api/subscription/plan', { cookie: clinicCookie, body: { planId: 'basico' } });
    assert.equal(downgrade.json.mode, 'programado', downgrade.text);
    assert.equal(downgrade.json.effectiveOn, addDays(paid.json.subscription.paidUntil, 1));
    const checkout = await env.request('POST', '/api/subscription/checkout', { cookie: clinicCookie, body: { months: 1 } });
    assert.equal(new URL(checkout.json.checkoutUrl).searchParams.get('amount-in-cents'), String(59000 * 100), 'La renovación ya cobra el plan nuevo');

    // Llega la fecha: el mantenimiento aplica la bajada.
    await env.db.prepare("UPDATE tenants SET pending_plan = json_set(pending_plan, '$.effectiveOn', ?) WHERE id = ?").bind(today, clinicTenantId).run();
    await env.app.services.maintenance.runScheduled();
    const afterDowngrade = await tenantRow(clinicTenantId);
    assert.equal(afterDowngrade.planId, 'basico');
    assert.equal(afterDowngrade.pendingPlan, null);
  });

  it('una demo vencida se bloquea y el mantenimiento la borra con todos sus datos', async () => {
    const demo = await publicPost('/api/public/demo', { acceptTerms: true, fullName: 'Pedro Ruiz', email: 'pedro@clinica.co', password: TEST_PASSWORD });
    const cookie = cookieOf(demo);
    const tenantId = (await env.request('GET', '/api/auth/me', { cookie })).json.clinic.id as string;
    await env.db.prepare('UPDATE tenants SET demo_expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), tenantId).run();
    const blocked = await env.request('GET', '/api/patients', { cookie });
    assert.equal(blocked.status, 402);
    assert.equal((await env.request('GET', '/api/auth/me', { cookie })).json.subscription.state, 'demo_vencida');

    const real = await tenantRow(clinicTenantId);
    assert.equal((await platform('DELETE', `/api/platform/tenants/${real.id}`)).status, 403, 'Nunca borra un consultorio real');

    await env.app.services.maintenance.runScheduled();
    assert.equal(await tenantRow(tenantId), undefined);
    const { results: tables } = await env.db
      .prepare("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'tenant_id')")
      .all<{ name: string }>();
    for (const { name } of tables) {
      if (name === 'platform_audit') continue;
      assert.ok((TENANT_DATA_TABLES as readonly string[]).includes(name) || ['users', 'roles'].includes(name), `Falta ${name} en TENANT_DATA_TABLES`);
      const left = await env.db.prepare(`SELECT COUNT(*) AS total FROM ${name} WHERE tenant_id = ?`).bind(tenantId).first<{ total: number }>();
      assert.equal(left?.total, 0, `Quedaron filas en ${name}`);
    }
  });

  it('el dueño edita precios y elimina demos', async () => {
    const current = (await platform('GET', '/api/platform/plans')).json as PlanCatalog;
    const plans = current.plans.map((plan) => (plan.id === 'basico' ? { ...plan, monthlyPrice: 65000 } : plan));
    const saved = await platform('PUT', '/api/platform/plans', { plans, addons: current.addons, annualFreeMonths: 1 });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await tenantRow(clinicTenantId)).monthlyPrice, 65000, 'Sin precio especial: toma el precio nuevo');

    const removed = await platform('DELETE', `/api/platform/tenants/${demoTenantId}`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await tenantRow(demoTenantId), undefined);
  });
});
