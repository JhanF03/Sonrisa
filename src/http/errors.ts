/**
 * Errores controlados. El manejador central los convierte en
 * { error: { code, message } } sin exponer detalles internos.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 429 | 500 = 400,
    readonly errorCode = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (entityLabel: string) =>
  new AppError(`${entityLabel} no existe o no pertenece a este consultorio.`, 404, 'NOT_FOUND');

export const forbidden = (message = 'No tienes permiso para realizar esta acción.') =>
  new AppError(message, 403, 'FORBIDDEN');

export const conflict = (message: string) => new AppError(message, 409, 'CONFLICT');

export const unauthorized = (message = 'Tu sesión expiró. Ingresa de nuevo.') =>
  new AppError(message, 401, 'UNAUTHORIZED');
