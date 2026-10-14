/**
 * Demo de autoservicio: aviso fijo con los días que quedan y un recordatorio
 * (una vez al día) que invita a crear el consultorio con la prueba gratis.
 * Las demos que crea el dueño sin vencimiento solo muestran el aviso de datos ficticios.
 */
import { html, type SafeHtml } from '../core/dom.js';
import { formatLongDate } from '../core/format.js';
import { icon, openModal } from '../core/ui.js';
import { session } from './session.js';

const DAY_MS = 86_400_000;
const REMINDER_KEY = 'agenda.demoReminder';

function daysLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / DAY_MS));
}

const daysText = (days: number) => (days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`);

export function demoBanner(): SafeHtml {
  const demo = session().demo;
  if (!demo?.expiresAt) {
    return html`<div class="showcase-banner">${icon('sparkles')} Esta es una demostración con datos ficticios. Explora con libertad: nada de lo que hagas afecta a pacientes reales.</div>`;
  }
  const expiresOn = formatLongDate(demo.expiresAt.slice(0, 10));
  if (demo.convertedTenantId) {
    return html`<div class="demo-banner">${icon('circle-check-big')} Ya creaste tu consultorio. Esta demo se cierra el <strong>${expiresOn}</strong>.
      <span>Entra a tu consultorio con tu correo y contraseña.</span></div>`;
  }
  return html`<div class="demo-banner">${icon('sparkles')}
    <span>Demo con datos ficticios · vence <strong>${daysText(daysLeft(demo.expiresAt))}</strong> (${expiresOn}). Tu usuario: <code>${demo.loginEmail}</code></span>
    <a class="button button-primary button-small" href="/registro">${icon('rocket')} Crear mi consultorio gratis</a></div>`;
}

/** Muestra el recordatorio una vez por día. Devuelve true si lo mostró. */
export function maybeShowDemoReminder(): boolean {
  const demo = session().demo;
  if (!demo?.expiresAt || demo.convertedTenantId) return false;
  const todayKey = `${session().clinic.id}:${new Date().toISOString().slice(0, 10)}`;
  try {
    if (localStorage.getItem(REMINDER_KEY) === todayKey) return false;
    localStorage.setItem(REMINDER_KEY, todayKey);
  } catch {
    /* sin almacenamiento: se muestra igual */
  }
  const days = daysLeft(demo.expiresAt);
  openModal({
    title: days <= 1 ? 'Tu demo termina pronto' : `Te quedan ${days} días de demo`,
    iconName: 'hourglass',
    content: html`<p>Esta demo tiene datos ficticios y se borra <strong>${daysText(days)}</strong> (${formatLongDate(demo.expiresAt.slice(0, 10))}).</p>
      <p class="muted">Cuando te convenza, crea tu consultorio real: empieza vacío, con prueba gratis, y eliges el plan que necesitas. Tu demo seguirá abierta 24 horas más.</p>
      <p class="subtle">${icon('info')} Para volver a la demo entra con <code>${demo.loginEmail}</code> y tu contraseña.</p>
      <div class="modal-actions">
        <button type="button" class="button button-ghost" data-close-modal>Seguir explorando</button>
        <a class="button button-primary" href="/registro">${icon('rocket')} Crear mi consultorio</a>
      </div>`,
  });
  return true;
}
