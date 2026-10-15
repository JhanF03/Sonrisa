/**
 * Genera frontend/core/iconSet.ts con los íconos que usa la interfaz
 * (Phosphor Icons, estilo duotono, licencia MIT). Solo se incluyen los
 * íconos de esta lista, así el paquete pesa poco y no se carga nada externo.
 *
 * Uso: node scripts/build-icons.mjs   (después de agregar un ícono a la lista)
 * La interfaz los pide por un nombre propio ("calendar-days") que se traduce
 * al nombre de Phosphor ("calendar").
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ICONS = {
  activity: 'pulse', 'arrow-down-up': 'arrows-down-up', 'arrow-right': 'arrow-right', 'badge-check': 'seal-check', ban: 'prohibit',
  bell: 'bell', 'bell-ring': 'bell-ringing', 'book-open': 'book-open', boxes: 'stack', 'building-2': 'buildings', calculator: 'calculator',
  calendar: 'calendar-blank', 'calendar-clock': 'calendar-dots', 'calendar-days': 'calendar', 'calendar-plus': 'calendar-plus', 'calendar-x': 'calendar-x',
  'chart-column': 'chart-bar', check: 'check', 'check-check': 'checks', 'chevron-down': 'caret-down', 'chevron-left': 'caret-left', 'chevron-right': 'caret-right',
  'circle-check-big': 'check-circle', 'circle-dollar-sign': 'currency-circle-dollar', 'circle-help': 'question', 'circle-play': 'play-circle', 'circle-x': 'x-circle',
  'clipboard-list': 'clipboard-text', clock: 'clock', coins: 'coins', copy: 'copy', 'credit-card': 'credit-card', crown: 'crown-simple', download: 'download-simple',
  ellipsis: 'dots-three', 'external-link': 'arrow-square-out', eye: 'eye', 'file-spreadsheet': 'file-xls', 'file-text': 'file-text', 'file-up': 'file-arrow-up',
  filter: 'funnel', gift: 'gift', 'graduation-cap': 'graduation-cap', 'hand-coins': 'hand-coins', hourglass: 'hourglass-medium', info: 'info', 'key-round': 'key',
  'layout-dashboard': 'squares-four', 'life-buoy': 'lifebuoy', link: 'link', 'list-checks': 'list-checks', lock: 'lock', 'log-in': 'sign-in', 'log-out': 'sign-out',
  'map-pin': 'map-pin', menu: 'list', 'message-circle': 'whatsapp-logo', 'message-square-text': 'chat-text', minus: 'minus', moon: 'moon', mouse: 'mouse',
  package: 'package', palette: 'palette', pencil: 'pencil-simple', phone: 'phone', 'plug-zap': 'plugs-connected', plus: 'plus', printer: 'printer',
  receipt: 'receipt', 'refresh-cw': 'arrows-clockwise', repeat: 'repeat', rocket: 'rocket-launch', scale: 'scales', 'scroll-text': 'scroll', search: 'magnifying-glass',
  send: 'paper-plane-tilt', settings: 'gear-six', shield: 'shield', 'shield-check': 'shield-check', smartphone: 'device-mobile', smile: 'smiley', sparkles: 'sparkle',
  stethoscope: 'stethoscope', store: 'storefront', sun: 'sun', 'trash-2': 'trash', 'trending-up': 'trend-up', 'triangle-alert': 'warning', truck: 'truck',
  'undo-2': 'arrow-u-up-left', user: 'user', 'user-check': 'user-check', 'user-plus': 'user-plus', 'user-x': 'user-minus', users: 'users', wallet: 'wallet',
  webhook: 'webhooks-logo', x: 'x', tooth: 'tooth', image: 'image', mail: 'envelope-simple', 'mail-check': 'envelope-simple-open', gavel: 'gavel',
};

const entries = Object.entries(ICONS).map(([name, phosphor]) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- lista fija de íconos de este archivo
  const svg = readFileSync(new URL(`../node_modules/@phosphor-icons/core/assets/duotone/${phosphor}-duotone.svg`, import.meta.url), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+/g, ' ').trim();
  return `  '${name}': '${inner.replace(/'/g, "\\'")}',`;
});

// eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta fija del proyecto
writeFileSync(
  new URL('../frontend/core/iconSet.ts', import.meta.url),
  `/* Generado por scripts/build-icons.mjs — no editar a mano. Íconos: Phosphor Icons (MIT), estilo duotono. */\nexport const ICON_SET: Record<string, string> = {\n${entries.join('\n')}\n};\n`,
);
console.log(`✔ ${entries.length} íconos`);
