/**
 * Conectores de facturación electrónica.
 *
 * Todos reciben la misma factura normalizada (EInvoiceDocument) y devuelven
 * un resultado común. Agregar un proveedor nuevo = implementar EInvoiceProvider.
 *
 * • Factus: API REST con OAuth (password grant). Docs: developers.factus.com.co
 *   POST /v2/bills/validate. Reenviar el mismo reference_code devuelve la
 *   factura ya creada (idempotente), por eso los reintentos son seguros.
 * • Webhook: POST JSON firmado con HMAC-SHA256 a una URL https propia.
 */

export interface EInvoiceCustomer {
  documentType: string; // CC, TI, CE, PA, RC, PPT, NIT
  documentNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface EInvoiceLine {
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBps: number;
}

export interface EInvoiceDocument {
  referenceCode: string;
  issueDate: string;
  customer: EInvoiceCustomer;
  lines: EInvoiceLine[];
  paymentForm: 'contado' | 'credito';
  paymentMethod: string;
  dueDate: string | null;
  observation: string | null;
  total: number;
}

export type EInvoiceResult =
  | { outcome: 'emitida'; number: string; cufe: string | null; qrUrl: string | null; publicUrl: string | null; validated: boolean }
  /** El proveedor rechazó los datos: hay que corregir y volver a facturar. */
  | { outcome: 'rechazada'; message: string }
  /** Falla temporal (red, 5xx, DIAN ocupada): se puede reintentar con la misma referencia. */
  | { outcome: 'reintentar'; message: string };

export interface EInvoiceProvider {
  testConnection(): Promise<string>;
  issue(document: EInvoiceDocument): Promise<EInvoiceResult>;
}

type FetchFn = typeof fetch;

// ─── Códigos DIAN (tablas de referencia) ────────────────────────────────────

export const DIAN_DOCUMENT_CODES: Record<string, string> = { RC: '11', TI: '12', CC: '13', CE: '22', NIT: '31', PA: '41', PPT: '48' };

export const PAYMENT_METHOD_CODES = {
  efectivo: '10',
  transferencia: '47',
  consignacion: '42',
  tarjeta_debito: '49',
  tarjeta_credito: '48',
  nequi: '47',
  daviplata: '47',
  otro: 'ZZZ',
} as const;
export type EInvoicePaymentMethod = keyof typeof PAYMENT_METHOD_CODES;

/** Dígito de verificación del NIT (algoritmo DIAN, módulo 11). */
export function nitCheckDigit(nit: string): string {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = nit.replace(/\D/g, '').split('').reverse();
  const sum = digits.reduce((total, digit, index) => total + Number(digit) * (weights[index] ?? 0), 0);
  const remainder = sum % 11;
  return String(remainder > 1 ? 11 - remainder : remainder);
}

const money = (value: number) => value.toFixed(2);

// ─── Factus ─────────────────────────────────────────────────────────────────

export interface FactusConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  numberingRangeId: number | null;
}

export const FACTUS_BASE_URLS = {
  pruebas: 'https://api-sandbox.factus.com.co',
  produccion: 'https://api.factus.com.co',
} as const;

export interface TokenCache {
  read(): Promise<string | null>;
  write(token: string, expiresInSeconds: number): Promise<void>;
}

/** Arma el cuerpo que exige Factus a partir de la factura normalizada (función pura, probada). */
export function buildFactusPayload(document: EInvoiceDocument, numberingRangeId: number | null): Record<string, unknown> {
  const isCompany = document.customer.documentType === 'NIT';
  const identification = document.customer.documentNumber.replace(isCompany ? /\D/g : /\s/g, '');
  return {
    reference_code: document.referenceCode,
    document: '01',
    ...(numberingRangeId ? { numbering_range_id: numberingRangeId } : {}),
    operation_type: '10',
    observation: document.observation?.slice(0, 500) ?? '',
    send_email: Boolean(document.customer.email),
    payment_details: [
      {
        payment_form: document.paymentForm === 'contado' ? '1' : '2',
        payment_method_code: PAYMENT_METHOD_CODES[document.paymentMethod as EInvoicePaymentMethod] ?? 'ZZZ',
        amount: money(document.total),
        ...(document.paymentForm === 'credito' && document.dueDate ? { due_date: document.dueDate } : {}),
      },
    ],
    customer: {
      identification_document_code: DIAN_DOCUMENT_CODES[document.customer.documentType] ?? '13',
      identification,
      ...(isCompany ? { dv: nitCheckDigit(identification), company: document.customer.name } : { names: document.customer.name }),
      legal_organization_code: isCompany ? '1' : '2',
      tribute_code: 'ZZ',
      country_code: 'CO',
      ...(document.customer.address ? { address: document.customer.address } : {}),
      ...(document.customer.email ? { email: document.customer.email } : {}),
      ...(document.customer.phone ? { phone: document.customer.phone.replace(/^\+57/, '') } : {}),
    },
    items: document.lines.map((line) => ({
      code_reference: line.code,
      name: line.description.slice(0, 300),
      quantity: String(line.quantity),
      price: money(line.unitPrice),
      unit_measure_code: '94',
      standard_code: '999',
      // Los servicios de salud están excluidos de IVA (art. 476 E.T.): tarifa 0 = excluido.
      taxes: [line.taxRateBps > 0 ? { code: '01', rate: (line.taxRateBps / 100).toFixed(2) } : { code: '01', rate: '0.00', is_excluded: true }],
    })),
  };
}

function describeErrors(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as { message?: unknown; data?: { errors?: unknown }; errors?: unknown };
  const errors = record.data?.errors ?? record.errors;
  const details =
    errors && typeof errors === 'object'
      ? Object.entries(errors as Record<string, unknown>)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
          .slice(0, 6)
          .join(' · ')
      : '';
  return [typeof record.message === 'string' ? record.message : '', details].filter(Boolean).join(' — ').slice(0, 900);
}

export class FactusProvider implements EInvoiceProvider {
  constructor(
    private readonly config: FactusConfig,
    private readonly fetchFn: FetchFn,
    private readonly tokenCache: TokenCache,
  ) {}

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.tokenCache.read();
      if (cached) return cached;
    }
    const response = await this.fetchFn(`${this.config.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        username: this.config.username,
        password: this.config.password,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.access_token) {
      throw new ProviderAuthError(response.status === 401 || response.status === 400 ? 'Factus rechazó las credenciales (client id/secret, usuario o contraseña).' : `Factus no respondió correctamente (HTTP ${response.status}).`);
    }
    await this.tokenCache.write(body.access_token, Math.max(60, (body.expires_in ?? 600) - 60));
    return body.access_token;
  }

  async testConnection(): Promise<string> {
    await this.getToken(true);
    return 'Conexión exitosa con Factus: credenciales válidas.';
  }

  async issue(document: EInvoiceDocument): Promise<EInvoiceResult> {
    const payload = JSON.stringify(buildFactusPayload(document, this.config.numberingRangeId));
    let response: Response;
    try {
      const send = async (token: string) =>
        this.fetchFn(`${this.config.baseUrl}/v2/bills/validate`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: payload,
          signal: AbortSignal.timeout(45_000),
        });
      response = await send(await this.getToken());
      if (response.status === 401) response = await send(await this.getToken(true));
    } catch (error) {
      if (error instanceof ProviderAuthError) return { outcome: 'rechazada', message: error.message };
      return { outcome: 'reintentar', message: 'No hubo respuesta de Factus (red o tiempo de espera). Reintenta; no se duplicará.' };
    }

    const body = (await response.json().catch(() => null)) as {
      data?: { number?: string; cufe?: string; is_validated?: boolean; links?: { qr?: string; public_url?: string }; bill?: { number?: string; cufe?: string; qr?: string; public_url?: string } };
    } | null;
    if (response.ok) {
      const data = body?.data;
      const bill = data?.bill;
      const number = data?.number ?? bill?.number;
      if (!number) return { outcome: 'reintentar', message: 'Factus respondió sin número de factura. Reintenta en unos minutos.' };
      return {
        outcome: 'emitida',
        number,
        cufe: data?.cufe ?? bill?.cufe ?? null,
        qrUrl: data?.links?.qr ?? bill?.qr ?? null,
        publicUrl: data?.links?.public_url ?? bill?.public_url ?? null,
        validated: data?.is_validated !== false,
      };
    }
    const message = describeErrors(body) || `HTTP ${response.status}`;
    // 409: hay una factura pendiente por enviar a la DIAN; 429/5xx: temporal.
    if (response.status === 409 || response.status === 429 || response.status >= 500) {
      return { outcome: 'reintentar', message: `Factus: ${message}` };
    }
    return { outcome: 'rechazada', message: `Factus rechazó la factura: ${message}` };
  }
}

export class ProviderAuthError extends Error {}

// ─── Webhook genérico ───────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  secret: string;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Solo https y hosts públicos (evita que se use para llegar a la red interna). */
export function assertPublicHttpsUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(host) ||
    /^\d+$/.test(host);
  if (url.protocol !== 'https:' || isPrivate || url.username || url.password) {
    throw new Error('La URL debe ser https y pública (sin usuario/contraseña).');
  }
}

export class WebhookProvider implements EInvoiceProvider {
  constructor(
    private readonly config: WebhookConfig,
    private readonly fetchFn: FetchFn,
  ) {}

  private async post(event: string, data: unknown): Promise<Response> {
    assertPublicHttpsUrl(this.config.url);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event, data });
    return this.fetchFn(this.config.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-AgendaSonrisa-Timestamp': timestamp,
        'X-AgendaSonrisa-Signature': `sha256=${await hmacHex(this.config.secret, `${timestamp}.${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }

  async testConnection(): Promise<string> {
    const response = await this.post('ping', { message: 'Prueba de conexión de Agenda Sonrisa' });
    if (!response.ok) throw new Error(`La URL respondió HTTP ${response.status}.`);
    return 'El webhook respondió correctamente.';
  }

  async issue(document: EInvoiceDocument): Promise<EInvoiceResult> {
    let response: Response;
    try {
      response = await this.post('invoice.issue', document);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('La URL')) return { outcome: 'rechazada', message: error.message };
      return { outcome: 'reintentar', message: 'El webhook no respondió. Reintenta; usa la misma referencia.' };
    }
    const body = (await response.json().catch(() => null)) as { number?: string; cufe?: string; qrUrl?: string; publicUrl?: string; error?: string } | null;
    if (response.ok && body?.number) {
      return { outcome: 'emitida', number: String(body.number).slice(0, 40), cufe: body.cufe ?? null, qrUrl: body.qrUrl ?? null, publicUrl: body.publicUrl ?? null, validated: true };
    }
    if (response.ok || response.status === 202) return { outcome: 'reintentar', message: 'El webhook recibió la factura pero aún no devuelve número. Reintenta luego.' };
    if (response.status >= 500 || response.status === 429) return { outcome: 'reintentar', message: `El webhook respondió HTTP ${response.status}.` };
    return { outcome: 'rechazada', message: (body?.error ?? `El webhook rechazó la factura (HTTP ${response.status}).`).slice(0, 900) };
  }
}
