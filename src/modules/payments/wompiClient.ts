/**
 * Cliente de Wompi (Colombia), según la documentación oficial:
 *   • Web Checkout:   https://docs.wompi.co/docs/colombia/widget-checkout-web/
 *   • Eventos:        https://docs.wompi.co/docs/colombia/eventos/
 *   • Llaves y URLs:  https://docs.wompi.co/docs/colombia/ambientes-y-llaves/
 *
 * Solo usa la llave pública, el secreto de integridad y el secreto de eventos.
 * La llave privada NO se necesita ni se guarda (menos riesgo).
 */
import { constantTimeEqual, sha256Hex } from '../../security/crypto.js';

export type WompiEnvironment = 'sandbox' | 'production';

export const WOMPI_CHECKOUT_URL = 'https://checkout.wompi.co/p/';
const API_BASE_URL: Record<WompiEnvironment, string> = {
  sandbox: 'https://sandbox.wompi.co/v1',
  production: 'https://production.wompi.co/v1',
};

/** Prefijos oficiales de cada llave por ambiente. */
export const KEY_PREFIXES: Record<WompiEnvironment, { publicKey: string; integrity: string; events: string }> = {
  sandbox: { publicKey: 'pub_test_', integrity: 'test_integrity_', events: 'test_events_' },
  production: { publicKey: 'pub_prod_', integrity: 'prod_integrity_', events: 'prod_events_' },
};

/** Valor de "environment" que Wompi envía en los eventos. */
export const EVENT_ENVIRONMENT: Record<WompiEnvironment, string> = { sandbox: 'test', production: 'prod' };

export type WompiTransactionStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';

export interface WompiTransaction {
  id: string;
  status: WompiTransactionStatus;
  amount_in_cents: number;
  currency: string;
  reference: string;
  payment_method_type?: string;
}

export interface WompiEvent {
  event: string;
  data: { transaction?: WompiTransaction } & Record<string, unknown>;
  environment: string;
  signature: { properties: string[]; checksum: string };
  timestamp: number;
  sent_at?: string;
}

export interface CheckoutRequest {
  publicKey: string;
  integritySecret: string;
  reference: string;
  amountInCents: number;
  redirectUrl: string;
  expirationTime: string;
  customer: { fullName: string; email: string | null; phoneE164: string | null; legalId: string; legalIdType: string };
}

/** Tipos de documento que acepta Wompi (los demás no se envían). */
const WOMPI_LEGAL_ID_TYPES: Record<string, string> = { CC: 'CC', CE: 'CE', NIT: 'NIT', TI: 'TI', PA: 'PP' };

/**
 * Firma de integridad: SHA-256 de <Referencia><Monto><Moneda>[<FechaExpiracion>]<SecretoIntegridad>.
 * Se calcula SIEMPRE en el servidor (el secreto nunca llega al navegador).
 */
export function integritySignature(
  reference: string,
  amountInCents: number,
  currency: string,
  integritySecret: string,
  expirationTime?: string,
): Promise<string> {
  return sha256Hex(`${reference}${amountInCents}${currency}${expirationTime ?? ''}${integritySecret}`);
}

export async function buildCheckoutUrl(request: CheckoutRequest): Promise<string> {
  const signature = await integritySignature(request.reference, request.amountInCents, 'COP', request.integritySecret, request.expirationTime);
  const params = new URLSearchParams({
    'public-key': request.publicKey,
    currency: 'COP',
    'amount-in-cents': String(request.amountInCents),
    reference: request.reference,
    'signature:integrity': signature,
    'redirect-url': request.redirectUrl,
    'expiration-time': request.expirationTime,
    'customer-data:full-name': request.customer.fullName.slice(0, 100),
  });
  if (request.customer.email) params.set('customer-data:email', request.customer.email);
  if (request.customer.phoneE164?.startsWith('+57')) {
    params.set('customer-data:phone-number', request.customer.phoneE164.slice(3));
    params.set('customer-data:phone-number-prefix', '+57');
  }
  const legalIdType = WOMPI_LEGAL_ID_TYPES[request.customer.legalIdType];
  if (legalIdType) {
    params.set('customer-data:legal-id', request.customer.legalId);
    params.set('customer-data:legal-id-type', legalIdType);
  }
  return `${WOMPI_CHECKOUT_URL}?${params.toString()}`;
}

/**
 * Verifica la autenticidad de un evento: concatena los valores de
 * signature.properties (rutas dentro de "data"), luego el timestamp y el
 * secreto de eventos, y compara el SHA-256 con el checksum recibido.
 */
export async function verifyEventChecksum(event: WompiEvent, eventsSecret: string, headerChecksum?: string | null): Promise<boolean> {
  const properties = event?.signature?.properties;
  const providedChecksum = (headerChecksum || event?.signature?.checksum || '').toLowerCase();
  if (!Array.isArray(properties) || properties.length === 0 || !/^[0-9a-f]{64}$/.test(providedChecksum)) return false;
  if (!Number.isFinite(event.timestamp)) return false;

  let concatenated = '';
  for (const propertyPath of properties) {
    if (typeof propertyPath !== 'string' || !/^[a-z_.]+$/i.test(propertyPath)) return false;
    const value = resolvePath(event.data, propertyPath);
    if (value === undefined || value === null || typeof value === 'object') return false;
    concatenated += String(value);
  }
  concatenated += String(event.timestamp) + eventsSecret;

  const expectedChecksum = await sha256Hex(concatenated);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(expectedChecksum), encoder.encode(providedChecksum));
}

function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export class WompiApi {
  constructor(private readonly fetchImplementation: typeof fetch) {}

  /** Consulta una transacción con la llave pública (fuente de verdad del estado). */
  async getTransaction(environment: WompiEnvironment, publicKey: string, transactionId: string): Promise<WompiTransaction | null> {
    if (!/^[A-Za-z0-9-]{5,80}$/.test(transactionId)) return null;
    const response = await this.fetchImplementation(`${API_BASE_URL[environment]}/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${publicKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Wompi respondió ${response.status}`);
    const body = (await response.json()) as { data?: WompiTransaction };
    return body.data ?? null;
  }

  /** Datos del comercio: sirve para comprobar que la llave pública y el ambiente son correctos. */
  async getMerchant(environment: WompiEnvironment, publicKey: string): Promise<{ name: string } | null> {
    const response = await this.fetchImplementation(`${API_BASE_URL[environment]}/merchants/${encodeURIComponent(publicKey)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 401 || response.status === 422) return null;
    if (!response.ok) throw new Error(`Wompi respondió ${response.status}`);
    const body = (await response.json()) as { data?: { name?: string; legal_name?: string } };
    return body.data ? { name: body.data.name ?? body.data.legal_name ?? 'Comercio' } : null;
  }
}

/** Traduce el método de Wompi al medio de pago de la caja. */
export function mapPaymentMethod(wompiMethod: string | undefined): 'tarjeta' | 'nequi' | 'transferencia' | 'daviplata' | 'otro' {
  switch (wompiMethod) {
    case 'CARD':
      return 'tarjeta';
    case 'NEQUI':
      return 'nequi';
    case 'PSE':
    case 'BANCOLOMBIA_TRANSFER':
      return 'transferencia';
    case 'DAVIPLATA':
      return 'daviplata';
    default:
      return 'otro';
  }
}
