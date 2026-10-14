/**
 * Registro de lo que se hace en la plataforma.
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { formatUtcAsLocal } from '../../core/format.js';
import { emptyState, icon, refreshIcons } from '../../core/ui.js';
import { OFFSET } from '../types.js';

const AUDIT_LABELS: Record<string, string> = {
  ingreso_plataforma: 'Ingreso a la plataforma',
  configuracion_plataforma: 'Configuración actualizada',
  consultorio_creado: 'Consultorio real creado',
  demo_creada: 'Demo creada',
  suscripcion_editada: 'Plan / acceso editado',
  pago_suscripcion: 'Pago registrado',
  pago_suscripcion_anulado: 'Pago anulado',
  clave_admin_restablecida: 'Clave de administrador restablecida',
  ingreso_fallido: 'Intento de ingreso fallido',
  cuenta_dueno_creada: 'Cuenta de plataforma creada',
  cuenta_dueno_activada: 'Cuenta de plataforma activada',
  cuenta_dueno_desactivada: 'Cuenta de plataforma desactivada',
  clave_dueno_cambiada: 'Contraseña de plataforma cambiada',
  acceso_recuperado: 'Acceso recuperado con la clave maestra',
  '2fa_activada': 'Verificación en dos pasos activada',
  '2fa_desactivada': 'Verificación en dos pasos desactivada',
  codigo_2fa_fallido: 'Código de verificación incorrecto',
};

export async function renderAuditView(content: HTMLElement): Promise<void> {
  const rows = await api.get<Array<{ id: string; action: string; tenant_name: string | null; details: string | null; ip: string | null; created_at: string }>>('/api/platform/audit');
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('scroll-text')} Lo que se hizo en la plataforma</h3></div>
      ${rows.length === 0
        ? emptyState('scroll-text', 'Sin registros', 'Aquí quedan los ingresos, pagos y cambios de la plataforma.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Acción</th><th>Consultorio</th><th>IP</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr><td>${formatUtcAsLocal(row.created_at, OFFSET)}</td><td>${AUDIT_LABELS[row.action] ?? row.action}</td><td>${row.tenant_name ?? '—'}</td><td><small class="subtle">${row.ip ?? 'automático'}</small></td></tr>`)}</tbody>
        </table></div>`}
    </section>`,
  );
  refreshIcons(content);
}

