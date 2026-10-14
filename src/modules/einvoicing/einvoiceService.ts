/**
 * Facturación electrónica de venta a partir de los cargos del paciente.
 *
 * Flujo:
 *  1. Se crea la factura en estado "pendiente" con una referencia única y sus
 *     líneas (cada cargo queda reservado: no se puede facturar dos veces).
 *  2. Se envía al proveedor configurado:
 *     • emitida   → se guardan número, CUFE, QR y enlace público.
 *     • rechazada → se liberan los cargos para corregir y volver a facturar.
 *     • reintentar→ queda pendiente; "Reintentar" reenvía la MISMA referencia
 *                   (el proveedor no duplica).
 *  3. Modo "externo": el consultorio factura en su software y registra aquí
 *     número y CUFE (costo cero, sin integración).
 *
 * Anular una factura emitida exige la referencia de la nota crédito hecha en
 * el proveedor (la DIAN no permite borrar facturas).
 */
import type { SqlDatabase, SqlStatement } from '../../db/database.js';
import type { Actor, AppConfig } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../security/secretBox.js';
import { isoNow, todayLocal } from '../../utils/time.js';
import type { AuditService } from '../audit/auditService.js';
import {
  assertPublicHttpsUrl,
  FACTUS_BASE_URLS,
  FactusProvider,
  WebhookProvider,
  type EInvoiceDocument,
  type EInvoiceProvider,
  type EInvoiceResult,
} from './providers.js';

export type EInvoiceProviderName = 'externo' | 'factus' | 'webhook';

interface SettingsRow {
  tenant_id: string;
  provider: EInvoiceProviderName;
  environment: 'pruebas' | 'produccion';
  credentials_enc: string | null;
  public_config: string;
  token_enc: string | null;
  token_expires_at: string | null;
  is_enabled: number;
  last_verified_at: string | null;
}

interface PublicConfig {
  clientId?: string;
  username?: string;
  numberingRangeId?: number | null;
  webhookUrl?: string;
}

interface SecretConfig {
  clientSecret?: string;
  password?: string;
  webhookSecret?: string;
}

export interface EInvoiceSettingsView {
  provider: EInvoiceProviderName;
  environment: 'pruebas' | 'produccion';
  isEnabled: boolean;
  clientId: string;
  username: string;
  numberingRangeId: number | null;
  webhookUrl: string;
  maskedClientSecret: string | null;
  hasPassword: boolean;
  maskedWebhookSecret: string | null;
  lastVerifiedAt: string | null;
}

export interface SaveSettingsInput {
  provider: EInvoiceProviderName;
  environment: 'pruebas' | 'produccion';
  isEnabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
  username: string | null;
  password: string | null;
  numberingRangeId: number | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

export interface InvoiceRow {
  id: string;
  patient_id: string;
  patient_name: string;
  reference_code: string;
  provider: EInvoiceProviderName;
  status: 'pendiente' | 'emitida' | 'rechazada' | 'anulada';
  number: string | null;
  cufe: string | null;
  qr_url: string | null;
  public_url: string | null;
  payment_form: 'contado' | 'credito';
  payment_method: string;
  due_date: string | null;
  subtotal: number;
  tax_total: number;
  total: number;
  last_error: string | null;
  attempts: number;
  void_reason: string | null;
  credit_note_ref: string | null;
  created_by_name: string | null;
  created_at: string;
  issued_at: string | null;
}

export interface InvoiceDetail extends InvoiceRow {
  customer: EInvoiceDocument['customer'];
  observation: string | null;
  lines: Array<{ id: string; charge_id: string; code: string; description: string; quantity: number; unit_price: number; tax_rate_bps: number; line_total: number }>;
}

export interface BillableCharge {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  created_at: string;
  service_code: string | null;
  tax_rate_bps: number;
}

export interface CreateInvoiceInput {
  patientId: string;
  chargeIds: string[];
  paymentForm: 'contado' | 'credito';
  paymentMethod: string;
  dueDate: string | null;
  observation: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  /** Solo modo externo: número y CUFE de la factura hecha en el software del consultorio. */
  externalNumber: string | null;
  externalCufe: string | null;
}

const INVOICE_SELECT = `
  SELECT i.id, i.patient_id, p.full_name AS patient_name, i.reference_code, i.provider, i.status, i.number, i.cufe, i.qr_url,
         i.public_url, i.payment_form, i.payment_method, i.due_date, i.subtotal, i.tax_total, i.total, i.last_error, i.attempts,
         i.void_reason, i.credit_note_ref, u.full_name AS created_by_name, i.created_at, i.issued_at
  FROM sales_invoices i
  JOIN patients p ON p.id = i.patient_id
  LEFT JOIN users u ON u.id = i.created_by`;

/** IVA contenido en un valor final (los precios del consultorio son finales). */
export const taxIncluded = (gross: number, taxRateBps: number) => (taxRateBps > 0 ? Math.round(gross - gross / (1 + taxRateBps / 10_000)) : 0);

export class EInvoiceService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly fetchFn: typeof fetch,
  ) {}

  // ─── Configuración ────────────────────────────────────────────────────────

  private async getSettingsRow(tenantId: string): Promise<SettingsRow | null> {
    return this.db.prepare('SELECT * FROM einvoice_settings WHERE tenant_id = ?').bind(tenantId).first<SettingsRow>();
  }

  private async readSecrets(row: SettingsRow): Promise<SecretConfig> {
    if (!row.credentials_enc) return {};
    return JSON.parse(await decryptSecret(this.config.appSecret, row.credentials_enc, `${row.tenant_id}:einvoice`)) as SecretConfig;
  }

  async getSettings(tenantId: string): Promise<EInvoiceSettingsView> {
    const row = await this.getSettingsRow(tenantId);
    if (!row) {
      return {
        provider: 'externo', environment: 'pruebas', isEnabled: true, clientId: '', username: '', numberingRangeId: null,
        webhookUrl: '', maskedClientSecret: null, hasPassword: false, maskedWebhookSecret: null, lastVerifiedAt: null,
      };
    }
    const publicConfig = JSON.parse(row.public_config) as PublicConfig;
    const secrets = await this.readSecrets(row);
    return {
      provider: row.provider,
      environment: row.environment,
      isEnabled: row.is_enabled === 1 || row.provider === 'externo',
      clientId: publicConfig.clientId ?? '',
      username: publicConfig.username ?? '',
      numberingRangeId: publicConfig.numberingRangeId ?? null,
      webhookUrl: publicConfig.webhookUrl ?? '',
      maskedClientSecret: secrets.clientSecret ? maskSecret(secrets.clientSecret) : null,
      hasPassword: Boolean(secrets.password),
      maskedWebhookSecret: secrets.webhookSecret ? maskSecret(secrets.webhookSecret) : null,
      lastVerifiedAt: row.last_verified_at,
    };
  }

  async saveSettings(actor: Actor, input: SaveSettingsInput): Promise<EInvoiceSettingsView> {
    const existing = await this.getSettingsRow(actor.tenantId);
    const previousSecrets = existing ? await this.readSecrets(existing) : {};
    const previousPublic = existing ? (JSON.parse(existing.public_config) as PublicConfig) : {};
    const publicConfig: PublicConfig = { ...previousPublic };
    const secrets: SecretConfig = { ...previousSecrets };

    if (input.provider === 'factus') {
      publicConfig.clientId = input.clientId ?? previousPublic.clientId;
      publicConfig.username = input.username ?? previousPublic.username;
      publicConfig.numberingRangeId = input.numberingRangeId;
      if (input.clientSecret) secrets.clientSecret = input.clientSecret;
      if (input.password) secrets.password = input.password;
      if (!publicConfig.clientId || !publicConfig.username || !secrets.clientSecret || !secrets.password) {
        throw new AppError('Para Factus completa client id, client secret, usuario y contraseña.', 422, 'MISSING_CREDENTIALS');
      }
    }
    if (input.provider === 'webhook') {
      publicConfig.webhookUrl = input.webhookUrl ?? previousPublic.webhookUrl;
      if (input.webhookSecret) secrets.webhookSecret = input.webhookSecret;
      if (!publicConfig.webhookUrl || !secrets.webhookSecret) {
        throw new AppError('Para el webhook indica la URL y un secreto de firma.', 422, 'MISSING_CREDENTIALS');
      }
      try {
        assertPublicHttpsUrl(publicConfig.webhookUrl);
      } catch (error) {
        throw new AppError((error as Error).message, 422, 'INVALID_URL');
      }
    }

    const credentialsChanged =
      JSON.stringify(secrets) !== JSON.stringify(previousSecrets) ||
      input.environment !== existing?.environment ||
      publicConfig.clientId !== previousPublic.clientId ||
      publicConfig.username !== previousPublic.username;
    const credentialsEnc = Object.keys(secrets).length
      ? await encryptSecret(this.config.appSecret, JSON.stringify(secrets), `${actor.tenantId}:einvoice`)
      : null;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO einvoice_settings (tenant_id, provider, environment, credentials_enc, public_config, is_enabled, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET provider = excluded.provider, environment = excluded.environment,
             credentials_enc = excluded.credentials_enc, public_config = excluded.public_config, is_enabled = excluded.is_enabled,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at,
             token_enc = CASE WHEN ? THEN NULL ELSE einvoice_settings.token_enc END,
             token_expires_at = CASE WHEN ? THEN NULL ELSE einvoice_settings.token_expires_at END,
             last_verified_at = CASE WHEN ? THEN NULL ELSE einvoice_settings.last_verified_at END`,
        )
        .bind(
          actor.tenantId, input.provider, input.environment, credentialsEnc, JSON.stringify(publicConfig), input.isEnabled ? 1 : 0,
          actor.userId, isoNow(), credentialsChanged ? 1 : 0, credentialsChanged ? 1 : 0, credentialsChanged ? 1 : 0,
        ),
      // Nunca se registran secretos en la auditoría.
      this.audit.buildStatement(actor, { action: 'facturacion_configurada', entity: 'facturacion', entityId: actor.tenantId, details: { provider: input.provider, environment: input.environment, enabled: input.isEnabled } }),
    ]);
    return this.getSettings(actor.tenantId);
  }

  private async buildProvider(tenantId: string): Promise<{ provider: EInvoiceProvider | null; name: EInvoiceProviderName }> {
    const row = await this.getSettingsRow(tenantId);
    if (!row || row.provider === 'externo') return { provider: null, name: 'externo' };
    const publicConfig = JSON.parse(row.public_config) as PublicConfig;
    const secrets = await this.readSecrets(row);
    if (row.provider === 'webhook') {
      return { provider: new WebhookProvider({ url: publicConfig.webhookUrl ?? '', secret: secrets.webhookSecret ?? '' }, this.fetchFn), name: 'webhook' };
    }
    const tokenAad = `${tenantId}:einvoice-token`;
    return {
      name: 'factus',
      provider: new FactusProvider(
        {
          baseUrl: FACTUS_BASE_URLS[row.environment],
          clientId: publicConfig.clientId ?? '',
          clientSecret: secrets.clientSecret ?? '',
          username: publicConfig.username ?? '',
          password: secrets.password ?? '',
          numberingRangeId: publicConfig.numberingRangeId ?? null,
        },
        this.fetchFn,
        {
          read: async () => {
            const current = await this.getSettingsRow(tenantId);
            if (!current?.token_enc || !current.token_expires_at || current.token_expires_at <= isoNow()) return null;
            return decryptSecret(this.config.appSecret, current.token_enc, tokenAad).catch(() => null);
          },
          write: async (token, expiresInSeconds) => {
            await this.db
              .prepare('UPDATE einvoice_settings SET token_enc = ?, token_expires_at = ? WHERE tenant_id = ?')
              .bind(await encryptSecret(this.config.appSecret, token, tokenAad), new Date(Date.now() + expiresInSeconds * 1000).toISOString(), tenantId)
              .run();
          },
        },
      ),
    };
  }

  async testConnection(actor: Actor): Promise<{ message: string }> {
    const { provider } = await this.buildProvider(actor.tenantId);
    if (!provider) return { message: 'Modo externo: no requiere conexión. Registra el número y CUFE de cada factura.' };
    try {
      const message = await provider.testConnection();
      await this.db.prepare('UPDATE einvoice_settings SET last_verified_at = ? WHERE tenant_id = ?').bind(isoNow(), actor.tenantId).run();
      return { message };
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : 'No se pudo conectar.', 422, 'CONNECTION_FAILED');
    }
  }

  // ─── Consultas ────────────────────────────────────────────────────────────

  async listInvoices(tenantId: string, filters: { fromUtc: string; toUtc: string; status?: string }): Promise<InvoiceRow[]> {
    const { results } = await this.db
      .prepare(`${INVOICE_SELECT} WHERE i.tenant_id = ? AND i.created_at >= ? AND i.created_at < ? ${filters.status ? 'AND i.status = ?' : ''} ORDER BY i.created_at DESC LIMIT 1000`)
      .bind(tenantId, filters.fromUtc, filters.toUtc, ...(filters.status ? [filters.status] : []))
      .all<InvoiceRow>();
    return results;
  }

  async getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceDetail> {
    const row = await this.db
      .prepare(`${INVOICE_SELECT.replace('SELECT i.id,', 'SELECT i.customer, i.observation, i.id,')} WHERE i.tenant_id = ? AND i.id = ?`)
      .bind(tenantId, invoiceId)
      .first<InvoiceRow & { customer: string; observation: string | null }>();
    if (!row) throw notFound('La factura');
    const { results: lines } = await this.db
      .prepare('SELECT id, charge_id, code, description, quantity, unit_price, tax_rate_bps, line_total FROM sales_invoice_lines WHERE invoice_id = ? AND tenant_id = ? ORDER BY rowid')
      .bind(invoiceId, tenantId)
      .all<InvoiceDetail['lines'][number]>();
    return { ...row, customer: JSON.parse(row.customer) as EInvoiceDocument['customer'], lines };
  }

  /** Cargos activos del paciente que aún no están en una factura vigente. */
  async listBillableCharges(tenantId: string, patientId: string): Promise<BillableCharge[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.description, c.quantity, c.amount, c.created_at, s.code AS service_code, COALESCE(s.tax_rate_bps, 0) AS tax_rate_bps
         FROM charges c LEFT JOIN services s ON s.id = c.service_id
         WHERE c.tenant_id = ? AND c.patient_id = ? AND c.status = 'activo'
           AND NOT EXISTS (SELECT 1 FROM sales_invoice_lines l WHERE l.charge_id = c.id AND l.is_active = 1)
         ORDER BY c.created_at`,
      )
      .bind(tenantId, patientId)
      .all<BillableCharge>();
    return results;
  }

  // ─── Emisión ──────────────────────────────────────────────────────────────

  async createInvoice(actor: Actor, input: CreateInvoiceInput, utcOffsetMinutes: number): Promise<InvoiceDetail> {
    const settings = await this.getSettings(actor.tenantId);
    if (!settings.isEnabled) throw new AppError('La facturación electrónica está desactivada en Configuración.', 409, 'EINVOICE_DISABLED');
    if (settings.provider === 'externo' && !input.externalNumber) {
      throw new AppError('En modo externo escribe el número de la factura que hiciste en tu software.', 422, 'MISSING_NUMBER');
    }
    if (input.paymentForm === 'credito' && !input.dueDate) throw new AppError('Indica la fecha de vencimiento de la factura a crédito.', 422, 'MISSING_DUE_DATE');

    const patient = await this.db
      .prepare('SELECT id, document_type, document_number, full_name, email, phone FROM patients WHERE id = ? AND tenant_id = ?')
      .bind(input.patientId, actor.tenantId)
      .first<{ id: string; document_type: string; document_number: string; full_name: string; email: string | null; phone: string | null }>();
    if (!patient) throw notFound('El paciente');

    const uniqueIds = [...new Set(input.chargeIds)];
    const billable = (await this.listBillableCharges(actor.tenantId, input.patientId)).filter((charge) => uniqueIds.includes(charge.id));
    if (billable.length === 0 || billable.length !== uniqueIds.length) {
      throw new AppError('Algunos cargos no existen, están anulados o ya fueron facturados. Actualiza la lista.', 409, 'CHARGES_UNAVAILABLE');
    }

    const total = billable.reduce((sum, charge) => sum + charge.amount, 0);
    const taxTotal = billable.reduce((sum, charge) => sum + taxIncluded(charge.amount, charge.tax_rate_bps), 0);
    const customer = {
      documentType: patient.document_type,
      documentNumber: patient.document_number,
      name: patient.full_name,
      email: input.customerEmail ?? patient.email,
      phone: patient.phone,
      address: input.customerAddress,
    };

    const invoiceId = crypto.randomUUID();
    const now = isoNow();
    const isExternal = settings.provider === 'externo';
    const referencePrefix = `AGS-${actor.tenantId.slice(0, 8).toUpperCase()}-`;
    const statements: SqlStatement[] = [
      this.db.prepare("INSERT INTO counters (tenant_id, name, value) VALUES (?, 'factura_ref', 0) ON CONFLICT (tenant_id, name) DO NOTHING").bind(actor.tenantId),
      this.db.prepare("UPDATE counters SET value = value + 1 WHERE tenant_id = ? AND name = 'factura_ref'").bind(actor.tenantId),
      this.db
        .prepare(
          `INSERT INTO sales_invoices (id, tenant_id, patient_id, reference_code, provider, status, number, cufe, customer, payment_form, payment_method,
             due_date, observation, subtotal, tax_total, total, created_by, created_at, issued_at)
           SELECT ?, ?, ?, ? || printf('%06d', value), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM counters WHERE tenant_id = ? AND name = 'factura_ref'`,
        )
        .bind(
          invoiceId, actor.tenantId, patient.id, referencePrefix, settings.provider, isExternal ? 'emitida' : 'pendiente',
          isExternal ? input.externalNumber?.trim().toUpperCase() ?? null : null, isExternal ? input.externalCufe : null,
          JSON.stringify(customer), input.paymentForm, input.paymentMethod, input.paymentForm === 'credito' ? input.dueDate : null,
          input.observation, total - taxTotal, taxTotal, total, actor.userId, now, isExternal ? now : null, actor.tenantId,
        ),
      // El índice único (cargo, vigente) impide facturar el mismo cargo dos veces aunque lleguen dos solicitudes a la vez.
      ...billable.map((charge) =>
        this.db
          .prepare(
            `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, charge_id, code, description, quantity, unit_price, tax_rate_bps, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), actor.tenantId, invoiceId, charge.id, charge.service_code ?? 'CARGO', charge.description, charge.quantity, Math.round(charge.amount / charge.quantity), charge.tax_rate_bps, charge.amount),
      ),
      this.audit.buildStatement(actor, { action: isExternal ? 'factura_registrada' : 'factura_creada', entity: 'factura', entityId: invoiceId, details: { total, provider: settings.provider } }),
    ];
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: sales_invoice_lines/i.test(error.message)) {
        throw new AppError('Uno de los cargos se acaba de facturar en otra ventana.', 409, 'CHARGES_UNAVAILABLE');
      }
      if (error instanceof Error && /UNIQUE constraint failed: sales_invoices.tenant_id, sales_invoices.cufe/i.test(error.message)) {
        throw new AppError('Ya hay una factura registrada con ese CUFE.', 409, 'DUPLICATE_CUFE');
      }
      throw error;
    }
    if (isExternal) return this.getInvoice(actor.tenantId, invoiceId);
    return this.issue(actor, invoiceId, utcOffsetMinutes);
  }

  /** Envía (o reenvía) una factura pendiente al proveedor. */
  async issue(actor: Actor, invoiceId: string, utcOffsetMinutes: number): Promise<InvoiceDetail> {
    const invoice = await this.getInvoice(actor.tenantId, invoiceId);
    if (invoice.status !== 'pendiente') throw new AppError('Solo se envían facturas pendientes.', 409, 'NOT_PENDING');
    const { provider, name } = await this.buildProvider(actor.tenantId);
    if (!provider || name !== invoice.provider) {
      throw new AppError('El proveedor de facturación cambió. Anula esta factura pendiente y créala de nuevo.', 409, 'PROVIDER_CHANGED');
    }
    const document: EInvoiceDocument = {
      referenceCode: invoice.reference_code,
      issueDate: todayLocal(utcOffsetMinutes),
      customer: invoice.customer,
      lines: invoice.lines.map((line) => ({
        code: line.code,
        description: line.description,
        quantity: line.quantity,
        // Precio unitario neto (sin IVA): los valores del consultorio son finales.
        unitPrice: line.tax_rate_bps > 0 ? Math.round((line.unit_price / (1 + line.tax_rate_bps / 10_000)) * 100) / 100 : line.unit_price,
        taxRateBps: line.tax_rate_bps,
      })),
      paymentForm: invoice.payment_form,
      paymentMethod: invoice.payment_method,
      dueDate: invoice.due_date,
      observation: invoice.observation,
      total: invoice.total,
    };

    const result: EInvoiceResult = await provider.issue(document);
    const now = isoNow();
    if (result.outcome === 'emitida') {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE sales_invoices SET status = 'emitida', number = ?, cufe = ?, qr_url = ?, public_url = ?, issued_at = ?, last_error = ?, attempts = attempts + 1
             WHERE id = ? AND tenant_id = ? AND status = 'pendiente'`,
          )
          .bind(result.number, result.cufe, result.qrUrl, result.publicUrl, now, result.validated ? null : 'Pendiente de validación en la DIAN.', invoiceId, actor.tenantId),
        this.audit.buildStatement(actor, { action: 'factura_emitida', entity: 'factura', entityId: invoiceId, details: { number: result.number } }),
      ]);
    } else if (result.outcome === 'rechazada') {
      await this.db.batch([
        this.db
          .prepare("UPDATE sales_invoices SET status = 'rechazada', last_error = ?, attempts = attempts + 1 WHERE id = ? AND tenant_id = ? AND status = 'pendiente'")
          .bind(result.message, invoiceId, actor.tenantId),
        this.db.prepare('UPDATE sales_invoice_lines SET is_active = 0 WHERE invoice_id = ? AND tenant_id = ?').bind(invoiceId, actor.tenantId),
        this.audit.buildStatement(actor, { action: 'factura_rechazada', entity: 'factura', entityId: invoiceId, details: { message: result.message.slice(0, 300) } }),
      ]);
    } else {
      await this.db
        .prepare('UPDATE sales_invoices SET last_error = ?, attempts = attempts + 1 WHERE id = ? AND tenant_id = ?')
        .bind(result.message, invoiceId, actor.tenantId)
        .run();
    }
    return this.getInvoice(actor.tenantId, invoiceId);
  }

  async voidInvoice(actor: Actor, invoiceId: string, input: { reason: string; creditNoteRef: string | null }): Promise<InvoiceDetail> {
    const invoice = await this.getInvoice(actor.tenantId, invoiceId);
    if (invoice.status === 'anulada' || invoice.status === 'rechazada') throw new AppError('Esta factura ya no está vigente.', 409, 'NOT_ACTIVE');
    if (invoice.status === 'emitida' && !input.creditNoteRef) {
      throw new AppError('Una factura emitida se anula con una nota crédito: escribe su número (hecha en el portal del proveedor).', 422, 'MISSING_CREDIT_NOTE');
    }
    await this.db.batch([
      this.db
        .prepare("UPDATE sales_invoices SET status = 'anulada', void_reason = ?, credit_note_ref = ? WHERE id = ? AND tenant_id = ? AND status IN ('pendiente', 'emitida')")
        .bind(input.reason, input.creditNoteRef, invoiceId, actor.tenantId),
      this.db.prepare('UPDATE sales_invoice_lines SET is_active = 0 WHERE invoice_id = ? AND tenant_id = ?').bind(invoiceId, actor.tenantId),
      this.audit.buildStatement(actor, { action: 'factura_anulada', entity: 'factura', entityId: invoiceId, details: { reason: input.reason, creditNoteRef: input.creditNoteRef } }),
    ]);
    return this.getInvoice(actor.tenantId, invoiceId);
  }
}
