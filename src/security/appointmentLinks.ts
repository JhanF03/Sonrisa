/**
 * Enlaces firmados (sin cuenta) para pacientes.
 *
 * Formato del token: "<id>.<firma>", con firma HMAC-SHA256 sobre
 * "<propósito>:<id>" usando el secreto de la aplicación. El propósito evita
 * que un token de pago sirva como token de cita y viceversa.
 *   • No se guarda ningún token en la base (nada que robar).
 *   • Sin el secreto es imposible fabricar un enlace válido.
 */
import { constantTimeEqual } from './crypto.js';

export type TokenPurpose = 'cita' | 'pago';

const textEncoder = new TextEncoder();
const SIGNATURE_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyCache = new Map<string, Promise<CryptoKey>>();

function importHmacKey(secret: string): Promise<CryptoKey> {
  let keyPromise = keyCache.get(secret);
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, keyPromise);
  }
  return keyPromise;
}

async function sign(secret: string, purpose: TokenPurpose, id: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(secret), textEncoder.encode(`${purpose}:${id}`));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, SIGNATURE_LENGTH);
}

export async function createSignedToken(secret: string, purpose: TokenPurpose, id: string): Promise<string> {
  return `${id}.${await sign(secret, purpose, id)}`;
}

/** Devuelve el id si el token es auténtico para ese propósito; si no, null. */
export async function verifySignedToken(secret: string, purpose: TokenPurpose, token: string): Promise<string | null> {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || token.length > 120) return null;

  const id = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  if (!UUID_PATTERN.test(id)) return null;

  const expectedSignature = await sign(secret, purpose, id);
  return constantTimeEqual(textEncoder.encode(providedSignature), textEncoder.encode(expectedSignature)) ? id : null;
}

export const createAppointmentToken = (secret: string, appointmentId: string) => createSignedToken(secret, 'cita', appointmentId);
export const verifyAppointmentToken = (secret: string, token: string) => verifySignedToken(secret, 'cita', token);
