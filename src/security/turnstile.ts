/**
 * Cloudflare Turnstile (opcional y gratuito): comprueba que quien reserva
 * es una persona y no un robot, sin pedirle resolver acertijos.
 * Se activa definiendo TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY.
 * Documentación: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
import { AppError } from '../http/errors.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

export class TurnstileVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImplementation: typeof fetch,
  ) {}

  get isEnabled(): boolean {
    return this.secretKey.length > 0;
  }

  /** Lanza 400 si el token no es válido. No hace nada si Turnstile está desactivado. */
  async assertHuman(token: string | undefined, clientIp: string): Promise<void> {
    if (!this.isEnabled) return;
    if (!token || token.length > 2048) {
      throw new AppError('Confirma que no eres un robot para continuar.', 400, 'TURNSTILE_REQUIRED');
    }

    let result: SiteverifyResponse;
    try {
      const response = await this.fetchImplementation(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: this.secretKey, response: token, remoteip: clientIp, idempotency_key: crypto.randomUUID() }),
        signal: AbortSignal.timeout(8000),
      });
      result = (await response.json()) as SiteverifyResponse;
    } catch {
      throw new AppError('No pudimos verificar que no eres un robot. Intenta de nuevo.', 400, 'TURNSTILE_UNAVAILABLE');
    }

    if (!result.success) {
      throw new AppError('La verificación anti-robots expiró o falló. Vuelve a marcarla.', 400, 'TURNSTILE_FAILED');
    }
  }
}
