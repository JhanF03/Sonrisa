/**
 * Criptografía con Web Crypto (disponible en Cloudflare Workers y Node 20+),
 * sin dependencias nativas ni servicios pagos.
 */

const textEncoder = new TextEncoder();

/** Token aleatorio criptográficamente seguro, en base64url. */
export function generateSecureToken(byteLength = 32): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(randomBytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return toHex(new Uint8Array(digest));
}

/**
 * Hash de contraseña con PBKDF2-SHA256 y sal aleatoria.
 * Formato: pbkdf2$<iteraciones>$<sal base64url>$<hash base64url>
 * Las iteraciones quedan guardadas para poder subirlas en el futuro.
 * (Cloudflare Workers admite como máximo 100.000 iteraciones de PBKDF2.)
 */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedKey = await derivePbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(derivedKey)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, hashText] = storedHash.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== 'pbkdf2' || !Number.isInteger(iterations) || !saltText || !hashText) return false;

  const derivedKey = await derivePbkdf2(password, fromBase64Url(saltText), iterations);
  return constantTimeEqual(derivedKey, fromBase64Url(hashText));
}

/** Iteraciones con que se generó un hash (para saber si conviene re-cifrarlo). */
export function getHashIterations(storedHash: string): number | null {
  const iterations = Number(storedHash.split('$')[1]);
  return Number.isInteger(iterations) ? iterations : null;
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(derivedBits);
}

/** Comparación en tiempo constante para evitar ataques de temporización. */
export function constantTimeEqual(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index++) {
    difference |= first[index] ^ second[index];
  }
  return difference === 0;
}

export async function constantTimeEqualText(first: string, second: string): Promise<boolean> {
  // Se comparan los hashes para que la longitud del secreto no se filtre.
  const [firstHash, secondHash] = await Promise.all([sha256Hex(first), sha256Hex(second)]);
  return constantTimeEqual(textEncoder.encode(firstHash), textEncoder.encode(secondHash));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
