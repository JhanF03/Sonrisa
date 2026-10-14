/**
 * Cliente HTTP de la API. Envía siempre la cabecera anti-CSRF y la cookie
 * de sesión (mismo origen). Convierte errores en ApiError con mensaje legible.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type QueryValue = string | number | boolean | null | undefined;

let onUnauthorized: (() => void) | null = null;
let onSuspended: (() => void) | null = null;

/** Se llama cuando el servidor responde 402 (suscripción suspendida por falta de pago). */
export function setSuspendedHandler(handler: (() => void) | null): void {
  onSuspended = handler;
}

/** Se llama cuando la sesión expira (para volver a la pantalla de ingreso). */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function apiRequest<TResponse>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { body?: unknown; query?: Record<string, QueryValue>; headers?: Record<string, string> } = {},
): Promise<TResponse> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(options.headers ?? {}),
        'X-Requested-With': 'agenda-sonrisa',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('No hay conexión con el servidor. Revisa tu internet.', 0, 'NETWORK');
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    if (response.status === 401 && onUnauthorized && !path.endsWith('/login')) onUnauthorized();
    if (response.status === 402 && onSuspended) onSuspended();
    const message = payload?.error?.message ?? `Error inesperado (${response.status}).`;
    throw new ApiError(message, response.status, payload?.error?.code ?? 'UNKNOWN');
  }
  return payload as TResponse;
}

export const api = {
  get: <TResponse>(path: string, query?: Record<string, QueryValue>) => apiRequest<TResponse>('GET', path, { query }),
  post: <TResponse>(path: string, body: unknown = {}) => apiRequest<TResponse>('POST', path, { body }),
  put: <TResponse>(path: string, body: unknown) => apiRequest<TResponse>('PUT', path, { body }),
  delete: <TResponse>(path: string) => apiRequest<TResponse>('DELETE', path),
};
