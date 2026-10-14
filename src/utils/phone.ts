/**
 * Teléfonos: normalización a formato internacional (E.164) y validación
 * de si un número puede recibir WhatsApp.
 *
 * Colombia:
 *   • Celular: 10 dígitos que empiezan por 3          → +573XXXXXXXXX
 *   • Fijo:    10 dígitos que empiezan por 60 (601…)  → +5760XXXXXXXX
 * Otros países: deben escribirse con "+" e indicativo (8 a 15 dígitos).
 */

export interface NormalizedPhone {
  /** Formato E.164, ej. +573001234567. */
  e164: string;
  /** true si es un celular (puede recibir WhatsApp). */
  isMobile: boolean;
}

export function normalizePhone(rawPhone: string): NormalizedPhone | null {
  const trimmed = rawPhone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  const hasPlus = trimmed.startsWith('+');
  const withoutInternationalPrefix = !hasPlus && digits.startsWith('00') ? digits.slice(2) : digits;

  // Número colombiano local (sin indicativo).
  if (!hasPlus && withoutInternationalPrefix.length === 10 && /^(3|60)/.test(withoutInternationalPrefix)) {
    return { e164: `+57${withoutInternationalPrefix}`, isMobile: withoutInternationalPrefix.startsWith('3') };
  }

  // Número con indicativo (con "+", "00" o 57 al inicio).
  const international = hasPlus || digits.startsWith('00') || (digits.length === 12 && digits.startsWith('57'))
    ? withoutInternationalPrefix
    : null;
  if (!international || international.length < 8 || international.length > 15) return null;

  if (international.startsWith('57')) {
    const national = international.slice(2);
    if (national.length !== 10 || !/^(3|60)/.test(national)) return null;
    return { e164: `+${international}`, isMobile: national.startsWith('3') };
  }
  // Extranjero: se asume que puede tener WhatsApp (no se puede saber).
  return { e164: `+${international}`, isMobile: true };
}

/** Clave de comparación: últimos 10 dígitos (iguala "+57300…" con "300…"). */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/** Número para enlaces wa.me: solo dígitos con indicativo. */
export function whatsappDigits(phone: string): string | null {
  const normalized = normalizePhone(phone);
  return normalized?.isMobile ? normalized.e164.slice(1) : null;
}

export function buildWhatsappLink(phone: string, message: string): string | null {
  const digits = whatsappDigits(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}
