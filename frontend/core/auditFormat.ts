/**
 * Muestra el detalle de un registro de auditoría de forma legible:
 * los cambios como "campo: antes → después" y el resto como "clave: valor".
 */
import { html, type SafeHtml } from './dom.js';

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Nombre', fullName: 'Nombre', document_type: 'Tipo de documento', document_number: 'Documento', phone: 'Celular', email: 'Correo',
  birth_date: 'Nacimiento', guardian_name: 'Acudiente', guardian_phone: 'Celular del acudiente', admin_notes: 'Notas', code: 'Código', name: 'Nombre',
  category: 'Categoría', price: 'Precio', duration_minutes: 'Duración', tax_rate_bps: 'IVA', is_bookable_online: 'Reserva en línea', is_active: 'Activo',
  isActive: 'Activo', prepayment_mode: 'Anticipo', prepayment_value: 'Valor del anticipo', specialty: 'Especialidad', color: 'Color', user_id: 'Usuario vinculado',
  roleIds: 'Roles', address: 'Dirección', city: 'Ciudad', brand_color: 'Color de marca', logo_url: 'Logo', slot_interval_minutes: 'Intervalo de citas',
  min_booking_notice_hours: 'Anticipación mínima', booking_window_days: 'Días para reservar', reactivation_months: 'Meses para reactivar',
  online_booking_enabled: 'Reservas en línea', close_on_holidays: 'Cerrar festivos',
};

const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return 'vacío';
  if (value === 1 || value === true) return 'sí';
  if (value === 0 || value === false) return 'no';
  if (Array.isArray(value)) return `${value.length} elemento(s)`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export function auditDetails(details: string | null): SafeHtml {
  if (!details) return html``;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(details) as Record<string, unknown>;
  } catch {
    return html`<small class="subtle">${details}</small>`;
  }
  const { cambios, ...rest } = parsed as { cambios?: Record<string, [unknown, unknown]> } & Record<string, unknown>;
  const changeLines = cambios ? Object.entries(cambios) : [];
  const otherLines = Object.entries(rest);
  if (changeLines.length === 0 && otherLines.length === 0) return html`<small class="subtle">Sin cambios de datos</small>`;
  return html`<small class="audit-detail">
    ${changeLines.map(([field, [before, after]]) => html`<span><strong>${FIELD_LABELS[field] ?? field}:</strong> ${show(before)} → ${show(after)}</span>`)}
    ${otherLines.map(([key, value]) => html`<span><strong>${FIELD_LABELS[key] ?? key}:</strong> ${show(value)}</span>`)}
  </small>`;
}

/** Texto plano para exportar a Excel. */
export function auditDetailsText(details: string | null): string {
  if (!details) return '';
  try {
    const { cambios, ...rest } = JSON.parse(details) as { cambios?: Record<string, [unknown, unknown]> } & Record<string, unknown>;
    return [
      ...Object.entries(cambios ?? {}).map(([field, [before, after]]) => `${FIELD_LABELS[field] ?? field}: ${show(before)} → ${show(after)}`),
      ...Object.entries(rest).map(([key, value]) => `${FIELD_LABELS[key] ?? key}: ${show(value)}`),
    ].join(' | ');
  } catch {
    return details;
  }
}
