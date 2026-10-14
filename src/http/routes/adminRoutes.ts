/**
 * Indicadores, usuarios, roles y auditoría.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { isPermission, type Permission } from '../../security/permissions.js';
import { todayLocal } from '../../utils/time.js';
import { actorOf, requireAuth, type AppEnv } from '../context.js';
import { defineRoutes, requiresAny } from '../routeRegistry.js';
import { idSchema, optionalText, paginationSchema, readIdParam, readJsonBody, readQuery, requiredText } from '../validation.js';
import { PASSWORD_POLICY } from './authRoutes.js';

const permissionListSchema = z
  .array(z.string())
  .max(200)
  .transform((values, context) => {
    const invalid = values.filter((value) => !isPermission(value));
    if (invalid.length > 0) {
      context.addIssue({ code: 'custom', message: `Permisos desconocidos: ${invalid.join(', ')}` });
      return z.NEVER;
    }
    return [...new Set(values)] as Permission[];
  });

const roleSchema = z.object({
  name: requiredText(60, 'El nombre del rol'),
  description: optionalText(200),
  permissions: permissionListSchema,
});

const roleIdsSchema = z.array(idSchema).max(20);

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  defineRoutes(app, [
    {
      method: 'GET',
      path: '/api/reports/monthly',
      access: requiresAny('reportes.ver'),
      handler: async (context) => {
        const auth = requireAuth(context);
        const { month } = readQuery(
          context,
          z.object({
            month: z
              .string()
              .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido (usa AAAA-MM).')
              .default(todayLocal(auth.tenant.utc_offset_minutes).slice(0, 7)),
          }),
        );
        return context.json(await context.get('services').reports.getMonthlyIndicators(auth.tenant, month));
      },
    },
    {
      method: 'GET',
      path: '/api/roles',
      access: requiresAny('roles.gestionar', 'usuarios.gestionar'),
      handler: async (context) => context.json(await context.get('services').users.listRoles(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/roles',
      access: requiresAny('roles.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(context, roleSchema);
        const auth = requireAuth(context);
        return context.json(await context.get('services').users.createRole(actorOf(context), auth.permissions, input), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/roles/:id',
      access: requiresAny('roles.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(context, roleSchema);
        const auth = requireAuth(context);
        return context.json(
          await context.get('services').users.updateRole(actorOf(context), auth.permissions, readIdParam(context), input),
        );
      },
    },
    {
      method: 'DELETE',
      path: '/api/roles/:id',
      access: requiresAny('roles.gestionar'),
      handler: async (context) => {
        await context.get('services').users.deleteRole(actorOf(context), readIdParam(context));
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/users',
      access: requiresAny('usuarios.gestionar'),
      handler: async (context) => context.json(await context.get('services').users.listUsers(requireAuth(context).tenant.id)),
    },
    {
      method: 'POST',
      path: '/api/users',
      access: requiresAny('usuarios.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({
            email: z.email('Correo inválido.').max(200),
            fullName: requiredText(120, 'El nombre'),
            password: PASSWORD_POLICY,
            roleIds: roleIdsSchema,
          }),
        );
        const auth = requireAuth(context);
        return context.json(await context.get('services').users.createUser(actorOf(context), auth.permissions, input), 201);
      },
    },
    {
      method: 'PUT',
      path: '/api/users/:id',
      access: requiresAny('usuarios.gestionar'),
      handler: async (context) => {
        const input = await readJsonBody(
          context,
          z.object({ fullName: requiredText(120, 'El nombre'), isActive: z.boolean(), roleIds: roleIdsSchema }),
        );
        const auth = requireAuth(context);
        return context.json(
          await context.get('services').users.updateUser(actorOf(context), auth.permissions, readIdParam(context), input),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/users/:id/reset-password',
      access: requiresAny('usuarios.gestionar'),
      handler: async (context) => {
        const { password } = await readJsonBody(context, z.object({ password: PASSWORD_POLICY }));
        await context
          .get('services')
          .users.resetPassword(actorOf(context), requireAuth(context).permissions, readIdParam(context), password);
        return context.json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      access: requiresAny('auditoria.ver'),
      handler: async (context) => {
        const query = readQuery(context, paginationSchema);
        return context.json(await context.get('services').audit.list(requireAuth(context).tenant.id, query));
      },
    },
  ]);
}
