/**
 * Registro de correos enviados: qué salió, a quién y si falló (con el motivo).
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { downloadExcel } from '../../core/excel.js';
import { formatUtcAsLocal } from '../../core/format.js';
import { emptyState, icon, refreshIcons } from '../../core/ui.js';
import { OFFSET, type EmailLogRow } from '../types.js';

const KIND_LABELS: Record<string, string> = {
  bienvenida: 'Bienvenida',
  demo: 'Datos de la demo',
  demo_por_vencer: 'Demo por terminar',
  comprobante: 'Comprobante de pago',
  recordatorio_por_vencer: 'Recordatorio: vence pronto',
  recordatorio_vence_manana: 'Recordatorio: vence mañana',
  recordatorio_vencida: 'Aviso: vencida',
  recordatorio_suspendida: 'Aviso: suspendida',
  recuperar_clave: 'Recuperar contraseña',
  aviso_dueno: 'Aviso para ti',
  prueba: 'Prueba',
};

const STATUS_BADGES: Record<EmailLogRow['status'], string> = { enviado: 'badge-success', fallido: 'badge-danger', omitido: 'badge-neutral' };
const STATUS_LABELS: Record<EmailLogRow['status'], string> = { enviado: 'Enviado', fallido: 'Falló', omitido: 'Omitido' };

export async function renderEmailLogView(content: HTMLElement): Promise<void> {
  const rows = await api.get<EmailLogRow[]>('/api/platform/email-log');
  const failed = rows.filter((row) => row.status === 'fallido').length;
  setContent(
    content,
    html`<section class="card">
      <div class="card-header"><h3>${icon('mail')} Correos enviados <span class="hint" data-tooltip="Últimos 200. 'Omitido' significa que el correo de Gmail aún no está configurado (Configuración). 'Fallido' muestra el motivo al pasar el mouse.">${icon('info')}</span></h3>
        <button class="button button-secondary button-small" type="button" data-export>${icon('file-spreadsheet')} Excel</button></div>
      ${failed ? html`<p class="card-padded form-error" style="margin: 0 18px 12px">${failed} correo(s) fallaron. Revisa el motivo y la configuración de Gmail.</p>` : ''}
      ${rows.length === 0
        ? emptyState('mail', 'Sin correos todavía', 'Aquí verás cada bienvenida, comprobante y recordatorio que envía el sistema.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Para</th><th>Consultorio</th><th>Asunto</th><th>Estado</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr>
            <td>${formatUtcAsLocal(row.created_at, OFFSET)}</td><td>${KIND_LABELS[row.kind] ?? row.kind}</td><td>${row.recipient}</td>
            <td>${row.tenant_name ?? '—'}</td><td>${row.subject}</td>
            <td><span class="badge ${STATUS_BADGES[row.status]}" ${row.error ? html`data-tooltip="${row.error}"` : ''}>${STATUS_LABELS[row.status]}</span></td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(content);
  content.querySelector('[data-export]')?.addEventListener('click', () => {
    void downloadExcel('correos', 'Correos', rows, [
      { header: 'Fecha', width: 18, value: (row) => formatUtcAsLocal(row.created_at, OFFSET) },
      { header: 'Tipo', width: 26, value: (row) => KIND_LABELS[row.kind] ?? row.kind },
      { header: 'Para', width: 30, value: (row) => row.recipient },
      { header: 'Consultorio', width: 28, value: (row) => row.tenant_name ?? '' },
      { header: 'Asunto', width: 48, value: (row) => row.subject },
      { header: 'Estado', width: 10, value: (row) => STATUS_LABELS[row.status] },
      { header: 'Error', width: 40, value: (row) => row.error ?? '' },
    ]);
  });
}
