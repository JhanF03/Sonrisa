/**
 * Páginas legales públicas, armadas con los datos que el dueño guarda en su panel:
 *   /legal/terminos    → Términos y condiciones del servicio
 *   /legal/privacidad  → Política de tratamiento de datos personales (Ley 1581 de 2012)
 *
 * También exporta el pie legal que usan /registro y el panel del consultorio.
 * La versión (fecha) de los textos está en src/shared/legal.ts (TERMS_VERSION).
 */
import { api } from '../core/api.js';
import { brandLockup } from '../core/brand.js';
import { html, setContent, type SafeHtml } from '../core/dom.js';
import { formatLongDate } from '../core/format.js';
import { icon, loadingState, themeToggleButton } from '../core/ui.js';
import type { LegalInfo } from '../../src/shared/legal.js';

export interface PublicLegal extends LegalInfo {
  taxNotice: string;
}

let cachedLegal: Promise<PublicLegal> | null = null;

/** Datos legales públicos (se piden una vez por página). */
export function loadLegal(): Promise<PublicLegal> {
  cachedLegal ??= api.get<PublicLegal>('/api/public/legal').catch((error: unknown) => {
    cachedLegal = null;
    throw error;
  });
  return cachedLegal;
}

/** Enlaces a los textos legales (se abren en otra pestaña desde el panel). */
export function legalLinks(newTab = false): SafeHtml {
  const target = newTab ? html` target="_blank" rel="noopener"` : html``;
  return html`<a href="/legal/terminos"${target}>Términos del servicio</a><a href="/legal/privacidad"${target}>Tratamiento de datos</a>`;
}

/** Pie de página de /registro y de las páginas legales: precios, impuestos y enlaces. */
export function legalFooter(legal: PublicLegal | null): SafeHtml {
  const provider = legal?.providerName ? `${legal.providerName}${legal.providerId ? ` · ${legal.providerId}` : ''}${legal.city ? ` · ${legal.city}` : ''}` : 'Agenda Sonrisa';
  return html`<footer class="site-footer legal-footer">
    <div class="legal-footer-main">
      <span>${provider}. Hecho en Colombia.</span>
      <nav class="legal-footer-links" aria-label="Información legal">${legalLinks()}<a href="/app">Ingresar a mi consultorio</a></nav>
    </div>
    ${legal ? html`<p class="legal-footer-tax">${icon('scale')} ${legal.taxNotice}</p>` : ''}
    ${legal?.contactEmail ? html`<p class="legal-footer-tax">Consultas, reclamos y datos personales: <a href="mailto:${legal.contactEmail}">${legal.contactEmail}</a></p>` : ''}
  </footer>`;
}

interface Section {
  title: string;
  body: SafeHtml;
}

const p = (text: string | SafeHtml) => html`<p>${text}</p>`;
const list = (items: Array<string | SafeHtml>) => html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;

function providerLine(legal: PublicLegal): SafeHtml {
  const name = legal.providerName || 'El titular de Agenda Sonrisa';
  return html`<strong>${name}</strong>${legal.providerId ? `, identificado con ${legal.providerId}` : ''}${legal.city ? `, domiciliado en ${legal.city} (Colombia)` : ', en Colombia'}`;
}

function contactLine(legal: PublicLegal): SafeHtml {
  return html`${legal.contactEmail ? html`correo <a href="mailto:${legal.contactEmail}">${legal.contactEmail}</a>` : 'el correo de contacto publicado en este sitio'}${legal.whatsapp ? `, WhatsApp ${legal.whatsapp}` : ''}`;
}

function termsSections(legal: PublicLegal): Section[] {
  const isIvaResponsible = legal.taxRegime === 'responsable_iva';
  return [
    {
      title: 'Quién presta el servicio',
      body: p(html`Agenda Sonrisa es un software en línea para consultorios odontológicos que presta ${providerLine(legal)} (en adelante, "el proveedor"). Puedes escribirnos por ${contactLine(legal)}.`),
    },
    {
      title: 'Qué contratas',
      body: html`${p('Una licencia de uso del software en la nube (no exclusiva, intransferible y por el tiempo que pagues) para gestionar la agenda, los pacientes, la caja, la cartera y las demás funciones del plan que elijas. No se vende ni se entrega el código del software.')}
        ${p('Agenda Sonrisa es una herramienta de gestión administrativa: no es un software de historia clínica. Si registras notas de salud, tu consultorio sigue siendo responsable de cumplir la normativa de historia clínica.')}`,
    },
    {
      title: 'Cuenta y usuarios',
      body: list([
        'Quien crea la cuenta declara ser mayor de edad y tener facultad para actuar en nombre del consultorio.',
        'Debes dar datos verdaderos y mantenerlos actualizados, en especial el correo, porque por ahí llegan los comprobantes y avisos.',
        'Cada usuario cuida su contraseña. Lo que se haga con tus usuarios queda en la bitácora y es responsabilidad del consultorio.',
        'Puedes recuperar tu contraseña desde "¿Olvidaste tu contraseña?" en la pantalla de ingreso.',
      ]),
    },
    {
      title: 'Demo y prueba gratis',
      body: list([
        'La demo es un consultorio de ejemplo con datos ficticios. Dura los días indicados al crearla y luego se borra por completo. No registres datos reales de pacientes en la demo.',
        'La prueba gratis es tu consultorio real sin costo durante los días indicados. No pedimos tarjeta. Al terminar, si no pagas, el acceso se pausa sin borrar tu información.',
      ]),
    },
    {
      title: 'Precios, pagos e impuestos',
      body: html`${list([
        'Los precios están en pesos colombianos (COP) y se publican en la página de planes. El precio que pagas es el del momento del pago.',
        'Pagas por anticipado, cada mes o cada año, desde tu panel (Wompi: tarjeta, PSE, Nequi, Bancolombia) o por transferencia. No hacemos cobros automáticos a tu tarjeta.',
        'Si cambiamos los precios, lo avisamos al menos 30 días antes y el nuevo valor aplica desde tu siguiente pago.',
        'Al subir de plan pagas solo la diferencia de los días que quedan; al bajar, el cambio se aplica cuando termina lo ya pagado.',
      ])}
        ${p(legal.taxNotice)}
        ${isIvaResponsible
          ? ''
          : p('El valor publicado es el total a pagar: no se le suma IVA ni otros cargos del proveedor. Si tu consultorio es agente de retención, consulta con tu contador cómo soportar el gasto.')}`,
    },
    {
      title: 'Vencimiento, gracia y suspensión',
      body: p('Te avisamos por correo antes de que venza tu periodo. Después del vencimiento tienes unos días de gracia con acceso normal; luego el acceso se suspende hasta que pagues. Durante la suspensión tu información se conserva y puedes pagar desde el mismo panel para reactivar todo de inmediato.'),
    },
    {
      title: 'Cancelación y devoluciones',
      body: list([
        'No hay permanencia mínima: puedes dejar de pagar cuando quieras.',
        'No se devuelve el valor de un periodo ya iniciado, salvo fallas graves del servicio atribuibles al proveedor.',
        'Los pagos dobles o equivocados se devuelven completos. Escríbenos con el comprobante.',
        'Si eres consumidor en los términos de la Ley 1480 de 2011, conservas todos los derechos que esa ley te da.',
      ]),
    },
    {
      title: 'Uso permitido',
      body: list([
        'Usar el servicio solo para la gestión legítima de tu consultorio.',
        'No intentar acceder a información de otros consultorios, vulnerar la seguridad ni sobrecargar el sistema.',
        'No revender ni sublicenciar el acceso.',
        'Contar con la autorización de tus pacientes para registrar y usar sus datos, incluidos los recordatorios por WhatsApp.',
      ]),
    },
    {
      title: 'Disponibilidad y copias',
      body: p('El servicio funciona en la infraestructura de Cloudflare. Hacemos lo razonable para que esté disponible y protegido, pero no garantizamos que funcione sin interrupciones. Puedes descargar tu información en Excel desde los reportes cuando quieras.'),
    },
    {
      title: 'Responsabilidad',
      body: p('El proveedor responde por prestar el servicio con diligencia. No responde por las decisiones clínicas o administrativas que el consultorio tome con la información, por los datos que el consultorio registre, ni por fallas de internet, de terceros o de fuerza mayor. Salvo lo que la ley no permita limitar, la responsabilidad del proveedor no supera lo pagado por el consultorio en los últimos tres meses.'),
    },
    {
      title: 'Tu información es tuya',
      body: p('Los datos que registras pertenecen a tu consultorio. El proveedor los trata solo para prestarte el servicio, como se explica en la política de tratamiento de datos. Si dejas el servicio, puedes pedir una copia; la información de cuentas suspendidas se conserva al menos 12 meses y antes de eliminarla te avisamos por correo con 30 días de anticipación.'),
    },
    {
      title: 'Comunicaciones y cambios a estos términos',
      body: p('Aceptas recibir por correo electrónico los comprobantes, recordatorios y avisos del servicio (Ley 527 de 1999). Si cambiamos estos términos, publicamos la nueva versión con su fecha y te avisamos; si sigues usando el servicio, se entiende que la aceptas. Al registrarte queda guardada la versión que aceptaste.'),
    },
    {
      title: 'Ley aplicable y reclamos',
      body: p(html`Estos términos se rigen por la ley colombiana. Para cualquier queja o reclamo escríbenos por ${contactLine(legal)}; respondemos en un máximo de 15 días hábiles. También puedes acudir a la Superintendencia de Industria y Comercio.`),
    },
  ];
}

function privacySections(legal: PublicLegal): Section[] {
  return [
    {
      title: 'Responsable y contacto',
      body: p(html`Esta política explica cómo ${providerLine(legal)} trata los datos personales en Agenda Sonrisa, según la Ley 1581 de 2012 y el Decreto 1074 de 2015. Para ejercer tus derechos escribe al ${contactLine(legal)}.`),
    },
    {
      title: 'Dos papeles distintos',
      body: html`${list([
        html`<strong>Responsable</strong> de los datos de nuestros clientes: nombre, correo, celular y usuario de quienes administran o usan un consultorio y de quienes piden una demo.`,
        html`<strong>Encargado</strong> de los datos de los pacientes: el consultorio es el responsable de esos datos (los recoge, pide la autorización y decide su uso). Nosotros solo los guardamos y procesamos por cuenta del consultorio y para prestarle el servicio.`,
      ])}
        ${p('Si eres paciente y quieres consultar, corregir o eliminar tus datos, dirígete primero a tu consultorio. Si nos escribes a nosotros, trasladamos tu solicitud al consultorio y lo apoyamos para responderte a tiempo.')}`,
    },
    {
      title: 'Datos que tratamos',
      body: list([
        'De clientes: nombre, correo, celular, ciudad, nombre del consultorio, plan, pagos y sus comprobantes.',
        'De pacientes (por cuenta del consultorio): identificación, nombre, contacto, citas, servicios, pagos y la autorización registrada.',
        'Técnicos y de seguridad: dirección IP, navegador, ingresos y la bitácora de quién hizo cada cambio.',
        'No guardamos datos de tarjetas: los pagos los procesa Wompi en su propia página.',
      ]),
    },
    {
      title: 'Datos sensibles',
      body: p('La información relacionada con la salud es un dato sensible. El consultorio debe obtener la autorización expresa del paciente antes de registrarla, y nadie está obligado a entregar datos sensibles. Los datos de niños, niñas y adolescentes los registra el consultorio con la autorización de su representante.'),
    },
    {
      title: 'Para qué usamos los datos',
      body: list([
        'Crear y administrar tu cuenta y prestar las funciones del plan.',
        'Enviarte comprobantes de pago, recordatorios de vencimiento, avisos de seguridad y enlaces para recuperar tu contraseña.',
        'Cobrar el servicio, dar soporte y atender solicitudes.',
        'Proteger el sistema, prevenir fraudes y cumplir obligaciones legales.',
        'Elaborar estadísticas generales sin identificar a nadie.',
      ]),
    },
    {
      title: 'Lo que no hacemos',
      body: list([
        'No vendemos ni alquilamos datos personales.',
        'No usamos los datos de los pacientes para publicidad ni para ningún fin distinto a prestar el servicio al consultorio.',
        'No usamos cookies de publicidad ni de rastreo: solo la cookie técnica de la sesión.',
      ]),
    },
    {
      title: 'Proveedores que nos ayudan',
      body: html`${list([
        'Cloudflare: alojamiento, base de datos y protección contra ataques (sus servidores pueden estar fuera de Colombia).',
        'Wompi (Bancolombia): procesamiento de pagos en línea.',
        'Google (Gmail): envío de correos del servicio.',
        'El proveedor de facturación electrónica que el consultorio decida configurar, si lo hace.',
      ])}
        ${p('Con ellos compartimos solo lo necesario para cada tarea. Al aceptar esta política autorizas la transmisión de los datos a estos proveedores, incluso fuera del país, con fines de alojamiento y prestación del servicio.')}`,
    },
    {
      title: 'Tus derechos',
      body: list([
        'Conocer, actualizar y corregir tus datos.',
        'Pedir prueba de la autorización que diste.',
        'Saber cómo se han usado tus datos.',
        'Revocar la autorización o pedir que se eliminen, cuando no exista un deber legal o contractual de conservarlos.',
        'Consultarlos gratis y presentar quejas ante la Superintendencia de Industria y Comercio después de agotar el trámite con nosotros.',
      ]),
    },
    {
      title: 'Cómo hacer una consulta o un reclamo',
      body: list([
        html`Escribe al ${contactLine(legal)} con tu nombre, identificación, lo que pides y cómo te respondemos.`,
        'Consultas: respondemos en máximo 10 días hábiles (prorrogables 5 días hábiles más, avisándote el motivo).',
        'Reclamos (corregir, actualizar, eliminar o revocar): respondemos en máximo 15 días hábiles (prorrogables 8 días hábiles más). Si falta información, te la pedimos dentro de los 5 días siguientes; si no llega en 2 meses, se entiende que desististe.',
      ]),
    },
    {
      title: 'Seguridad',
      body: list([
        'Conexión cifrada (HTTPS) en todo el sitio.',
        'Contraseñas guardadas con un algoritmo de un solo sentido (nadie puede leerlas, ni siquiera nosotros) y claves de integración cifradas.',
        'Cada consultorio ve solo su información, con usuarios y permisos por rol.',
        'Bitácora de cambios, límites de intentos de ingreso y verificación en dos pasos para la administración.',
      ]),
    },
    {
      title: 'Cuánto tiempo guardamos los datos',
      body: p('Mientras la cuenta esté activa y, después, lo necesario para cumplir obligaciones legales o atender reclamos. Las demos se borran solas al vencer. La información de cuentas suspendidas se conserva al menos 12 meses y antes de eliminarla avisamos por correo con 30 días de anticipación.'),
    },
    {
      title: 'Vigencia',
      body: p(`Esta política rige desde el ${formatLongDate(legal.termsVersion)}. Si la cambiamos, publicamos la nueva versión aquí y te avisamos antes de aplicarla.`),
    },
  ];
}

export async function renderLegalPage(root: HTMLElement, kind: 'terminos' | 'privacidad'): Promise<void> {
  const title = kind === 'terminos' ? 'Términos y condiciones del servicio' : 'Política de tratamiento de datos personales';
  document.title = `${title} · Agenda Sonrisa`;
  setContent(root, html`<main class="public-page">${loadingState()}</main>`);
  let legal: PublicLegal;
  try {
    legal = await loadLegal();
  } catch {
    setContent(root, html`<main class="public-page"><section class="card success-panel" style="margin-top: 40px">${icon('triangle-alert')}<h1>No pudimos cargar el documento</h1><p class="muted">Revisa tu conexión y recarga la página.</p></section></main>`);
    return;
  }
  const sections = kind === 'terminos' ? termsSections(legal) : privacySections(legal);
  setContent(
    root,
    html`<div class="site">
      <header class="site-bar"><div class="site-bar-inner">
        ${brandLockup('Información legal', '/registro')}
        <nav aria-label="Documentos legales">
          <a href="/legal/terminos" ${kind === 'terminos' ? html`aria-current="page"` : ''}>Términos</a>
          <a href="/legal/privacidad" ${kind === 'privacidad' ? html`aria-current="page"` : ''}>Datos personales</a>
          <a href="/registro#planes">Planes</a>
        </nav>
        <div class="site-actions">${themeToggleButton()}<button class="button button-secondary button-small" type="button" data-print>${icon('printer')} Imprimir</button></div>
      </div></header>
      <main class="site-section legal-doc">
        <p class="legal-kicker">${icon(kind === 'terminos' ? 'gavel' : 'shield-check')} Versión del ${formatLongDate(legal.termsVersion)}</p>
        <h1>${title}</h1>
        <nav class="legal-toc" aria-label="Contenido"><ol>${sections.map((section, index) => html`<li><a href="#s${index + 1}">${section.title}</a></li>`)}</ol></nav>
        ${sections.map((section, index) => html`<section id="s${index + 1}"><h2>${index + 1}. ${section.title}</h2>${section.body}</section>`)}
      </main>
      ${legalFooter(legal)}
    </div>`,
  );
  root.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  // Los enlaces del índice usan #sN: se desplazan sin recargar.
  root.querySelector('.legal-toc')?.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    root.querySelector(link.getAttribute('href') ?? '')?.scrollIntoView({ behavior: 'smooth' });
  });
}
