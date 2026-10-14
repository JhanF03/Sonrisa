/**
 * Marca de Agenda Sonrisa: un diente dibujado en línea, con la marca roja que
 * se usa en el odontograma. Se usa en el panel, la plataforma y el sitio público.
 */
import { html, raw, type SafeHtml } from './dom.js';

const TOOTH_PATH =
  'M84 36c-29 0-50 22-50 54 0 25 10 43 16 62 7 22 9 46 14 64 4 15 11 24 21 24 15 0 19-19 23-41 3-17 8-33 20-33s17 16 20 33c4 22 8 41 23 41 10 0 17-9 21-24 5-18 7-42 14-64 6-19 16-37 16-62 0-32-21-54-50-54-21 0-31 11-44 11S105 36 84 36Z';

/** Ícono del diente (hereda el color del texto). */
export function logoTooth(): SafeHtml {
  return raw(
    `<svg class="logo-tooth" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path d="${TOOTH_PATH}" fill="none" stroke="currentColor" stroke-width="20" stroke-linejoin="round"/><circle cx="196" cy="62" r="26" fill="#e0454c"/></svg>`,
  );
}

/** Logo completo (marca + nombre). */
export function brandLockup(subtitle = 'Agenda para consultorios odontológicos', href?: string): SafeHtml {
  const content = html`<span class="brand-mark">${logoTooth()}</span><div><div class="brand-name">Agenda Sonrisa</div>${subtitle ? html`<div class="brand-product">${subtitle}</div>` : ''}</div>`;
  return href ? html`<a class="brand" href="${href}">${content}</a>` : html`<div class="brand">${content}</div>`;
}
