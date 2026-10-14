/**
 * Fase 3: facturación electrónica (modo externo, Factus y webhook).
 * Las APIs externas se simulan: no se hace ninguna llamada real.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { assertPublicHttpsUrl, buildFactusPayload, nitCheckDigit, type EInvoiceDocument } from '../src/modules/einvoicing/providers.js';
import { createTestEnvironment, type TestClinic } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

const baseDocument: EInvoiceDocument = {
  referenceCode: 'AGS-1',
  issueDate: '2026-10-14',
  customer: { documentType: 'CC', documentNumber: '1020304050', name: 'Laura Gómez', email: 'laura@correo.co', phone: '+573001234567', address: null },
  lines: [{ code: 'PRO', description: 'Limpieza', quantity: 1, unitPrice: 120000, taxRateBps: 0 }],
  paymentForm: 'contado',
  paymentMethod: 'transferencia',
  dueDate: null,
  observation: null,
  total: 120000,
};

describe('Conector Factus: armado de la factura', () => {
  it('persona natural con cédula, servicio de salud excluido de IVA y pago por transferencia', () => {
    const payload = buildFactusPayload(baseDocument, 12) as any;
    assert.equal(payload.reference_code, 'AGS-1');
    assert.equal(payload.numbering_range_id, 12);
    assert.equal(payload.operation_type, '10');
    assert.deepEqual(payload.payment_details, [{ payment_form: '1', payment_method_code: '47', amount: '120000.00' }]);
    assert.equal(payload.customer.identification_document_code, '13');
    assert.equal(payload.customer.legal_organization_code, '2');
    assert.equal(payload.customer.names, 'Laura Gómez');
    assert.equal(payload.customer.phone, '3001234567');
    assert.deepEqual(payload.items[0].taxes, [{ code: '01', rate: '0.00', is_excluded: true }]);
    assert.equal(payload.items[0].price, '120000.00');
  });

  it('empresa con NIT (dígito de verificación DIAN) y crédito con vencimiento', () => {
    assert.equal(nitCheckDigit('800197268'), '4', 'NIT de la DIAN');
    assert.equal(nitCheckDigit('900123456'), '8');
    const payload = buildFactusPayload(
      { ...baseDocument, customer: { ...baseDocument.customer, documentType: 'NIT', documentNumber: '800.197.268', name: 'EPS Ejemplo SAS' }, paymentForm: 'credito', dueDate: '2026-11-14' },
      null,
    ) as any;
    assert.equal(payload.numbering_range_id, undefined);
    assert.equal(payload.customer.identification, '800197268');
    assert.equal(payload.customer.dv, '4');
    assert.equal(payload.customer.company, 'EPS Ejemplo SAS');
    assert.equal(payload.customer.legal_organization_code, '1');
    assert.equal(payload.payment_details[0].payment_form, '2');
    assert.equal(payload.payment_details[0].due_date, '2026-11-14');
  });

  it('el webhook solo acepta URLs https públicas (anti-SSRF)', () => {
    assert.doesNotThrow(() => assertPublicHttpsUrl('https://hook.make.com/abc'));
    for (const url of ['http://hook.make.com/abc', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://[::1]/x', 'https://user:pass@hook.make.com/', 'https://169.254.169.254/latest', 'https://2130706433/']) {
      assert.throws(() => assertPublicHttpsUrl(url), `Debió rechazar ${url}`);
    }
  });
});

describe('Facturación electrónica (API)', () => {
  let env: TestEnvironment;
  let clinic: TestClinic;
  let admin: string;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let factusBehavior: 'ok' | 'reject' | 'network' = 'ok';
  let invoiceCounter = 0;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, body: String(init?.body ?? ''), headers });
    if (url.endsWith('/oauth/token')) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('password') !== 'clave-factus') return Response.json({ message: 'invalid_grant' }, { status: 401 });
      return Response.json({ token_type: 'Bearer', expires_in: 600, access_token: 'token-123', refresh_token: 'r' });
    }
    if (url.endsWith('/v2/bills/validate')) {
      if (headers.authorization !== 'Bearer token-123') return new Response('', { status: 401 });
      if (factusBehavior === 'network') throw new TypeError('fetch failed');
      if (factusBehavior === 'reject') return Response.json({ message: 'Validación', data: { errors: { 'customer.identification': ['es inválida'] } } }, { status: 422 });
      const reference = JSON.parse(String(init?.body)).reference_code as string;
      invoiceCounter++;
      return Response.json({
        status: 'Created',
        message: 'ok',
        data: { number: `SETP99000${invoiceCounter}`, cufe: `cufe${reference.replace(/\W/g, '').toLowerCase()}`, is_validated: true, links: { qr: 'https://catalogo-vpfe.dian.gov.co/x', public_url: 'https://factus.com.co/f/1' } },
      }, { status: 201 });
    }
    if (url.startsWith('https://hook.example.co/')) {
      return Response.json({ number: 'WH-1', cufe: 'abc123', publicUrl: 'https://hook.example.co/f/1' });
    }
    throw new Error(`Llamada no simulada: ${url}`);
  };

  const newCharge = async (amount = 120000) =>
    (await env.request('POST', '/api/charges', { cookie: admin, body: { patientId: clinic.patientId, serviceId: clinic.serviceId, unitPrice: amount } })).json.id as string;
  const createInvoice = (chargeIds: string[], extra: Record<string, unknown> = {}) =>
    env.request('POST', '/api/einvoices', { cookie: admin, body: { patientId: clinic.patientId, chargeIds, paymentForm: 'contado', paymentMethod: 'efectivo', ...extra } });
  const saveSettings = (body: Record<string, unknown>) => env.request('PUT', '/api/settings/einvoicing', { cookie: admin, body });

  before(async () => {
    env = await createTestEnvironment({ fetch: fakeFetch });
    clinic = await env.createClinic('Consultorio Facturación', 'admin-factura@prueba.co');
    admin = await env.login(clinic.adminEmail);
  });

  describe('Modo externo (costo cero)', () => {
    it('registra la factura hecha en otro software y no deja facturar dos veces el mismo cargo', async () => {
      const chargeId = await newCharge();
      const billable = await env.request('GET', `/api/patients/${clinic.patientId}/billable-charges`, { cookie: admin });
      assert.ok(billable.json.some((row: { id: string }) => row.id === chargeId));

      const missingNumber = await createInvoice([chargeId]);
      assert.equal(missingNumber.status, 422);

      const created = await createInvoice([chargeId], { externalNumber: 'fe-100' });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.json.status, 'emitida');
      assert.equal(created.json.number, 'FE-100');
      assert.equal(created.json.total, 120000);
      assert.match(created.json.reference_code, /^AGS-[0-9A-F]{8}-000001$/);

      const again = await createInvoice([chargeId], { externalNumber: 'FE-101' });
      assert.equal(again.status, 409);
      const stillBillable = (await env.request('GET', `/api/patients/${clinic.patientId}/billable-charges`, { cookie: admin })).json;
      assert.ok(!stillBillable.some((row: { id: string }) => row.id === chargeId));
    });

    it('un cargo facturado no se puede anular; anular la factura exige nota crédito y libera el cargo', async () => {
      const chargeId = await newCharge(50000);
      const invoice = (await createInvoice([chargeId], { externalNumber: 'FE-200' })).json;

      const voidCharge = await env.request('POST', `/api/charges/${chargeId}/void`, { cookie: admin, body: { reason: 'Error' } });
      assert.equal(voidCharge.status, 409);
      assert.match(voidCharge.json.error.message, /factura electrónica/);

      const withoutNote = await env.request('POST', `/api/einvoices/${invoice.id}/void`, { cookie: admin, body: { reason: 'Error en valor' } });
      assert.equal(withoutNote.status, 422);
      const voided = await env.request('POST', `/api/einvoices/${invoice.id}/void`, { cookie: admin, body: { reason: 'Error en valor', creditNoteRef: 'NC-5' } });
      assert.equal(voided.json.status, 'anulada');
      assert.equal(voided.json.credit_note_ref, 'NC-5');
      assert.equal((await env.request('POST', `/api/charges/${chargeId}/void`, { cookie: admin, body: { reason: 'Error' } })).status, 200);
    });

    it('dos facturas simultáneas con el mismo cargo: solo una queda', async () => {
      const chargeId = await newCharge(30000);
      const results = await Promise.all([createInvoice([chargeId], { externalNumber: 'FE-300' }), createInvoice([chargeId], { externalNumber: 'FE-301' })]);
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    });
  });

  describe('Factus', () => {
    it('valida credenciales al probar la conexión y nunca devuelve los secretos', async () => {
      const incomplete = await saveSettings({ provider: 'factus', environment: 'pruebas', clientId: 'cid' });
      assert.equal(incomplete.status, 422);

      const bad = await saveSettings({ provider: 'factus', environment: 'pruebas', clientId: 'cid', clientSecret: 'secreto-cliente-123', username: 'consultorio@correo.co', password: 'otra-clave' });
      assert.equal(bad.status, 200);
      assert.equal((await env.request('POST', '/api/settings/einvoicing/test', { cookie: admin })).status, 422);

      const saved = await saveSettings({ provider: 'factus', environment: 'pruebas', clientId: 'cid', username: 'consultorio@correo.co', password: 'clave-factus', numberingRangeId: 8 });
      assert.equal(saved.status, 200);
      assert.ok(!saved.text.includes('secreto-cliente-123') && !saved.text.includes('clave-factus'), 'No expone secretos');
      assert.ok(saved.json.maskedClientSecret, 'Conserva el client secret anterior');
      const test = await env.request('POST', '/api/settings/einvoicing/test', { cookie: admin });
      assert.equal(test.status, 200, test.text);
      assert.ok(calls.some((call) => call.url === 'https://api-sandbox.factus.com.co/oauth/token'));

      const stored = await env.db.prepare('SELECT credentials_enc, public_config FROM einvoice_settings WHERE tenant_id = ?').bind(clinic.tenantId).first<{ credentials_enc: string; public_config: string }>();
      assert.ok(stored && !stored.credentials_enc.includes('clave-factus') && !stored.public_config.includes('clave-factus'), 'Cifrado en la base');
      const audit = await env.db.prepare("SELECT details FROM audit_log WHERE action = 'facturacion_configurada'").all<{ details: string }>();
      assert.ok(audit.results.every((row) => !row.details.includes('clave-factus') && !row.details.includes('secreto-cliente')));
    });

    it('emite la factura: número, CUFE, enlaces y token reutilizado', async () => {
      const tokenCallsBefore = calls.filter((call) => call.url.endsWith('/oauth/token')).length;
      const created = await createInvoice([await newCharge()], { customerEmail: 'paciente@correo.co' });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.json.status, 'emitida');
      assert.match(created.json.number, /^SETP99000\d+$/);
      assert.ok(created.json.cufe);
      assert.equal(created.json.public_url, 'https://factus.com.co/f/1');

      const sent = JSON.parse(calls.filter((call) => call.url.endsWith('/v2/bills/validate')).at(-1)?.body ?? '{}');
      assert.equal(sent.numbering_range_id, 8);
      assert.equal(sent.customer.email, 'paciente@correo.co');
      assert.equal(sent.reference_code, created.json.reference_code);

      await createInvoice([await newCharge()]);
      const tokenCallsAfter = calls.filter((call) => call.url.endsWith('/oauth/token')).length;
      assert.equal(tokenCallsAfter - tokenCallsBefore, 0, 'Reutiliza (cifrado) el token obtenido al probar la conexión');
    });

    it('rechazo de la DIAN/Factus: guarda el motivo y libera los cargos', async () => {
      factusBehavior = 'reject';
      const chargeId = await newCharge();
      const created = await createInvoice([chargeId]);
      factusBehavior = 'ok';
      assert.equal(created.json.status, 'rechazada');
      assert.match(created.json.last_error, /customer\.identification/);
      const billable = (await env.request('GET', `/api/patients/${clinic.patientId}/billable-charges`, { cookie: admin })).json;
      assert.ok(billable.some((row: { id: string }) => row.id === chargeId), 'El cargo vuelve a estar disponible');
    });

    it('falla de red: queda pendiente y el reintento usa la MISMA referencia', async () => {
      factusBehavior = 'network';
      const created = await createInvoice([await newCharge()]);
      assert.equal(created.json.status, 'pendiente');
      assert.match(created.json.last_error, /Reintenta/);
      factusBehavior = 'ok';
      const retried = await env.request('POST', `/api/einvoices/${created.json.id}/retry`, { cookie: admin });
      assert.equal(retried.json.status, 'emitida');
      assert.equal(retried.json.attempts, 2);
      const references = calls.filter((call) => call.url.endsWith('/v2/bills/validate')).slice(-2).map((call) => JSON.parse(call.body).reference_code);
      assert.equal(references[0], references[1]);
      const again = await env.request('POST', `/api/einvoices/${created.json.id}/retry`, { cookie: admin });
      assert.equal(again.status, 409, 'Una emitida no se reenvía');
    });
  });

  describe('Webhook', () => {
    it('envía la factura firmada con HMAC y guarda el número que responde', async () => {
      const ssrf = await saveSettings({ provider: 'webhook', webhookUrl: 'https://localhost/hook', webhookSecret: 'secreto-webhook-1234567' });
      assert.equal(ssrf.status, 422);
      const saved = await saveSettings({ provider: 'webhook', webhookUrl: 'https://hook.example.co/factura', webhookSecret: 'secreto-webhook-1234567' });
      assert.equal(saved.status, 200, saved.text);

      const created = await createInvoice([await newCharge()]);
      assert.equal(created.json.status, 'emitida');
      assert.equal(created.json.number, 'WH-1');
      const call = calls.at(-1)!;
      const expected = createHmac('sha256', 'secreto-webhook-1234567').update(`${call.headers['x-agendasonrisa-timestamp']}.${call.body}`).digest('hex');
      assert.equal(call.headers['x-agendasonrisa-signature'], `sha256=${expected}`);
      assert.equal(JSON.parse(call.body).event, 'invoice.issue');
    });
  });

  describe('Permisos y aislamiento', () => {
    it('Recepción emite pero no configura; Odontólogo no ve facturación', async () => {
      const reception = await env.createUserWithRoles(admin, 'recepcion-fe@prueba.co', ['Recepción']);
      assert.equal((await env.request('GET', '/api/einvoices', { cookie: reception.cookie })).status, 200);
      assert.equal((await env.request('PUT', '/api/settings/einvoicing', { cookie: reception.cookie, body: { provider: 'externo' } })).status, 403);
      const dentist = await env.createUserWithRoles(admin, 'odontologo-fe@prueba.co', ['Odontólogo']);
      assert.equal((await env.request('GET', '/api/einvoices', { cookie: dentist.cookie })).status, 403);
    });

    it('otro consultorio no ve ni factura cargos ajenos', async () => {
      const chargeId = await newCharge();
      const other = await env.createClinic('Otro Consultorio FE', 'admin-otro-fe@prueba.co');
      const otherAdmin = await env.login(other.adminEmail);
      assert.equal((await env.request('GET', '/api/einvoices', { cookie: otherAdmin })).json.length, 0);
      const steal = await env.request('POST', '/api/einvoices', {
        cookie: otherAdmin,
        body: { patientId: clinic.patientId, chargeIds: [chargeId], paymentForm: 'contado', paymentMethod: 'efectivo', externalNumber: 'X-1' },
      });
      assert.equal(steal.status, 404);
    });
  });
});
