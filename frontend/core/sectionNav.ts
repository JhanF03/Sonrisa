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
 *
 * Dos modos:
 *  • 'link' (por defecto): cada grupo es un enlace y la vista se vuelve a dibujar.
 *  • 'local': todos los grupos están en la página (un solo formulario con un solo
 *    Guardar) y el menú solo muestra u oculta; lo escrito no se pierde al cambiar.
 *    Cada grupo va en `<div data-section-pane="id">` y se activa con `mountLocalSections`.
 */
import { html, setContent, type SafeHtml } from './dom.js';
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
export function sectionLayout(options: {
  items: SectionNavItem[];
  active: SectionNavItem;
  baseHref: string;
  label: string;
  mode?: 'link' | 'local';
  /** Solo en modo 'local': los grupos (cada uno con data-section-pane) y lo que va debajo (ej. Guardar). */
  panes?: SafeHtml;
  footer?: SafeHtml;
}): SafeHtml {
  const { items, active, baseHref, label, mode = 'link' } = options;
  return html`<div class="section-layout">
    <nav class="section-nav" aria-label="${label}">
      ${items.map((item) => {
        const isActive = item.id === active.id;
        const inner = html`<span class="section-link-icon">${icon(item.iconName)}</span>
          <span class="section-link-text"><strong>${item.label}</strong>${item.hint ? html`<small>${item.hint}</small>` : ''}</span>
          ${item.status ? html`<span class="section-dot is-${item.status}" role="img" aria-label="${STATUS_LABELS[item.status]}" data-tooltip="${STATUS_LABELS[item.status]}"></span>` : ''}`;
        return mode === 'local'
          ? html`<button type="button" class="section-link ${isActive ? 'is-active' : ''}" data-section="${item.id}" ${isActive ? html`aria-current="true"` : ''}>${inner}</button>`
          : html`<a class="section-link ${isActive ? 'is-active' : ''}" href="${baseHref}/${item.id}" ${isActive ? html`aria-current="page"` : ''}>${inner}</a>`;
      })}
    </nav>
    <div class="section-panel">
      <header class="section-head">${sectionHead(active)}</header>
      <div data-section-content>${options.panes ?? ''}</div>
      ${options.footer ?? ''}
    </div>
  </div>`;
}

function sectionHead(item: SectionNavItem): SafeHtml {
  return html`<h2>${icon(item.iconName)} ${item.label}</h2>
    ${item.description ?? item.hint ? html`<p class="subtle">${item.description ?? item.hint}</p>` : ''}`;
}

/**
 * Modo 'local': cambia de grupo sin volver a dibujar (conserva lo escrito) y
 * deja la URL en #/vista/grupo sin recargar.
 */
export function mountLocalSections(root: HTMLElement, items: SectionNavItem[], baseHref: string, initialId: string): (id: string) => void {
  const show = (id: string) => {
    const item = items.find((candidate) => candidate.id === id) ?? items[0];
    if (!item) return;
    root.querySelectorAll<HTMLElement>('[data-section]').forEach((button) => {
      const isActive = button.dataset.section === item.id;
      button.classList.toggle('is-active', isActive);
      if (isActive) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    root.querySelectorAll<HTMLElement>('[data-section-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.sectionPane !== item.id;
    });
    const head = root.querySelector<HTMLElement>('.section-head');
    if (head) setContent(head, sectionHead(item));
    // replaceState no dispara "hashchange": la vista no se vuelve a dibujar.
    window.history.replaceState(null, '', `${baseHref}/${item.id}`);
  };
  root.querySelector('.section-nav')?.addEventListener('click', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section;
    if (id) show(id);
  });
  show(initialId);
  return show;
}
