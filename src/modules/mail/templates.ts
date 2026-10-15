/**
 * Plantillas de los correos (HTML con estilos en línea, que es lo que leen
 * Gmail y Outlook, más una versión en texto plano).
 */
import { receiptNote, taxNotice, type LegalInfo } from '../../shared/legal.js';
import type { OutgoingMail } from './smtpClient.js';

const INK = '#1d232b';
const BLUE = '#2742a8';
const MUTED = '#56606b';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = (value: number) => `$ ${value.toLocaleString('es-CO')}`;
const longDate = (localDate: string) =>
  new Date(`${localDate}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

interface Layout {
  to: string;
  subject: string;
  /** Título grande del correo. */
  heading: string;
  /** Párrafos y bloques ya escapados. */
  bodyHtml: string;
  text: string;
  button?: { label: string; url: string };
  legal: LegalInfo;
  baseUrl: string;
}

function layout({ to, subject, heading, bodyHtml, text, button, legal, baseUrl }: Layout): OutgoingMail {
  const footerLinks = baseUrl
    ? `<a href="${escapeHtml(baseUrl)}/legal/terminos" style="color:${MUTED}">Términos</a> · <a href="${escapeHtml(baseUrl)}/legal/privacidad" style="color:${MUTED}">Tratamiento de datos</a>`
    : '';
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f2f4f5;font-family:Arial,Helvetica,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9dee3;border-radius:10px;overflow:hidden">
<tr><td style="background:${INK};padding:16px 24px;color:#ffffff;font-size:16px;font-weight:bold">Agenda Sonrisa</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${INK}">${escapeHtml(heading)}</h1>
${bodyHtml}
${button ? `<p style="margin:22px 0 6px"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px">${escapeHtml(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #d9dee3;font-size:12px;line-height:1.5;color:${MUTED}">
${escapeHtml(legal.providerName || 'Agenda Sonrisa')}${legal.city ? ` · ${escapeHtml(legal.city)}` : ''}${legal.contactEmail ? ` · ${escapeHtml(legal.contactEmail)}` : ''}<br>${footerLinks}
</td></tr></table></td></tr></table></body></html>`;
  return { to, subject, html, text: `${text}${button ? `\n\n${button.label}: ${button.url}` : ''}\n\n— Agenda Sonrisa${legal.providerName ? ` · ${legal.providerName}` : ''}` };
}

const p = (content: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${content}</p>`;

export function welcomeEmail(input: { to: string; name: string; clinicName: string; planName: string; trialUntil: string; baseUrl: string; legal: LegalInfo }): OutgoingMail {
  return layout({
    ...input,
    subject: `Tu consultorio ${input.clinicName} está listo`,
    heading: `Bienvenida a Agenda Sonrisa, ${input.name.split(' ')[0]}`,
    bodyHtml:
      p(`Creamos <strong>${escapeHtml(input.clinicName)}</strong> con el plan <strong>${escapeHtml(input.planName)}</strong>.`) +
      p(`Tu prueba gratis va hasta el <strong>${escapeHtml(longDate(input.trialUntil))}</strong>. Antes de esa fecha te avisamos para que elijas cómo pagar desde <em>Mi plan</em>; si no pagas, el acceso se pausa pero no se borra nada.`) +
      p('Primeros pasos: agrega tus profesionales y sus horarios en Configuración, crea tus servicios y comparte tu enlace de reservas.'),
    text: `Creamos ${input.clinicName} con el plan ${input.planName}. Tu prueba gratis va hasta el ${longDate(input.trialUntil)}.`,
    button: { label: 'Entrar a mi consultorio', url: `${input.baseUrl}/app` },
  });
}

export function demoEmail(input: { to: string; name: string; loginEmail: string; expiresAt: string; baseUrl: string; legal: LegalInfo }): OutgoingMail {
  const expires = longDate(input.expiresAt.slice(0, 10));
  return layout({
    ...input,
    subject: 'Tu demo de Agenda Sonrisa',
    heading: 'Tu demo está lista',
    bodyHtml:
      p(`Hola ${escapeHtml(input.name.split(' ')[0])}. Para volver a entrar usa este usuario y la contraseña que escribiste:`) +
      `<p style="margin:0 0 12px;font-size:16px;font-weight:bold;font-family:Consolas,monospace">${escapeHtml(input.loginEmail)}</p>` +
      p(`La demo tiene datos de ejemplo y estará disponible hasta el <strong>${escapeHtml(expires)}</strong>; luego se borra sola.`) +
      p(`Cuando quieras empezar con tus pacientes, crea tu consultorio con la prueba gratis: <a href="${escapeHtml(input.baseUrl)}/registro" style="color:${BLUE}">ver planes</a>.`),
    text: `Usuario de tu demo: ${input.loginEmail}. Disponible hasta el ${expires}. Crea tu consultorio: ${input.baseUrl}/registro`,
    button: { label: 'Entrar a la demo', url: `${input.baseUrl}/app` },
  });
}

export function demoEndingEmail(input: { to: string; name: string; expiresAt: string; baseUrl: string; legal: LegalInfo }): OutgoingMail {
  const expires = longDate(input.expiresAt.slice(0, 10));
  return layout({
    ...input,
    subject: 'Tu demo termina pronto',
    heading: 'Tu demo termina pronto',
    bodyHtml:
      p(`Hola ${escapeHtml(input.name.split(' ')[0])}. Tu demo de Agenda Sonrisa se borra el <strong>${escapeHtml(expires)}</strong>.`) +
      p('Si te sirvió, crea tu consultorio real con la prueba gratis: empieza vacío y eliges el plan que necesitas.'),
    text: `Tu demo se borra el ${expires}. Crea tu consultorio: ${input.baseUrl}/registro`,
    button: { label: 'Crear mi consultorio', url: `${input.baseUrl}/registro` },
  });
}

export type ReminderKind = 'por_vencer' | 'vence_manana' | 'vencida' | 'suspendida';

export function reminderEmail(input: {
  to: string; kind: ReminderKind; clinicName: string; onTrial: boolean; paidUntil: string; suspendOn: string | null; monthlyPrice: number; baseUrl: string; legal: LegalInfo;
}): OutgoingMail {
  const what = input.onTrial ? 'tu prueba gratis' : 'tu suscripción';
  const until = longDate(input.paidUntil);
  const headings: Record<ReminderKind, string> = {
    por_vencer: input.onTrial ? 'Tu prueba gratis termina pronto' : 'Tu suscripción vence pronto',
    vence_manana: input.onTrial ? 'Tu prueba gratis termina mañana' : 'Tu suscripción vence mañana',
    vencida: input.onTrial ? 'Terminó tu prueba gratis' : 'Tu suscripción venció',
    suspendida: 'El acceso a tu consultorio está pausado',
  };
  const bodies: Record<ReminderKind, string> = {
    por_vencer: `${what[0]?.toUpperCase()}${what.slice(1)} de <strong>${escapeHtml(input.clinicName)}</strong> va hasta el <strong>${escapeHtml(until)}</strong>.`,
    vence_manana: `${what[0]?.toUpperCase()}${what.slice(1)} de <strong>${escapeHtml(input.clinicName)}</strong> termina el <strong>${escapeHtml(until)}</strong>.`,
    vencida: `${what[0]?.toUpperCase()}${what.slice(1)} de <strong>${escapeHtml(input.clinicName)}</strong> terminó el ${escapeHtml(until)}.${input.suspendOn ? ` Puedes seguir entrando hasta el <strong>${escapeHtml(longDate(input.suspendOn))}</strong>.` : ''}`,
    suspendida: `El acceso a <strong>${escapeHtml(input.clinicName)}</strong> se pausó por falta de pago. Tus pacientes, citas y caja están intactos: vuelven en cuanto pagues.`,
  };
  return layout({
    ...input,
    subject: `${headings[input.kind]} · ${input.clinicName}`,
    heading: headings[input.kind],
    bodyHtml:
      p(bodies[input.kind]) +
      (input.monthlyPrice ? p(`Valor del plan: <strong>${escapeHtml(money(input.monthlyPrice))}</strong> al mes. Puedes pagar mensual o anual con tarjeta, PSE o Nequi; el acceso se activa al instante.`) : ''),
    text: `${headings[input.kind]}. ${bodies[input.kind].replace(/<[^>]+>/g, '')} Paga desde Mi plan.`,
    button: { label: 'Pagar desde Mi plan', url: `${input.baseUrl}/app#/suscripcion/pagar` },
  });
}

export interface ReceiptData {
  number: number | null;
  createdAt: string;
  amount: number;
  method: string;
  reference: string | null;
  concept: string;
  periodFrom: string | null;
  paidUntil: string;
  customer: { clinicName: string; contactName: string | null; email: string | null; city: string | null };
  provider: LegalInfo;
}

export const receiptNumberLabel = (number: number | null) => (number ? `N.º ${String(number).padStart(6, '0')}` : 'Sin número');

const METHOD_LABELS: Record<string, string> = {
  wompi: 'En línea (Wompi)', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', efectivo: 'Efectivo', tarjeta: 'Tarjeta', otro: 'Otro',
};

export function receiptEmail(input: { to: string; receipt: ReceiptData; baseUrl: string }): OutgoingMail {
  const { receipt } = input;
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:${MUTED};font-size:14px;vertical-align:top;width:40%">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px">${value}</td></tr>`;
  const date = new Date(receipt.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });
  const provider = receipt.provider;
  return layout({
    to: input.to,
    legal: provider,
    baseUrl: input.baseUrl,
    subject: `Comprobante de pago ${receiptNumberLabel(receipt.number)} · Agenda Sonrisa`,
    heading: 'Recibimos tu pago',
    bodyHtml:
      p(`Gracias. Este es el comprobante de pago de <strong>${escapeHtml(receipt.customer.clinicName)}</strong>.`) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #d9dee3;border-bottom:1px solid #d9dee3;margin:8px 0 14px">
${row('Comprobante', `<strong>${escapeHtml(receiptNumberLabel(receipt.number))}</strong>`)}
${row('Fecha', escapeHtml(date))}
${row('Recibido de', escapeHtml(`${receipt.customer.clinicName}${receipt.customer.contactName ? ` (${receipt.customer.contactName})` : ''}`))}
${row('Concepto', escapeHtml(receipt.concept))}
${row('Cubre hasta', escapeHtml(longDate(receipt.paidUntil)))}
${row('Medio de pago', escapeHtml(`${METHOD_LABELS[receipt.method] ?? receipt.method}${receipt.reference ? ` · ${receipt.reference}` : ''}`))}
${row('Valor pagado', `<strong style="font-size:16px">${escapeHtml(money(receipt.amount))}</strong>`)}
${row('Recibido por', escapeHtml(`${provider.providerName || 'Agenda Sonrisa'}${provider.providerId ? ` · ${provider.providerId}` : ''}${provider.city ? ` · ${provider.city}` : ''}`))}
</table>` +
      `<p style="margin:0 0 8px;font-size:12.5px;line-height:1.5;color:${MUTED}">${escapeHtml(receiptNote(provider))}</p>` +
      `<p style="margin:0;font-size:12.5px;line-height:1.5;color:${MUTED}">${escapeHtml(taxNotice(provider))}</p>`,
    text: `Comprobante de pago ${receiptNumberLabel(receipt.number)}\nFecha: ${date}\nRecibido de: ${receipt.customer.clinicName}\nConcepto: ${receipt.concept}\nCubre hasta: ${longDate(receipt.paidUntil)}\nValor: ${money(receipt.amount)}\n${receiptNote(provider)}`,
    button: { label: 'Ver mis pagos', url: `${input.baseUrl}/app#/suscripcion/pagos` },
  });
}

export function passwordResetEmail(input: { to: string; name: string; url: string; legal: LegalInfo; baseUrl: string }): OutgoingMail {
  return layout({
    ...input,
    subject: 'Restablece tu contraseña · Agenda Sonrisa',
    heading: 'Restablece tu contraseña',
    bodyHtml:
      p(`Hola ${escapeHtml(input.name.split(' ')[0])}. Alguien pidió cambiar la contraseña de tu usuario. El enlace sirve una sola vez durante 1 hora.`) +
      p('Si no fuiste tú, ignora este correo: tu contraseña sigue igual.'),
    text: `Restablece tu contraseña (1 hora, un solo uso): ${input.url}\nSi no fuiste tú, ignora este correo.`,
    button: { label: 'Elegir una contraseña nueva', url: input.url },
  });
}

export function ownerAlertEmail(input: { to: string; subject: string; lines: string[]; baseUrl: string; legal: LegalInfo }): OutgoingMail {
  return layout({
    ...input,
    heading: input.subject,
    bodyHtml: input.lines.map((line) => p(escapeHtml(line))).join(''),
    text: input.lines.join('\n'),
    button: { label: 'Abrir el panel del dueño', url: `${input.baseUrl}/plataforma` },
  });
}
