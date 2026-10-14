/**
 * Registro declarativo de rutas con su control de acceso.
 *
 * Cada ruta declara explícitamente quién puede usarla. Eso permite:
 *   1. Aplicar el permiso de forma uniforme (imposible "olvidarlo").
 *   2. Que las pruebas de seguridad recorran TODAS las rutas y verifiquen
 *      que sin sesión o sin permiso la respuesta es 401/403.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { forbidden, unauthorized } from './errors.js';
import type { AppContext, AppEnv } from './context.js';
import type { Permission } from '../security/permissions.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteAccess =
  | { type: 'public' }
  | { type: 'authenticated' }
  | { type: 'permission'; anyOf: readonly Permission[] };

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  access: RouteAccess;
  handler: (context: AppContext) => Promise<Response> | Response;
}

export interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  access: RouteAccess;
}

const registeredRouteMap = new Map<string, RegisteredRoute>();

/** Lista de rutas registradas (usada por las pruebas de seguridad). */
export function getRegisteredRoutes(): RegisteredRoute[] {
  return [...registeredRouteMap.values()];
}

export const publicAccess: RouteAccess = { type: 'public' };
export const authenticatedAccess: RouteAccess = { type: 'authenticated' };
export const requiresAny = (...anyOf: Permission[]): RouteAccess => ({ type: 'permission', anyOf });

export function defineRoutes(app: Hono<AppEnv>, routes: RouteDefinition[]): void {
  for (const route of routes) {
    registeredRouteMap.set(`${route.method} ${route.path}`, {
      method: route.method,
      path: route.path,
      access: route.access,
    });
    app.on(route.method, route.path, accessGuard(route.access), (context) => route.handler(context));
  }
}

function accessGuard(access: RouteAccess): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (access.type === 'public') return next();

    const auth = context.get('auth');
    if (!auth) throw unauthorized();

    if (access.type === 'permission' && !access.anyOf.some((permission) => auth.permissions.has(permission))) {
      throw forbidden();
    }
    return next();
  };
}
