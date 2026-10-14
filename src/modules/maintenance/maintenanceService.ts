/**
 * Tareas de mantenimiento: liberar retenciones vencidas, vencer intentos de
 * pago antiguos y limpiar contadores de intentos.
 *
 * Se ejecutan con el Cron Trigger de Cloudflare (cada 10 minutos, gratis),
 * con un temporizador en Node, y además de forma "perezosa" al abrir la agenda
 * o los recordatorios. Aunque nunca corrieran, una retención vencida ya no
 * ocupa el horario (la regla SQL lo garantiza): esto solo ordena el registro.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { AppointmentService } from '../appointments/appointmentService.js';
import type { PaymentService } from '../payments/paymentService.js';

const DAY_MS = 86_400_000;

export class MaintenanceService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly appointments: AppointmentService,
    private readonly payments: PaymentService,
  ) {}

  async runScheduled(): Promise<{ releasedHolds: number }> {
    const releasedHolds = await this.appointments.expireStaleHolds();
    await this.payments.expireStaleIntents();
    await this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - DAY_MS).run();
    await this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
    return { releasedHolds };
  }

  /** Versión rápida para un consultorio (se llama al abrir la agenda). */
  releaseExpiredHolds(tenantId: string): Promise<number> {
    return this.appointments.expireStaleHolds(tenantId);
  }
}
