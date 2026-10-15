/**
 * Textos legales y tributarios que se repiten en el sitio, el panel y los
 * comprobantes. Cambia TERMS_VERSION cada vez que cambie el texto de los
 * términos o de la política de datos: así queda registrado qué versión aceptó
 * cada consultorio.
 *
 * Estos textos son una base redactada según la normativa colombiana
 * (Ley 1581 de 2012, Decreto 1074 de 2015, Ley 1480 de 2011, Ley 527 de 1999 y
 * Estatuto Tributario). Conviene que un abogado los revise antes de crecer.
 */

export const TERMS_VERSION = '2026-10-15';

export type TaxRegime = 'no_responsable_iva' | 'responsable_iva';

export interface LegalInfo {
  /** Nombre de quien presta el servicio (persona natural o empresa). */
  providerName: string;
  /** Cédula o NIT. */
  providerId: string;
  city: string;
  /** Correo para consultas, reclamos y datos personales. */
  contactEmail: string;
  whatsapp: string;
  taxRegime: TaxRegime;
  termsVersion: string;
}

/** Aviso corto de precios e impuestos (pie de página, Mi plan, comprobantes). */
export function taxNotice(info: Pick<LegalInfo, 'providerName' | 'taxRegime'>): string {
  const provider = info.providerName || 'quien presta el servicio';
  if (info.taxRegime === 'responsable_iva') {
    return `Precios en pesos colombianos (COP) con IVA incluido. ${provider} envía la factura electrónica de cada pago.`;
  }
  return `Precios en pesos colombianos (COP). ${provider} presta el servicio como persona natural no responsable de IVA (parágrafo 3 del artículo 437 del Estatuto Tributario): a los precios no se les suma IVA. Por cada pago se envía un comprobante de pago; no se expide factura electrónica porque no hay obligación de facturar. Si tu consultorio está obligado, puede soportar el gasto con el documento soporte de adquisiciones a no obligados a facturar.`;
}

/** Nota del comprobante de pago. */
export function receiptNote(info: Pick<LegalInfo, 'taxRegime'>): string {
  return info.taxRegime === 'responsable_iva'
    ? 'Este comprobante confirma el pago; la factura electrónica se envía por separado.'
    : 'Comprobante de pago. No es factura electrónica: quien presta el servicio es persona natural no responsable de IVA y no está obligada a facturar. IVA: no aplica.';
}
