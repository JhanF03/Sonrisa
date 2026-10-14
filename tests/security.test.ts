/**
 * Pruebas de seguridad: autenticación, autorización granular, aislamiento
 * entre consultorios, CSRF, inyección, escalamiento de privilegios y
 * enlaces firmados.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { getRegisteredRoutes } from '../src/http/routeRegistry.js';
import { createAppointmentToken, verifyAppointmentToken } from '../src/security/appointmentLinks.js';
import { hashPassword, verifyPassword } from '../src/security/crypto.js';
import { ALL_PERMISSIONS } from '../src/security/permissions.js';
import { APP_SECRET, createTestEnvironment, nextBusinessDay, PLATFORM_KEY, TEST_PASSWORD, type TestClinic } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

const FAKE_ID = '11111111-1111-4111-8111-111111111111';

/** Reemplaza parámetros de ruta por valores de prueba. */
function concretePath(routePath: string): string {
  return routePath
    .replace(':slug', 'consultorio-inexistente')
    .replace(':token', `${FAKE_ID}.firma`)
    .replace(':year', '2026')
    .replace(/:[a-zA-Z]+/g, FAKE_ID);
}

describe('Seguridad', () => {
  let env: TestEnvironment;
  let clinicA: TestClinic;
  let clinicB: TestClinic;
  let adminA: string;
  let adminB: string;

  before(async () => {
    env = await createTestEnvironment();
    clinicA = await env.createClinic('Consultorio A', 'admin-a@prueba.co');
    clinicB = await env.createClinic('Consultorio B', 'admin-b@prueba.co');
    adminA = await env.login(clinicA.adminEmail);
    adminB = await env.login(clinicB.adminEmail);
  });

  describe('Autenticación y autorización en TODAS las rutas', () => {
    it('cada ruta privada responde 401 sin sesión', async () => {
      const privateRoutes = getRegisteredRoutes().filter((route) => route.access.type !== 'public');
      assert.ok(privateRoutes.length > 40, `Se esperaban más de 40 rutas privadas, hay ${privateRoutes.length}`);

      for (const route of privateRoutes) {
        const response = await env.request(route.method, concretePath(route.path), { body: route.method === 'GET' ? undefined : {} });
        assert.equal(response.status, 401, `${route.method} ${route.path} debería exigir sesión (devolvió ${response.status})`);
      }
    });

    it('cada ruta con permiso responde 403 a un usuario sin ese permiso', async () => {
      // Usuario con un rol vacío: autenticado pero sin permisos.
      const emptyRole = await env.request('POST', '/api/roles', { cookie: adminA, body: { name: 'Sin permisos', permissions: [] } });
      const created = await env.request('POST', '/api/users', {
        cookie: adminA,
        body: { email: 'sinpermisos@prueba.co', fullName: 'Sin permisos', password: TEST_PASSWORD, roleIds: [emptyRole.json.id] },
      });
      assert.equal(created.status, 201);
      const noPermissionCookie = await env.login('sinpermisos@prueba.co');

      const permissionRoutes = getRegisteredRoutes().filter((route) => route.access.type === 'permission');
      for (const route of permissionRoutes) {
        const response = await env.request(route.method, concretePath(route.path), {
          cookie: noPermissionCookie,
          body: route.method === 'GET' ? undefined : {},
        });
        assert.equal(response.status, 403, `${route.method} ${route.path} debería devolver 403 (devolvió ${response.status})`);
      }
    });

    it('todos los permisos del catálogo están protegiendo al menos una ruta', () => {
      const usedPermissions = new Set(
        getRegisteredRoutes().flatMap((route) => (route.access.type === 'permission' ? route.access.anyOf : [])),
      );
      const unused = ALL_PERMISSIONS.filter((permission) => !usedPermissions.has(permission) && permission !== 'agenda.ver_propia');
      assert.deepEqual(unused, [], `Permisos sin uso: ${unused.join(', ')}`);
    });
  });

  describe('Sesión y contraseñas', () => {
    it('la cookie de sesión es HttpOnly y SameSite=Strict', async () => {
      const response = await env.app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agenda-sonrisa', 'X-Real-IP': 'cookie-test' },
        body: JSON.stringify({ email: clinicA.adminEmail, password: TEST_PASSWORD }),
      });
      const setCookie = response.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
    });

    it('usa el mismo mensaje para usuario inexistente y clave incorrecta', async () => {
      const wrongPassword = await env.request('POST', '/api/auth/login', {
        body: { email: clinicA.adminEmail, password: 'incorrecta' },
        headers: { 'X-Real-IP': 'enum-1' },
      });
      const unknownUser = await env.request('POST', '/api/auth/login', {
        body: { email: 'nadie@prueba.co', password: 'incorrecta' },
        headers: { 'X-Real-IP': 'enum-2' },
      });
      assert.equal(wrongPassword.status, 401);
      assert.equal(unknownUser.status, 401);
      assert.equal(wrongPassword.json.error.message, unknownUser.json.error.message);
    });

    it('bloquea tras demasiados intentos fallidos (fuerza bruta)', async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await env.request('POST', '/api/auth/login', {
          body: { email: 'victima@prueba.co', password: `mala-${attempt}` },
          headers: { 'X-Real-IP': `atacante-${attempt}` },
        });
        lastStatus = response.status;
      }
      assert.equal(lastStatus, 429);
    });

    it('guarda contraseñas con PBKDF2 y sal (nunca en texto plano)', async () => {
      const hash = await hashPassword('MiClave12345', 1000);
      assert.match(hash, /^pbkdf2\$1000\$[\w-]+\$[\w-]+$/);
      assert.equal(await verifyPassword('MiClave12345', hash), true);
      assert.equal(await verifyPassword('MiClave12346', hash), false);
      assert.notEqual(hash, await hashPassword('MiClave12345', 1000), 'Cada hash debe tener sal distinta');
    });

    it('cerrar sesión invalida la cookie en el servidor', async () => {
      const cookie = await env.login(clinicA.adminEmail);
      assert.equal((await env.request('GET', '/api/auth/me', { cookie })).status, 200);
      await env.request('POST', '/api/auth/logout', { cookie });
      assert.equal((await env.request('GET', '/api/auth/me', { cookie })).status, 401);
    });

    it('desactivar un usuario cierra sus sesiones de inmediato', async () => {
      const { cookie, userId } = await env.createUserWithRoles(adminA, 'temporal@prueba.co', ['Recepción']);
      assert.equal((await env.request('GET', '/api/auth/me', { cookie })).status, 200);
      const update = await env.request('PUT', `/api/users/${userId}`, {
        cookie: adminA,
        body: { fullName: 'Temporal', isActive: false, roleIds: [] },
      });
      assert.equal(update.status, 200);
      assert.equal((await env.request('GET', '/api/auth/me', { cookie })).status, 401);
    });

    it('rechaza contraseñas débiles', async () => {
      const response = await env.request('POST', '/api/users', {
        cookie: adminA,
        body: { email: 'debil@prueba.co', fullName: 'Débil', password: '12345678', roleIds: [] },
      });
      assert.equal(response.status, 400);
    });
  });

  describe('CSRF y cabeceras', () => {
    it('rechaza peticiones que modifican datos sin la cabecera anti-CSRF', async () => {
      const response = await env.request('POST', '/api/patients', { cookie: adminA, body: {}, skipCsrf: true });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'CSRF_REJECTED');
    });

    it('rechaza peticiones de otro origen', async () => {
      const response = await env.request('POST', '/api/patients', {
        cookie: adminA,
        body: {},
        headers: { Origin: 'https://sitio-malicioso.com' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'ORIGIN_REJECTED');
    });

    it('envía cabeceras de seguridad incluso en errores', async () => {
      const response = await env.request('GET', '/api/patients');
      assert.equal(response.status, 401);
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });

    it('rechaza cuerpos demasiado grandes', async () => {
      const response = await env.request('POST', '/api/patients', { cookie: adminA, body: { fullName: 'x'.repeat(70_000) } });
      assert.equal(response.status, 400);
    });

    it('no expone detalles internos ante JSON inválido', async () => {
      const response = await env.request('POST', '/api/patients', { cookie: adminA, body: '{malformado' });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'INVALID_JSON');
    });
  });

  describe('Aislamiento entre consultorios (multi-tenant)', () => {
    it('no se puede leer un paciente de otro consultorio', async () => {
      const response = await env.request('GET', `/api/patients/${clinicB.patientId}`, { cookie: adminA });
      assert.equal(response.status, 404);
    });

    it('no se puede crear una cita con paciente, servicio o profesional de otro consultorio', async () => {
      const response = await env.request('POST', '/api/appointments', {
        cookie: adminA,
        body: {
          patientId: clinicB.patientId,
          professionalId: clinicA.professionalId,
          serviceId: clinicA.serviceId,
          startAt: `${nextBusinessDay()}T09:00`,
        },
      });
      assert.equal(response.status, 404);
    });

    it('no se puede registrar un pago a un paciente de otro consultorio', async () => {
      const response = await env.request('POST', '/api/payments', {
        cookie: adminA,
        body: { patientId: clinicB.patientId, amount: 1000, method: 'efectivo' },
      });
      assert.equal(response.status, 404);
    });

    it('la búsqueda de pacientes solo devuelve los propios', async () => {
      const responseA = await env.request('GET', '/api/patients', { cookie: adminA });
      const responseB = await env.request('GET', '/api/patients', { cookie: adminB });
      const idsA = responseA.json.map((patient: { id: string }) => patient.id);
      assert.ok(idsA.includes(clinicA.patientId));
      assert.ok(!idsA.includes(clinicB.patientId));
      assert.ok(responseB.json.every((patient: { id: string }) => !idsA.includes(patient.id)));
    });

    it('no se puede asignar a un usuario un rol de otro consultorio', async () => {
      const rolesB = await env.request('GET', '/api/roles', { cookie: adminB });
      const response = await env.request('POST', '/api/users', {
        cookie: adminA,
        body: { email: 'cruzado@prueba.co', fullName: 'Cruzado', password: TEST_PASSWORD, roleIds: [rolesB.json[0].id] },
      });
      assert.equal(response.status, 404);
    });
  });

  describe('Escalamiento de privilegios', () => {
    it('recepción no puede crear un rol con permisos que no tiene', async () => {
      const recepcionAdmin = await env.request('POST', '/api/roles', {
        cookie: adminA,
        body: { name: 'Recepción con usuarios', permissions: ['usuarios.gestionar', 'roles.gestionar', 'pacientes.ver'] },
      });
      await env.request('POST', '/api/users', {
        cookie: adminA,
        body: { email: 'rrhh@prueba.co', fullName: 'RRHH', password: TEST_PASSWORD, roleIds: [recepcionAdmin.json.id] },
      });
      const cookie = await env.login('rrhh@prueba.co');

      const escalation = await env.request('POST', '/api/roles', {
        cookie,
        body: { name: 'Superpoderes', permissions: ['caja.recaudo.anular'] },
      });
      assert.equal(escalation.status, 403);

      const roles = await env.request('GET', '/api/roles', { cookie });
      const adminRole = roles.json.find((role: { isSystem: boolean }) => role.isSystem);
      const assignAdmin = await env.request('POST', '/api/users', {
        cookie,
        body: { email: 'falso-admin@prueba.co', fullName: 'Falso', password: TEST_PASSWORD, roleIds: [adminRole.id] },
      });
      assert.equal(assignAdmin.status, 403);

      const users = await env.request('GET', '/api/users', { cookie });
      const realAdmin = users.json.find((user: { email: string }) => user.email === clinicA.adminEmail);
      const takeover = await env.request('POST', `/api/users/${realAdmin.id}/reset-password`, {
        cookie,
        body: { password: 'TomarCuenta123' },
      });
      assert.equal(takeover.status, 403, 'No debe poder cambiar la clave de alguien con más permisos');
    });

    it('el rol Administrador no se puede editar ni eliminar', async () => {
      const roles = await env.request('GET', '/api/roles', { cookie: adminA });
      const adminRole = roles.json.find((role: { isSystem: boolean }) => role.isSystem);
      const edit = await env.request('PUT', `/api/roles/${adminRole.id}`, {
        cookie: adminA,
        body: { name: 'Administrador', permissions: [] },
      });
      const remove = await env.request('DELETE', `/api/roles/${adminRole.id}`, { cookie: adminA });
      assert.equal(edit.status, 403);
      assert.equal(remove.status, 403);
    });

    it('siempre queda al menos un administrador activo', async () => {
      const users = await env.request('GET', '/api/users', { cookie: adminB });
      const onlyAdmin = users.json.find((user: { email: string }) => user.email === clinicB.adminEmail);
      const selfDeactivate = await env.request('PUT', `/api/users/${onlyAdmin.id}`, {
        cookie: adminB,
        body: { fullName: 'Admin', isActive: false, roleIds: onlyAdmin.roleIds },
      });
      assert.equal(selfDeactivate.status, 403);
      const removeAdminRole = await env.request('PUT', `/api/users/${onlyAdmin.id}`, {
        cookie: adminB,
        body: { fullName: 'Admin', isActive: true, roleIds: [] },
      });
      assert.equal(removeAdminRole.status, 409);
    });

    it('ignora campos extra en el cuerpo (asignación masiva)', async () => {
      const response = await env.request('POST', '/api/patients', {
        cookie: adminA,
        body: {
          documentType: 'CC', documentNumber: '555000111', fullName: 'Masivo', phone: '3001110000', consentGiven: true,
          tenantId: clinicB.tenantId, id: FAKE_ID,
        },
      });
      assert.equal(response.status, 201);
      assert.notEqual(response.json.id, FAKE_ID);
      const fromB = await env.request('GET', `/api/patients/${response.json.id}`, { cookie: adminB });
      assert.equal(fromB.status, 404);
    });
  });

  describe('Alcance por profesional ("ver solo su agenda")', () => {
    it('un odontólogo solo ve y modifica sus propias citas', async () => {
      const { cookie, userId } = await env.createUserWithRoles(adminA, 'odontologo@prueba.co', ['Odontólogo']);
      await env.request('PUT', `/api/professionals/${clinicA.professionalId}`, {
        cookie: adminA,
        body: { fullName: 'Dra. Prueba', specialty: 'General', color: '#3f6f68', userId, isActive: true },
      });

      const date = nextBusinessDay(9);
      const own = await env.request('POST', '/api/appointments', {
        cookie: adminA,
        body: { patientId: clinicA.patientId, professionalId: clinicA.professionalId, serviceId: clinicA.serviceId, startAt: `${date}T08:00` },
      });
      const other = await env.request('POST', '/api/appointments', {
        cookie: adminA,
        body: { patientId: clinicA.patientId, professionalId: clinicA.secondProfessionalId, serviceId: clinicA.serviceId, startAt: `${date}T08:00` },
      });
      assert.equal(own.status, 201);
      assert.equal(other.status, 201);

      const list = await env.request('GET', `/api/appointments?from=${date}&to=${date}&professionalId=${clinicA.secondProfessionalId}`, { cookie });
      assert.equal(list.status, 200);
      assert.ok(list.json.length > 0);
      assert.ok(list.json.every((appointment: { professional_id: string }) => appointment.professional_id === clinicA.professionalId));

      const changeOther = await env.request('POST', `/api/appointments/${other.json.created[0].id}/status`, {
        cookie,
        body: { status: 'confirmada' },
      });
      assert.equal(changeOther.status, 404);

      const changeOwn = await env.request('POST', `/api/appointments/${own.json.created[0].id}/status`, {
        cookie,
        body: { status: 'confirmada' },
      });
      assert.equal(changeOwn.status, 200);
    });
  });

  describe('Inyección y validación', () => {
    it('la búsqueda es inmune a inyección SQL y trata comodines como texto', async () => {
      for (const attack of ["' OR 1=1 --", '"; DROP TABLE patients; --', '%', '_']) {
        const response = await env.request('GET', `/api/patients?q=${encodeURIComponent(attack)}`, { cookie: adminA });
        assert.equal(response.status, 200, `Falló con: ${attack}`);
        assert.equal(response.json.length, 0, `No debería coincidir nada con: ${attack}`);
      }
      const stillThere = await env.request('GET', '/api/patients', { cookie: adminA });
      assert.ok(stillThere.json.length > 0);
    });

    it('rechaza identificadores con formato inválido', async () => {
      const response = await env.request('GET', "/api/patients/1' OR '1'='1", { cookie: adminA });
      assert.equal(response.status, 400);
    });

    it('rechaza URLs de logo que no sean https (evita javascript:)', async () => {
      const clinic = await env.request('GET', '/api/settings/clinic', { cookie: adminA });
      const response = await env.request('PUT', '/api/settings/clinic', {
        cookie: adminA,
        body: {
          name: clinic.json.name, phone: null, address: null, city: null, brandColor: '#3f6f68',
          logoUrl: 'javascript:alert(1)', slotIntervalMinutes: 30, minBookingNoticeHours: 2,
          bookingWindowDays: 30, reactivationMonths: 6, onlineBookingEnabled: true, closeOnHolidays: true,
        },
      });
      assert.equal(response.status, 400);
    });
  });

  describe('Reserva pública y enlaces firmados', () => {
    it('los enlaces de cita no se pueden falsificar', async () => {
      const token = await createAppointmentToken(APP_SECRET, FAKE_ID);
      assert.equal(await verifyAppointmentToken(APP_SECRET, token), FAKE_ID);
      assert.equal(await verifyAppointmentToken('otro-secreto-distinto-de-32-caracteres!!', token), null);
      assert.equal(await verifyAppointmentToken(APP_SECRET, `${FAKE_ID}.firmafalsa`), null);
      assert.equal(await verifyAppointmentToken(APP_SECRET, token.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'))), null);

      const response = await env.request('GET', `/api/public/appointments/${encodeURIComponent(`${FAKE_ID}.abc`)}`);
      assert.equal(response.status, 404);
    });

    it('una reserva en línea NO sobrescribe el teléfono de un paciente existente', async () => {
      const patient = await env.request('GET', `/api/patients/${clinicA.patientId}`, { cookie: adminA });
      const date = nextBusinessDay(10);
      const booking = await env.request('POST', `/api/public/clinics/${clinicA.slug}/appointments`, {
        headers: { 'X-Real-IP': 'paciente-1' },
        body: {
          serviceId: clinicA.serviceId,
          startAt: `${date}T15:00`,
          consentGiven: true,
          patient: {
            documentType: patient.json.patient.document_type,
            documentNumber: patient.json.patient.document_number,
            fullName: 'Impostor',
            phone: '3009999999',
          },
        },
      });
      assert.equal(booking.status, 201, booking.text);
      const after = await env.request('GET', `/api/patients/${clinicA.patientId}`, { cookie: adminA });
      assert.equal(after.json.patient.phone, patient.json.patient.phone);
      assert.equal(after.json.patient.full_name, patient.json.patient.full_name);
      const bookedAppointment = after.json.appointments.find((appointment: { start_at: string }) => appointment.start_at === `${date}T15:00`);
      assert.match(bookedAppointment.notes, /Verificar/);
    });

    it('la respuesta pública no expone teléfonos ni datos de otros pacientes', async () => {
      const date = nextBusinessDay(11);
      const booking = await env.request('POST', `/api/public/clinics/${clinicA.slug}/appointments`, {
        headers: { 'X-Real-IP': 'paciente-2' },
        body: {
          serviceId: clinicA.serviceId,
          startAt: `${date}T09:00`,
          consentGiven: true,
          patient: { documentType: 'CC', documentNumber: '777888999', fullName: 'Nueva Paciente', phone: '3005556677' },
        },
      });
      assert.equal(booking.status, 201, booking.text);
      const view = await env.request('GET', `/api/public/appointments/${encodeURIComponent(booking.json.token)}`);
      assert.equal(view.status, 200);
      assert.doesNotMatch(view.text, /3005556677|777888999/);
      assert.equal(view.json.appointment.patientFirstName, 'Nueva');
    });

    it('exige autorización de datos y bloquea bots con el campo trampa', async () => {
      const base = {
        serviceId: clinicA.serviceId,
        startAt: `${nextBusinessDay(12)}T10:00`,
        patient: { documentType: 'CC', documentNumber: '111222333', fullName: 'Bot', phone: '3001112222' },
      };
      const noConsent = await env.request('POST', `/api/public/clinics/${clinicA.slug}/appointments`, {
        headers: { 'X-Real-IP': 'bot-1' },
        body: { ...base, consentGiven: false },
      });
      const honeypot = await env.request('POST', `/api/public/clinics/${clinicA.slug}/appointments`, {
        headers: { 'X-Real-IP': 'bot-2' },
        body: { ...base, consentGiven: true, website: 'http://spam.example' },
      });
      assert.equal(noConsent.status, 400);
      assert.equal(honeypot.status, 400);
    });

    it('limita las reservas públicas por IP', async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await env.request('POST', `/api/public/clinics/${clinicA.slug}/appointments`, {
          headers: { 'X-Real-IP': 'spammer' },
          body: { invalid: true },
        });
        lastStatus = response.status;
      }
      assert.equal(lastStatus, 429);
    });
  });

  describe('Plataforma (modo vitrina)', () => {
    it('exige la clave de plataforma', async () => {
      const withoutKey = await env.request('POST', '/api/platform/showcase', {
        headers: { 'X-Real-IP': 'plataforma-1' },
        body: { clinicName: 'Demo' },
      });
      const wrongKey = await env.request('POST', '/api/platform/showcase', {
        headers: { 'X-Real-IP': 'plataforma-2', 'X-Platform-Key': 'incorrecta' },
        body: { clinicName: 'Demo' },
      });
      assert.equal(withoutKey.status, 403);
      assert.equal(wrongKey.status, 403);
    });

    it('crea una demo funcional con datos de ejemplo', async () => {
      const response = await env.request('POST', '/api/platform/showcase', {
        headers: { 'X-Real-IP': 'plataforma-3', 'X-Platform-Key': PLATFORM_KEY },
        body: { clinicName: 'Clínica Dental Sonrisas del Norte', city: 'Barranquilla', brandColor: '#4f6d8a' },
      });
      assert.equal(response.status, 201, response.text);
      assert.match(response.json.bookingUrl, /\/c\/clinica-dental-sonrisas-del-norte$/);

      const cookie = await env.login(response.json.login.email, response.json.login.password);
      const patients = await env.request('GET', '/api/patients', { cookie });
      assert.ok(patients.json.length >= 10);
      const publicView = await env.request('GET', `/api/public/clinics/${response.json.slug}`);
      assert.equal(publicView.json.isShowcase, true);
      assert.ok(publicView.json.services.length >= 5);
    });
  });
});

describe('Re-cifrado de contraseñas', () => {
  it('actualiza el hash al ingresar si cambió la configuración de iteraciones', async () => {
    const env = await createTestEnvironment();
    const clinic = await env.createClinic('Consultorio Rehash', 'rehash@prueba.co');
    const { hashPassword: makeHash } = await import('../src/security/crypto.js');
    await env.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').bind(await makeHash(TEST_PASSWORD, 2000), clinic.adminEmail).run();
    await env.login(clinic.adminEmail);
    const row = await env.db.prepare('SELECT password_hash FROM users WHERE email = ?').bind(clinic.adminEmail).first<{ password_hash: string }>();
    assert.match(row?.password_hash ?? '', /^pbkdf2\$1000\$/);
  });
});

describe('Detección de IP (anti-evasión del límite de intentos)', () => {
  it('sin proxy de confianza ignora X-Real-IP falsificadas', async () => {
    const { buildConfig, createApp } = await import('../src/app.js');
    const { NodeSqliteDatabase } = await import('../src/db/nodeSqliteDatabase.js');
    const path = await import('node:path');
    const db = new NodeSqliteDatabase(':memory:');
    db.applyMigrations(path.join(process.cwd(), 'migrations'));
    const app = createApp(db, buildConfig({ APP_SECRET, PASSWORD_HASH_ITERATIONS: '1000', TRUST_PROXY: 'false' }));

    let lastStatus = 0;
    for (let attempt = 0; attempt < 22; attempt++) {
      const response = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agenda-sonrisa', 'X-Real-IP': `10.0.0.${attempt}` },
        body: JSON.stringify({ email: `usuario${attempt}@prueba.co`, password: 'incorrecta' }),
      });
      lastStatus = response.status;
    }
    assert.equal(lastStatus, 429, 'Rotar X-Real-IP no debe evadir el límite por IP');
  });
});
