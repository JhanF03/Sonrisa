/**
 * Punto de entrada para Cloudflare Workers (plan gratuito).
 * Los archivos del frontend los sirve Cloudflare directamente (Static Assets);
 * este Worker atiende /api/* y la tarea programada de mantenimiento.
 */
import { buildConfig, createApp } from './app.js';
import type { SqlDatabase } from './db/database.js';

export interface WorkerBindings {
  DB: D1Database;
  APP_SECRET?: string;
  PLATFORM_ADMIN_KEY?: string;
  PASSWORD_HASH_ITERATIONS?: string;
  SESSION_TTL_HOURS?: string;
  ENVIRONMENT?: string;
  TRUST_PROXY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

// La app se construye una vez por instancia (isolate) y se reutiliza.
let cachedApp: ReturnType<typeof createApp> | undefined;

function getApp(bindings: WorkerBindings): ReturnType<typeof createApp> {
  cachedApp ??= createApp(bindings.DB as unknown as SqlDatabase, buildConfig(bindings));
  return cachedApp;
}

export default {
  fetch(request: Request, bindings: WorkerBindings, executionContext: ExecutionContext): Response | Promise<Response> {
    return getApp(bindings).fetch(request, bindings, executionContext);
  },

  /** Cron Trigger (wrangler.toml): libera reservas vencidas y limpia datos temporales. */
  scheduled(_controller: ScheduledController, bindings: WorkerBindings, executionContext: ExecutionContext): void {
    executionContext.waitUntil(
      getApp(bindings)
        .services.maintenance.runScheduled()
        .then(({ releasedHolds }) => {
          if (releasedHolds > 0) console.log(`Mantenimiento: ${releasedHolds} reservas vencidas liberadas`);
        }),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
