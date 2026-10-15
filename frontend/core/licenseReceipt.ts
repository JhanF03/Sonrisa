/**
 * Comprobante de pago de la licencia de Agenda Sonrisa (el mismo que llega por
 * correo). Lo usan "Mi plan" del consultorio y el panel del dueño; se imprime
 * o se guarda como PDF desde el navegador.
 */
import { api } from './api.js';
import { $, html } from './dom.js';
import { formatLongDate, formatMoney, formatUtcAsLocal } from './format.js';
import { icon, openModal, refreshIcons, withErrorToast } from './ui.js';
import { receiptNote, taxNotice, type LegalInfo } from '../../src/shared/legal.js';

export interface LicenseReceipt {
  id: string;
  number: number | null;
  createdAt: string;
  status: 'aprobado' | 'anulado';
  voidReason: string | null;
  amount: number;
  method: string;
  reference: string | null;
  concept: string;
  periodFrom: string | null;
  paidUntil: string;
  customer: { clinicName: string; contactName: string | null; email: string | null; city: string | null };
  provider: LegalInfo;
}

const METHOD_LABELS: Record<string, string> = {
  wompi: 'En línea (Wompi)', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', efectivo: 'Efectivo', tarjeta: 'Tarjeta', otro: 'Otro',
};

export const receiptLabel = (number: number | null) => (number ? `N.º ${String(number).padStart(6, '0')}` : 'sin número');

/** Abre el comprobante. `url` es el endpoint del consultorio o del dueño. */
export async function openLicenseReceipt(url: string): Promise<void> {
  const receipt = await withErrorToast(() => api.get<LicenseReceipt>(url));
  if (!receipt) return;
  const { provider, customer } = receipt;
  const modal = openModal({
    title: `Comprobante de pago ${receiptLabel(receipt.number)}`,
    iconName: 'receipt',
    content: html`<div class="receipt">
      <div class="receipt-header">
        <div><strong>${provider.providerName || 'Agenda Sonrisa'}</strong><br />
          <span class="muted">${[provider.providerId, provider.city].filter(Boolean).join(' · ')}</span><br />
          <span class="muted">${provider.contactEmail}</span></div>
        <div class="receipt-number">Comprobante de pago<br />${receiptLabel(receipt.number)}</div>
      </div>
      ${receipt.status === 'anulado' ? html`<p class="form-error">ANULADO: ${receipt.voidReason ?? ''}</p>` : ''}
      <dl class="detail-list">
        <dt>Fecha</dt><dd>${formatUtcAsLocal(receipt.createdAt, -300)}</dd>
        <dt>Recibido de</dt><dd>${customer.clinicName}${customer.contactName ? ` (${customer.contactName})` : ''}${customer.city ? ` · ${customer.city}` : ''}</dd>
        ${customer.email ? html`<dt>Correo</dt><dd>${customer.email}</dd>` : ''}
        <dt>Medio de pago</dt><dd>${METHOD_LABELS[receipt.method] ?? receipt.method}${receipt.reference ? ` · Ref. ${receipt.reference}` : ''}</dd>
      </dl>
      <table>
        <thead><tr><th>Concepto</th><th class="align-right">Valor</th></tr></thead>
        <tbody><tr>
          <td>${receipt.concept}<br /><span class="subtle">${receipt.periodFrom ? `Del ${formatLongDate(receipt.periodFrom)} al ${formatLongDate(receipt.paidUntil)}` : `Cubre hasta el ${formatLongDate(receipt.paidUntil)}`}</span></td>
          <td class="money">${formatMoney(receipt.amount)}</td>
        </tr></tbody>
      </table>
      <p class="total">Total pagado: ${formatMoney(receipt.amount)}</p>
      <p class="subtle">${receiptNote(provider)}</p>
      <p class="subtle">${taxNotice(provider)}</p>
      <div class="modal-actions no-print">
        <button class="button button-secondary" type="button" data-close-modal>Cerrar</button>
        <button class="button button-primary" type="button" data-action="print">${icon('printer')} Imprimir o guardar PDF</button>
      </div>
    </div>`,
  });
  refreshIcons(modal.dialog);
  $('[data-action="print"]', modal.dialog).addEventListener('click', () => window.print());
}
