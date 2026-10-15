/**
 * Tareas de mantenimiento: liberar retenciones vencidas, vencer intentos de
 * pago antiguos, limpiar contadores de intentos, borrar demos vencidas y
 * aplicar bajadas de plan programadas. Los recordatorios de pago van en
 * otra tarea (cada hora) para no gastar el cupo de consultas de esta.
 *
 * Se ejecutan con el Cron Trigger de Cloudflare (cada 10 minutos, gratis),
 * con un temporizador en Node, y además de forma "perezosa" al abrir la agenda
 * o los recordatorios. Aunque nunca corrieran, una retención vencida ya no
 * ocupa el horario (la regla SQL lo garantiza): esto solo ordena el registro.
 */
import type { SqlDatabase } from '../../db/database.js';
import type { AppointmentService } from '../appointments/appointmentService.js';
import type { PaymentService } from '../payments/paymentService.js';
import type { PlatformService } from '../platform/platformService.js';

const DAY_MS = 86_400_000;

export class MaintenanceService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly appointments: AppointmentService,
    private readonly payments: PaymentService,
    private readonly platform?: Pick<PlatformService, 'deleteExpiredDemos' | 'applyDuePendingPlans'>,
  ) {}

  async runScheduled(): Promise<{ releasedHolds: number; deletedDemos: number }> {
    const releasedHolds = await this.appointments.expireStaleHolds();
    await this.payments.expireStaleIntents();
    await this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - DAY_MS).run();
    await this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
    // Demos vencidas (se borran pocas por vez) y bajadas de plan cuya fecha llegó.
    const deletedDemos = (await this.platform?.deleteExpiredDemos()) ?? 0;
    await this.platform?.applyDuePendingPlans();
    return { releasedHolds, deletedDemos };
  }

  /** Versión rápida para un consultorio (se llama al abrir la agenda). */
  releaseExpiredHolds(tenantId: string): Promise<number> {
    return this.appointments.expireStaleHolds(tenantId);
  }
}
