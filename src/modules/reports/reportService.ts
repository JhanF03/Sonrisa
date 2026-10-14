/**
 * Indicadores del mes: el argumento de venta del sistema.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { TenantRow } from '../../http/context.js';
import { addDays, localToUtcIso } from '../../utils/time.js';

export interface MonthlyIndicators {
  month: string;
  appointments: {
    total: number;
    attended: number;
    noShow: number;
    cancelled: number;
    online: number;
    confirmed: number;
  };
  noShowRate: number | null;
  confirmationRate: number | null;
  /** Ingresos de citas atendidas a las que se les envió recordatorio. */
  revenueFromRemindedAppointments: number;
  collected: number;
  newPatients: number;
  outstandingBalance: number;
}

interface AppointmentCounts {
  total: number;
  attended: number;
  no_show: number;
  cancelled: number;
  online: number;
  confirmed: number;
  reminded_revenue: number;
}

export class ReportService {
  constructor(private readonly db: SqlDatabase) {}

  async getMonthlyIndicators(tenant: TenantRow, month: string): Promise<MonthlyIndicators> {
    const monthStart = `${month}-01`;
    const nextMonthStart = firstDayOfNextMonth(month);
    const fromUtc = localToUtcIso(`${monthStart}T00:00`, tenant.utc_offset_minutes);
    const toUtc = localToUtcIso(`${nextMonthStart}T00:00`, tenant.utc_offset_minutes);

    const [counts, collected, newPatients, outstanding] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(status = 'atendida'), 0) AS attended,
             COALESCE(SUM(status = 'no_asistio'), 0) AS no_show,
             COALESCE(SUM(status = 'cancelada'), 0) AS cancelled,
             COALESCE(SUM(source = 'online'), 0) AS online,
             COALESCE(SUM(confirmed_at IS NOT NULL), 0) AS confirmed,
             COALESCE(SUM(CASE WHEN status = 'atendida' AND reminder_sent_at IS NOT NULL THEN price ELSE 0 END), 0) AS reminded_revenue
           FROM appointments
           WHERE tenant_id = ? AND start_at >= ? AND start_at < ?`,
        )
        .bind(tenant.id, `${monthStart}T00:00`, `${nextMonthStart}T00:00`)
        .first<AppointmentCounts>(),
      this.db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS value FROM payments WHERE tenant_id = ? AND status = 'activo' AND created_at >= ? AND created_at < ?")
        .bind(tenant.id, fromUtc, toUtc)
        .first<{ value: number }>(),
      this.db
        .prepare('SELECT COUNT(*) AS value FROM patients WHERE tenant_id = ? AND created_at >= ? AND created_at < ?')
        .bind(tenant.id, fromUtc, toUtc)
        .first<{ value: number }>(),
      this.db
        .prepare(
          `SELECT COALESCE(SUM(balance), 0) AS value FROM (
             SELECT c.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
               JOIN payments p ON p.id = pa.payment_id AND p.status = 'activo' WHERE pa.charge_id = c.id), 0) AS balance
             FROM charges c WHERE c.tenant_id = ? AND c.status = 'activo'
           ) WHERE balance > 0`,
        )
        .bind(tenant.id)
        .first<{ value: number }>(),
    ]);

    const appointmentCounts = counts ?? { total: 0, attended: 0, no_show: 0, cancelled: 0, online: 0, confirmed: 0, reminded_revenue: 0 };
    const closedAppointments = appointmentCounts.attended + appointmentCounts.no_show;
    const activeAppointments = appointmentCounts.total - appointmentCounts.cancelled;

    return {
      month,
      appointments: {
        total: appointmentCounts.total,
        attended: appointmentCounts.attended,
        noShow: appointmentCounts.no_show,
        cancelled: appointmentCounts.cancelled,
        online: appointmentCounts.online,
        confirmed: appointmentCounts.confirmed,
      },
      noShowRate: closedAppointments > 0 ? appointmentCounts.no_show / closedAppointments : null,
      confirmationRate: activeAppointments > 0 ? appointmentCounts.confirmed / activeAppointments : null,
      revenueFromRemindedAppointments: appointmentCounts.reminded_revenue,
      collected: collected?.value ?? 0,
      newPatients: newPatients?.value ?? 0,
      outstandingBalance: outstanding?.value ?? 0,
    };
  }
}

function firstDayOfNextMonth(month: string): string {
  // Sumar 32 días al primer día siempre cae en el mes siguiente.
  return `${addDays(`${month}-01`, 32).slice(0, 7)}-01`;
}
