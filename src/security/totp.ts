/**
 * Códigos de verificación de 6 dígitos (TOTP, RFC 6238) compatibles con
 * Google Authenticator, Microsoft Authenticator, Authy, 1Password…
 * Solo usa Web Crypto: funciona igual en Cloudflare Workers y en Node.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SECONDS = 30;

export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export async function totpCode(secretBase32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretBase32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) | ((hmac[offset + 1] ?? 0) << 16) | ((hmac[offset + 2] ?? 0) << 8) | (hmac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, '0');
}

export const currentTotpStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/**
 * Verifica un código aceptando ±1 periodo (desfase de reloj). Devuelve el
 * periodo usado para impedir que el mismo código se use dos veces.
 */
export async function verifyTotp(secretBase32: string, code: string, lastUsedStep: number, nowMs = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentTotpStep(nowMs);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate <= lastUsedStep) continue;
    if ((await totpCode(secretBase32, candidate)) === code) return candidate;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, accountName: string, issuer = 'Agenda Sonrisa'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_SECONDS}`;
}
