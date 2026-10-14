/**
 * Fase 2: proveedores, compras, cuentas por pagar, inventario, recetas,
 * consumo automático y lectura del XML de la DIAN.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { InvoiceXmlError, parseDianInvoice } from '../src/shared/dianInvoiceXml.js';
import { todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, nextBusinessDay, type TestClinic } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml') as never;

const INVOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>FEV-1234</cbc:ID>
  <cbc:UUID schemeName="CUFE-SHA384">a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6</cbc:UUID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  <cbc:DueDate>2026-10-31</cbc:DueDate>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>DentalMax</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:RegistrationName>DentalMax S.A.S.</cbc:RegistrationName><cbc:CompanyID schemeID="7">900123456</cbc:CompanyID></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="COP">69020.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="BX">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">40000.00</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="COP">7600.00</cbc:TaxAmount></cac:TaxTotal>
    <cac:Item><cbc:Description>Guantes nitrilo caja x100</cbc:Description><cac:SellersItemIdentification><cbc:ID>GN-100</cbc:ID></cac:SellersItemIdentification></cac:Item>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="EA">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">18000.50</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="COP">3420.00</cbc:TaxAmount></cac:TaxTotal>
    <cac:Item><cbc:Description>Resina A2 4g</cbc:Description><cac:StandardItemIdentification><cbc:ID>RES-A2</cbc:ID></cac:StandardItemIdentification></cac:Item>
  </cac:InvoiceLine>
</Invoice>`;

describe('Lectura de factura electrónica DIAN (XML)', () => {
  it('lee una factura UBL: proveedor, NIT, fechas, CUFE y líneas', () => {
    const invoice = parseDianInvoice(INVOICE_XML, parseXml);
    assert.equal(invoice.invoiceNumber, 'FEV-1234');
    assert.equal(invoice.issueDate, '2026-10-01');
    assert.equal(invoice.dueDate, '2026-10-31');
    assert.deepEqual(invoice.supplier, { name: 'DentalMax S.A.S.', nit: '900123456' });
    assert.equal(invoice.cufe?.startsWith('a1b2'), true);
    assert.equal(invoice.lines.length, 2);
    assert.deepEqual(invoice.lines[0], { supplierCode: 'GN-100', description: 'Guantes nitrilo caja x100', quantity: 2, lineTotal: 40000, taxAmount: 7600 });
    assert.equal(invoice.lines[1]?.supplierCode, 'RES-A2');
    assert.equal(invoice.lines[1]?.lineTotal, 18001, 'Los centavos se redondean a pesos');
    assert.equal(invoice.payableAmount, 69020);
  });

  it('lee la factura dentro de un AttachedDocument (el XML que llega por correo)', () => {
    const attached = `<?xml version="1.0"?>
      <AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2"
        xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
        xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
        <cbc:ID>AD-1</cbc:ID>
        <cac:Attachment><cac:ExternalReference><cbc:MimeCode>text/xml</cbc:MimeCode>
          <cbc:Description><![CDATA[${INVOICE_XML.replace('<?xml version="1.0" encoding="UTF-8"?>', '')}]]></cbc:Description>
        </cac:ExternalReference></cac:Attachment>
      </AttachedDocument>`;
    assert.equal(parseDianInvoice(attached, parseXml).invoiceNumber, 'FEV-1234');
  });

  it('rechaza notas crédito, XML con DOCTYPE (XXE) y archivos que no son factura', () => {
    assert.throws(() => parseDianInvoice('<CreditNote><ID>1</ID></CreditNote>', parseXml), InvoiceXmlError);
    assert.throws(() => parseDianInvoice('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Invoice>&e;</Invoice>', parseXml), /DOCTYPE/);
    assert.throws(() => parseDianInvoice('<Pedido/>', parseXml), InvoiceXmlError);
    assert.throws(() => parseDianInvoice('<Invoice><ID>1</ID><IssueDate>2026-10-01</IssueDate></Invoice>', parseXml), InvoiceXmlError);
  });
});

describe('Compras e inventario', () => {
  let env: TestEnvironment;
  let clinic: TestClinic;
  let admin: string;
  let glovesId: string;

  before(async () => {
    env = await createTestEnvironment();
    clinic = await env.createClinic('Consultorio Inventario', 'admin-inventario@prueba.co');
    admin = await env.login(clinic.adminEmail);
  });

  const today = () => todayLocal(-300);
  const supply = async (id: string) => (await env.request('GET', '/api/supplies?all=1', { cookie: admin })).json.find((row: { id: string }) => row.id === id);
  const purchase = (body: Record<string, unknown>) => env.request('POST', '/api/purchases', { cookie: admin, body: { issueDate: today(), ...body } });

  it('crea insumos con código automático y valida duplicados', async () => {
    const created = await env.request('POST', '/api/supplies', { cookie: admin, body: { name: 'Guantes nitrilo M', unit: 'unidad', minStock: 50 } });
    assert.equal(created.status, 201);
    assert.equal(created.json.code, 'INS-0001');
    assert.equal(created.json.stock, 0);
    glovesId = created.json.id;
    const withCode = await env.request('POST', '/api/supplies', { cookie: admin, body: { code: 'res-a2', name: 'Resina A2', unit: 'g' } });
    assert.equal(withCode.json.code, 'RES-A2');
    const duplicate = await env.request('POST', '/api/supplies', { cookie: admin, body: { code: 'RES-A2', name: 'Otra', unit: 'g' } });
    assert.equal(duplicate.status, 409);
  });

  it('una compra suma al inventario con factor de conversión y costo promedio ponderado', async () => {
    const supplier = await env.request('POST', '/api/suppliers', { cookie: admin, body: { name: 'Depósito Dental', nit: '800.111.222-3' } });
    assert.equal(supplier.status, 201);
    assert.equal(supplier.json.nit, '800111222', 'El NIT se guarda sin puntos ni dígito de verificación');

    // 2 cajas x 100 guantes por $40.000 + IVA $0 → 200 guantes a $200 c/u.
    const first = await purchase({
      supplierId: supplier.json.id,
      invoiceNumber: 'A-1',
      lines: [{ supplyId: glovesId, description: 'Caja guantes', quantity: 2, conversionFactor: 100, lineTotal: 40000, taxAmount: 0 }],
    });
    assert.equal(first.status, 201);
    assert.equal(first.json.total, 40000);
    assert.equal((await supply(glovesId)).stock, 200);
    assert.equal((await supply(glovesId)).avg_cost, 200);

    // 100 guantes más a $300 → promedio (200×200 + 100×300) / 300 = 233,33.
    await purchase({
      supplierId: supplier.json.id,
      invoiceNumber: 'A-2',
      lines: [{ supplyId: glovesId, description: 'Caja guantes', quantity: 1, conversionFactor: 100, lineTotal: 30000, taxAmount: 0 }],
    });
    const gloves = await supply(glovesId);
    assert.equal(gloves.stock, 300);
    assert.ok(Math.abs(gloves.avg_cost - 233.333) < 0.01, `Costo promedio inesperado: ${gloves.avg_cost}`);
    assert.equal(gloves.stock_value, 70000);
  });

  it('no registra dos veces la misma factura del mismo proveedor', async () => {
    const suppliers = (await env.request('GET', '/api/suppliers', { cookie: admin })).json;
    const again = await purchase({
      supplierId: suppliers[0].id,
      invoiceNumber: 'a-1',
      lines: [{ supplyId: null, description: 'Algo', quantity: 1, lineTotal: 1000 }],
    });
    assert.equal(again.status, 409);
    assert.match(again.json.error.message, /ya está registrada/);
  });

  it('importación XML: crea proveedor e insumo nuevo y recuerda el código del proveedor', async () => {
    const parsed = parseDianInvoice(INVOICE_XML, parseXml);
    const created = await purchase({
      newSupplier: parsed.supplier,
      invoiceNumber: parsed.invoiceNumber,
      cufe: parsed.cufe,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate,
      source: 'xml',
      lines: [
        { supplyId: glovesId, description: parsed.lines[0]?.description, supplierCode: 'GN-100', quantity: 2, conversionFactor: 100, lineTotal: 40000, taxAmount: 7600 },
        { supplyId: null, newSupply: { name: 'Resina A3', unit: 'g' }, description: 'Resina A3 4g', supplierCode: 'RES-A3', quantity: 1, conversionFactor: 4, lineTotal: 18001, taxAmount: 3420 },
        { supplyId: null, newSupply: null, description: 'Flete', quantity: 1, lineTotal: 5000 },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.source, 'xml');
    assert.equal(created.json.total, 40000 + 7600 + 18001 + 3420 + 5000);
    assert.equal(created.json.lines[2].supply_id, null, 'El flete es gasto, no inventario');

    const supplier = (await env.request('GET', '/api/suppliers', { cookie: admin })).json.find((row: { nit: string }) => row.nit === '900123456');
    assert.ok(supplier, 'Se creó el proveedor del XML');
    const links = (await env.request('GET', `/api/suppliers/${supplier.id}/item-links`, { cookie: admin })).json;
    assert.equal(links.length, 2);
    assert.equal(links.find((link: { supplier_code: string }) => link.supplier_code === 'GN-100').conversion_factor, 100);

    const resin = (await env.request('GET', '/api/supplies', { cookie: admin })).json.find((row: { name: string }) => row.name === 'Resina A3');
    assert.equal(resin.stock, 4);
    assert.ok(Math.abs(resin.avg_cost - (18001 + 3420) / 4) < 0.01, 'El costo incluye el IVA (no descontable en salud)');

    // El mismo CUFE no entra dos veces aunque cambien el número.
    const duplicateCufe = await purchase({ supplierId: supplier.id, invoiceNumber: 'OTRO', cufe: parsed.cufe, lines: [{ description: 'X', quantity: 1, lineTotal: 1 }] });
    assert.equal(duplicateCufe.status, 409);
  });

  it('cuentas por pagar: abonos, sin sobrepago, y anulación de pagos', async () => {
    const pending = (await env.request('GET', '/api/purchases?pending=1', { cookie: admin })).json;
    const xmlPurchase = pending.find((row: { invoice_number: string }) => row.invoice_number === 'FEV-1234');
    assert.equal(xmlPurchase.balance, 74021);

    const firstPayment = await env.request('POST', `/api/purchases/${xmlPurchase.id}/payments`, {
      cookie: admin,
      body: { amount: 50000, method: 'transferencia', paymentDate: today(), reference: 'TRX-1' },
    });
    assert.equal(firstPayment.status, 201);
    assert.equal(firstPayment.json.balance, 24021);

    const overpay = await env.request('POST', `/api/purchases/${xmlPurchase.id}/payments`, {
      cookie: admin,
      body: { amount: 30000, method: 'efectivo', paymentDate: today() },
    });
    assert.equal(overpay.status, 422);

    // Dos pagos simultáneos por el saldo completo: solo uno entra.
    const [a, b] = await Promise.all(
      [1, 2].map(() => env.request('POST', `/api/purchases/${xmlPurchase.id}/payments`, { cookie: admin, body: { amount: 24021, method: 'efectivo', paymentDate: today() } })),
    );
    const statuses = [a?.status, b?.status];
    assert.equal(statuses.filter((status) => status === 201).length, 1, `Solo un pago debe entrar: ${statuses.join(', ')}`);
    assert.ok(statuses.some((status) => status === 409 || status === 422));

    const detail = (await env.request('GET', `/api/purchases/${xmlPurchase.id}`, { cookie: admin })).json;
    assert.equal(detail.balance, 0);
    assert.ok(!(await env.request('GET', '/api/purchases?pending=1', { cookie: admin })).json.some((row: { id: string }) => row.id === xmlPurchase.id));

    const voided = await env.request('POST', `/api/supplier-payments/${detail.payments[0].id}/void`, { cookie: admin, body: { reason: 'Error de digitación' } });
    assert.equal(voided.json.balance, 50000);
  });

  it('anular una compra exige anular sus pagos y revierte el inventario', async () => {
    const list = (await env.request('GET', '/api/purchases?pending=1', { cookie: admin })).json;
    const xmlPurchase = list.find((row: { invoice_number: string }) => row.invoice_number === 'FEV-1234');
    const blocked = await env.request('POST', `/api/purchases/${xmlPurchase.id}/void`, { cookie: admin, body: { reason: 'Prueba' } });
    assert.equal(blocked.status, 409, 'Tiene un pago activo');

    const detail = (await env.request('GET', `/api/purchases/${xmlPurchase.id}`, { cookie: admin })).json;
    for (const payment of detail.payments.filter((row: { status: string }) => row.status === 'activo')) {
      await env.request('POST', `/api/supplier-payments/${payment.id}/void`, { cookie: admin, body: { reason: 'Devolución' } });
    }
    const stockBefore = (await supply(glovesId)).stock;
    const voided = await env.request('POST', `/api/purchases/${xmlPurchase.id}/void`, { cookie: admin, body: { reason: 'Mercancía devuelta' } });
    assert.equal(voided.status, 200);
    assert.equal(voided.json.status, 'anulada');
    assert.equal((await supply(glovesId)).stock, stockBefore - 200);

    // Anulada, la misma factura se puede volver a registrar (corrección).
    const supplier = (await env.request('GET', '/api/suppliers', { cookie: admin })).json.find((row: { nit: string }) => row.nit === '900123456');
    const again = await purchase({ supplierId: supplier.id, invoiceNumber: 'FEV-1234', lines: [{ description: 'Corrección', quantity: 1, lineTotal: 100 }] });
    assert.equal(again.status, 201);
  });

  it('ajustes de inventario: conteo físico y entrada inicial con costo', async () => {
    const before = await supply(glovesId);
    const out = await env.request('POST', `/api/supplies/${glovesId}/adjust`, { cookie: admin, body: { quantity: -10, reason: 'Vencidos' } });
    assert.equal(out.json.stock, before.stock - 10);
    const zero = await env.request('POST', `/api/supplies/${glovesId}/adjust`, { cookie: admin, body: { quantity: 0, reason: 'Nada' } });
    assert.equal(zero.status, 422);

    const fresh = await env.request('POST', '/api/supplies', { cookie: admin, body: { name: 'Anestesia', unit: 'carpule' } });
    const initial = await env.request('POST', `/api/supplies/${fresh.json.id}/adjust`, { cookie: admin, body: { quantity: 50, reason: 'Inventario inicial', unitCost: 1500 } });
    assert.equal(initial.json.stock, 50);
    assert.equal(initial.json.avg_cost, 1500);
  });

  it('receta: costo y margen por servicio, y consumo automático al atender (sin duplicar)', async () => {
    const anesthesia = (await env.request('GET', '/api/supplies', { cookie: admin })).json.find((row: { name: string }) => row.name === 'Anestesia');
    const recipe = await env.request('PUT', `/api/services/${clinic.serviceId}/recipe`, {
      cookie: admin,
      body: { items: [{ supplyId: glovesId, quantity: 2 }, { supplyId: anesthesia.id, quantity: 1 }] },
    });
    assert.equal(recipe.status, 200);
    assert.equal(recipe.json.length, 2);

    const duplicated = await env.request('PUT', `/api/services/${clinic.serviceId}/recipe`, {
      cookie: admin,
      body: { items: [{ supplyId: glovesId, quantity: 1 }, { supplyId: glovesId, quantity: 2 }] },
    });
    assert.equal(duplicated.status, 422);

    const costs = (await env.request('GET', '/api/service-costs', { cookie: admin })).json;
    const cleaning = costs.find((row: { service_id: string }) => row.service_id === clinic.serviceId);
    const gloveCost = (await supply(glovesId)).avg_cost;
    assert.equal(cleaning.supplies_cost, Math.round(2 * gloveCost + 1500));
    assert.equal(cleaning.margin, 120000 - cleaning.supplies_cost);

    const glovesBefore = (await supply(glovesId)).stock;
    const anesthesiaBefore = (await supply(anesthesia.id)).stock;
    const appointment = await env.request('POST', '/api/appointments', {
      cookie: admin,
      body: { patientId: clinic.patientId, professionalId: clinic.professionalId, serviceId: clinic.serviceId, startAt: `${nextBusinessDay(3)}T09:00` },
    });
    assert.equal(appointment.status, 201, appointment.text);
    const appointmentId: string = appointment.json.created[0].id;
    const attended = await env.request('POST', `/api/appointments/${appointmentId}/status`, { cookie: admin, body: { status: 'atendida' } });
    assert.equal(attended.status, 200);
    assert.equal((await supply(glovesId)).stock, glovesBefore - 2);
    assert.equal((await supply(anesthesia.id)).stock, anesthesiaBefore - 1);

    // Idempotente: volver a ejecutar el consumo no descuenta otra vez.
    const services = env.app.services;
    assert.equal(await services.inventory.consumeForAppointment(clinic.tenantId, appointmentId), 0);
    assert.equal((await supply(glovesId)).stock, glovesBefore - 2);

    const movements = (await env.request('GET', `/api/stock-movements?supplyId=${glovesId}`, { cookie: admin })).json;
    const consumption = movements.find((row: { kind: string }) => row.kind === 'consumo');
    assert.equal(consumption.patient_name, 'Paciente Prueba');

    const summary = (await env.request('GET', '/api/inventory/summary', { cookie: admin })).json;
    assert.ok(summary.monthConsumptionCost > 0);
    assert.ok(summary.inventoryValue > 0);
  });

  it('marca insumos bajo el mínimo', async () => {
    const low = await env.request('POST', '/api/supplies', { cookie: admin, body: { name: 'Eyectores', unit: 'unidad', minStock: 20 } });
    await env.request('POST', `/api/supplies/${low.json.id}/adjust`, { cookie: admin, body: { quantity: 5, reason: 'Inicial', unitCost: 100 } });
    assert.equal((await supply(low.json.id)).is_low, 1);
    const summary = (await env.request('GET', '/api/inventory/summary', { cookie: admin })).json;
    assert.ok(summary.lowStockCount >= 1);
  });

  it('permisos: Recepción ve inventario pero no compras; Odontólogo no ve nada de esto', async () => {
    const reception = await env.createUserWithRoles(admin, 'recepcion-inv@prueba.co', ['Recepción']);
    assert.equal((await env.request('GET', '/api/supplies', { cookie: reception.cookie })).status, 200);
    assert.equal((await env.request('GET', '/api/purchases', { cookie: reception.cookie })).status, 403);
    assert.equal((await env.request('POST', '/api/supplies', { cookie: reception.cookie, body: { name: 'X', unit: 'unidad' } })).status, 403);

    const dentist = await env.createUserWithRoles(admin, 'odontologo-inv@prueba.co', ['Odontólogo']);
    assert.equal((await env.request('GET', '/api/supplies', { cookie: dentist.cookie })).status, 403);
    assert.equal((await env.request('GET', '/api/suppliers', { cookie: dentist.cookie })).status, 403);

    const accountant = await env.createUserWithRoles(admin, 'contable-inv@prueba.co', ['Auxiliar contable']);
    assert.equal((await env.request('GET', '/api/purchases', { cookie: accountant.cookie })).status, 200);
    assert.equal((await env.request('PUT', `/api/services/${clinic.serviceId}/recipe`, { cookie: accountant.cookie, body: { items: [] } })).status, 403);
  });

  it('aislamiento: otro consultorio no ve ni usa los insumos, compras o proveedores', async () => {
    const other = await env.createClinic('Otro Consultorio Inv', 'admin-otro-inv@prueba.co');
    const otherAdmin = await env.login(other.adminEmail);
    assert.equal((await env.request('GET', '/api/supplies', { cookie: otherAdmin })).json.length, 0);
    assert.equal((await env.request('GET', `/api/supplies/${glovesId}/adjust`, { cookie: otherAdmin })).status, 404);
    const adjust = await env.request('POST', `/api/supplies/${glovesId}/adjust`, { cookie: otherAdmin, body: { quantity: 1, reason: 'Intrusión' } });
    assert.equal(adjust.status, 404);
    const steal = await env.request('PUT', `/api/services/${other.serviceId}/recipe`, { cookie: otherAdmin, body: { items: [{ supplyId: glovesId, quantity: 1 }] } });
    assert.equal(steal.status, 404);
    const foreignPurchase = await env.request('POST', '/api/purchases', {
      cookie: otherAdmin,
      body: { issueDate: today(), invoiceNumber: 'Z-1', supplierId: null, newSupplier: { name: 'P', nit: null }, lines: [{ supplyId: glovesId, description: 'X', quantity: 1, lineTotal: 1 }] },
    });
    assert.equal(foreignPurchase.status, 404);
  });
});
