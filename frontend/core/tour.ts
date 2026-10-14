/**
 * Recorridos guiados paso a paso (sin librerías).
 *
 * • Resalta el elemento real de la pantalla (oscurece el resto) y muestra
 *   una tarjeta con la explicación, el avance y botones Anterior/Siguiente.
 * • Cada paso puede indicar varios selectores: se usa el primero visible.
 *   Si ninguno existe (p. ej. el usuario no tiene ese permiso), el paso se
 *   muestra centrado, sin resaltar, para no romper el recorrido.
 * • Teclado: ← → para moverse, Esc para salir. Accesible (role="dialog").
 */
import { html, setContent } from './dom.js';
import { icon, refreshIcons } from './ui.js';

export interface TourStep {
  /** Selectores CSS en orden de preferencia. Vacío = paso centrado. */
  target?: string | string[];
  title: string;
  body: string;
  /** Si el paso no encuentra su elemento, se omite en lugar de mostrarse centrado. */
  optional?: boolean;
}

interface ActiveTour {
  steps: TourStep[];
  index: number;
  onFinish?: (completed: boolean) => void;
  cleanup: () => void;
}

let activeTour: ActiveTour | null = null;

function findTarget(step: TourStep): HTMLElement | null {
  const selectors = step.target ? (Array.isArray(step.target) ? step.target : [step.target]) : [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = element.getBoundingClientRect();
      const onScreen = rect.right > 0 && rect.left < window.innerWidth;
      if (rect.width > 0 && rect.height > 0 && onScreen && !element.closest('[hidden]')) return element;
    }
  }
  return null;
}

export function isTourRunning(): boolean {
  return activeTour !== null;
}

export function stopTour(completed = false): void {
  if (!activeTour) return;
  const { onFinish, cleanup } = activeTour;
  activeTour = null;
  cleanup();
  onFinish?.(completed);
}

export function startTour(rawSteps: TourStep[], options: { onFinish?: (completed: boolean) => void } = {}): void {
  stopTour();
  // Se omiten los pasos opcionales cuyo elemento no está en pantalla.
  const steps = rawSteps.filter((step) => !step.optional || findTarget(step));
  if (steps.length === 0) return;

  const overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  const spotlight = document.createElement('div');
  spotlight.className = 'tour-spotlight';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-live', 'polite');
  document.body.append(overlay, spotlight, card);

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const position = () => {
    if (!activeTour) return;
    const step = activeTour.steps[activeTour.index];
    if (!step) return;
    const target = findTarget(step);
    const margin = 8;
    if (target) {
      const rect = target.getBoundingClientRect();
      spotlight.hidden = false;
      overlay.classList.remove('is-solid');
      Object.assign(spotlight.style, {
        top: `${rect.top - margin}px`,
        left: `${rect.left - margin}px`,
        width: `${rect.width + margin * 2}px`,
        height: `${rect.height + margin * 2}px`,
      });
      // Tarjeta: debajo, arriba, a la derecha o a la izquierda (la primera que quepa).
      const cardRect = card.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = margin + 12;
      const clampLeft = (value: number) => Math.min(Math.max(12, value), Math.max(12, viewportWidth - cardRect.width - 12));
      const clampTop = (value: number) => Math.min(Math.max(12, value), Math.max(12, viewportHeight - cardRect.height - 12));
      const candidates = [
        { fits: rect.bottom + gap + cardRect.height <= viewportHeight - 12, top: rect.bottom + gap, left: clampLeft(rect.left) },
        { fits: rect.top - gap - cardRect.height >= 12, top: rect.top - gap - cardRect.height, left: clampLeft(rect.left) },
        { fits: rect.right + gap + cardRect.width <= viewportWidth - 12, top: clampTop(rect.top), left: rect.right + gap },
        { fits: rect.left - gap - cardRect.width >= 12, top: clampTop(rect.top), left: rect.left - gap - cardRect.width },
      ];
      const chosen = candidates.find((candidate) => candidate.fits) ?? { top: viewportHeight - cardRect.height - 12, left: viewportWidth - cardRect.width - 12 };
      card.style.top = `${chosen.top}px`;
      card.style.left = `${chosen.left}px`;
      card.classList.remove('is-centered');
    } else {
      spotlight.hidden = true;
      overlay.classList.add('is-solid');
      card.style.top = '';
      card.style.left = '';
      card.classList.add('is-centered');
    }
  };

  const render = () => {
    if (!activeTour) return;
    const { index } = activeTour;
    const step = activeTour.steps[index];
    if (!step) return;
    const isLast = index === activeTour.steps.length - 1;
    setContent(
      card,
      html`<div class="tour-progress"><span style="width:${Math.round(((index + 1) / activeTour.steps.length) * 100)}%"></span></div>
        <div class="tour-header"><span class="tour-count">Paso ${index + 1} de ${activeTour.steps.length}</span>
          <button type="button" class="icon-button" data-tour="close" aria-label="Cerrar recorrido">${icon('x')}</button></div>
        <h3 id="tour-title">${step.title}</h3>
        <p>${step.body}</p>
        <div class="tour-actions">
          <button type="button" class="button button-ghost button-small" data-tour="prev" ${index === 0 ? 'disabled' : ''}>Anterior</button>
          <button type="button" class="button button-primary button-small" data-tour="next">${isLast ? 'Terminar' : 'Siguiente'}</button>
        </div>`,
    );
    card.setAttribute('aria-labelledby', 'tour-title');
    refreshIcons(card);
    const target = findTarget(step);
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.top < 70 || rect.bottom > window.innerHeight - 20) target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    }
    requestAnimationFrame(position);
    card.querySelector<HTMLElement>('[data-tour="next"]')?.focus();
  };

  const go = (delta: number) => {
    if (!activeTour) return;
    const next = activeTour.index + delta;
    if (next >= activeTour.steps.length) return stopTour(true);
    if (next < 0) return;
    activeTour.index = next;
    render();
  };

  const onClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-tour]')?.dataset.tour;
    if (action === 'next') go(1);
    if (action === 'prev') go(-1);
    if (action === 'close') stopTour(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') stopTour(false);
    if (event.key === 'ArrowRight') go(1);
    if (event.key === 'ArrowLeft') go(-1);
  };
  const onLayout = () => requestAnimationFrame(position);

  card.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onLayout);
  window.addEventListener('scroll', onLayout, true);

  activeTour = {
    steps,
    index: 0,
    onFinish: options.onFinish,
    cleanup: () => {
      card.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
      overlay.remove();
      spotlight.remove();
      card.remove();
      previouslyFocused?.focus?.();
    },
  };
  render();
}

// ─── Avance del usuario (solo en este navegador) ───────────────────────────

const PROGRESS_KEY = 'agenda-sonrisa:tours';

export function completedTours(): Set<string> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function markTourCompleted(tourId: string): void {
  try {
    const done = completedTours();
    done.add(tourId);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...done]));
  } catch {
    // Sin almacenamiento (modo privado): el avance simplemente no se recuerda.
  }
}
