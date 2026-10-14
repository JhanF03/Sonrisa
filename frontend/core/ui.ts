/**
 * Componentes de interfaz reutilizables: íconos, tema día/noche,
 * notificaciones, ventanas modales y confirmaciones.
 */
import {
  Activity, Ban, Bell, BellRing, Building2, Calendar, CalendarClock, CalendarDays, CalendarPlus, CalendarX, ChartColumn,
  Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleCheckBig, CircleDollarSign, CircleHelp, ClipboardList,
  Clock, Coins, Copy, createIcons, CreditCard, Download, ExternalLink, Eye, FileSpreadsheet, Filter, HandCoins, Hourglass, Info,
  KeyRound, Link, ListChecks, Lock, LogOut, MapPin, Menu, MessageCircle, Moon, Palette, Pencil, Phone, Plus, Printer,
  Receipt, RefreshCw, Repeat, ScrollText, Search, Settings, ShieldCheck, Smile, Sparkles, Stethoscope, Store, Sun, Trash2,
  TrendingUp, TriangleAlert, Undo2, User, UserCheck, UserPlus, Users, UserX, Wallet, X,
  MessageSquareText, Send, Webhook, PlugZap, Shield,
  Package, Truck, FileUp, Boxes, ArrowDownUp, Calculator, Scale, FileText,
  ArrowRight, CircleX, LogIn, GraduationCap, LifeBuoy, BookOpen, CirclePlay, BadgeCheck, LayoutDashboard, Ellipsis, Mouse, Smartphone,
  Gift, Rocket, Crown, Minus,
} from 'lucide';
import { $, html, safeUrl, setContent, type SafeHtml } from './dom.js';
import { whatsappLink } from './format.js';

const ICONS = {
  Activity, Ban, Bell, BellRing, Building2, Calendar, CalendarClock, CalendarDays, CalendarPlus, CalendarX, ChartColumn,
  Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleCheckBig, CircleDollarSign, CircleHelp, ClipboardList,
  Clock, Coins, Copy, CreditCard, Download, ExternalLink, Eye, FileSpreadsheet, Filter, HandCoins, Hourglass, Info, KeyRound, Link,
  ListChecks, Lock, LogOut, MapPin, Menu, MessageCircle, Moon, Palette, Pencil, Phone, Plus, Printer, Receipt, RefreshCw,
  Repeat, ScrollText, Search, Settings, ShieldCheck, Smile, Sparkles, Stethoscope, Store, Sun, Trash2, TrendingUp,
  TriangleAlert, Undo2, User, UserCheck, UserPlus, Users, UserX, Wallet, X,
  MessageSquareText, Send, Webhook, PlugZap, Shield,
  Package, Truck, FileUp, Boxes, ArrowDownUp, Calculator, Scale, FileText,
  ArrowRight, CircleX, LogIn, GraduationCap, LifeBuoy, BookOpen, CirclePlay, BadgeCheck, LayoutDashboard, Ellipsis, Mouse, Smartphone,
  Gift, Rocket, Crown, Minus,
};

/** Reemplaza los <i data-lucide="nombre"> por sus SVG. */
export function refreshIcons(root?: Element): void {
  createIcons({ icons: ICONS, attrs: { 'stroke-width': '1.75', 'aria-hidden': 'true' }, root });
}

/** Ícono inline para usar dentro de plantillas `html`. */
export const icon = (name: string) => html`<i data-lucide="${name}"></i>`;

// ─── Tema día / noche ───────────────────────────────────────────────────────

const THEME_STORAGE_KEY = 'agenda.theme';

export function toggleTheme(): void {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    /* sin persistencia disponible */
  }
}

export function themeToggleButton(): SafeHtml {
  return html`<button class="icon-button" type="button" data-action="toggle-theme" aria-label="Cambiar entre modo día y noche" data-tooltip="Modo día / noche" data-tooltip-position="bottom">
    ${icon('moon')}<span class="theme-sun">${icon('sun')}</span>
  </button>`;
}

document.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-action="toggle-theme"]')) toggleTheme();
});

/** Aplica el color de marca del consultorio a la interfaz. */
export function applyBrandColor(hexColor: string | null | undefined): void {
  if (hexColor && /^#[0-9a-fA-F]{6}$/.test(hexColor)) {
    document.documentElement.style.setProperty('--brand', hexColor);
  }
}

// ─── Notificaciones ─────────────────────────────────────────────────────────

export function toast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const iconName = { success: 'circle-check-big', error: 'triangle-alert', info: 'info' }[type];
  const element = document.createElement('div');
  element.className = `toast toast-${type}`;
  setContent(element, html`${icon(iconName)}<span>${message}</span>`);
  region.append(element);
  refreshIcons(element);
  window.setTimeout(() => {
    element.classList.add('is-leaving');
    window.setTimeout(() => element.remove(), 250);
  }, type === 'error' ? 6000 : 3500);
}

/** Ejecuta una acción mostrando el error como notificación si falla. */
export async function withErrorToast<TResult>(action: () => Promise<TResult>): Promise<TResult | undefined> {
  try {
    return await action();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Ocurrió un error.', 'error');
    return undefined;
  }
}

// ─── Modales ────────────────────────────────────────────────────────────────

export interface ModalHandle {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  close: () => void;
}

export function openModal(options: { title: string; iconName?: string; content: SafeHtml; size?: 'normal' | 'wide' }): ModalHandle {
  const dialog = document.createElement('dialog');
  dialog.className = `modal ${options.size === 'wide' ? 'modal-wide' : ''}`;
  setContent(
    dialog,
    html`<div class="modal-header">
        <h2>${options.iconName ? icon(options.iconName) : ''}${options.title}</h2>
        <button class="icon-button" type="button" data-close-modal aria-label="Cerrar">${icon('x')}</button>
      </div>
      <div class="modal-body">${options.content}</div>`,
  );
  document.body.append(dialog);
  refreshIcons(dialog);

  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || (event.target as Element).closest('[data-close-modal]')) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.showModal();
  dialog.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea')?.focus();
  return { dialog, body: $('.modal-body', dialog), close };
}

/**
 * Modal con formulario. `onSubmit` recibe el formulario; si lanza error se
 * muestra en el mismo modal sin cerrarlo.
 */
export function openFormModal(options: {
  title: string;
  iconName?: string;
  fields: SafeHtml;
  submitLabel: string;
  size?: 'normal' | 'wide';
  danger?: boolean;
  onSubmit: (form: HTMLFormElement) => Promise<void>;
}): ModalHandle {
  const modal = openModal({
    title: options.title,
    iconName: options.iconName,
    size: options.size,
    content: html`<form class="form" novalidate>
      ${options.fields}
      <p class="form-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button type="button" class="button button-ghost" data-close-modal>Cancelar</button>
        <button type="submit" class="button ${options.danger ? 'button-danger' : 'button-primary'}">${options.submitLabel}</button>
      </div>
    </form>`,
  });

  const form = modal.body.querySelector('form') as HTMLFormElement;
  const errorElement = $('.form-error', form);
  const submitButton = form.querySelector<HTMLButtonElement>('button[type=submit]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    if (submitButton) submitButton.disabled = true;
    try {
      await options.onSubmit(form);
      modal.close();
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
  return modal;
}

/** Confirmación con motivo obligatorio (para anulaciones y cancelaciones). */
export function askReason(options: { title: string; message: string; confirmLabel: string; onConfirm: (reason: string) => Promise<void> }): void {
  openFormModal({
    title: options.title,
    iconName: 'triangle-alert',
    danger: true,
    submitLabel: options.confirmLabel,
    fields: html`<p class="muted">${options.message}</p>
      <label class="field"><span>Motivo</span>
        <textarea name="reason" required maxlength="200" rows="2" placeholder="Escribe el motivo (queda en la auditoría)"></textarea>
      </label>`,
    onSubmit: async (form) => {
      const reason = (new FormData(form).get('reason') as string).trim();
      if (!reason) throw new Error('El motivo es obligatorio.');
      await options.onConfirm(reason);
    },
  });
}

export async function copyToClipboard(text: string, successMessage = 'Copiado.'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage, 'success');
  } catch {
    toast('No se pudo copiar. Selecciona el texto y cópialo manualmente.', 'error');
  }
}

/**
 * Botón de WhatsApp. Si el número no es un celular, muestra el botón
 * deshabilitado con la explicación (evita abrir chats que fallarán).
 */
export function whatsappButton(
  phone: string | null | undefined,
  message: string,
  options: { label?: string; variant?: 'button' | 'small' | 'icon'; tooltip?: string } = {},
): SafeHtml {
  const link = whatsappLink(phone, message);
  const variant = options.variant ?? 'button';
  const className = variant === 'icon' ? 'icon-button' : `button button-whatsapp ${variant === 'small' ? 'button-small' : ''}`;
  const content = variant === 'icon' ? icon('message-circle') : html`${icon('message-circle')} ${options.label ?? 'WhatsApp'}`;
  if (!link) {
    return html`<span class="${className} is-disabled" aria-disabled="true" tabindex="0"
      data-tooltip="${phone ? 'Este número no es un celular: no puede recibir WhatsApp.' : 'Sin número de celular.'}">${content}</span>`;
  }
  return html`<a class="${className}" href="${safeUrl(link, ['https:'])}" target="_blank" rel="noopener"
    ${options.tooltip ? html`data-tooltip="${options.tooltip}"` : ''} aria-label="${options.label ?? 'WhatsApp'}">${content}</a>`;
}

export function emptyState(iconName: string, title: string, description: string): SafeHtml {
  return html`<div class="empty-state">${icon(iconName)}<h3>${title}</h3><p>${description}</p></div>`;
}

export function loadingState(message = 'Cargando…'): SafeHtml {
  return html`<div class="loading-state"><span class="spinner" aria-hidden="true"></span>${message}</div>`;
}
