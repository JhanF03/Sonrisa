/**
 * Panel del dueño (plataforma.html → assets/platform.js).
 * Aplicación independiente de la de los consultorios: su propio HTML, su
 * propio paquete y su propio ingreso (correo + contraseña + 2 pasos).
 *
 * Rutas (hash): #/resumen · #/consultorios · #/demos · #/crear · #/planes ·
 * #/configuracion · #/correos · #/auditoria · #/cuenta · #/recuperar
 */
import { logoTooth } from '../core/brand.js';
import { api, ApiError } from '../core/api.js';
import { $, html, setContent } from '../core/dom.js';
import { icon, loadingState, refreshIcons, themeToggleButton } from '../core/ui.js';
import { renderLogin, renderRecover, renderSetup } from './auth/authViews.js';
import type { PlatformAdmin } from './types.js';
import { renderAccountView } from './views/accountView.js';
import { renderAuditView } from './views/auditView.js';
import { renderClinicsView } from './views/clinicsView.js';
import { renderCreateView } from './views/createView.js';
import { renderEmailLogView } from './views/emailLogView.js';
import { renderPlansView } from './views/plansView.js';
import { renderSettingsView } from './views/settingsView.js';
import { renderSummaryView } from './views/summaryView.js';

interface SessionState {
  authenticated: boolean;
  needsSetup: boolean;
  admin: PlatformAdmin | null;
}

const VIEWS = [
  { id: 'resumen', label: 'Resumen', iconName: 'layout-dashboard' },
  { id: 'consultorios', label: 'Consultorios', iconName: 'building-2' },
  { id: 'demos', label: 'Demos', iconName: 'sparkles' },
  { id: 'crear', label: 'Crear', iconName: 'plus' },
  { id: 'planes', label: 'Planes', iconName: 'crown' },
  { id: 'configuracion', label: 'Configuración', iconName: 'settings' },
  { id: 'correos', label: 'Correos', iconName: 'mail' },
  { id: 'auditoria', label: 'Auditoría', iconName: 'scroll-text' },
  { id: 'cuenta', label: 'Mi cuenta', iconName: 'user' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const root = document.getElementById('root') as HTMLElement;
document.title = 'Plataforma · Agenda Sonrisa';

const currentRoute = () => window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
/** Lo que sigue a la vista en la URL (#/configuracion/correo → ['correo']). */
const routeParams = () => window.location.hash.replace(/^#\/?/, '').split('/').slice(1).filter(Boolean);

async function start(): Promise<void> {
  setContent(root, html`<main class="public-page">${loadingState()}</main>`);
  const state = await api.get<SessionState>('/api/platform/session').catch(() => ({ authenticated: false, needsSetup: false, admin: null }));
  if (state.needsSetup) return renderSetup(root, start);
  if (!state.authenticated || !state.admin) {
    return currentRoute() === 'recuperar' ? renderRecover(root, start) : renderLogin(root, start);
  }
  if (currentRoute() === 'recuperar' || !currentRoute()) window.history.replaceState(null, '', '#/resumen');
  return renderPanel(state.admin);
}

async function renderPanel(admin: PlatformAdmin): Promise<void> {
  const viewId = (VIEWS.find((view) => view.id === currentRoute())?.id ?? 'resumen') as ViewId;
  setContent(
    root,
    html`<main class="public-page platform-page">
      <header class="public-header">
        <div class="brand"><span class="brand-mark">${logoTooth()}</span><div><div class="brand-name">Panel del dueño</div><div class="brand-product">${admin.fullName}</div></div></div>
        <div class="button-row">${themeToggleButton()}<button class="button button-ghost button-small" data-action="logout">${icon('log-out')} Salir</button></div>
      </header>
      ${admin.twoFactorEnabled ? '' : html`<a class="platform-notice" href="#/cuenta">${icon('shield-check')} Protege tu cuenta: activa la verificación en dos pasos.</a>`}
      <nav class="tabs tabs-scroll" aria-label="Secciones">${VIEWS.map(
        (view) => html`<a class="tab ${view.id === viewId ? 'is-active' : ''}" href="#/${view.id}">${icon(view.iconName)} ${view.label}</a>`,
      )}</nav>
      <div data-content>${loadingState()}</div>
    </main>`,
  );
  refreshIcons(root);
  const content = $('[data-content]', root);
  const reload = () => renderPanel(admin);
  try {
    if (viewId === 'resumen') await renderSummaryView(content);
    else if (viewId === 'consultorios') await renderClinicsView(content, reload, false);
    else if (viewId === 'demos') await renderClinicsView(content, reload, true);
    else if (viewId === 'crear') await renderCreateView(content);
    else if (viewId === 'planes') await renderPlansView(content);
    else if (viewId === 'configuracion') await renderSettingsView(content, reload, routeParams());
    else if (viewId === 'correos') await renderEmailLogView(content);
    else if (viewId === 'auditoria') await renderAuditView(content);
    else await renderAccountView(content, admin, reload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return void start();
    setContent(content, html`<div class="card card-padded form-error">${error instanceof Error ? error.message : 'No se pudo cargar.'}</div>`);
  }
}

root.addEventListener('click', async (event) => {
  if (!(event.target as HTMLElement).closest('[data-action="logout"]')) return;
  await api.post('/api/platform/logout');
  window.location.hash = '';
  await start();
});
window.addEventListener('hashchange', () => void start());

void start();
