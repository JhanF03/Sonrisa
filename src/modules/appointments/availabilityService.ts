/**
 * Cálculo de horarios disponibles.
 *
 * Disponible = franjas del horario semanal
 *              − citas activas − bloqueos − festivos (si el consultorio cierra)
 *              − horas pasadas o dentro del margen mínimo de reserva.
 *
 * Se consulta la base UNA vez por rango de fechas y el resto se calcula en
 * memoria, para respetar el límite de CPU del plan gratuito de Cloudflare.
 */
import type { SqlDatabase } from '../../db/database.js';
import { occupiesSlot } from '../../db/sqlFragments.js';
import type { TenantRow } from '../../http/context.js';
import { isColombianHoliday } from '../../utils/colombianHolidays.js';
import { addDays, addMinutes, nowLocal, weekdayOf } from '../../utils/time.js';

export interface AvailableSlot {
  start: string;
  end: string;
  professionalId: string;
  professionalName: string;
}

export interface AvailabilityRequest {
  fromDate: string;
  toDate: string;
  durationMinutes: number;
  professionalId?: string;
  /** Cita a ignorar (al reprogramar, su propio espacio cuenta como libre). */
  excludeAppointmentId?: string;
  /** Reglas de reserva en línea: margen mínimo y ventana máxima. */
  applyPublicRules: boolean;
}

interface ScheduleWithName {
  professional_id: string;
  full_name: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

interface BusyRange {
  professional_id: string | null;
  start_at: string;
  end_at: string;
}

export const MAX_AVAILABILITY_RANGE_DAYS = 31;

export class AvailabilityService {
  constructor(private readonly db: SqlDatabase) {}

  async findSlots(tenant: TenantRow, request: AvailabilityRequest, nowMs = Date.now()): Promise<AvailableSlot[]> {
    const currentLocal = nowLocal(tenant.utc_offset_minutes, nowMs);
    const earliestStart = request.applyPublicRules
      ? addMinutes(currentLocal, tenant.min_booking_notice_hours * 60)
      : currentLocal;
    const latestDate = request.applyPublicRules
      ? addDays(currentLocal.slice(0, 10), tenant.booking_window_days)
      : request.toDate;
    const toDate = request.toDate < latestDate ? request.toDate : latestDate;
    if (request.fromDate > toDate) return [];

    const { schedules, busyRanges } = await this.loadCalendarData(tenant.id, request.fromDate, toDate, request);
    const slots: AvailableSlot[] = [];

    for (let date = request.fromDate; date <= toDate; date = addDays(date, 1)) {
      if (tenant.close_on_holidays === 1 && isColombianHoliday(date)) continue;
      const weekday = weekdayOf(date);

      for (const schedule of schedules) {
        if (schedule.weekday !== weekday) continue;

        const blockEnd = `${date}T${schedule.end_time}`;
        for (
          let slotStart = `${date}T${schedule.start_time}`;
          addMinutes(slotStart, request.durationMinutes) <= blockEnd;
          slotStart = addMinutes(slotStart, tenant.slot_interval_minutes)
        ) {
          const slotEnd = addMinutes(slotStart, request.durationMinutes);
          if (slotStart < earliestStart) continue;

          const isBusy = busyRanges.some(
            (busy) =>
              (busy.professional_id === null || busy.professional_id === schedule.professional_id) &&
              busy.start_at < slotEnd &&
              busy.end_at > slotStart,
          );
          if (!isBusy) {
            slots.push({
              start: slotStart,
              end: slotEnd,
              professionalId: schedule.professional_id,
              professionalName: schedule.full_name,
            });
          }
        }
      }
    }

    return slots.sort((first, second) => first.start.localeCompare(second.start) || first.professionalName.localeCompare(second.professionalName));
  }

  /** Verifica que un horario concreto esté libre (para validar reservas). */
  async isSlotAvailable(
    tenant: TenantRow,
    request: Omit<AvailabilityRequest, 'fromDate' | 'toDate'> & { start: string; professionalId: string },
  ): Promise<boolean> {
    const date = request.start.slice(0, 10);
    const slots = await this.findSlots(tenant, { ...request, fromDate: date, toDate: date });
    return slots.some((slot) => slot.start === request.start && slot.professionalId === request.professionalId);
  }

  private async loadCalendarData(
    tenantId: string,
    fromDate: string,
    toDate: string,
    request: AvailabilityRequest,
  ): Promise<{ schedules: ScheduleWithName[]; busyRanges: BusyRange[] }> {
    const professionalFilter = request.professionalId ? 'AND p.id = ?' : '';
    const professionalParams = request.professionalId ? [request.professionalId] : [];
    const rangeStart = `${fromDate}T00:00`;
    const rangeEnd = `${addDays(toDate, 1)}T00:00`;

    const [scheduleResult, appointmentResult, blockResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT s.professional_id, p.full_name, s.weekday, s.start_time, s.end_time
           FROM schedules s JOIN professionals p ON p.id = s.professional_id AND p.is_active = 1
           WHERE s.tenant_id = ? ${professionalFilter}`,
        )
        .bind(tenantId, ...professionalParams)
        .all<ScheduleWithName>(),
      this.db
        .prepare(
          `SELECT a.professional_id, a.start_at, a.end_at FROM appointments a
           WHERE a.tenant_id = ? AND ${occupiesSlot('a')} AND a.start_at < ? AND a.end_at > ?
             ${request.excludeAppointmentId ? 'AND a.id <> ?' : ''}`,
        )
        .bind(tenantId, rangeEnd, rangeStart, ...(request.excludeAppointmentId ? [request.excludeAppointmentId] : []))
        .all<BusyRange>(),
      this.db
        .prepare('SELECT professional_id, start_at, end_at FROM time_blocks WHERE tenant_id = ? AND start_at < ? AND end_at > ?')
        .bind(tenantId, rangeEnd, rangeStart)
        .all<BusyRange>(),
    ]);

    return {
      schedules: scheduleResult.results,
      busyRanges: [...appointmentResult.results, ...blockResult.results],
    };
  }
}

