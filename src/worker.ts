/**
 * Punto de entrada para Cloudflare Workers (plan gratuito).
 * Los archivos del frontend los sirve Cloudflare directamente (Static Assets);
 * este Worker atiende /api/* y la tarea programada de mantenimiento.
 */
import { buildConfig, createApp } from './app.js';
import type { SqlDatabase } from './db/database.js';
import { openWorkerSocket } from './modules/mail/workerSocket.js';

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

/** Debe coincidir con el segundo cron de wrangler.toml. */
const REMINDERS_CRON = '7 * * * *';

// La app se construye una vez por instancia (isolate) y se reutiliza.
let cachedApp: ReturnType<typeof createApp> | undefined;

function getApp(bindings: WorkerBindings): ReturnType<typeof createApp> {
  cachedApp ??= createApp(bindings.DB as unknown as SqlDatabase, buildConfig(bindings), {
    fetch: (input, init) => fetch(input, init),
    openSocket: openWorkerSocket,
  });
  return cachedApp;
}

export default {
  async fetch(request: Request, bindings: WorkerBindings, executionContext: ExecutionContext): Promise<Response> {
    const app = getApp(bindings);
    const response = await app.fetch(request, bindings, executionContext);
    // Los correos se envían después de responder (el usuario no espera a Gmail).
    executionContext.waitUntil(app.services.mail.flush());
    return response;
  },

  /**
   * Cron Triggers (wrangler.toml). Cada uno corre aparte y tiene su propio cupo
   * de consultas a D1 (50 en el plan gratuito):
   *   • cada 10 min → libera reservas vencidas y limpia datos temporales.
   *   • cada hora   → recordatorios de pago y de demos por terminar (por correo).
   */
  scheduled(controller: ScheduledController, bindings: WorkerBindings, executionContext: ExecutionContext): void {
    const { services } = getApp(bindings);
    if (controller.cron === REMINDERS_CRON) {
      executionContext.waitUntil(
        services.notifications.sendReminders().then(async (sent) => {
          if (sent > 0) console.log(`Recordatorios: ${sent} correos`);
          await services.mail.flush();
        }),
      );
      return;
    }
    executionContext.waitUntil(
      services.maintenance.runScheduled().then(({ releasedHolds }) => {
        if (releasedHolds > 0) console.log(`Mantenimiento: ${releasedHolds} reservas vencidas liberadas`);
      }),
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
