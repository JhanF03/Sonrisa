/**
 * Prueba de humo de extremo a extremo contra un servidor en ejecución
 * (local con `npm run cf:dev`, o tu despliegue en Cloudflare).
 *
 * Uso: node scripts/smoke-test.mjs <URL_BASE> <PLATFORM_ADMIN_KEY>
 * Ej.:  node scripts/smoke-test.mjs http://localhost:8787 mi-clave-de-plataforma
 *
 * Crea una demo (modo vitrina), ingresa, agenda, reserva en línea, confirma
 * con el enlace firmado, atiende, cobra y revisa los indicadores.
 */
const [baseUrl, platformKey] = process.argv.slice(2);
if (!baseUrl || !platformKey) {
  console.error('Uso: node scripts/smoke-test.mjs <URL_BASE> <PLATFORM_ADMIN_KEY>');
  process.exit(1);
}

const CSRF = { 'X-Requested-With': 'agenda-sonrisa' };
let sessionCookie = '';
let step = 0;

async function call(method, path, body, extraHeaders = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...CSRF,
      ...extraHeaders,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta no JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

function check(description, condition, detail = '') {
  step++;
  if (!condition) {
    console.error(`✘ ${step}. ${description} ${detail}`);
    process.exit(1);
  }
  console.log(`✔ ${step}. ${description}`);
}

function addDays(date, days) {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

const health = await call('GET', '/api/health');
check('La API responde', health.status === 200, health.text);
check('Cabeceras de seguridad presentes', (health.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));

const showcase = await call('POST', '/api/platform/showcase', { clinicName: `Prueba Humo ${Date.now()}`, city: 'Medellín' }, { 'X-Platform-Key': platformKey });
check('Crea una demo (modo vitrina)', showcase.status === 201, showcase.text);
const { slug, login } = showcase.json;

const loginResponse = await call('POST', '/api/auth/login', login);
check('Ingresa al panel', loginResponse.status === 200, loginResponse.text);
sessionCookie = (loginResponse.headers.get('set-cookie') ?? '').split(';')[0];
check('Recibe cookie de sesión HttpOnly', /httponly/i.test(loginResponse.headers.get('set-cookie') ?? ''));

const me = await call('GET', '/api/auth/me');
check('Carga el perfil con permisos', me.status === 200 && me.json.permissions.length > 20, me.text);

const clinic = await call('GET', `/api/public/clinics/${slug}`);
check('Página pública del consultorio', clinic.status === 200 && clinic.json.services.length > 0, clinic.text);
const service = clinic.json.services[0];

const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const slots = await call('GET', `/api/public/clinics/${slug}/availability?from=${addDays(today, 1)}&to=${addDays(today, 14)}&serviceId=${service.id}`);
check('Consulta horarios disponibles', slots.status === 200 && slots.json.length > 0, slots.text);

const booking = await call('POST', `/api/public/clinics/${slug}/appointments`, {
  serviceId: service.id,
  startAt: slots.json[0].start,
  consentGiven: true,
  patient: { documentType: 'CC', documentNumber: `9${Date.now() % 1e9}`, fullName: 'Paciente Humo', phone: '3001234567' },
});
check('Reserva en línea', booking.status === 201, booking.text);

const duplicate = await call('POST', `/api/public/clinics/${slug}/appointments`, {
  serviceId: service.id,
  professionalId: slots.json[0].professionalId,
  startAt: slots.json[0].start,
  consentGiven: true,
  patient: { documentType: 'CC', documentNumber: '123456789', fullName: 'Otra Persona', phone: '3009998877' },
});
check('Rechaza reservar el mismo horario dos veces', duplicate.status === 409, duplicate.text);

const token = encodeURIComponent(booking.json.token);
const confirmed = await call('POST', `/api/public/appointments/${token}/confirm`);
check('El paciente confirma con su enlace', confirmed.json?.appointment?.status === 'confirmada', confirmed.text);

const tampered = await call('GET', `/api/public/appointments/${token.slice(0, -2)}xx`);
check('Rechaza enlaces alterados', tampered.status === 404);

const date = slots.json[0].start.slice(0, 10);
const agenda = await call('GET', `/api/appointments?from=${date}&to=${date}`);
const appointment = agenda.json.find((item) => item.start_at === slots.json[0].start && item.patient_name === 'Paciente Humo');
check('La cita aparece en la agenda', Boolean(appointment), agenda.text);

const attended = await call('POST', `/api/appointments/${appointment.id}/status`, { status: 'atendida' });
check('Marca la cita como atendida', attended.status === 200, attended.text);

const statement = await call('GET', `/api/patients/${appointment.patient_id}/statement`);
check('Se generó la cuenta por cobrar', statement.json.totals.pendingDebt === service.price, statement.text);

const payment = await call('POST', '/api/payments', { patientId: appointment.patient_id, amount: service.price + 10_000, method: 'nequi' });
check('Registra el pago con recibo consecutivo', payment.status === 201 && payment.json.receipt_number > 0, payment.text);
check('El excedente queda como anticipo', payment.json.available === 10_000, payment.text);

const aging = await call('GET', '/api/receivables/aging');
check('Calcula la cartera por edades', aging.status === 200 && Array.isArray(aging.json));

const indicators = await call('GET', '/api/reports/monthly');
check('Calcula los indicadores del mes', indicators.status === 200 && indicators.json.appointments.total > 0, indicators.text);

const noCsrf = await fetch(new URL('/api/payments', baseUrl), { method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' }, body: '{}' });
check('Bloquea peticiones sin cabecera anti-CSRF', noCsrf.status === 403);

await call('POST', '/api/auth/logout');
const afterLogout = await call('GET', '/api/auth/me');
check('Cerrar sesión invalida la cookie', afterLogout.status === 401);

console.log(`\n✅ Prueba de humo superada (${step} verificaciones) contra ${baseUrl}`);
