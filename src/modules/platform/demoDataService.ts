/**
 * Datos de demostración (modo vitrina y desarrollo local).
 * Todos los pacientes, teléfonos y documentos son FICTICIOS.
 * Los precios son ilustrativos; cada consultorio define los suyos.
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import { addDays, addMinutes, isoNow, localToUtcIso, nowLocal, todayLocal, weekdayOf } from '../../utils/time.js';

/** Horas de un día con agenda llena: [hora, profesional]. Separadas para no cruzarse (servicios de hasta 60 min). */
const BUSY_DAY_TIMES: Array<[string, number]> = [
  ['08:00', 0], ['08:30', 1], ['09:15', 0], ['10:00', 1], ['10:30', 0], ['11:00', 1],
  ['14:00', 0], ['14:30', 1], ['15:15', 0], ['16:00', 1], ['16:30', 0],
];

const DEMO_SERVICES = [
  { code: 'VAL', name: 'Valoración inicial', category: 'General', price: 50_000, duration: 30 },
  { code: 'PRO', name: 'Limpieza y profilaxis', category: 'Prevención', price: 120_000, duration: 45 },
  { code: 'RES', name: 'Resina (calza)', category: 'Operatoria', price: 150_000, duration: 60 },
  { code: 'EXT', name: 'Extracción simple', category: 'Cirugía', price: 180_000, duration: 45 },
  { code: 'ORT', name: 'Control de ortodoncia', category: 'Ortodoncia', price: 90_000, duration: 30 },
  { code: 'END', name: 'Endodoncia unirradicular', category: 'Endodoncia', price: 450_000, duration: 90 },
  { code: 'BLA', name: 'Blanqueamiento', category: 'Estética', price: 600_000, duration: 60 },
  { code: 'URG', name: 'Urgencia odontológica', category: 'General', price: 80_000, duration: 30 },
] as const;

const DEMO_PATIENT_NAMES = [
  'Laura Gómez Restrepo', 'Andrés Felipe Ríos', 'María José Cárdenas', 'Carlos Andrés Peña', 'Valentina Ospina',
  'Juan David Herrera', 'Paula Andrea Mejía', 'Santiago Morales', 'Daniela Castaño', 'Sebastián Quintero',
  'Natalia Arango', 'Felipe Zuluaga', 'Camila Londoño', 'Mateo Giraldo', 'Isabella Duque',
] as const;

export async function seedDemoData(db: SqlDatabase, tenantId: string, utcOffsetMinutes: number, adminUserId: string): Promise<void> {
  const now = isoNow();
  const today = todayLocal(utcOffsetMinutes);
  const statements: SqlStatement[] = [];

  // Profesionales con horario lunes a viernes (pausa de almuerzo) y sábado en la mañana.
  const professionals = [
    { id: crypto.randomUUID(), name: 'Dra. Ana María Torres', specialty: 'Odontología general', color: '#3f6f68' },
    { id: crypto.randomUUID(), name: 'Dr. Julián Vélez', specialty: 'Ortodoncia', color: '#4f6d8a' },
  ];
  for (const professional of professionals) {
    statements.push(
      db
        .prepare('INSERT INTO professionals (id, tenant_id, full_name, specialty, color, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(professional.id, tenantId, professional.name, professional.specialty, professional.color, now),
    );
    for (let weekday = 1; weekday <= 6; weekday++) {
      const blocks = weekday === 6 ? [['08:00', '12:00']] : [['08:00', '12:00'], ['14:00', '18:00']];
      for (const [startTime, endTime] of blocks) {
        statements.push(
          db
            .prepare('INSERT INTO schedules (id, tenant_id, professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), tenantId, professional.id, weekday, startTime, endTime),
        );
      }
    }
  }

  const services = DEMO_SERVICES.map((service) => ({ ...service, id: crypto.randomUUID() }));
  for (const service of services) {
    statements.push(
      db
        .prepare(
          `INSERT INTO services (id, tenant_id, code, name, category, item_type, price, duration_minutes, tax_rate_bps,
             is_bookable_online, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, 'servicio', ?, ?, 0, ?, 1, ?)`,
        )
        .bind(service.id, tenantId, service.code, service.name, service.category, service.price, service.duration, service.code === 'END' ? 0 : 1, now),
    );
  }

  const patients = DEMO_PATIENT_NAMES.map((fullName, index) => ({
    id: crypto.randomUUID(),
    fullName,
    document: String(1_000_000_000 + index * 7_919),
    phone: `+57300555${String(1000 + index * 13).padStart(4, '0')}`,
  }));
  for (const patient of patients) {
    statements.push(
      db
        .prepare(
          `INSERT INTO patients (id, tenant_id, document_type, document_number, full_name, phone, consent_at, consent_version,
             consent_channel, created_at, updated_at)
           VALUES (?, ?, 'CC', ?, ?, ?, ?, '1', 'presencial', ?, ?)`,
        )
        .bind(patient.id, tenantId, patient.document, patient.fullName, patient.phone, now, now, now),
    );
  }
  await db.batch(statements);

  // Citas: historial (atendidas / no asistió) y próximas (pendientes / confirmadas).
  const appointmentStatements: SqlStatement[] = [];
  const attendedAppointments: Array<{ id: string; patientId: string; price: number; name: string; date: string }> = [];
  let patientCursor = 0;

  for (let dayOffset = -45; dayOffset <= 14; dayOffset++) {
    const date = addDays(today, dayOffset);
    const weekday = weekdayOf(date);
    if (weekday === 0) continue;

    // Hoy y los dos días siguientes, agenda llena (así se ve un día real de consultorio).
    const isBusyDay = dayOffset >= 0 && dayOffset <= 2 && weekday !== 6;
    const dailyTimes: Array<[string, number]> = isBusyDay
      ? BUSY_DAY_TIMES
      : weekday === 6 ? [['09:00', dayOffset % 2]] : [['08:30', dayOffset % 2], ['14:30', (dayOffset + 1) % 2]];
    for (const [timeIndex, [time, professionalIndex]] of dailyTimes.entries()) {
      const professional = professionals[Math.abs(professionalIndex) % 2];
      const service = services[(dayOffset + timeIndex + 100) % 5];
      const patient = patients[patientCursor++ % patients.length];
      const startAt = `${date}T${time}`;
      const isPast = startAt < nowLocal(utcOffsetMinutes);
      const status = isPast ? (patientCursor % 9 === 0 ? 'no_asistio' : 'atendida') : patientCursor % 3 === 0 ? 'confirmada' : 'pendiente';
      const appointmentId = crypto.randomUUID();
      const createdAt = localToUtcIso(`${addDays(date, -3)}T10:00`, utcOffsetMinutes);

      appointmentStatements.push(
        db
          .prepare(
            `INSERT INTO appointments (id, tenant_id, patient_id, professional_id, service_id, start_at, end_at, status, source, price,
               reminder_sent_at, confirmed_at, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            appointmentId, tenantId, patient.id, professional.id, service.id, startAt, addMinutes(startAt, service.duration),
            status, patientCursor % 4 === 0 ? 'online' : 'manual', service.price,
            isPast && patientCursor % 2 === 0 ? createdAt : null,
            status === 'confirmada' || (isPast && patientCursor % 2 === 0) ? createdAt : null,
            adminUserId, createdAt, createdAt,
          ),
      );
      if (status === 'atendida') {
        attendedAppointments.push({ id: appointmentId, patientId: patient.id, price: service.price, name: service.name, date });
      }
    }
  }
  await db.batch(appointmentStatements);

  // Cargos por citas atendidas y pagos variados (completos, abonos y un anticipo).
  const billingStatements: SqlStatement[] = [];
  let receiptNumber = 0;
  for (const [index, appointment] of attendedAppointments.entries()) {
    const chargeId = crypto.randomUUID();
    const chargeCreatedAt = localToUtcIso(`${appointment.date}T12:00`, utcOffsetMinutes);
    billingStatements.push(
      db
        .prepare(
          `INSERT INTO charges (id, tenant_id, patient_id, appointment_id, description, quantity, amount, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'activo', ?, ?)`,
        )
        .bind(chargeId, tenantId, appointment.patientId, appointment.id, appointment.name, appointment.price, adminUserId, chargeCreatedAt),
    );

    // 1 de cada 4 queda pendiente; 1 de cada 4 con abono parcial; el resto pagado.
    const paidAmount = index % 4 === 0 ? 0 : index % 4 === 1 ? Math.round(appointment.price / 2) : appointment.price;
    if (paidAmount > 0) {
      const paymentId = crypto.randomUUID();
      receiptNumber++;
      billingStatements.push(
        db
          .prepare(
            `INSERT INTO payments (id, tenant_id, patient_id, receipt_number, amount, method, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'activo', ?, ?)`,
          )
          .bind(paymentId, tenantId, appointment.patientId, receiptNumber, paidAmount, ['efectivo', 'transferencia', 'nequi'][index % 3], adminUserId, chargeCreatedAt),
        db
          .prepare('INSERT INTO payment_allocations (id, tenant_id, payment_id, charge_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), tenantId, paymentId, chargeId, paidAmount, chargeCreatedAt),
      );
    }
  }

  // Un anticipo para un tratamiento de blanqueamiento.
  receiptNumber++;
  billingStatements.push(
    db
      .prepare(
        `INSERT INTO payments (id, tenant_id, patient_id, receipt_number, amount, method, notes, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 300000, 'transferencia', 'Anticipo blanqueamiento', 'activo', ?, ?)`,
      )
      .bind(crypto.randomUUID(), tenantId, patients[2].id, receiptNumber, adminUserId, now),
    db.prepare("UPDATE counters SET value = ? WHERE tenant_id = ? AND name = 'recibo_caja'").bind(receiptNumber, tenantId),
    db
      .prepare(
        `INSERT INTO waitlist_entries (id, tenant_id, patient_id, service_id, notes, status, created_at)
         VALUES (?, ?, ?, ?, 'Prefiere jornada de la tarde', 'activa', ?)`,
      )
      .bind(crypto.randomUUID(), tenantId, patients[5].id, services[1].id, now),
  );
  await db.batch(billingStatements);
  await seedDemoInventory(db, tenantId, adminUserId, services, today);
}

/** Proveedor, insumos con existencias, una compra con saldo por pagar y recetas de servicios. */
async function seedDemoInventory(
  db: SqlDatabase,
  tenantId: string,
  adminUserId: string,
  services: Array<{ id: string; code: string }>,
  today: string,
): Promise<void> {
  const now = isoNow();
  const supplierId = crypto.randomUUID();
  const purchaseId = crypto.randomUUID();
  const supplies = [
    { code: 'INS-0001', name: 'Guantes de nitrilo talla M', unit: 'unidad', min: 100, qty: 4, factor: 100, total: 72_000, recipe: { PRO: 2, RES: 2, EXT: 2, END: 2, VAL: 2, URG: 2, BLA: 2, ORT: 2 } },
    { code: 'INS-0002', name: 'Tapabocas desechable', unit: 'unidad', min: 50, qty: 1, factor: 50, total: 15_000, recipe: { PRO: 1, RES: 1, EXT: 1, END: 1, VAL: 1, URG: 1, BLA: 1, ORT: 1 } },
    { code: 'INS-0003', name: 'Anestesia lidocaína 2 %', unit: 'carpule', min: 20, qty: 1, factor: 50, total: 95_000, recipe: { RES: 1, EXT: 2, END: 2, URG: 1 } },
    { code: 'INS-0004', name: 'Resina compuesta A2', unit: 'g', min: 8, qty: 3, factor: 4, total: 165_000, recipe: { RES: 0.5 } },
    { code: 'INS-0005', name: 'Pasta profiláctica', unit: 'g', min: 50, qty: 1, factor: 200, total: 38_000, recipe: { PRO: 3 } },
    { code: 'INS-0006', name: 'Gel blanqueador 35 %', unit: 'jeringa', min: 4, qty: 1, factor: 3, total: 210_000, recipe: { BLA: 2 } },
  ].map((supply) => ({ ...supply, id: crypto.randomUUID() }));
  const subtotal = supplies.reduce((total, supply) => total + supply.total, 0);
  const serviceIdByCode = new Map(services.map((service) => [service.code, service.id]));

  const statements: SqlStatement[] = [
    db
      .prepare("INSERT INTO suppliers (id, tenant_id, name, nit, phone, contact_name, is_active, created_at) VALUES (?, ?, 'Depósito Dental Andino S.A.S.', '900555123', '+576044440000', 'Carolina Mejía', 1, ?)")
      .bind(supplierId, tenantId, now),
    db
      .prepare(
        `INSERT INTO purchases (id, tenant_id, supplier_id, invoice_number, issue_date, due_date, subtotal, tax_total, total, source, status, created_by, created_at)
         VALUES (?, ?, ?, 'DDA-20431', ?, ?, ?, 0, ?, 'manual', 'registrada', ?, ?)`,
      )
      .bind(purchaseId, tenantId, supplierId, addDays(today, -10), addDays(today, 20), subtotal, subtotal, adminUserId, now),
    db
      .prepare("INSERT INTO supplier_payments (id, tenant_id, purchase_id, amount, method, payment_date, status, created_by, created_at) VALUES (?, ?, ?, 300000, 'transferencia', ?, 'activo', ?, ?)")
      .bind(crypto.randomUUID(), tenantId, purchaseId, addDays(today, -9), adminUserId, now),
    db.prepare("UPDATE counters SET value = ? WHERE tenant_id = ? AND name = 'insumo'").bind(supplies.length, tenantId),
  ];
  for (const supply of supplies) {
    const stock = supply.qty * supply.factor;
    const unitCost = supply.total / stock;
    statements.push(
      db
        .prepare('INSERT INTO supplies (id, tenant_id, code, name, unit, min_stock, avg_cost, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(supply.id, tenantId, supply.code, supply.name, supply.unit, supply.min, unitCost, now),
      db
        .prepare(
          `INSERT INTO purchase_lines (id, tenant_id, purchase_id, supply_id, description, quantity, conversion_factor, line_total, tax_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(crypto.randomUUID(), tenantId, purchaseId, supply.id, supply.name, supply.qty, supply.factor, supply.total),
      db
        .prepare(
          `INSERT INTO stock_movements (id, tenant_id, supply_id, kind, quantity, unit_cost, purchase_id, reason, created_by, created_at)
           VALUES (?, ?, ?, 'compra', ?, ?, ?, 'Factura DDA-20431', ?, ?)`,
        )
        .bind(crypto.randomUUID(), tenantId, supply.id, stock, unitCost, purchaseId, adminUserId, now),
    );
    for (const [code, quantity] of Object.entries(supply.recipe)) {
      const serviceId = serviceIdByCode.get(code);
      if (!serviceId) continue;
      statements.push(
        db.prepare('INSERT INTO service_supplies (tenant_id, service_id, supply_id, quantity) VALUES (?, ?, ?, ?)').bind(tenantId, serviceId, supply.id, quantity),
      );
    }
  }
  await db.batch(statements);
}
