/**
 * Construcción de la aplicación HTTP (Hono).
 *
 * Es la misma app para Cloudflare Workers (src/worker.ts) y para Node
 * (src/node/server.ts): solo cambia la base de datos que se le entrega.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SqlDatabase } from './db/database.js';
import type { AppConfig, AppEnv } from './http/context.js';
import { AppError } from './http/errors.js';
import { clientIpResolver, csrfProtection, errorHandler, securityHeaders, sessionLoader } from './http/middleware.js';
import { registerAdminRoutes } from './http/routes/adminRoutes.js';
import { registerAppointmentRoutes } from './http/routes/appointmentRoutes.js';
import { registerAuthRoutes } from './http/routes/authRoutes.js';
import { registerBillingRoutes } from './http/routes/billingRoutes.js';
import { registerCatalogAndPatientRoutes } from './http/routes/catalogAndPatientRoutes.js';
import { registerPlatformRoutes } from './http/routes/platformRoutes.js';
import { registerPublicRoutes } from './http/routes/publicRoutes.js';
import { registerSettingsRoutes } from './http/routes/settingsRoutes.js';
import { registerPaymentRoutes } from './http/routes/paymentRoutes.js';
import { registerInventoryRoutes } from './http/routes/inventoryRoutes.js';
import { registerEInvoiceRoutes } from './http/routes/einvoiceRoutes.js';
import { registerSubscriptionRoutes } from './http/routes/subscriptionRoutes.js';
import { registerSelfServiceRoutes } from './http/routes/selfServiceRoutes.js';
import { createServices, type AppServices, type ExternalDependencies } from './services.js';

const MAX_BODY_BYTES = 64 * 1024;

export function createApp(
  db: SqlDatabase,
  config: AppConfig,
  external: ExternalDependencies = { fetch: (input, init) => fetch(input, init) },
): Hono<AppEnv> & { services: AppServices } {
  const services = createServices(db, config, external);
  const app = new Hono<AppEnv>();

  app.use('*', async (context, next) => {
    context.set('db', db);
    context.set('config', config);
    context.set('services', services);
    await next();
  });
  app.use('*', securityHeaders);
  app.use('*', clientIpResolver);
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new AppError('La petición es demasiado grande.', 400, 'BODY_TOO_LARGE');
      },
    }),
  );
  app.use('/api/*', csrfProtection);
  app.use('/api/*', sessionLoader);

  app.get('/api/health', (context) => context.json({ status: 'ok' }));

  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerCatalogAndPatientRoutes(app);
  registerAppointmentRoutes(app);
  registerBillingRoutes(app);
  registerAdminRoutes(app);
  registerPublicRoutes(app);
  registerPlatformRoutes(app);
  registerPaymentRoutes(app);
  registerInventoryRoutes(app);
  registerEInvoiceRoutes(app);
  registerSubscriptionRoutes(app);
  registerSelfServiceRoutes(app);

  app.notFound((context) =>
    context.json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } }, 404),
  );
  app.onError(errorHandler);

  return Object.assign(app, { services });
}

/** Valida la configuración y aplica valores por defecto seguros. */
export function buildConfig(rawValues: {
  PASSWORD_HASH_ITERATIONS?: string;
  SESSION_TTL_HOURS?: string;
  PLATFORM_ADMIN_KEY?: string;
  APP_SECRET?: string;
  ENVIRONMENT?: string;
  TRUST_PROXY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}): AppConfig {
  const environment =
    rawValues.ENVIRONMENT === 'development' || rawValues.ENVIRONMENT === 'test' ? rawValues.ENVIRONMENT : 'production';
  const appSecret = rawValues.APP_SECRET ?? '';

  if (appSecret.length < 32) {
    throw new Error('APP_SECRET es obligatorio y debe tener al menos 32 caracteres.');
  }
  const turnstileSiteKey = (rawValues.TURNSTILE_SITE_KEY ?? '').trim();
  const turnstileSecretKey = (rawValues.TURNSTILE_SECRET_KEY ?? '').trim();
  if (Boolean(turnstileSiteKey) !== Boolean(turnstileSecretKey)) {
    throw new Error('Para activar Turnstile define TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY (ambas).');
  }

  const iterations = Number(rawValues.PASSWORD_HASH_ITERATIONS ?? 100_000);
  const sessionTtlHours = Number(rawValues.SESSION_TTL_HOURS ?? 12);

  return Object.freeze({
    environment,
    appSecret,
    platformAdminKey: rawValues.PLATFORM_ADMIN_KEY ?? '',
    trustProxyHeaders: rawValues.TRUST_PROXY === 'true',
    turnstileSiteKey,
    turnstileSecretKey,
    passwordHashIterations: Number.isInteger(iterations) && iterations >= 1_000 && iterations <= 100_000 ? iterations : 100_000,
    sessionTtlHours: Number.isFinite(sessionTtlHours) && sessionTtlHours >= 1 && sessionTtlHours <= 72 ? sessionTtlHours : 12,
  });
}
