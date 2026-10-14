/**
 * Estructura del panel: menú lateral filtrado por permisos, barra superior y
 * enrutador por hash (#/agenda, #/pacientes/123…).
 */
import { api, setSuspendedHandler, setUnauthorizedHandler } from '../core/api.js';
import { $, html, raw, readForm, safeUrl, setContent, type SafeHtml } from '../core/dom.js';
import { applyBrandColor, icon, openFormModal, refreshIcons, themeToggleButton, toast } from '../core/ui.js';
import { renderLogin } from './login.js';
import { can, loadSession, session } from './session.js';
import { renderSubscriptionView, renderSuspendedScreen, subscriptionBanner } from './subscription.js';
import { maybeShowWelcome, openContextHelp, renderHelpView, VIEW_RENDERED_EVENT } from './help/helpCenter.js';
import { renderAgendaView } from './views/agendaView.js';
import { renderAuditView } from './views/auditView.js';
import { renderCashView } from './views/cashView.js';
import { renderEInvoicesView } from './views/einvoicesView.js';
import { renderInventoryView } from './views/inventoryView.js';
import { renderPurchasesView } from './views/purchasesView.js';
import { renderOnlinePaymentsView } from './views/onlinePaymentsView.js';
import { renderPatientsView } from './views/patientsView.js';
import { renderReceivablesView } from './views/receivablesView.js';
import { renderRemindersView } from './views/remindersView.js';
import { renderReportsView } from './views/reportsView.js';
import { renderServicesView } from './views/servicesView.js';
import { renderSettingsView } from './views/settingsView.js';
import { renderUsersView } from './views/usersView.js';

export type ViewRenderer = (container: HTMLElement, params: string[]) => Promise<void> | void;

interface NavItem {
  path: string;
  label: string;
  iconName: string;
  tooltip: string;
  permissions: string[];
  section: 'Día a día' | 'Finanzas' | 'Administración';
  render: ViewRenderer;
}

const NAV_ITEMS: NavItem[] = [
  { path: 'agenda', label: 'Agenda', iconName: 'calendar-days', tooltip: 'Citas del día por profesional', permissions: ['agenda.ver_todas', 'agenda.ver_propia'], section: 'Día a día', render: renderAgendaView },
  { path: 'recordatorios', label: 'Recordatorios', iconName: 'bell-ring', tooltip: 'Confirmaciones y verificaciones por WhatsApp, reactivación y lista de espera', permissions: ['recordatorios.gestionar', 'agenda.verificar'], section: 'Día a día', render: renderRemindersView },
  { path: 'pacientes', label: 'Pacientes', iconName: 'users', tooltip: 'Directorio, historial y estado de cuenta', permissions: ['pacientes.ver'], section: 'Día a día', render: renderPatientsView },
  { path: 'caja', label: 'Caja', iconName: 'wallet', tooltip: 'Pagos, recibos y cierre del día', permissions: ['caja.recaudo.ver', 'caja.recaudo.crear', 'caja.cierre.ver'], section: 'Finanzas', render: renderCashView },
  { path: 'pagos-en-linea', label: 'Pagos en línea', iconName: 'credit-card', tooltip: 'Anticipos pagados con Wompi y alertas', permissions: ['pagos.ver'], section: 'Finanzas', render: renderOnlinePaymentsView },
  { path: 'cartera', label: 'Cartera', iconName: 'hand-coins', tooltip: 'Quién debe y desde cuándo', permissions: ['cartera.ver'], section: 'Finanzas', render: renderReceivablesView },
  { path: 'facturacion', label: 'Facturación', iconName: 'file-text', tooltip: 'Facturas electrónicas de venta y proveedor DIAN', permissions: ['facturacion.ver', 'facturacion.configurar'], section: 'Finanzas', render: renderEInvoicesView },
  { path: 'compras', label: 'Compras', iconName: 'truck', tooltip: 'Facturas de proveedores, cuentas por pagar y proveedores', permissions: ['compras.ver', 'compras.gestionar'], section: 'Finanzas', render: renderPurchasesView },
  { path: 'indicadores', label: 'Indicadores', iconName: 'chart-column', tooltip: 'Resultados del mes', permissions: ['reportes.ver'], section: 'Finanzas', render: renderReportsView },
  { path: 'servicios', label: 'Servicios', iconName: 'stethoscope', tooltip: 'Catálogo, precios y duración', permissions: ['servicios.ver', 'servicios.gestionar'], section: 'Administración', render: renderServicesView },
  { path: 'inventario', label: 'Inventario', iconName: 'package', tooltip: 'Insumos, existencias, movimientos y costo por servicio', permissions: ['inventario.ver'], section: 'Administración', render: renderInventoryView },
  { path: 'configuracion', label: 'Configuración', iconName: 'settings', tooltip: 'Consultorio, profesionales, horarios y bloqueos', permissions: ['configuracion.consultorio', 'configuracion.profesionales', 'agenda.bloquear', 'pagos.configurar'], section: 'Administración', render: renderSettingsView },
  { path: 'suscripcion', label: 'Mi suscripción', iconName: 'badge-check', tooltip: 'Estado y pago de Agenda Sonrisa', permissions: ['suscripcion.pagar'], section: 'Administración', render: renderSubscriptionView },
  { path: 'usuarios', label: 'Usuarios y roles', iconName: 'shield-check', tooltip: 'Accesos y permisos granulares', permissions: ['usuarios.gestionar', 'roles.gestionar'], section: 'Administración', render: renderUsersView },
  { path: 'auditoria', label: 'Auditoría', iconName: 'scroll-text', tooltip: 'Quién hizo qué y cuándo', permissions: ['auditoria.ver'], section: 'Administración', render: renderAuditView },
  { path: 'ayuda', label: 'Aprende a usarlo', iconName: 'graduation-cap', tooltip: 'Guías paso a paso y recorridos guiados de cada módulo', permissions: [], section: 'Administración', render: renderHelpView },
];

let appRoot: HTMLElement;
let isShellListenerAttached = false;

export async function startAdminApp(root: HTMLElement): Promise<void> {
  appRoot = root;

  if (window.location.pathname !== '/app') window.history.replaceState(null, '', `/app${window.location.hash}`);

  const sessionInfo = await loadSession();
  if (!sessionInfo) {
    renderLogin(root, () => void startAdminApp(root));
    return;
  }

  // Solo después de tener sesión: un 401 posterior significa que expiró.
  setUnauthorizedHandler(() => {
    setUnauthorizedHandler(() => undefined);
    toast('Tu sesión expiró. Ingresa de nuevo.', 'info');
    renderLogin(appRoot, () => void startAdminApp(appRoot));
  });
  applyBrandColor(sessionInfo.clinic.brandColor);

  // Sin pago: en vez del panel se muestra cómo reactivar el acceso.
  const showSuspended = () =>
    renderSuspendedScreen(
      root,
      async () => {
        isShellListenerAttached = false;
        await startAdminApp(root);
      },
      async () => {
        await api.post('/api/auth/logout');
        window.location.hash = '';
        await startAdminApp(root);
      },
    );
  setSuspendedHandler(() => void startAdminApp(root));
  if (sessionInfo.subscription.blocked) {
    root.onclick = null;
    await showSuspended();
    return;
  }
  root.onclick = null;
  renderShell();
  window.setTimeout(maybeShowWelcome, 600);
  window.removeEventListener('hashchange', handleRoute);
  window.addEventListener('hashchange', handleRoute);
  await handleRoute();
}

function allowedNavItems(): NavItem[] {
  return NAV_ITEMS.filter((item) => item.permissions.length === 0 || can(...item.permissions));
}

function renderShell(): void {
  const { user, clinic } = session();
  const initials = user.fullName.split(' ').slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
  const sections = ['Día a día', 'Finanzas', 'Administración'] as const;

  const navMarkup: SafeHtml[] = sections.flatMap((section) => {
    const items = allowedNavItems().filter((item) => item.section === section);
    if (items.length === 0) return [];
    return [
      html`<div class="nav-section">${section}</div>`,
      ...items.map(
        (item) => html`<a class="nav-link" href="#/${item.path}" data-nav="${item.path}" data-tooltip="${item.tooltip}" data-tooltip-position="right">
          ${icon(item.iconName)}<span>${item.label}</span></a>`,
      ),
    ];
  });

  setContent(
    appRoot,
    html`${clinic.isShowcase
        ? html`<div class="showcase-banner">${icon('sparkles')} Esta es una demostración con datos ficticios. Explora con libertad: nada de lo que hagas afecta a pacientes reales.</div>`
        : ''}
      ${subscriptionBanner() ?? ''}
      <div class="shell" id="shell">
        <aside class="sidebar" aria-label="Menú principal">
          <div class="brand">
            <span class="brand-mark">${clinic.logoUrl ? html`<img src="${safeUrl(clinic.logoUrl, ['https:'])}" alt="" referrerpolicy="no-referrer" />` : icon('smile')}</span>
            <div><div class="brand-name">${clinic.name}</div><div class="brand-product">Agenda Sonrisa</div></div>
          </div>
          <nav>${navMarkup}</nav>
          <div class="sidebar-footer">
            <a class="nav-link" href="/c/${clinic.slug}" target="_blank" rel="noopener" data-tooltip="Página donde tus pacientes reservan solos" data-tooltip-position="right">
              ${icon('external-link')}<span>Página de reservas</span></a>
            <div class="user-chip"><span class="avatar">${initials}</span><div><strong>${user.fullName}</strong><div class="subtle">${user.email}</div></div></div>
            <div class="button-row">
              <button class="button button-ghost button-small" type="button" data-action="change-password">${icon('key-round')} Clave</button>
              <button class="button button-ghost button-small" type="button" data-action="logout">${icon('log-out')} Salir</button>
            </div>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="topbar-title">
              <button class="icon-button menu-button" type="button" data-action="toggle-menu" aria-label="Abrir menú">${icon('menu')}</button>
              <span id="view-title"></span>
            </div>
            <div class="topbar-actions" id="topbar-actions">
              <button class="icon-button" type="button" data-action="open-help" aria-label="Ayuda de esta pantalla" data-tooltip="¿Cómo se usa esta pantalla?" data-tooltip-position="bottom">${icon('circle-help')}</button>
              ${themeToggleButton()}</div>
          </header>
          <main class="content" id="view-container"></main>
        </div>
      </div>`,
  );
  refreshIcons(appRoot);

  if (isShellListenerAttached) return;
  isShellListenerAttached = true;
  appRoot.addEventListener('click', async (event) => {
    const target = event.target as Element;
    if (target.closest('[data-action="toggle-menu"]')) $('#shell').classList.toggle('nav-open');
    if (target.closest('.nav-link')) $('#shell').classList.remove('nav-open');
    if (target.closest('[data-action="logout"]')) {
      await api.post('/api/auth/logout');
      window.location.hash = '';
      await startAdminApp(appRoot);
    }
    if (target.closest('[data-action="change-password"]')) openChangePasswordModal();
    if (target.closest('[data-action="open-help"]')) openContextHelp();
  });
}

async function handleRoute(): Promise<void> {
  const [viewPath = '', ...params] = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const items = allowedNavItems();
  const item = items.find((candidate) => candidate.path === viewPath) ?? items[0];
  const container = document.getElementById('view-container');
  if (!container) return;

  if (!item) {
    setContent(container, html`<div class="card card-padded">${raw('<p>Tu usuario no tiene módulos asignados. Pide a un administrador que te asigne un rol.</p>')}</div>`);
    return;
  }
  if (item.path !== viewPath) {
    window.history.replaceState(null, '', `#/${item.path}`);
  }

  document.querySelectorAll('.nav-link[data-nav]').forEach((link) => {
    link.classList.toggle('is-active', link.getAttribute('data-nav') === item.path);
  });
  setContent($('#view-title'), html`${icon(item.iconName)}${item.label}`);
  document.title = `${item.label} · ${session().clinic.name}`;
  refreshIcons($('#view-title'));

  try {
    await item.render(container, params);
    refreshIcons(container);
    document.dispatchEvent(new CustomEvent(VIEW_RENDERED_EVENT, { detail: item.path }));
  } catch (error) {
    setContent(container, html`<div class="card card-padded form-error">${error instanceof Error ? error.message : 'No se pudo cargar.'}</div>`);
  }
}

/** Vuelve a dibujar la vista actual (tras guardar cambios). */
export function reloadCurrentView(): Promise<void> {
  return handleRoute();
}

function openChangePasswordModal(): void {
  openFormModal({
    title: 'Cambiar mi contraseña',
    iconName: 'key-round',
    submitLabel: 'Guardar',
    fields: html`
      <label class="field"><span>Contraseña actual</span><input type="password" name="currentPassword" required autocomplete="current-password" /></label>
      <label class="field"><span>Nueva contraseña</span><input type="password" name="newPassword" required minlength="10" autocomplete="new-password" />
        <small class="field-hint">Mínimo 10 caracteres, con letras y números.</small></label>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      await api.post('/api/auth/change-password', values);
      toast('Contraseña actualizada.', 'success');
    },
  });
}
