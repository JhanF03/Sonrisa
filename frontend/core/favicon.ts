/**
 * Ícono de la pestaña de cada consultorio.
 *
 * El usuario puede subir cualquier imagen (PNG, JPG, WebP o SVG): aquí se
 * recorta al centro en cuadrado y se convierte a un PNG de 64×64 px. Así el
 * archivo siempre es pequeño, con el formato correcto y sin nada ejecutable.
 */
import { html, type SafeHtml } from './dom.js';
import { icon } from './ui.js';

const ICON_SIZE = 64;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];

export const FAVICON_HINT = 'Opcional. Imagen cuadrada de al menos 64 × 64 px (ideal 512 × 512). PNG, JPG, WebP o SVG. Se recorta al centro y se ajusta sola.';

/** Convierte el archivo elegido en un PNG 64×64 (data URL). */
export async function processFaviconFile(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('Usa una imagen PNG, JPG, WebP o SVG.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('La imagen pesa más de 5 MB. Usa una más liviana.');
  // Se lee como data URL (la política de seguridad de la página permite data:, no blob:).
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con otro archivo.'));
    element.src = source;
  });
  const width = image.naturalWidth || ICON_SIZE;
  const height = image.naturalHeight || ICON_SIZE;
  if (Math.min(width, height) < 32 && file.type !== 'image/svg+xml') throw new Error('La imagen es muy pequeña: usa al menos 64 × 64 px.');
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Tu navegador no permite procesar la imagen.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL('image/png');
}

/** Pone el ícono del consultorio en la pestaña (o deja el de Agenda Sonrisa). */
export function applyFavicon(dataUrl: string | null | undefined): void {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return;
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
    link.href = dataUrl;
    if (link.rel === 'icon') link.type = 'image/png';
    link.removeAttribute('sizes');
  });
}

/** Campo del formulario: elegir, ver y quitar el ícono. Guarda el valor en un campo oculto "favicon". */
export function faviconField(current: string | null = null): SafeHtml {
  return html`<div class="field favicon-field" data-favicon-field>
    <span>Ícono de la pestaña <span class="hint" data-tooltip="${FAVICON_HINT}">${icon('info')}</span></span>
    <div class="favicon-picker">
      <span class="favicon-preview" data-favicon-preview>${current ? html`<img src="${current}" alt="Ícono actual" width="32" height="32" />` : icon('image')}</span>
      <label class="button button-secondary button-small">${icon('file-up')} Elegir imagen
        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-favicon-file hidden /></label>
      <button type="button" class="button button-ghost button-small" data-favicon-clear ${current ? '' : 'hidden'}>Quitar</button>
    </div>
    <small class="field-hint">Cuadrada, mínimo 64 × 64 px. PNG, JPG, WebP o SVG. Opcional.</small>
    <input type="hidden" name="favicon" value="${current ?? ''}" />
  </div>`;
}

/**
 * Activa los campos de ícono dentro de `root`. `onChange` se llama con el
 * nuevo valor (o null al quitarlo) por si se quiere guardar al instante.
 */
export function bindFaviconFields(root: ParentNode, onChange?: (value: string | null) => Promise<void> | void): void {
  root.querySelectorAll<HTMLElement>('[data-favicon-field]').forEach((field) => {
    const hidden = field.querySelector<HTMLInputElement>('input[name="favicon"]') as HTMLInputElement;
    const preview = field.querySelector<HTMLElement>('[data-favicon-preview]') as HTMLElement;
    const clear = field.querySelector<HTMLButtonElement>('[data-favicon-clear]') as HTMLButtonElement;
    const show = (value: string | null) => {
      hidden.value = value ?? '';
      preview.innerHTML = '';
      if (value) {
        const image = document.createElement('img');
        image.src = value;
        image.alt = 'Ícono elegido';
        image.width = 32;
        image.height = 32;
        preview.append(image);
      } else {
        preview.insertAdjacentHTML('beforeend', icon('image').value);
      }
      clear.hidden = !value;
    };
    field.querySelector<HTMLInputElement>('[data-favicon-file]')?.addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const value = await processFaviconFile(file);
        show(value);
        await onChange?.(value);
      } catch (error) {
        field.dispatchEvent(new CustomEvent('favicon-error', { bubbles: true, detail: error instanceof Error ? error.message : 'No se pudo usar la imagen.' }));
      }
    });
    clear.addEventListener('click', async () => {
      show(null);
      await onChange?.(null);
    });
  });
}
