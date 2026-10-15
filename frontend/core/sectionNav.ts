/**
 * Submenú lateral para pantallas de configuración con varios grupos.
 *
 *   ┌──────────────┬──────────────────────────────┐
 *   │ ● Grupo 1    │  Título del grupo            │
 *   │   Grupo 2    │  descripción corta           │
 *   │   Grupo 3 •  │  [formulario del grupo]      │
 *   └──────────────┴──────────────────────────────┘
 *
 * Se muestra un grupo a la vez y cada uno tiene su propia URL (#/vista/grupo),
 * así se puede enlazar directo y el botón "atrás" del navegador funciona.
 * En el celular el menú pasa arriba como una fila deslizable.
 */
import { html, type SafeHtml } from './dom.js';
import { icon } from './ui.js';

export interface SectionNavItem {
  id: string;
  label: string;
  iconName: string;
  /** Línea corta bajo el nombre (qué se configura ahí). */
  hint?: string;
  /** Explicación más larga bajo el título del panel (si no, se usa `hint`). */
  description?: string;
  /** Punto de estado: listo (verde) o pendiente (ámbar). */
  status?: 'ok' | 'pendiente' | null;
}

const STATUS_LABELS = { ok: 'Configurado', pendiente: 'Pendiente por configurar' } as const;

/** Busca el grupo pedido en la URL; si no existe, el primero. */
export function pickSection<T extends SectionNavItem>(items: T[], requestedId: string | undefined): T | undefined {
  return items.find((item) => item.id === requestedId) ?? items[0];
}

/**
 * Estructura completa: menú + panel. El contenido del grupo se dibuja después
 * dentro de `[data-section-content]`.
 */
export function sectionLayout(options: { items: SectionNavItem[]; active: SectionNavItem; baseHref: string; label: string }): SafeHtml {
  const { items, active, baseHref, label } = options;
  return html`<div class="section-layout">
    <nav class="section-nav" aria-label="${label}">
      ${items.map((item) => {
        const isActive = item.id === active.id;
        return html`<a class="section-link ${isActive ? 'is-active' : ''}" href="${baseHref}/${item.id}" ${isActive ? html`aria-current="page"` : ''}>
          <span class="section-link-icon">${icon(item.iconName)}</span>
          <span class="section-link-text"><strong>${item.label}</strong>${item.hint ? html`<small>${item.hint}</small>` : ''}</span>
          ${item.status ? html`<span class="section-dot is-${item.status}" role="img" aria-label="${STATUS_LABELS[item.status]}" data-tooltip="${STATUS_LABELS[item.status]}"></span>` : ''}
        </a>`;
      })}
    </nav>
    <div class="section-panel">
      <header class="section-head">
        <h2>${icon(active.iconName)} ${active.label}</h2>
        ${active.description ?? active.hint ? html`<p class="subtle">${active.description ?? active.hint}</p>` : ''}
      </header>
      <div data-section-content></div>
    </div>
  </div>`;
}
