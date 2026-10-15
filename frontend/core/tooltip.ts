/**
 * Tooltips flotantes para todo el sistema (atributo `data-tooltip`).
 *
 * Antes eran un ::after dentro de cada elemento: los cortaban los contenedores
 * con scroll (menú lateral, tablas, modales) y creaban scroll horizontal.
 * Ahora hay un solo globo que flota por encima de todo:
 *  • Se dibuja en la "capa superior" del navegador (popover), así queda encima
 *    incluso de los modales. Si el navegador no tiene popover, se mete dentro
 *    del modal abierto o del body.
 *  • Posición fija calculada con la pantalla: arriba por defecto, se voltea si
 *    no cabe y nunca se sale por los lados (no genera scroll).
 *  • Mouse: aparece al pasar por encima. Teclado: al enfocar. Celular: al tocar
 *    un ícono (i). Se oculta con Escape, scroll, clic o al salir.
 *
 * Uso: `data-tooltip="texto"` y opcional `data-tooltip-position="bottom|right|left"`.
 */

const SHOW_DELAY_MS = 300;
const TOUCH_VISIBLE_MS = 3500;
const GAP = 8;
const EDGE = 8;

type Side = 'top' | 'bottom' | 'right' | 'left';

let bubble: HTMLDivElement | null = null;
let currentTarget: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'floating-tooltip';
  bubble.id = 'floating-tooltip';
  bubble.setAttribute('role', 'tooltip');
  if (supportsPopover) bubble.setAttribute('popover', 'manual');
  return bubble;
}

/** Elige el lado: el pedido si cabe; si no, el opuesto; si tampoco, el que tenga más espacio. */
function chooseSide(preferred: Side, rect: DOMRect, width: number, height: number): Side {
  const space = { top: rect.top, bottom: window.innerHeight - rect.bottom, left: rect.left, right: window.innerWidth - rect.right };
  const needed = (side: Side) => (side === 'top' || side === 'bottom' ? height : width) + GAP + EDGE;
  if (space[preferred] >= needed(preferred)) return preferred;
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  if (space[opposite[preferred]] >= needed(opposite[preferred])) return opposite[preferred];
  return space.top >= space.bottom ? 'top' : 'bottom';
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function place(target: HTMLElement, element: HTMLDivElement): void {
  const rect = target.getBoundingClientRect();
  const { width, height } = element.getBoundingClientRect();
  const requested = (target.dataset.tooltipPosition as Side | undefined) ?? 'top';
  const side = chooseSide(['top', 'bottom', 'left', 'right'].includes(requested) ? requested : 'top', rect, width, height);
  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    left = rect.left + rect.width / 2 - width / 2;
    top = side === 'top' ? rect.top - height - GAP : rect.bottom + GAP;
  } else {
    top = rect.top + rect.height / 2 - height / 2;
    left = side === 'right' ? rect.right + GAP : rect.left - width - GAP;
  }
  // Nunca fuera de la pantalla: así no aparece scroll horizontal ni se corta.
  element.style.left = `${clamp(left, EDGE, window.innerWidth - width - EDGE)}px`;
  element.style.top = `${clamp(top, EDGE, window.innerHeight - height - EDGE)}px`;
  element.dataset.side = side;
}

function show(target: HTMLElement): void {
  const text = target.dataset.tooltip?.trim();
  if (!text || !target.isConnected) return;
  const element = ensureBubble();
  element.textContent = text;
  // Sin popover: dentro del modal abierto (si lo hay) para quedar por encima de él.
  const host = supportsPopover ? document.body : (target.closest('dialog[open]') ?? document.body);
  if (element.parentElement !== host) host.append(element);
  if (supportsPopover) {
    // Volver a abrirlo lo pone encima de cualquier modal abierto después.
    if (element.matches(':popover-open')) element.hidePopover();
    element.showPopover();
  }
  element.classList.add('is-visible');
  element.style.left = '0px';
  element.style.top = '0px';
  place(target, element);
  currentTarget = target;
  target.setAttribute('aria-describedby', element.id);
}

export function hideTooltip(): void {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  if (currentTarget?.getAttribute('aria-describedby') === 'floating-tooltip') currentTarget.removeAttribute('aria-describedby');
  currentTarget = null;
  if (!bubble) return;
  bubble.classList.remove('is-visible');
  if (supportsPopover && bubble.matches(':popover-open')) bubble.hidePopover();
}

function scheduleShow(target: HTMLElement): void {
  window.clearTimeout(showTimer);
  if (currentTarget === target) return;
  hideTooltip();
  showTimer = window.setTimeout(() => show(target), SHOW_DELAY_MS);
}

const tooltipTarget = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null);

let initialized = false;

/** Se llama una vez al iniciar cada aplicación. */
export function initTooltips(): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const target = tooltipTarget(event.target);
    if (target) scheduleShow(target);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const target = tooltipTarget(event.target);
    if (!target) return;
    // Sigue dentro del mismo elemento (pasó a un hijo): no se oculta.
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
    hideTooltip();
  });
  document.addEventListener('focusin', (event) => {
    const target = tooltipTarget(event.target);
    if (target && (event.target as HTMLElement).matches(':focus-visible')) scheduleShow(target);
  });
  document.addEventListener('focusout', () => hideTooltip());

  // Celular: tocar un ícono (i) muestra su explicación unos segundos.
  document.addEventListener('click', (event) => {
    const target = tooltipTarget(event.target);
    const isTouch = (event as PointerEvent).pointerType === 'touch' || window.matchMedia('(hover: none)').matches;
    if (target && isTouch && target.classList.contains('hint')) {
      event.preventDefault();
      if (currentTarget === target) return hideTooltip();
      hideTooltip();
      show(target);
      hideTimer = window.setTimeout(hideTooltip, TOUCH_VISIBLE_MS);
      return;
    }
    hideTooltip();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  });
  window.addEventListener('scroll', () => hideTooltip(), { capture: true, passive: true });
  window.addEventListener('resize', () => hideTooltip());
  // Si el elemento desaparece (cambio de vista, modal cerrado), el globo también.
  new MutationObserver(() => {
    if (currentTarget && !currentTarget.isConnected) hideTooltip();
  }).observe(document.body, { childList: true, subtree: true });
}
