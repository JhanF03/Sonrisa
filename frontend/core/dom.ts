/**
 * Utilidades de DOM seguras.
 *
 * `html` es una plantilla etiquetada que ESCAPA todo valor interpolado.
 * Para insertar HTML ya construido (otro `html`), se usa `raw()`.
 * Así es imposible inyectar HTML por olvido (protección XSS por defecto).
 */

const SAFE_HTML = Symbol('safeHtml');

export interface SafeHtml {
  readonly [SAFE_HTML]: true;
  readonly value: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

export function raw(value: string): SafeHtml {
  return { [SAFE_HTML]: true, value };
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && SAFE_HTML in value;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (isSafeHtml(value)) return value.value;
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let result = strings[0];
  values.forEach((value, index) => {
    result += renderValue(value) + strings[index + 1];
  });
  return raw(result);
}

/** Solo permite URLs http(s), tel: y relativas; todo lo demás se descarta. */
export function safeUrl(url: string | null | undefined, allowedProtocols = ['http:', 'https:', 'tel:']): string {
  if (!url) return '#';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return allowedProtocols.includes(parsed.protocol) ? parsed.href : '#';
  } catch {
    return '#';
  }
}

export function setContent(element: Element, content: SafeHtml): void {
  element.innerHTML = content.value;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`No se encontró el elemento ${selector}`);
  return element;
}

export function $all<TElement extends Element = HTMLElement>(selector: string, root: ParentNode = document): TElement[] {
  return [...root.querySelectorAll<TElement>(selector)];
}

/** Lee un formulario como objeto plano de strings. */
export function readForm(form: HTMLFormElement): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value.trim() : '';
  }
  return data;
}

export function emptyToNull(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

export function debounce<TArgs extends unknown[]>(callback: (...args: TArgs) => void, waitMs: number) {
  let timeoutId: number | undefined;
  return (...args: TArgs) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), waitMs);
  };
}
