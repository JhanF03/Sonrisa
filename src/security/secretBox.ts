/**
 * Cifrado de secretos en reposo (llaves de Wompi de cada consultorio).
 *
 * AES-256-GCM con una llave derivada (HKDF-SHA256) del APP_SECRET.
 * El id del consultorio se usa como "datos asociados": un secreto cifrado de
 * un consultorio no se puede copiar a otro (fallaría al descifrar).
 * Formato: v1.<iv base64url>.<texto cifrado base64url>
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function deriveKey(appSecret: string): Promise<CryptoKey> {
  let keyPromise = keyCache.get(appSecret);
  if (!keyPromise) {
    keyPromise = crypto.subtle
      .importKey('raw', textEncoder.encode(appSecret), 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: textEncoder.encode('agenda-sonrisa/secret-box'), info: textEncoder.encode('v1') },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    keyCache.set(appSecret, keyPromise);
  }
  return keyPromise;
}

export async function encryptSecret(appSecret: string, plainText: string, associatedData: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(associatedData) },
    await deriveKey(appSecret),
    textEncoder.encode(plainText),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipherText))}`;
}

export async function decryptSecret(appSecret: string, encrypted: string, associatedData: string): Promise<string> {
  const [version, ivText, cipherText] = encrypted.split('.');
  if (version !== 'v1' || !ivText || !cipherText) throw new Error('Formato de secreto cifrado inválido');
  const plainText = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(ivText) as BufferSource, additionalData: textEncoder.encode(associatedData) },
    await deriveKey(appSecret),
    fromBase64Url(cipherText) as BufferSource,
  );
  return textDecoder.decode(plainText);
}

/** "prod_integrity_Z5mM…sI6S" → "prod_integrity_••••I6S" (para mostrar sin revelar). */
export function maskSecret(secret: string): string {
  const prefixMatch = /^([a-z]+_[a-z]+_)/.exec(secret);
  const prefix = prefixMatch?.[1] ?? '';
  return `${prefix}••••${secret.slice(-4)}`;
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
