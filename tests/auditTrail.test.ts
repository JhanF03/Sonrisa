/**
 * Trazabilidad y hallazgos de la auditoría de seguridad:
 *  • La bitácora y los registros financieros no se pueden editar ni borrar
 *    (ni siquiera con acceso directo a la base de datos).
 *  • Las ediciones guardan qué cambió (antes → después).
 *  • Cambiar la clave cierra las otras sesiones.
 *  • Nadie puede "ocupar" el correo de otra persona desde una demo.
 *  • El panel del dueño registra qué cuenta hizo cada acción.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createTestEnvironment, PLATFORM_KEY, TEST_PASSWORD } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

describe('Trazabilidad y endurecimiento', () => {
  let env: TestEnvironment;
  let clinic: Awaited<ReturnType<TestEnvironment['createClinic']>>;
  let admin: string;
  let ip = 0;
  const fresh = () => ({ 'X-Real-IP': `audit-${++ip}` });
  const cookieOf = (response: { headers: Headers }) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  before(async () => {
    env = await createTestEnvironment();
    clinic = await env.createClinic('Clínica Bitácora', 'bitacora@x.co');
    admin = await env.login('bitacora@x.co');
  });

  it('la bitácora no se puede editar ni borrar directamente en la base', async () => {
    const row = await env.db.prepare('SELECT id FROM audit_log WHERE tenant_id = ? LIMIT 1').bind(clinic.tenantId).first<{ id: string }>();
    assert.ok(row);
    await assert.rejects(env.db.prepare("UPDATE audit_log SET action = 'nada' WHERE id = ?").bind(row.id).run(), /BITACORA_INMUTABLE/);
    await assert.rejects(env.db.prepare('DELETE FROM audit_log WHERE id = ?').bind(row.id).run(), /BITACORA_INMUTABLE/);
    await assert.rejects(env.db.prepare('DELETE FROM platform_audit').run().then(async () => {
      await env.db.prepare("INSERT INTO platform_audit (id, action, created_at) VALUES ('x', 'prueba', 'hoy')").run();
      await env.db.prepare("DELETE FROM platform_audit WHERE id = 'x'").run();
    }), /BITACORA_INMUTABLE/);
  });

  it('los pagos no se borran, no cambian de valor y lo anulado no revive', async () => {
    const payment = await env.request('POST', '/api/payments', { cookie: admin, body: { patientId: clinic.patientId, amount: 80000, method: 'efectivo' } });
    assert.equal(payment.status, 201, payment.text);
    const id = payment.json.id as string;
    await assert.rejects(env.db.prepare('DELETE FROM payments WHERE id = ?').bind(id).run(), /REGISTRO_PROTEGIDO/);
    await assert.rejects(env.db.prepare('UPDATE payments SET amount = 1 WHERE id = ?').bind(id).run(), /REGISTRO_PROTEGIDO/);
    assert.equal((await env.request('POST', `/api/payments/${id}/void`, { cookie: admin, body: { reason: 'Error de digitación' } })).status, 200);
    await assert.rejects(env.db.prepare("UPDATE payments SET status = 'activo' WHERE id = ?").bind(id).run(), /REGISTRO_PROTEGIDO/);
    await assert.rejects(env.db.prepare('DELETE FROM patients WHERE id = ?').bind(clinic.patientId).run(), /REGISTRO_PROTEGIDO/);
  });

  it('editar un paciente deja en la bitácora qué cambió (antes → después)', async () => {
    const current = (await env.request('GET', `/api/patients/${clinic.patientId}`, { cookie: admin })).json.patient;
    const update = await env.request('PUT', `/api/patients/${clinic.patientId}`, {
      cookie: admin,
      body: { documentType: current.document_type, documentNumber: current.document_number, fullName: current.full_name, phone: '3109998877', consentGiven: true },
    });
    assert.equal(update.status, 200, update.text);
    const audit = (await env.request('GET', '/api/audit?limit=20&offset=0', { cookie: admin })).json as Array<{ action: string; details: string; user_agent: string | null }>;
    const entry = audit.find((row) => row.action === 'paciente_actualizado');
    assert.ok(entry);
    const changes = JSON.parse(entry.details).cambios;
    assert.deepEqual(changes.phone, ['+573001234567', '+573109998877']);
    assert.equal(changes.full_name, undefined, 'Solo los campos que cambiaron');
  });

  it('cambiar la clave cierra las otras sesiones y limita los intentos', async () => {
    const roles = (await env.request('GET', '/api/roles', { cookie: admin })).json;
    const reception = roles.find((role: { name: string }) => role.name === 'Recepción').id;
    await env.request('POST', '/api/users', { cookie: admin, body: { email: 'clave@x.co', fullName: 'Clave', password: TEST_PASSWORD, roleIds: [reception] } });
    const laptop = await env.login('clave@x.co');
    const stolen = await env.login('clave@x.co');
    const changed = await env.request('POST', '/api/auth/change-password', { cookie: laptop, body: { currentPassword: TEST_PASSWORD, newPassword: 'NuevaClave2026x' } });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((await env.request('GET', '/api/auth/me', { cookie: stolen })).status, 401, 'La sesión robada se cierra');
    assert.equal((await env.request('GET', '/api/auth/me', { cookie: laptop })).status, 200, 'La sesión actual sigue');
    let limited = false;
    for (let attempt = 0; attempt < 7; attempt++) {
      const guess = await env.request('POST', '/api/auth/change-password', { cookie: laptop, body: { currentPassword: `Adivina${attempt}x99`, newPassword: 'OtraClave2026y' } });
      if (guess.status === 429) limited = true;
    }
    assert.ok(limited, 'No se puede adivinar la clave actual a fuerza de intentos');
  });

  it('un correo usado dentro de una demo se libera para quien se registra de verdad', async () => {
    const demo = await env.request('POST', '/api/public/demo', { headers: fresh(), body: { fullName: 'Malicioso', email: 'malo@x.co', password: TEST_PASSWORD, acceptTerms: true } });
    const demoCookie = cookieOf(demo);
    const roles = (await env.request('GET', '/api/roles', { cookie: demoCookie })).json;
    const squat = await env.request('POST', '/api/users', { cookie: demoCookie, body: { email: 'cliente-real@clinica.co', fullName: 'x', password: TEST_PASSWORD, roleIds: [roles[1].id] } });
    assert.equal(squat.status, 201, 'En la demo se puede probar crear usuarios');
    const signup = await env.request('POST', '/api/public/signup', { headers: fresh(), body: { clinicName: 'Real', fullName: 'Real', email: 'cliente-real@clinica.co', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true } });
    assert.equal(signup.status, 201, signup.text);
    const reserved = await env.request('POST', '/api/public/signup', { headers: fresh(), body: { clinicName: 'X', fullName: 'X', email: 'demo-abc@vitrina.agenda', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true } });
    assert.equal(reserved.status, 422, 'Nadie se registra con el dominio interno de las demos');
    const taken = await env.request('POST', '/api/public/signup', { headers: fresh(), body: { clinicName: 'X', fullName: 'X', email: 'bitacora@x.co', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true } });
    assert.equal(taken.status, 409);
    assert.doesNotMatch(taken.json.error.message, /ya existe un usuario/i, 'Mensaje neutro');
  });

  it('el panel del dueño registra qué cuenta hizo cada acción', async () => {
    await env.request('POST', '/api/platform/setup', { headers: fresh(), body: { masterKey: PLATFORM_KEY, fullName: 'Dueña Uno', email: 'duena@agenda.co', password: TEST_PASSWORD } });
    const login = await env.request('POST', '/api/platform/login', { headers: fresh(), body: { email: 'duena@agenda.co', password: TEST_PASSWORD } });
    const platformCookie = cookieOf(login);
    await env.request('PUT', `/api/platform/tenants/${clinic.tenantId}/subscription`, {
      cookie: platformCookie,
      body: { selection: { planId: 'completo' }, customPrice: 50000, graceDays: 3, billingMode: 'auto', paidUntil: '2030-01-01', ownerNotes: null },
    });
    const audit = (await env.request('GET', '/api/platform/audit', { cookie: platformCookie })).json as Array<{ action: string; admin_name: string | null }>;
    assert.equal(audit.find((row) => row.action === 'suscripcion_editada')?.admin_name, 'Dueña Uno');
  });
});

describe('Ícono de la pestaña del consultorio', () => {
  // PNG de 1×1 válido.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let env: Awaited<ReturnType<typeof createTestEnvironment>>;
  before(async () => {
    env = await createTestEnvironment();
  });

  it('es opcional al registrarse, se valida y llega al panel y a la página de reservas', async () => {
    const base = { clinicName: 'Con Ícono', fullName: 'Ana', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true };
    const svg = await env.request('POST', '/api/public/signup', { headers: { 'X-Real-IP': 'ico-1' }, body: { ...base, email: 'svg@x.co', favicon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } });
    assert.equal(svg.status, 400, 'Nada de SVG (puede llevar código)');
    const fake = await env.request('POST', '/api/public/signup', { headers: { 'X-Real-IP': 'ico-2' }, body: { ...base, email: 'fake@x.co', favicon: 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' } });
    assert.equal(fake.status, 400, 'Debe ser un PNG de verdad');
    const ok = await env.request('POST', '/api/public/signup', { headers: { 'X-Real-IP': 'ico-3' }, body: { ...base, email: 'ico@x.co', favicon: PNG } });
    assert.equal(ok.status, 201, ok.text);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const me = (await env.request('GET', '/api/auth/me', { cookie })).json;
    assert.equal(me.clinic.favicon, PNG);
    assert.equal((await env.request('GET', `/api/public/clinics/${me.clinic.slug}`)).json.favicon, PNG);
    const without = await env.request('POST', '/api/public/signup', { headers: { 'X-Real-IP': 'ico-4' }, body: { ...base, email: 'sin@x.co' } });
    assert.equal(without.status, 201, 'Sin ícono también se puede');

    const removed = await env.request('PUT', '/api/settings/favicon', { cookie, body: { favicon: null } });
    assert.equal(removed.status, 200);
    assert.equal((await env.request('GET', '/api/auth/me', { cookie })).json.clinic.favicon, null);
    const tooBig = await env.request('PUT', '/api/settings/favicon', { cookie, body: { favicon: `${PNG}${'A'.repeat(50_000)}` } });
    assert.equal(tooBig.status, 400, 'Tamaño máximo');
  });
});
