/**
 * Middlewares transversales: cabeceras de seguridad, CSRF, sesión y errores.
 */
import type { ErrorHandler, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import type { AppEnv } from './context.js';
import { isSlotTakenError } from '../db/sqlFragments.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE_SECURE = '__Host-sid';
export const SESSION_COOKIE_DEV = 'sid';
/** Cabecera obligatoria en peticiones que modifican datos (defensa CSRF). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'agenda-sonrisa';

/** Política de seguridad de contenido: solo recursos propios. */
/** Turnstile (anti-robots opcional) es el único origen externo permitido. */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self' ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (context, next) => {
  await next();
  for (const [headerName, headerValue] of Object.entries(SECURITY_HEADERS)) {
    context.res.headers.set(headerName, headerValue);
  }
  if (new URL(context.req.url).protocol === 'https:') {
    context.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (context.req.path.startsWith('/api/')) {
    context.res.headers.set('Cache-Control', 'no-store');
  }
};

/**
 * Defensa CSRF en dos capas para métodos que modifican datos:
 * 1. Cabecera personalizada obligatoria (un formulario de otro sitio no puede enviarla).
 * 2. Si llega el encabezado Origin, debe ser el mismo sitio.
 * Además la cookie de sesión es SameSite=Strict.
 */
/** Rutas llamadas por servidores externos (autenticadas con su propia firma). */
export const WEBHOOK_PATH_PREFIX = '/api/webhooks/';

export const csrfProtection: MiddlewareHandler<AppEnv> = async (context, next) => {
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method);
  // Los webhooks no vienen de un navegador: se validan con el checksum de Wompi.
  if (isMutation && !context.req.path.startsWith(WEBHOOK_PATH_PREFIX)) {
    if (context.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw new AppError('Petición rechazada por seguridad (CSRF).', 403, 'CSRF_REJECTED');
    }
    const origin = context.req.header('Origin');
    if (origin && origin !== new URL(context.req.url).origin) {
      throw new AppError('Petición rechazada: origen no permitido.', 403, 'ORIGIN_REJECTED');
    }
  }
  await next();
};

export function getSessionCookieName(requestUrl: string): string {
  return new URL(requestUrl).protocol === 'https:' ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV;
}

/** Si hay cookie de sesión válida, deja el usuario en el contexto. */
export const sessionLoader: MiddlewareHandler<AppEnv> = async (context, next) => {
  const sessionToken = getCookie(context, getSessionCookieName(context.req.url));
  if (sessionToken && sessionToken.length <= 100) {
    context.set('auth', await context.get('services').auth.resolveSession(sessionToken));
  }
  await next();
};

export const clientIpResolver: MiddlewareHandler<AppEnv> = async (context, next) => {
  // En Cloudflare, CF-Connecting-IP lo pone la plataforma (el cliente no puede falsificarlo).
  const cloudflareIp = context.req.header('CF-Connecting-IP');
  const proxyIp = context.get('config').trustProxyHeaders
    ? (context.req.header('X-Real-IP') ?? context.req.header('X-Forwarded-For')?.split(',')[0]?.trim())
    : undefined;
  // En Node sin proxy se usa la dirección real del socket.
  const socketIp = (context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;

  context.set('clientIp', (cloudflareIp ?? proxyIp ?? socketIp ?? 'desconocida').slice(0, 64));
  await next();
};

export const errorHandler: ErrorHandler<AppEnv> = (error, context) => {
  if (error instanceof AppError) {
    return context.json({ error: { code: error.errorCode, message: error.message } }, error.statusCode);
  }
  if (error instanceof ZodError) {
    return context.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues[0]?.message ?? 'Datos inválidos.',
          details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      },
      400,
    );
  }
  // Un trigger de la base rechazó un cruce de horario (última línea de defensa).
  if (isSlotTakenError(error)) {
    return context.json({ error: { code: 'CONFLICT', message: 'Ese horario ya está ocupado. Actualiza y elige otro.' } }, 409);
  }
  if (error instanceof Error && error.message.includes('CARGO_FACTURADO')) {
    return context.json({ error: { code: 'CONFLICT', message: 'Este cargo ya está en una factura electrónica. Primero anula la factura (nota crédito).' } }, 409);
  }
  // Errores de restricción de la base (ej. UNIQUE) sin exponer el SQL.
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    return context.json({ error: { code: 'CONFLICT', message: 'El registro ya existe.' } }, 409);
  }
  console.error('[error no controlado]', error);
  return context.json({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' } }, 500);
};
