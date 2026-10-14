/**
 * Lectura de facturas electrónicas DIAN (UBL 2.1) para registrar compras.
 *
 * Se ejecuta en el navegador (DOMParser): no consume CPU del servidor ni
 * requiere servicios externos. Acepta:
 *   • El XML de la factura (<Invoice>).
 *   • El "AttachedDocument" que envían los proveedores por correo (trae la
 *     factura dentro, en un CDATA).
 * Lo compartido con las pruebas recibe la función de parseo como parámetro.
 */

export interface ParsedInvoiceLine {
  supplierCode: string | null;
  description: string;
  quantity: number;
  lineTotal: number;
  taxAmount: number;
}

export interface ParsedInvoice {
  invoiceNumber: string;
  cufe: string | null;
  issueDate: string;
  dueDate: string | null;
  supplier: { name: string; nit: string | null };
  lines: ParsedInvoiceLine[];
  subtotal: number;
  taxTotal: number;
  /** Total a pagar según la factura (puede diferir por retenciones o descuentos globales). */
  payableAmount: number;
}

export class InvoiceXmlError extends Error {}

/** Lo mínimo del DOM que se usa (compatible con DOMParser del navegador y @xmldom en pruebas). */
interface XmlNode {
  readonly nodeType: number;
  readonly childNodes: ArrayLike<XmlNode>;
  readonly localName?: string | null;
  readonly textContent: string | null;
}
interface XmlDocument extends XmlNode {
  getElementsByTagName(name: string): { readonly length: number };
}
type Element = XmlNode;
type Document = XmlDocument;
type XmlParser = (xml: string) => XmlDocument;

const ELEMENT_NODE = 1;

function childElements(parent: Element | Document): Element[] {
  const result: Element[] = [];
  const nodes = parent.childNodes;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node?.nodeType === ELEMENT_NODE) result.push(node as Element);
  }
  return result;
}

/** Hijo directo por nombre local (ignora prefijos cbc:/cac:). */
function child(parent: Element | null | undefined, localName: string): Element | null {
  if (!parent) return null;
  return childElements(parent).find((element) => element.localName === localName) ?? null;
}

/** Ruta de hijos directos: path(invoice, 'AccountingSupplierParty', 'Party'). */
function path(parent: Element | null | undefined, ...names: string[]): Element | null {
  let current: Element | null | undefined = parent;
  for (const name of names) current = child(current, name);
  return current ?? null;
}

function text(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

/** Pesos sin centavos (la factura puede traer decimales). */
function money(element: Element | null): number {
  const value = Number.parseFloat(text(element));
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function rootElement(document: Document): Element {
  const root = childElements(document)[0];
  if (!root) throw new InvoiceXmlError('El archivo está vacío o no es XML.');
  return root;
}

function extractInvoice(document: Document, parse: XmlParser): Element {
  const root = rootElement(document);
  if (root.localName === 'Invoice') return root;
  if (root.localName === 'AttachedDocument') {
    const embedded = text(path(root, 'Attachment', 'ExternalReference', 'Description'));
    if (!embedded) throw new InvoiceXmlError('El AttachedDocument no trae la factura adentro.');
    const inner = rootElement(safeParse(embedded, parse));
    if (inner.localName !== 'Invoice') throw new InvoiceXmlError('El documento adjunto no es una factura (puede ser una nota crédito).');
    return inner;
  }
  if (root.localName === 'CreditNote' || root.localName === 'DebitNote') {
    throw new InvoiceXmlError('Este XML es una nota crédito/débito. Solo se importan facturas.');
  }
  throw new InvoiceXmlError('El XML no es una factura electrónica DIAN.');
}

function safeParse(xml: string, parse: XmlParser): Document {
  // Las facturas no usan DTD; se rechazan para evitar ataques de entidades.
  if (/<!DOCTYPE/i.test(xml)) throw new InvoiceXmlError('El XML trae una declaración DOCTYPE no permitida.');
  let document: Document;
  try {
    document = parse(xml);
  } catch {
    throw new InvoiceXmlError('El archivo no es un XML válido.');
  }
  if (document.getElementsByTagName('parsererror').length > 0) throw new InvoiceXmlError('El archivo no es un XML válido.');
  return document;
}

export function parseDianInvoice(xml: string, parse: XmlParser): ParsedInvoice {
  if (xml.length > 5_000_000) throw new InvoiceXmlError('El archivo es demasiado grande (máximo 5 MB).');
  const invoice = extractInvoice(safeParse(xml, parse), parse);

  const invoiceNumber = text(child(invoice, 'ID'));
  const issueDate = text(child(invoice, 'IssueDate'));
  if (!invoiceNumber || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new InvoiceXmlError('La factura no tiene número o fecha de emisión válidos.');
  }
  const dueDate = text(child(invoice, 'DueDate')) || text(path(invoice, 'PaymentMeans', 'PaymentDueDate')) || null;

  const party = path(invoice, 'AccountingSupplierParty', 'Party');
  const taxScheme = child(party, 'PartyTaxScheme');
  const supplierName =
    text(child(taxScheme, 'RegistrationName')) ||
    text(path(party, 'PartyLegalEntity', 'RegistrationName')) ||
    text(path(party, 'PartyName', 'Name'));
  const supplierNit = text(child(taxScheme, 'CompanyID')) || text(path(party, 'PartyLegalEntity', 'CompanyID')) || null;
  if (!supplierName) throw new InvoiceXmlError('La factura no trae el nombre del proveedor.');

  const lines = childElements(invoice)
    .filter((element) => element.localName === 'InvoiceLine')
    .map((line): ParsedInvoiceLine => {
      const item = child(line, 'Item');
      const quantity = Number.parseFloat(text(child(line, 'InvoicedQuantity')));
      return {
        supplierCode: text(path(item, 'SellersItemIdentification', 'ID')) || text(path(item, 'StandardItemIdentification', 'ID')) || null,
        description: (text(child(item, 'Description')) || 'Producto sin descripción').slice(0, 300),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        lineTotal: money(child(line, 'LineExtensionAmount')),
        taxAmount: childElements(line)
          .filter((element) => element.localName === 'TaxTotal')
          .reduce((total, taxTotal) => total + money(child(taxTotal, 'TaxAmount')), 0),
      };
    });
  if (lines.length === 0) throw new InvoiceXmlError('La factura no tiene líneas de productos.');

  const monetaryTotal = child(invoice, 'LegalMonetaryTotal');
  return {
    invoiceNumber: invoiceNumber.slice(0, 40),
    cufe: text(child(invoice, 'UUID')) || null,
    issueDate,
    dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
    supplier: { name: supplierName.slice(0, 150), nit: supplierNit },
    lines,
    subtotal: lines.reduce((total, line) => total + line.lineTotal, 0),
    taxTotal: lines.reduce((total, line) => total + line.taxAmount, 0),
    payableAmount: money(child(monetaryTotal, 'PayableAmount')),
  };
}
