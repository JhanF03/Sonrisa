/**
 * Servidor Node.js: para desarrollo local, pruebas o desplegar en tu propio
 * servidor (ej. AWS EC2) con SQLite. Mismo código de negocio que en Cloudflare.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildConfig, createApp } from '../app.js';
import { NodeSqliteDatabase } from '../db/nodeSqliteDatabase.js';
import { seedDemoData } from '../modules/platform/demoDataService.js';
import { generateSecureToken, hashPassword } from '../security/crypto.js';
import { TenantService } from '../modules/tenants/tenantService.js';
import { AuditService } from '../modules/audit/auditService.js';

const projectRoot = process.cwd();

const envFile = path.join(projectRoot, '.env');
if (!existsSync(envFile) && !process.env.APP_SECRET) {
  // Primera ejecución: se crea un .env con secretos aleatorios para que todo funcione de inmediato.
  writeFileSync(
    envFile,
    [
      '# Generado automáticamente en la primera ejecución. No lo subas a git.',
      `APP_SECRET=${generateSecureToken(32)}`,
      `PLATFORM_ADMIN_KEY=${generateSecureToken(24)}`,
      'PORT=8787',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log('✔ Se creó el archivo .env con secretos aleatorios.');
}
try {
  process.loadEnvFile(envFile);
} catch {
  // Sin archivo .env: se usan variables del sistema.
}

const port = Number(process.env.PORT ?? 8787);
const databaseFile = process.env.DATABASE_FILE ?? path.join(projectRoot, 'data', 'agenda-sonrisa.db');

if (!process.env.APP_SECRET) {
  process.env.APP_SECRET = generateSecureToken(32);
  console.warn('⚠  APP_SECRET no está definido en .env: se generó uno temporal. Los enlaces de citas dejarán de servir al reiniciar.');
}

const config = buildConfig({ ...process.env, ENVIRONMENT: process.env.ENVIRONMENT ?? 'development' });

process.on('uncaughtException', (error) => {
  console.error('\n✘ Error al iniciar el servidor:', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('\n✘ Error al iniciar el servidor:', error);
  process.exit(1);
});

console.log(`… Abriendo base de datos: ${path.relative(projectRoot, databaseFile)}`);
mkdirSync(path.dirname(databaseFile), { recursive: true });
const database = new NodeSqliteDatabase(databaseFile);
console.log(`… Revisando migraciones (motor: ${database.driverName})`);
const appliedMigrations = database.applyMigrations(path.join(projectRoot, 'migrations'));
if (appliedMigrations.length > 0) console.log(`✔ Migraciones aplicadas: ${appliedMigrations.join(', ')}`);

console.log('… Preparando consultorio de demostración');
await createDemoClinicIfEmpty();
console.log(`… Iniciando servidor web en el puerto ${port}`);

const app = createApp(database, config);
const publicDirectory = path.relative(projectRoot, path.join(projectRoot, 'public'));
const indexHtml = readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
const platformHtml = readFileSync(path.join(projectRoot, 'public', 'plataforma.html'), 'utf8');

// Panel del dueño: aplicación aparte (igual que en Cloudflare, /plataforma → plataforma.html).
app.get('/plataforma', (context) => context.html(platformHtml));
app.use('/*', serveStatic({ root: publicDirectory }));
// Rutas de la aplicación de una sola página (/app, /c/consultorio, /ingresar…).
app.get('*', (context) => (context.req.path.startsWith('/api/') ? context.notFound() : context.html(indexHtml)));

// Mantenimiento cada 5 minutos (equivalente al Cron Trigger de Cloudflare).
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
  app.services.maintenance.runScheduled().catch((error: unknown) => console.error('[mantenimiento]', error));
}, MAINTENANCE_INTERVAL_MS).unref();

serve({ fetch: app.fetch, port }, () => {
  console.log(`\n🦷 Agenda Sonrisa lista en http://localhost:${port}`);
  console.log(`   Panel:          http://localhost:${port}/app`);
  console.log(`   Plataforma:     http://localhost:${port}/plataforma  (la primera vez: clave PLATFORM_ADMIN_KEY de .env)`);
});

async function createDemoClinicIfEmpty(): Promise<void> {
  const existingTenant = await database.prepare('SELECT slug FROM tenants LIMIT 1').first<{ slug: string }>();
  if (existingTenant) return;

  const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'admin@demo.local';
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD || `Demo-${generateSecureToken(8)}7`;
  const tenantService = new TenantService(database, new AuditService(database));
  const { tenantId, slug, adminUserId } = await tenantService.createTenant(
    { name: 'Consultorio Demo Sonrisa', city: 'Medellín', phone: '+57 604 000 0000', billingMode: 'exento' },
    { fullName: 'Administrador', email: adminEmail, passwordHash: await hashPassword(adminPassword, config.passwordHashIterations) },
  );
  await seedDemoData(database, tenantId, -300, adminUserId);

  const credentialsFile = path.join(path.dirname(databaseFile), 'credenciales-demo.txt');
  if (!existsSync(credentialsFile)) {
    writeFileSync(credentialsFile, `Correo: ${adminEmail}\nContraseña: ${adminPassword}\n`, { mode: 0o600 });
  }
  console.log('\n✔ Consultorio de demostración creado.');
  console.log(`   Reservas: http://localhost:${port}/c/${slug}`);
  console.log(`   Ingreso:  ${adminEmail}  /  ${adminPassword}`);
  console.log(`   (también guardado en ${path.relative(projectRoot, credentialsFile)})`);
}
