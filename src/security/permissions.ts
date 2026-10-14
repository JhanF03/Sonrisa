/**
 * Catálogo de permisos granulares: "módulo.recurso.acción".
 *
 * • El servidor valida el permiso en CADA ruta (ver http/routeRegistry.ts).
 * • La interfaz solo oculta lo que el usuario no puede usar; nunca es la
 *   única barrera.
 * • Los roles son conjuntos editables de estos permisos.
 *
 * Para agregar un permiso: añádelo aquí, úsalo en una ruta y listo; aparece
 * automáticamente en la matriz de roles de la interfaz.
 */

export const PERMISSION_CATALOG = {
  // Agenda
  'agenda.ver_todas': { module: 'Agenda', label: 'Ver la agenda de todos los profesionales' },
  'agenda.ver_propia': { module: 'Agenda', label: 'Ver solo su propia agenda' },
  'agenda.crear': { module: 'Agenda', label: 'Crear citas' },
  'agenda.editar': { module: 'Agenda', label: 'Reprogramar y editar citas' },
  'agenda.cambiar_estado': { module: 'Agenda', label: 'Marcar citas como confirmadas, atendidas o no asistió' },
  'agenda.cancelar': { module: 'Agenda', label: 'Cancelar citas' },
  'agenda.bloquear': { module: 'Agenda', label: 'Crear y eliminar bloqueos de horario' },
  'agenda.verificar': { module: 'Agenda', label: 'Verificar reservas en línea (código de WhatsApp)' },
  'recordatorios.gestionar': { module: 'Agenda', label: 'Recordatorios, reactivación y lista de espera' },

  // Pacientes
  'pacientes.ver': { module: 'Pacientes', label: 'Ver pacientes' },
  'pacientes.crear': { module: 'Pacientes', label: 'Crear pacientes' },
  'pacientes.editar': { module: 'Pacientes', label: 'Editar datos de pacientes' },
  'pacientes.exportar': { module: 'Pacientes', label: 'Exportar pacientes a Excel' },

  // Servicios
  'servicios.ver': { module: 'Servicios', label: 'Ver el catálogo de servicios' },
  'servicios.gestionar': { module: 'Servicios', label: 'Crear y editar servicios y precios' },

  // Caja
  'caja.recaudo.crear': { module: 'Caja', label: 'Registrar pagos (abonos y anticipos)' },
  'caja.recaudo.ver': { module: 'Caja', label: 'Ver pagos y recibos' },
  'caja.recaudo.anular': { module: 'Caja', label: 'Anular recibos de caja' },
  'caja.cierre.ver': { module: 'Caja', label: 'Ver el cierre de caja' },

  // Cartera
  'cartera.ver': { module: 'Cartera', label: 'Ver saldos y edades de cartera' },
  'cartera.cargo.crear': { module: 'Cartera', label: 'Crear cargos (cuentas por cobrar)' },
  'cartera.cargo.anular': { module: 'Cartera', label: 'Anular cargos' },

  // Pagos en línea
  'pagos.ver': { module: 'Pagos en línea', label: 'Ver pagos en línea y marcar alertas como atendidas' },
  'pagos.configurar': { module: 'Pagos en línea', label: 'Configurar la cuenta de Wompi del consultorio' },

  // Compras e inventario
  'compras.ver': { module: 'Compras', label: 'Ver compras, proveedores y cuentas por pagar' },
  'compras.gestionar': { module: 'Compras', label: 'Registrar y anular compras; gestionar proveedores' },
  'compras.pagar': { module: 'Compras', label: 'Registrar y anular pagos a proveedores' },
  'inventario.ver': { module: 'Inventario', label: 'Ver insumos, existencias y costo por servicio' },
  'inventario.gestionar': { module: 'Inventario', label: 'Crear insumos, ajustar existencias y definir el consumo de cada servicio' },

  // Facturación electrónica
  'facturacion.ver': { module: 'Facturación', label: 'Ver facturas electrónicas de venta' },
  'facturacion.emitir': { module: 'Facturación', label: 'Emitir facturas y reintentar envíos' },
  'facturacion.anular': { module: 'Facturación', label: 'Anular facturas (con nota crédito)' },
  'facturacion.configurar': { module: 'Facturación', label: 'Configurar el proveedor de facturación electrónica' },

  // Reportes
  'reportes.ver': { module: 'Reportes', label: 'Ver indicadores' },

  // Configuración
  'configuracion.consultorio': { module: 'Configuración', label: 'Editar datos y reglas del consultorio' },
  'configuracion.profesionales': { module: 'Configuración', label: 'Gestionar profesionales y horarios' },

  // Seguridad
  'usuarios.gestionar': { module: 'Seguridad', label: 'Crear, editar y desactivar usuarios' },
  'roles.gestionar': { module: 'Seguridad', label: 'Crear y editar roles y permisos' },
  'auditoria.ver': { module: 'Seguridad', label: 'Ver el registro de auditoría' },
} as const;

export type Permission = keyof typeof PERMISSION_CATALOG;

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOG) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSION_CATALOG, value);
}

/** Roles iniciales de cada consultorio. Todos son editables excepto Administrador. */
export const DEFAULT_ROLES: ReadonlyArray<{
  name: string;
  description: string;
  isSystem: boolean;
  permissions: readonly Permission[];
}> = [
  {
    name: 'Administrador',
    description: 'Acceso total. No se puede editar ni eliminar.',
    isSystem: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Recepción',
    description: 'Agenda, pacientes, recordatorios y registro de pagos.',
    isSystem: false,
    permissions: [
      'agenda.ver_todas', 'agenda.crear', 'agenda.editar', 'agenda.cambiar_estado', 'agenda.cancelar',
      'agenda.verificar', 'recordatorios.gestionar', 'pagos.ver', 'pacientes.ver', 'pacientes.crear', 'pacientes.editar', 'servicios.ver',
      'caja.recaudo.crear', 'caja.recaudo.ver', 'cartera.ver', 'cartera.cargo.crear', 'inventario.ver',
      'facturacion.ver', 'facturacion.emitir',
    ],
  },
  {
    name: 'Odontólogo',
    description: 'Su propia agenda y los pacientes que atiende.',
    isSystem: false,
    permissions: ['agenda.ver_propia', 'agenda.cambiar_estado', 'pacientes.ver', 'servicios.ver', 'cartera.cargo.crear'],
  },
  {
    name: 'Auxiliar contable',
    description: 'Caja, cartera e indicadores.',
    isSystem: false,
    permissions: [
      'caja.recaudo.crear', 'caja.recaudo.ver', 'caja.recaudo.anular', 'caja.cierre.ver', 'cartera.ver',
      'cartera.cargo.crear', 'cartera.cargo.anular', 'reportes.ver', 'pacientes.ver', 'pacientes.exportar',
      'servicios.ver', 'pagos.ver', 'inventario.ver', 'compras.ver', 'compras.gestionar', 'compras.pagar',
      'facturacion.ver', 'facturacion.emitir', 'facturacion.anular',
    ],
  },
];
