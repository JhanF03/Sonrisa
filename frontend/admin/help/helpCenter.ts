/**
 * Centro de aprendizaje (#/ayuda): guías paso a paso por módulo, buscador,
 * avance del usuario y recorridos guiados sobre la pantalla real.
 * También el botón (?) de cada vista y la bienvenida del primer ingreso.
 */
import { $, html, setContent, type SafeHtml } from '../../core/dom.js';
import { icon, openModal, refreshIcons } from '../../core/ui.js';
import { completedTours, markTourCompleted, startTour } from '../../core/tour.js';
import { can, session } from '../session.js';
import { HELP_TOPICS, topicForPath, type HelpSection, type HelpTopic } from './helpContent.js';

export const VIEW_RENDERED_EVENT = 'agenda-sonrisa:view-rendered';
const WELCOME_KEY = 'agenda-sonrisa:welcome-dismissed';

let searchText = '';

export function allowedTopics(): HelpTopic[] {
  return HELP_TOPICS.filter((topic) => topic.permissions.length === 0 || can(...topic.permissions));
}

function sectionMarkup(section: HelpSection): SafeHtml {
  const iconName = section.kind === 'pasos' ? 'list-checks' : section.kind === 'botones' ? 'mouse' : 'sparkles';
  const items = section.items.map((item) => html`<li>${item}</li>`);
  return html`<section class="help-section help-${section.kind}">
    <h3>${icon(iconName)} ${section.title}</h3>
    ${section.kind === 'pasos' ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`}
  </section>`;
}

/** Inicia el recorrido de un tema; si es de otra pantalla, primero navega. */
export function startTopicTour(topic: HelpTopic): void {
  const run = (): void => {
    window.setTimeout(
      () =>
        startTour(topic.tour, {
          onFinish: (completed) => {
            if (completed) markTourCompleted(topic.id);
          },
        }),
      150,
    );
  };
  const currentPath = window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  if (!topic.path || topic.path === currentPath) return run();
  const onRendered = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== topic.path) return;
    document.removeEventListener(VIEW_RENDERED_EVENT, onRendered);
    run();
  };
  document.addEventListener(VIEW_RENDERED_EVENT, onRendered);
  window.location.hash = `#/${topic.path}`;
}

export async function renderHelpView(container: HTMLElement, params: string[] = []): Promise<void> {
  const topics = allowedTopics();
  const done = completedTours();
  const selected = topics.find((topic) => topic.id === params[0]) ?? topics[0];
  if (!selected) return;
  const completedCount = topics.filter((topic) => done.has(topic.id)).length;
  const percent = Math.round((completedCount / topics.length) * 100);

  const matches = (topic: HelpTopic) => {
    const query = searchText.trim().toLowerCase();
    if (!query) return true;
    return [topic.title, topic.summary, ...topic.sections.flatMap((section) => [section.title, ...section.items])].join(' ').toLowerCase().includes(query);
  };

  setContent(
    container,
    html`<div class="help-layout">
      <aside class="card help-index">
        <div class="help-progress">
          <strong>${icon('graduation-cap')} Tu avance</strong>
          <div class="progress-bar" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width: ${percent}%"></span></div>
          <small class="subtle">${completedCount} de ${topics.length} recorridos completados</small>
        </div>
        <div class="search-input">${icon('search')}<input type="search" data-help-search placeholder="¿Qué quieres aprender?" value="${searchText}" aria-label="Buscar en la ayuda" /></div>
        <nav class="help-topics">${topics.filter(matches).map((topic) => html`<a href="#/ayuda/${topic.id}" class="help-topic ${topic.id === selected.id ? 'is-active' : ''}">
          ${icon(topic.iconName)}<span>${topic.title}</span>${done.has(topic.id) ? html`<span class="help-done" aria-label="Completado">${icon('circle-check-big')}</span>` : ''}</a>`)}</nav>
      </aside>
      <article class="card card-padded help-article">
        <header class="help-article-header">
          <span class="kpi-icon">${icon(selected.iconName)}</span>
          <div><h2>${selected.title}</h2><p class="muted">${selected.summary}</p></div>
        </header>
        <div class="button-row">
          <button class="button button-primary" data-action="start-tour">${icon('circle-play')} ${selected.path ? 'Recorrido guiado en la pantalla' : 'Iniciar recorrido de bienvenida'}</button>
          ${selected.path ? html`<a class="button button-secondary" href="#/${selected.path}">${icon('arrow-right')} Ir a ${selected.title}</a>` : ''}
        </div>
        ${selected.sections.map(sectionMarkup)}
        ${session().clinic.isShowcase
          ? html`<p class="help-practice">${icon('sparkles')} Estás en una demostración: practica sin miedo, nada afecta a pacientes reales.</p>`
          : ''}
      </article>
    </div>`,
  );
  refreshIcons(container);

  const searchInput = container.querySelector<HTMLInputElement>('[data-help-search]');
  searchInput?.addEventListener('input', () => {
    searchText = searchInput.value;
    void renderHelpView(container, params).then(() => {
      const again = container.querySelector<HTMLInputElement>('[data-help-search]');
      again?.focus();
      again?.setSelectionRange(searchText.length, searchText.length);
    });
  });
  container.onclick = (event) => {
    if ((event.target as HTMLElement).closest('[data-action="start-tour"]')) startTopicTour(selected);
  };
}

/** Botón (?) de la barra superior: ayuda de la pantalla actual. */
export function openContextHelp(): void {
  const path = window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  const topic = topicForPath(path) ?? HELP_TOPICS[0];
  if (!topic) return;
  const modal = openModal({
    title: `Ayuda: ${topic.title}`,
    iconName: 'life-buoy',
    size: 'wide',
    content: html`<p class="muted">${topic.summary}</p>
      ${topic.sections.slice(0, 2).map(sectionMarkup)}
      <div class="modal-actions">
        <a class="button button-ghost" href="#/ayuda/${topic.id}" data-close-modal>${icon('book-open')} Guía completa</a>
        <button class="button button-primary" data-action="tour">${icon('circle-play')} Recorrido guiado</button>
      </div>`,
  });
  refreshIcons(modal.body);
  modal.body.querySelector('[data-action="tour"]')?.addEventListener('click', () => {
    modal.close();
    startTopicTour(topic);
  });
}

/** Bienvenida en el primer ingreso (solo una vez por navegador). */
export function maybeShowWelcome(): void {
  let dismissed: boolean;
  try {
    dismissed = localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    dismissed = true;
  }
  if (dismissed || completedTours().has('inicio')) return;
  const remember = () => {
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      // Sin almacenamiento: se volverá a ofrecer en el próximo ingreso.
    }
  };
  const modal = openModal({
    title: `¡Hola, ${session().user.fullName.split(' ')[0]}!`,
    iconName: 'graduation-cap',
    content: html`<p>Te damos la bienvenida a <strong>Agenda Sonrisa</strong>. ¿Quieres un recorrido de un minuto por el panel?</p>
      <p class="subtle">Siempre puedes volver a verlo en <strong>Aprende a usarlo</strong> o con el botón ${icon('circle-help')} de cada pantalla.</p>
      <div class="modal-actions">
        <button class="button button-ghost" data-action="later">Ahora no</button>
        <button class="button button-primary" data-action="tour">${icon('circle-play')} Hacer el recorrido</button>
      </div>`,
  });
  refreshIcons(modal.body);
  $('[data-action="later"]', modal.body).addEventListener('click', () => {
    remember();
    modal.close();
  });
  $('[data-action="tour"]', modal.body).addEventListener('click', () => {
    remember();
    modal.close();
    const welcome = HELP_TOPICS.find((topic) => topic.id === 'inicio');
    if (welcome) startTopicTour(welcome);
  });
}
