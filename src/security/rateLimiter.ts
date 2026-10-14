/**
 * Limitador de intentos con ventana fija, guardado en la base de datos
 * (funciona igual en Cloudflare y Node, sin servicios extra).
 */
import type { SqlDatabase } from '../db/database.js';
import { AppError } from '../http/errors.js';

export interface RateLimitRule {
  /** Máximo de intentos por ventana. */
  limit: number;
  windowMs: number;
  message: string;
}

export const RATE_LIMIT_RULES = {
  loginPerIp: { limit: 20, windowMs: 15 * 60_000, message: 'Demasiados intentos de ingreso. Espera 15 minutos.' },
  loginPerEmail: { limit: 8, windowMs: 15 * 60_000, message: 'Demasiados intentos para esta cuenta. Espera 15 minutos.' },
  publicBookingPerIp: { limit: 10, windowMs: 60 * 60_000, message: 'Has hecho muchas reservas seguidas. Intenta más tarde o llama al consultorio.' },
  publicLookupPerIp: { limit: 120, windowMs: 10 * 60_000, message: 'Demasiadas consultas. Espera unos minutos.' },
  platformPerIp: { limit: 10, windowMs: 15 * 60_000, message: 'Demasiados intentos. Espera 15 minutos.' },
} as const satisfies Record<string, RateLimitRule>;

export class RateLimiter {
  constructor(private readonly db: SqlDatabase) {}

  /** Registra un intento y lanza 429 si se superó el límite. */
  async consume(bucketKey: string, rule: RateLimitRule, nowMs = Date.now()): Promise<void> {
    const windowStart = nowMs - (nowMs % rule.windowMs);

    const [, countResult] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO rate_limits (bucket_key, window_start, hit_count) VALUES (?, ?, 1)
           ON CONFLICT(bucket_key) DO UPDATE SET
             hit_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.hit_count + 1 ELSE 1 END,
             window_start = excluded.window_start`,
        )
        .bind(bucketKey, windowStart),
      this.db.prepare('SELECT hit_count FROM rate_limits WHERE bucket_key = ?').bind(bucketKey),
    ]);

    const hitCount = (countResult.results?.[0] as { hit_count: number } | undefined)?.hit_count ?? 0;
    if (hitCount > rule.limit) {
      throw new AppError(rule.message, 429, 'RATE_LIMITED');
    }
  }

  /** Reinicia el contador (ej. tras un ingreso exitoso). */
  async reset(bucketKey: string): Promise<void> {
    await this.db.prepare('DELETE FROM rate_limits WHERE bucket_key = ?').bind(bucketKey).run();
  }
}
