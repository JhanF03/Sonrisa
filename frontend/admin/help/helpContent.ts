/**
 * Contenido del centro de aprendizaje: una guía por módulo (para qué sirve,
 * paso a paso de cada tarea, qué hace cada botón y buenas prácticas) y un
 * recorrido guiado sobre la pantalla real.
 *
 * Para agregar un módulo: añade un HelpTopic con el mismo `path` del menú.
 */
import type { TourStep } from '../../core/tour.js';

export interface HelpSection {
  title: string;
  kind: 'pasos' | 'botones' | 'consejos';
  items: string[];
}

export interface HelpTopic {
  id: string;
  /** Ruta del menú (#/path). null = tema general. */
  path: string | null;
  title: string;
  iconName: string;
  /** Se muestra si el usuario tiene al menos uno (vacío = todos). */
  permissions: string[];
  summary: string;
  sections: HelpSection[];
  tour: TourStep[];
}

const PRIMARY_BUTTON = ['.card-header .button-primary', '.button-row .button-primary', '.button-primary'];
const EXPORT_BUTTON = '[data-action="export"]';
const TABLE = '.data-table';
const TABS = '.tabs';
const KPIS = '.kpi-grid';
const HELP_BUTTON = '[data-action="open-help"]';

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'inicio',
    path: null,
    title: 'Primeros pasos',
    iconName: 'graduation-cap',
    permissions: [],
    summary: 'Cómo está organizado el panel, cómo moverte y dónde pedir ayuda en cada pantalla.',
    sections: [
      {
        title: 'Cómo está organizado',
        kind: 'pasos',
        items: [
          'A la izquierda está el menú. Solo ves los módulos que tu rol permite: si te falta alguno, pídeselo al administrador.',
          '“Día a día” reúne lo que usa la recepción: Agenda, Recordatorios y Pacientes.',
          '“Finanzas” reúne Caja, Pagos en línea, Cartera, Facturación, Compras e Indicadores.',
          '“Administración” reúne Servicios, Inventario, Configuración, Suscripción, Usuarios y Auditoría.',
          'Arriba a la derecha está el botón de ayuda (?) que explica la pantalla en la que estás y el modo día/noche.',
        ],
      },
      {
        title: 'Primer día con el sistema (administrador)',
        kind: 'pasos',
        items: [
          'Configuración → Consultorio: nombre, dirección, teléfono, color y logo.',
          'Configuración → Profesionales: crea a cada odontólogo y define su horario semanal.',
          'Servicios: crea los servicios con precio y duración (y anticipo si lo vas a cobrar en línea).',
          'Usuarios y roles: crea los usuarios de recepción y de los odontólogos con su rol.',
          'Configuración → WhatsApp: escribe el celular del consultorio para los recordatorios.',
          'Comparte el enlace de la Página de reservas (abajo en el menú) en Instagram, Google y WhatsApp.',
        ],
      },
      {
        title: 'Botones que verás en todas partes',
        kind: 'botones',
        items: [
          'Botón verde (principal): crea algo nuevo — cita, paciente, pago, compra…',
          'Exportar: descarga la tabla que estás viendo a Excel.',
          'Lápiz: editar. Ojo: ver detalle. Prohibido (círculo tachado): anular con motivo.',
          'El ícono (i) junto a un campo explica qué poner. Pasa el mouse encima de cualquier ícono para ver qué hace.',
          'Nada se borra: pagos, cargos, compras y facturas se ANULAN con un motivo que queda en la auditoría.',
        ],
      },
    ],
    tour: [
      { title: 'Bienvenido a Agenda Sonrisa', body: 'Este recorrido te muestra en un minuto dónde está cada cosa. Usa Siguiente o las flechas del teclado.' },
      { target: ['.sidebar nav', '.menu-button'], title: 'El menú', body: 'Aquí están los módulos que tu rol puede usar, agrupados en Día a día, Finanzas y Administración. En el celular se abre con el botón ☰.' },
      { target: '#view-title', title: 'Dónde estás', body: 'El título muestra el módulo abierto. El contenido de ese módulo aparece debajo.' },
      { target: HELP_BUTTON, title: 'Ayuda en cada pantalla', body: 'Este botón explica la pantalla actual y puede iniciar un recorrido como este sobre ella.' },
      { target: '[data-action="toggle-theme"]', title: 'Modo día / noche', body: 'Cambia a colores oscuros para descansar la vista. El sistema recuerda tu elección.' },
      { target: '.sidebar-footer a[target="_blank"]', title: 'Página de reservas', body: 'Abre la página donde tus pacientes reservan solos. Copia ese enlace y compártelo en tus redes.' },
      { target: '[data-action="change-password"]', title: 'Tu contraseña', body: 'Cámbiala aquí. Usa al menos 10 caracteres con letras y números y no la compartas.' },
      { target: '[data-nav="ayuda"]', title: 'Centro de aprendizaje', body: 'Aquí encuentras la guía paso a paso de cada módulo y tu avance. ¡Listo, ya puedes empezar!' },
    ],
  },
  {
    id: 'agenda',
    path: 'agenda',
    title: 'Agenda',
    iconName: 'calendar-days',
    permissions: ['agenda.ver_todas', 'agenda.ver_propia'],
    summary: 'Las citas del día por profesional: crear, mover, confirmar, marcar atendidas o cancelar, y bloquear horarios.',
    sections: [
      {
        title: 'Agendar una cita',
        kind: 'pasos',
        items: [
          'Oprime “Nueva cita” (o haz clic en un espacio libre de la columna del profesional).',
          'Busca al paciente por nombre, documento o celular. Si no existe, créalo ahí mismo con “Paciente nuevo”.',
          'Elige el servicio: la duración se completa sola. Elige profesional, fecha y hora.',
          'Si es un tratamiento con varias sesiones, activa “Repetir” y el sistema crea las citas y te avisa cuáles chocan.',
          'Guarda. Es imposible que dos citas se crucen: si alguien tomó ese horario un segundo antes, el sistema te lo dice.',
        ],
      },
      {
        title: 'Durante el día',
        kind: 'pasos',
        items: [
          'Haz clic en una cita para ver el detalle y cambiar su estado.',
          '“Confirmada”: el paciente confirmó. “Atendida”: se crea el cargo en su cuenta, se aplican anticipos y se descuentan los insumos.',
          '“No asistió”: cuenta para el indicador de inasistencia. “Cancelar” pide un motivo.',
          '“Reprogramar” mueve la cita a otro horario libre conservando su historial.',
          'Las reservas en línea pendientes de verificación o de pago aparecen con una etiqueta; el horario se libera solo si no se completan.',
        ],
      },
      {
        title: 'Botones de la pantalla',
        kind: 'botones',
        items: [
          'Flechas y “Hoy”: cambian de día. El calendario permite saltar a cualquier fecha.',
          'Nueva cita: agenda manualmente.',
          'Bloquear horario: vacaciones, capacitaciones o almuerzo extendido; avisa cuántas citas quedan afectadas.',
          'Leyenda de colores: cada estado de cita tiene su color.',
        ],
      },
      {
        title: 'Buenas prácticas',
        kind: 'consejos',
        items: [
          'Marca “Atendida” al terminar cada cita: así la caja, la cartera y el inventario quedan correctos.',
          'Usa Recordatorios el día anterior para reducir inasistencias.',
        ],
      },
    ],
    tour: [
      { target: '.agenda-toolbar', title: 'Cambiar de día', body: 'Usa las flechas, “Hoy” o el calendario para ver otro día.' },
      { target: ['[data-action="new-appointment"]', ...PRIMARY_BUTTON], title: 'Nueva cita', body: 'Agenda una cita: paciente, servicio, profesional y hora. El sistema impide cruces de horario.' },
      { target: '[data-action="new-block"]', title: 'Bloquear horario', body: 'Reserva tiempo sin citas (vacaciones, reuniones). Te avisa si hay citas afectadas.', optional: true },
      { target: ['.agenda-grid', '.agenda-scroll'], title: 'Las columnas', body: 'Cada columna es un profesional. Haz clic en una cita para ver su detalle y cambiar su estado.' },
      { target: '.agenda-legend', title: 'Colores', body: 'Cada color indica el estado de la cita: pendiente, confirmada, atendida, no asistió…', optional: true },
    ],
  },
  {
    id: 'recordatorios',
    path: 'recordatorios',
    title: 'Recordatorios',
    iconName: 'bell-ring',
    permissions: ['recordatorios.gestionar', 'agenda.verificar'],
    summary: 'Confirmar citas por WhatsApp sin costo, verificar reservas en línea, reactivar pacientes y gestionar la lista de espera.',
    sections: [
      {
        title: 'Enviar los recordatorios de mañana',
        kind: 'pasos',
        items: [
          'Abre la pestaña de confirmaciones: aparecen las citas del día siguiente.',
          'Oprime el botón de WhatsApp de cada paciente: se abre WhatsApp con el mensaje listo y el enlace personal de la cita.',
          'Envíalo. Cuando el paciente confirma desde su enlace, la cita cambia sola a “Confirmada”.',
          'Los teléfonos fijos no muestran botón de WhatsApp: llámalos.',
        ],
      },
      {
        title: 'Verificar reservas en línea',
        kind: 'pasos',
        items: [
          'Si activaste la verificación por WhatsApp, el paciente que reserva en línea recibe un código de 6 dígitos.',
          'Cuando te escriba el código, ábrelo en “Por verificar” y digítalo: la reserva queda firme.',
          'Si no verifica a tiempo, el horario se libera automáticamente.',
        ],
      },
      {
        title: 'Reactivación y lista de espera',
        kind: 'pasos',
        items: [
          'Reactivación: pacientes que no vienen hace meses. Escríbeles con un clic para invitarlos a su control.',
          'Lista de espera: anota a quien quiere una cita más pronto; cuando se libere un espacio, contáctalo.',
        ],
      },
    ],
    tour: [
      { target: TABS, title: 'Pestañas', body: 'Confirmaciones de mañana, reservas por verificar, reactivación de pacientes y lista de espera.' },
      { target: ['.button-whatsapp', TABLE], title: 'Enviar por WhatsApp', body: 'Cada botón abre WhatsApp con el mensaje y el enlace listos. No cuesta nada.' },
      { target: '[data-action="add"]', title: 'Lista de espera', body: 'Agrega pacientes que esperan un espacio libre.', optional: true },
    ],
  },
  {
    id: 'pacientes',
    path: 'pacientes',
    title: 'Pacientes',
    iconName: 'users',
    permissions: ['pacientes.ver'],
    summary: 'El directorio de pacientes con su historial de citas y su estado de cuenta (lo que debe y lo que tiene a favor).',
    sections: [
      {
        title: 'Crear y buscar pacientes',
        kind: 'pasos',
        items: [
          'Usa el buscador: funciona por nombre, documento o celular.',
          '“Nuevo paciente”: tipo y número de documento, nombre, celular y autorización de tratamiento de datos (Ley 1581).',
          'Para menores, registra el nombre y celular del acudiente.',
          'Aquí solo van datos administrativos: no escribas diagnósticos ni datos clínicos.',
        ],
      },
      {
        title: 'Ficha del paciente',
        kind: 'pasos',
        items: [
          'Al abrir un paciente ves sus citas pasadas y futuras y su estado de cuenta.',
          '“Cargo”: registra algo que debe (un servicio o un ítem de un tratamiento).',
          '“Pago”: registra un abono; se aplica primero a lo más antiguo y el excedente queda como saldo a favor.',
          '“Aplicar saldo a favor”: cruza un anticipo con cargos nuevos.',
        ],
      },
    ],
    tour: [
      { target: ['.toolbar', '.search-input'], title: 'Buscar', body: 'Escribe nombre, documento o celular para encontrar al paciente.' },
      { target: ['[data-action="new"]', ...PRIMARY_BUTTON], title: 'Nuevo paciente', body: 'Registra un paciente con su autorización de datos.' },
      { target: EXPORT_BUTTON, title: 'Exportar', body: 'Descarga el directorio a Excel (requiere permiso).', optional: true },
      { target: TABLE, title: 'Lista', body: 'Haz clic en un paciente para ver su historial, sus cargos y sus pagos.' },
    ],
  },
  {
    id: 'caja',
    path: 'caja',
    title: 'Caja',
    iconName: 'wallet',
    permissions: ['caja.recaudo.ver', 'caja.recaudo.crear', 'caja.cierre.ver'],
    summary: 'Registrar pagos con recibo consecutivo, ver el cierre del día por medio de pago y anular recibos con motivo.',
    sections: [
      {
        title: 'Registrar un pago',
        kind: 'pasos',
        items: [
          'Oprime “Registrar pago”, busca al paciente y escribe el valor.',
          'Elige el medio: efectivo, transferencia, Nequi, Daviplata, tarjeta u otro.',
          'El sistema abona a las deudas más antiguas; si sobra, queda como anticipo (saldo a favor).',
          'Se genera el recibo con número consecutivo: puedes imprimirlo o compartirlo.',
        ],
      },
      {
        title: 'Cierre del día',
        kind: 'pasos',
        items: [
          'Arriba ves el total recaudado y cuánto entró por cada medio de pago.',
          'Compara el efectivo con lo que hay físicamente en la caja.',
          'Exporta a Excel para tu contador.',
        ],
      },
      {
        title: 'Anular un recibo',
        kind: 'consejos',
        items: ['Los recibos no se borran: se anulan con motivo. La deuda vuelve a quedar pendiente y todo queda en la auditoría.'],
      },
    ],
    tour: [
      { target: '.agenda-toolbar', title: 'Día de caja', body: 'Elige el día que quieres revisar.' },
      { target: KPIS, title: 'Cierre', body: 'Total recaudado y desglose por medio de pago.', optional: true },
      { target: ['[data-action="new-payment"]', ...PRIMARY_BUTTON], title: 'Registrar pago', body: 'Recibe un abono o anticipo y genera el recibo consecutivo.' },
      { target: TABLE, title: 'Recibos del día', body: 'Abre cualquier recibo para imprimirlo o anularlo con motivo.', optional: true },
    ],
  },
  {
    id: 'pagos-en-linea',
    path: 'pagos-en-linea',
    title: 'Pagos en línea',
    iconName: 'credit-card',
    permissions: ['pagos.ver'],
    summary: 'Los anticipos que los pacientes pagan con Wompi al reservar, y las alertas que requieren revisión.',
    sections: [
      {
        title: 'Cómo funciona',
        kind: 'pasos',
        items: [
          'En Servicios eliges qué servicios exigen anticipo (porcentaje o valor fijo).',
          'Al reservar en línea, el paciente paga con tarjeta, PSE o Nequi. La cita queda confirmada solo si Wompi aprueba.',
          'El pago genera un recibo automático; al atender la cita, el anticipo se abona a su cargo.',
          'Si no paga a tiempo, el horario se libera.',
        ],
      },
      {
        title: 'Alertas',
        kind: 'pasos',
        items: [
          'Pago tardío con el horario ya ocupado: el dinero queda como saldo a favor del paciente; contáctalo.',
          'Pago doble o anulado en Wompi: revísalo y márcalo como atendido.',
        ],
      },
    ],
    tour: [
      { target: TABS, title: 'Pagos y alertas', body: 'Revisa los pagos recibidos y las alertas por atender.', optional: true },
      { target: TABLE, title: 'Detalle', body: 'Cada fila muestra paciente, cita, valor y resultado del pago.', optional: true },
    ],
  },
  {
    id: 'cartera',
    path: 'cartera',
    title: 'Cartera',
    iconName: 'hand-coins',
    permissions: ['cartera.ver'],
    summary: 'Quién debe, cuánto y desde cuándo (0-30, 31-60, 61-90 y más de 90 días), con cobro amable por WhatsApp.',
    sections: [
      {
        title: 'Cobrar',
        kind: 'pasos',
        items: [
          'Revisa primero las columnas de más días: es la deuda más difícil de recuperar.',
          'Usa el botón de WhatsApp para enviar un recordatorio amable de pago.',
          'Cuando paguen, regístralo en Caja: la cartera se actualiza sola.',
        ],
      },
    ],
    tour: [
      { target: KPIS, title: 'Resumen', body: 'Total por cobrar y cuánto está vencido por rangos de días.', optional: true },
      { target: TABLE, title: 'Por paciente', body: 'Cada paciente con su deuda por antigüedad y botón de cobro por WhatsApp.' },
      { target: EXPORT_BUTTON, title: 'Exportar', body: 'Descarga la cartera a Excel.', optional: true },
    ],
  },
  {
    id: 'facturacion',
    path: 'facturacion',
    title: 'Facturación electrónica',
    iconName: 'file-text',
    permissions: ['facturacion.ver', 'facturacion.configurar'],
    summary: 'Facturas electrónicas de venta a partir de los cargos del paciente, con tu proveedor (Factus, webhook o registro manual).',
    sections: [
      {
        title: 'Facturar',
        kind: 'pasos',
        items: [
          'Oprime “Nueva factura” y busca al paciente: aparecen sus cargos sin facturar.',
          'Marca los cargos a incluir, elige contado o crédito y el medio de pago.',
          'Con Factus o webhook se emite al instante y verás número, CUFE y enlace para imprimir.',
          'En modo manual: emítela en tu software actual y registra aquí el número y el CUFE.',
          'Un cargo no se puede facturar dos veces.',
        ],
      },
      {
        title: 'Si algo falla',
        kind: 'pasos',
        items: [
          '“Rechazada”: el motivo aparece en la factura; los cargos quedan libres para corregir y facturar de nuevo.',
          '“Pendiente”: hubo un problema de conexión. Oprime “Reintentar”; no se duplicará.',
          'Para anular una factura emitida, haz la nota crédito en el portal del proveedor y registra su número.',
        ],
      },
      {
        title: 'Configurar (administrador)',
        kind: 'pasos',
        items: ['Pestaña “Proveedor”: elige el modo, escribe las credenciales y usa “Probar conexión”. Empieza en ambiente de pruebas.'],
      },
    ],
    tour: [
      { target: TABS, title: 'Facturas y proveedor', body: 'La pestaña Proveedor solo la ve quien configura la facturación.', optional: true },
      { target: KPIS, title: 'Resumen', body: 'Total facturado, facturas pendientes de envío y proveedor activo.', optional: true },
      { target: ['[data-action="new"]', ...PRIMARY_BUTTON], title: 'Nueva factura', body: 'Elige al paciente y sus cargos sin facturar.', optional: true },
      { target: TABLE, title: 'Facturas', body: 'Abre una factura para ver el CUFE, imprimirla, reintentar o anularla.', optional: true },
    ],
  },
  {
    id: 'compras',
    path: 'compras',
    title: 'Compras y proveedores',
    iconName: 'truck',
    permissions: ['compras.ver', 'compras.gestionar'],
    summary: 'Registrar facturas de proveedores (importando el XML de la DIAN), controlar cuentas por pagar y abonos.',
    sections: [
      {
        title: 'Registrar una compra con el XML',
        kind: 'pasos',
        items: [
          'Oprime “Registrar compra” y luego “Importar XML de la factura electrónica”. Usa el XML que llega al correo junto al PDF.',
          'Se llenan proveedor, número, fechas, CUFE y líneas. Si el proveedor no existe, se crea solo.',
          'En cada línea elige: insumo existente, crear insumo nuevo o gasto (no inventario, p. ej. flete).',
          '“Unid. x cant.”: cuántas unidades de inventario trae cada unidad comprada (1 caja de 100 guantes = 100).',
          'Registra: el inventario y el costo promedio se actualizan. La próxima factura de ese proveedor reconocerá los productos sola.',
        ],
      },
      {
        title: 'Cuentas por pagar',
        kind: 'pasos',
        items: [
          'La pestaña muestra lo vencido y lo que vence en 7 días.',
          'Abre una factura y oprime “Registrar pago” para abonar (no permite pagar de más).',
          'Para anular una compra primero anula sus pagos; el inventario que entró se descuenta.',
        ],
      },
    ],
    tour: [
      { target: TABS, title: 'Compras, por pagar y proveedores', body: 'Tres pestañas: facturas registradas, saldos pendientes y directorio de proveedores.' },
      { target: '.agenda-toolbar', title: 'Fechas', body: 'Filtra las compras por fecha de la factura.', optional: true },
      { target: ['[data-action="new"]', ...PRIMARY_BUTTON], title: 'Registrar compra', body: 'Manual o importando el XML de la factura electrónica.', optional: true },
      { target: TABLE, title: 'Facturas', body: 'Abre una para ver líneas, pagos, registrar abonos o anularla.', optional: true },
    ],
  },
  {
    id: 'indicadores',
    path: 'indicadores',
    title: 'Indicadores',
    iconName: 'chart-column',
    permissions: ['reportes.ver'],
    summary: 'Los números del mes: inasistencia, confirmación, ingresos, recaudo, cartera y reservas en línea.',
    sections: [
      {
        title: 'Cómo leerlos',
        kind: 'consejos',
        items: [
          'Inasistencia alta → refuerza recordatorios o exige anticipo en servicios largos.',
          'Confirmación baja → envía los recordatorios más temprano.',
          'Reservas en línea → mide cuánto te sirve compartir la página de reservas.',
        ],
      },
    ],
    tour: [
      { target: ['.toolbar', '.agenda-date'], title: 'Mes', body: 'Elige el mes que quieres analizar.', optional: true },
      { target: KPIS, title: 'Indicadores', body: 'Cada tarjeta explica su cálculo al pasar el mouse por el ícono.' },
    ],
  },
  {
    id: 'servicios',
    path: 'servicios',
    title: 'Servicios',
    iconName: 'stethoscope',
    permissions: ['servicios.ver', 'servicios.gestionar'],
    summary: 'El catálogo de servicios: código, precio, duración, si se reserva en línea y si exige anticipo.',
    sections: [
      {
        title: 'Crear un servicio',
        kind: 'pasos',
        items: [
          '“Nuevo servicio”: código corto (p. ej. PRO), nombre, categoría, precio y duración.',
          '“Se puede reservar en línea”: si lo desmarcas, solo la recepción lo agenda.',
          'Anticipo: porcentaje o valor fijo que el paciente paga con Wompi al reservar (requiere Wompi activo).',
          'Impuesto: la mayoría de servicios de salud son excluidos de IVA; confírmalo con tu contador.',
        ],
      },
    ],
    tour: [
      { target: ['[data-action="new"]', ...PRIMARY_BUTTON], title: 'Nuevo servicio', body: 'Crea un servicio con su precio, duración y anticipo.', optional: true },
      { target: TABLE, title: 'Catálogo', body: 'Edita con el lápiz. Inactivar un servicio lo oculta sin perder su historial.', optional: true },
    ],
  },
  {
    id: 'inventario',
    path: 'inventario',
    title: 'Inventario y costos',
    iconName: 'package',
    permissions: ['inventario.ver'],
    summary: 'Existencias de insumos, alertas de mínimo, movimientos y costo/margen de cada servicio.',
    sections: [
      {
        title: 'Empezar',
        kind: 'pasos',
        items: [
          'Crea los insumos (o deja que se creen al importar compras). La unidad es la que gastas: guante, gramo, carpule…',
          'Carga lo que ya tienes con “Ajustar” → Entrada, indicando el costo unitario (inventario inicial).',
          'Define el mínimo: al llegar ahí aparece “Pedir”.',
        ],
      },
      {
        title: 'Costo por servicio',
        kind: 'pasos',
        items: [
          'Pestaña “Costo por servicio” → “Editar receta”: qué insumos y cuánto gasta una cita de ese servicio.',
          'Verás el costo y el margen. Al marcar una cita como atendida, los insumos se descuentan solos (una sola vez).',
        ],
      },
      {
        title: 'Conteo físico',
        kind: 'consejos',
        items: ['Una vez al mes cuenta lo que hay y usa “Ajustar” → Conteo físico. El sistema registra la diferencia con motivo.'],
      },
    ],
    tour: [
      { target: TABS, title: 'Pestañas', body: 'Insumos, movimientos (kardex) y costo por servicio.' },
      { target: KPIS, title: 'Resumen', body: 'Valor del inventario, insumos por pedir y lo consumido este mes.', optional: true },
      { target: ['[data-action="new"]', ...PRIMARY_BUTTON], title: 'Nuevo insumo', body: 'Crea un insumo con su unidad y mínimo.', optional: true },
      { target: TABLE, title: 'Existencias', body: 'Los botones de cada fila: ver movimientos, ajustar existencia y editar.', optional: true },
    ],
  },
  {
    id: 'configuracion',
    path: 'configuracion',
    title: 'Configuración',
    iconName: 'settings',
    permissions: ['configuracion.consultorio', 'configuracion.profesionales', 'agenda.bloquear', 'pagos.configurar'],
    summary: 'Datos del consultorio, reglas de reserva en línea, WhatsApp, Wompi, profesionales con horarios y bloqueos.',
    sections: [
      {
        title: 'Pestañas',
        kind: 'botones',
        items: [
          'Consultorio: nombre, dirección, color y logo (se ven en la página de reservas).',
          'Reservas en línea: anticipación mínima, días hacia adelante, verificación por WhatsApp, límite de reservas por persona y liberación automática.',
          'WhatsApp: celular del consultorio y plantilla del recordatorio (debe incluir {enlace}).',
          'Pagos en línea: conecta tu cuenta Wompi (prueba primero en sandbox con la tarjeta 4242 4242 4242 4242).',
          'Profesionales: crea odontólogos, su color y su horario semanal con pausas.',
          'Bloqueos: vacaciones o ausencias.',
        ],
      },
    ],
    tour: [
      { target: TABS, title: 'Secciones', body: 'Cada pestaña configura una parte del consultorio. Solo ves las que tu rol permite.' },
      { target: ['form .button-primary', ...PRIMARY_BUTTON], title: 'Guardar', body: 'Los cambios se aplican al instante después de guardar.', optional: true },
    ],
  },
  {
    id: 'suscripcion',
    path: 'suscripcion',
    title: 'Mi suscripción',
    iconName: 'badge-check',
    permissions: ['suscripcion.pagar'],
    summary: 'Estado de pago de Agenda Sonrisa, cómo pagar y el historial de pagos.',
    sections: [
      {
        title: 'Fechas importantes',
        kind: 'pasos',
        items: [
          '5 días antes del vencimiento aparece un aviso en la parte superior.',
          'Después del vencimiento hay unos días de gracia: puedes seguir trabajando, con aviso en rojo.',
          'Si no se paga al terminar la gracia, el acceso se suspende y la página de reservas no recibe citas nuevas. No se borra ningún dato.',
        ],
      },
      {
        title: 'Pagar',
        kind: 'pasos',
        items: [
          'En línea: elige 1, 3, 6 o 12 meses y paga con tarjeta, PSE o Nequi. El acceso se reactiva automáticamente.',
          'Por transferencia: sigue las instrucciones de pago y envía el comprobante por WhatsApp. Al registrarse, el acceso vuelve al instante.',
        ],
      },
    ],
    tour: [
      { target: KPIS, title: 'Estado', body: 'Estado, fecha hasta la que está pago y valor mensual.' },
      { target: ['.plan-options', '.steps-list'], title: 'Cómo pagar', body: 'Elige los meses para pagar en línea o sigue las instrucciones de transferencia.', optional: true },
      { target: TABLE, title: 'Historial', body: 'Cada pago y hasta qué fecha cubrió.', optional: true },
    ],
  },
  {
    id: 'usuarios',
    path: 'usuarios',
    title: 'Usuarios y roles',
    iconName: 'shield-check',
    permissions: ['usuarios.gestionar', 'roles.gestionar'],
    summary: 'Quién entra al sistema y qué puede hacer cada uno, con permisos granulares por rol.',
    sections: [
      {
        title: 'Crear un usuario',
        kind: 'pasos',
        items: [
          '“Nuevo usuario”: nombre, correo, contraseña inicial y uno o varios roles.',
          'Si es odontólogo, vincúlalo a su profesional para que vea solo su agenda.',
          'Para quitar el acceso, desactívalo: sus sesiones se cierran al instante y su historial se conserva.',
          'Si alguien olvida la contraseña, restablécela desde su usuario.',
        ],
      },
      {
        title: 'Roles y permisos',
        kind: 'pasos',
        items: [
          'Pestaña Roles: edita los roles existentes o crea uno nuevo marcando cada permiso.',
          'Cada permiso controla una pantalla o un botón concreto; el servidor también lo verifica.',
          'El rol Administrador tiene todo y no se puede editar. Recomendación: que haya al menos dos administradores.',
        ],
      },
    ],
    tour: [
      { target: TABS, title: 'Usuarios y roles', body: 'Gestiona las personas y lo que cada rol puede hacer.', optional: true },
      { target: ['[data-action="new-user"]', '[data-action="new-role"]', ...PRIMARY_BUTTON], title: 'Crear', body: 'Agrega usuarios o roles nuevos.', optional: true },
      { target: ['.permission-grid', TABLE], title: 'Detalle', body: 'Revisa a quién se le asigna cada rol y sus permisos.', optional: true },
    ],
  },
  {
    id: 'auditoria',
    path: 'auditoria',
    title: 'Auditoría',
    iconName: 'scroll-text',
    permissions: ['auditoria.ver'],
    summary: 'El registro de quién hizo qué y cuándo: pagos, anulaciones, cambios de permisos y configuración.',
    sections: [
      {
        title: 'Para qué sirve',
        kind: 'consejos',
        items: [
          'Aclarar diferencias de caja: verás quién registró o anuló cada recibo y con qué motivo.',
          'Control de seguridad: cambios de roles, usuarios desactivados y configuraciones.',
          'Los registros no se pueden editar ni borrar.',
        ],
      },
    ],
    tour: [{ target: TABLE, title: 'Registro', body: 'Cada fila: fecha, usuario, acción y detalle.', optional: true }],
  },
];

export function topicForPath(path: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.path === path);
}
