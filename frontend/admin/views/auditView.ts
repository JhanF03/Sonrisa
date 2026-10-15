/**
 * Registro de auditoría: quién hizo qué, cuándo, desde dónde y qué cambió.
 * No se puede editar ni borrar (lo impide la base de datos).
 */
import { api } from '../../core/api.js';
import { html, setContent } from '../../core/dom.js';
import { formatUtcAsLocal } from '../../core/format.js';
import { auditDetails, auditDetailsText } from '../../core/auditFormat.js';
import { downloadExcel } from '../../core/excel.js';
import { emptyState, icon, loadingState, refreshIcons } from '../../core/ui.js';
import { clinicOffset } from '../session.js';

interface AuditRow {
  id: string;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: string | null;
  ip: string | null;
  user_agent?: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export async function renderAuditView(container: HTMLElement, params: string[]): Promise<void> {
  const page = Math.max(0, Number(params[0] ?? 0) || 0);
  setContent(container, loadingState());
  const rows = await api.get<AuditRow[]>('/api/audit', { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const offset = clinicOffset();

  setContent(
    container,
    html`<section class="card">
      <div class="card-header"><h3>${icon('scroll-text')} Registro de auditoría</h3>
        <div class="button-row">
          ${rows.length ? html`<button class="button button-secondary button-small" data-action="export">${icon('file-spreadsheet')} Exportar</button>` : ''}
          ${page > 0 ? html`<a class="button button-secondary button-small" href="#/auditoria/${page - 1}">${icon('chevron-left')} Más recientes</a>` : ''}
          ${rows.length === PAGE_SIZE ? html`<a class="button button-secondary button-small" href="#/auditoria/${page + 1}">Anteriores ${icon('chevron-right')}</a>` : ''}
        </div></div>
      ${rows.length === 0
        ? emptyState('scroll-text', 'Sin registros', 'Aquí quedan las acciones importantes del sistema.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr>
            <td class="nowrap">${formatUtcAsLocal(row.created_at, offset)}</td>
            <td>${row.user_name ?? html`<span class="subtle">Paciente / sistema</span>`}</td>
            <td><span class="badge badge-neutral">${row.action.replaceAll('_', ' ')}</span></td>
            <td>${auditDetails(row.details)}</td>
            <td><small class="subtle" data-tooltip="${row.user_agent ?? ''}">${row.ip ?? ''}</small></td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(container);
  container.querySelector('[data-action="export"]')?.addEventListener('click', () =>
    void downloadExcel('auditoria', 'Auditoría', rows, [
      { header: 'Fecha', width: 20, value: (row) => formatUtcAsLocal(row.created_at, offset) },
      { header: 'Usuario', width: 24, value: (row) => row.user_name ?? 'Paciente / sistema' },
      { header: 'Acción', width: 26, value: (row) => row.action.replaceAll('_', ' ') },
      { header: 'Registro', width: 14, value: (row) => row.entity },
      { header: 'Detalle', width: 60, value: (row) => auditDetailsText(row.details) },
      { header: 'IP', width: 16, value: (row) => row.ip },
      { header: 'Navegador', width: 40, value: (row) => row.user_agent ?? '' },
    ]),
  );
}
