/**
 * Utilidades de prueba: base SQLite en memoria con migraciones reales,
 * dos consultorios aislados y usuarios con distintos roles.
 */
import path from 'node:path';
import { buildConfig, createApp } from '../src/app.js';
import { NodeSqliteDatabase } from '../src/db/nodeSqliteDatabase.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../src/http/middleware.js';
import { AuditService } from '../src/modules/audit/auditService.js';
import { TenantService } from '../src/modules/tenants/tenantService.js';
import { hashPassword } from '../src/security/crypto.js';
import { isColombianHoliday } from '../src/utils/colombianHolidays.js';
import { addDays, todayLocal, weekdayOf } from '../src/utils/time.js';

export const TEST_PASSWORD = 'ClaveSegura123';
export const PLATFORM_KEY = 'clave-de-plataforma-para-pruebas-123456';
export const APP_SECRET = 'secreto-de-aplicacion-para-pruebas-0123456789';

const baseConfigValues = {
  APP_SECRET,
  PLATFORM_ADMIN_KEY: PLATFORM_KEY,
  PASSWORD_HASH_ITERATIONS: '1000', // Rápido en pruebas; producción usa 100.000.
  ENVIRONMENT: 'test',
  TRUST_PROXY: 'true', // Las pruebas simulan IPs con X-Real-IP.
};

export interface TestEnvironmentOptions {
  /** Simula las APIs externas (Wompi, Turnstile). Por defecto, cualquier llamada falla. */
  fetch?: typeof fetch;
  turnstile?: { siteKey: string; secretKey: string };
}

const unexpectedFetch: typeof fetch = async (input) => {
  throw new Error(`Llamada externa no simulada: ${String(input)}`);
};

export interface TestClinic {
  tenantId: string;
  slug: string;
  adminEmail: string;
  professionalId: string;
  secondProfessionalId: string;
  serviceId: string;
  patientId: string;
}

export async function createTestEnvironment(options: TestEnvironmentOptions = {}) {
  const db = new NodeSqliteDatabase(':memory:');
  db.applyMigrations(path.join(process.cwd(), 'migrations'));
  const config = buildConfig({
    ...baseConfigValues,
    TURNSTILE_SITE_KEY: options.turnstile?.siteKey,
    TURNSTILE_SECRET_KEY: options.turnstile?.secretKey,
  });
  const app = createApp(db, config, { fetch: options.fetch ?? unexpectedFetch });
  const passwordHash = await hashPassword(TEST_PASSWORD, 1000);
  const tenantService = new TenantService(db, new AuditService(db));

  async function request(
    method: string,
    requestPath: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string>; skipCsrf?: boolean } = {},
  ) {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    if (!options.skipCsrf && method !== 'GET') headers[CSRF_HEADER] = CSRF_HEADER_VALUE;

    const response = await app.request(`http://localhost${requestPath}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, headers: response.headers, json, text };
  }

  async function login(email: string, password = TEST_PASSWORD): Promise<string> {
    const response = await app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'X-Real-IP': `ip-${email}` },
      body: JSON.stringify({ email, password }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (response.status !== 200 || !setCookie) throw new Error(`Login falló para ${email}: ${response.status} ${await response.text()}`);
    return setCookie.split(';')[0];
  }

  async function createClinic(name: string, adminEmail: string): Promise<TestClinic> {
    const { tenantId, slug } = await tenantService.createTenant({ name }, { fullName: 'Admin', email: adminEmail, passwordHash });
    const adminCookie = await login(adminEmail);

    const professional = await request('POST', '/api/professionals', {
      cookie: adminCookie,
      body: { fullName: 'Dra. Prueba', specialty: 'General', color: '#3f6f68' },
    });
    const secondProfessional = await request('POST', '/api/professionals', {
      cookie: adminCookie,
      body: { fullName: 'Dr. Segundo', specialty: 'Ortodoncia', color: '#4f6d8a' },
    });
    const weekdayBlocks = [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, startTime: '08:00', endTime: '12:00' },
      { weekday, startTime: '14:00', endTime: '18:00' },
    ]);
    for (const professionalId of [professional.json.id, secondProfessional.json.id]) {
      await request('PUT', `/api/professionals/${professionalId}/schedule`, { cookie: adminCookie, body: { blocks: weekdayBlocks } });
    }
    const service = await request('POST', '/api/services', {
      cookie: adminCookie,
      body: { code: 'PRO', name: 'Limpieza', price: 120000, durationMinutes: 60 },
    });
    const patient = await request('POST', '/api/patients', {
      cookie: adminCookie,
      body: { documentType: 'CC', documentNumber: `10${Math.floor(Math.random() * 1e8)}`, fullName: 'Paciente Prueba', phone: '3001234567', consentGiven: true },
    });

    return {
      tenantId,
      slug,
      adminEmail,
      professionalId: professional.json.id,
      secondProfessionalId: secondProfessional.json.id,
      serviceId: service.json.id,
      patientId: patient.json.id,
    };
  }

  /** Crea un usuario con los roles indicados por nombre y devuelve su cookie. */
  async function createUserWithRoles(adminCookie: string, email: string, roleNames: string[]): Promise<{ cookie: string; userId: string }> {
    const roles = await request('GET', '/api/roles', { cookie: adminCookie });
    const roleIds = roles.json.filter((role: { name: string }) => roleNames.includes(role.name)).map((role: { id: string }) => role.id);
    const created = await request('POST', '/api/users', {
      cookie: adminCookie,
      body: { email, fullName: email, password: TEST_PASSWORD, roleIds },
    });
    if (created.status !== 201) throw new Error(`No se pudo crear ${email}: ${created.text}`);
    return { cookie: await login(email), userId: created.json.id };
  }

  return { db, app, request, login, createClinic, createUserWithRoles };
}

/** Próximo día hábil (lunes a viernes, sin festivos) al menos `minDaysAhead` días adelante. */
export function nextBusinessDay(minDaysAhead = 7): string {
  let date = addDays(todayLocal(-300), minDaysAhead);
  // Evita fines de semana y festivos colombianos.
  while (weekdayOf(date) === 0 || weekdayOf(date) === 6 || isColombianHoliday(date)) {
    date = addDays(date, 1);
  }
  return date;
}
