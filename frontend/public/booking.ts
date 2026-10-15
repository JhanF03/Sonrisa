/**
 * Página pública de reservas del consultorio (/c/:slug).
 * Flujo en 4 pasos: servicio → profesional → día y hora → datos.
 */
import { logoTooth } from '../core/brand.js';
import { applyFavicon } from '../core/favicon.js';
import { api, ApiError } from '../core/api.js';
import { $, html, readForm, safeUrl, setContent, type SafeHtml } from '../core/dom.js';
import { addDays, DOCUMENT_TYPES, formatLongDate, formatMoney, formatShortDate, formatTime, todayLocal } from '../core/format.js';
import { applyBrandColor, icon, loadingState, refreshIcons, themeToggleButton, whatsappButton } from '../core/ui.js';

export interface PublicClinic {
  name: string;
  slug: string;
  brandColor: string;
  logoUrl: string | null; favicon?: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  address: string | null;
  city: string | null;
  onlineBookingEnabled: boolean;
  verificationMode: 'ninguna' | 'whatsapp';
  paymentPolicyText: string | null;
  turnstileSiteKey: string | null;
  bookingWindowDays: number;
  isShowcase: boolean;
  services: Array<{ id: string; name: string; category: string | null; price: number; durationMinutes: number; prepaymentAmount: number }>;
  professionals: Array<{ id: string; fullName: string; specialty: string | null }>;
}

export interface PublicSlot {
  start: string;
  end: string;
  professionalId: string;
  professionalName: string;
}

interface BookingState {
  serviceId?: string;
  professionalId?: string | null;
  date?: string;
  slot?: PublicSlot;
}

const DAYS_TO_SHOW = 14;

export async function renderBookingPage(root: HTMLElement, slug: string): Promise<void> {
  setContent(root, loadingState('Cargando consultorio…'));
  let clinic: PublicClinic;
  try {
    clinic = await api.get<PublicClinic>(`/api/public/clinics/${encodeURIComponent(slug)}`);
  } catch {
    setContent(root, html`<main class="public-page"><div class="card success-panel" style="margin-top: 40px">${icon('calendar-x')}<h1>Consultorio no encontrado</h1><p class="muted">Revisa el enlace que te compartieron.</p></div></main>`);
    refreshIcons(root);
    return;
  }

  applyBrandColor(clinic.brandColor);
  applyFavicon(clinic.favicon);
  document.title = `Reservar cita · ${clinic.name}`;
  const state: BookingState = {};

  const draw = async () => {
    setContent(root, publicLayout(clinic, await stepContent(clinic, state)));
    refreshIcons(root);
    mountTurnstile(root);
  };

  root.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const serviceButton = target.closest<HTMLElement>('[data-service]');
    if (serviceButton) {
      state.serviceId = serviceButton.dataset.service;
      state.professionalId = clinic.professionals.length > 1 ? undefined : null;
      state.date = undefined;
      state.slot = undefined;
      return draw();
    }
    const professionalButton = target.closest<HTMLElement>('[data-professional]');
    if (professionalButton) {
      state.professionalId = professionalButton.dataset.professional || null;
      return draw();
    }
    const dayButton = target.closest<HTMLElement>('[data-day]');
    if (dayButton) {
      state.date = dayButton.dataset.day;
      state.slot = undefined;
      return draw();
    }
    const slotButton = target.closest<HTMLElement>('[data-slot-index]');
    if (slotButton) {
      const slots = await loadSlots(clinic, state);
      state.slot = slots.filter((slot) => slot.start.slice(0, 10) === state.date)[Number(slotButton.dataset.slotIndex)];
      return draw();
    }
    const back = target.closest<HTMLElement>('[data-back]')?.dataset.back;
    if (back === 'service') { state.serviceId = undefined; state.professionalId = undefined; state.date = undefined; state.slot = undefined; return draw(); }
    if (back === 'professional') { state.professionalId = undefined; state.date = undefined; state.slot = undefined; return draw(); }
    if (back === 'time') { state.slot = undefined; return draw(); }
  };

  root.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const values = readForm(form);
    const errorElement = $('.form-error', form);
    const submitButton = form.querySelector('button[type=submit]') as HTMLButtonElement;
    errorElement.hidden = true;
    if (!(form.elements.namedItem('consent') as HTMLInputElement).checked) {
      errorElement.textContent = 'Debes autorizar el tratamiento de tus datos para reservar.';
      errorElement.hidden = false;
      return;
    }
    submitButton.disabled = true;
    try {
      const result = await api.post<BookingResult>(
        `/api/public/clinics/${encodeURIComponent(clinic.slug)}/appointments`,
        {
          serviceId: state.serviceId,
          professionalId: state.slot?.professionalId ?? null,
          startAt: state.slot?.start,
          consentGiven: true,
          website: values.website,
          turnstileToken: readTurnstileToken(form),
          patient: {
            documentType: values.documentType,
            documentNumber: values.documentNumber,
            fullName: values.fullName,
            phone: values.phone,
            email: values.email || null,
          },
        },
      );
      if (result.payment) {
        // Pago anticipado: se envía al checkout seguro de Wompi (solo ese dominio).
        const checkoutUrl = new URL(result.payment.checkoutUrl);
        if (checkoutUrl.origin !== 'https://checkout.wompi.co') throw new Error('Dirección de pago inválida.');
        setContent(root, publicLayout(clinic, html`<section class="card success-panel" style="margin-top: 16px">${icon('credit-card')}<h2>Te llevamos a Wompi para pagar ${formatMoney(result.payment.amount)}</h2><p class="muted">Tu horario queda apartado mientras pagas.</p></section>`));
        refreshIcons(root);
        window.location.assign(checkoutUrl.href);
        return;
      }
      setContent(root, publicLayout(clinic, successContent(clinic, result)));
      refreshIcons(root);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo reservar.';
      errorElement.hidden = false;
      resetTurnstile();
      if (error instanceof ApiError && error.status === 409 && error.code !== 'BOOKING_LIMIT') {
        slotCache.clear();
        state.slot = undefined;
        window.setTimeout(() => void draw(), 2500);
      }
    } finally {
      submitButton.disabled = false;
    }
  };

  await draw();
}

export function publicLayout(clinic: Pick<PublicClinic, 'name' | 'logoUrl' | 'phone' | 'address' | 'city'> & { isShowcase?: boolean }, content: SafeHtml): SafeHtml {
  return html`${clinic.isShowcase ? html`<div class="showcase-banner">${icon('sparkles')} Demostración: las reservas aquí son de prueba.</div>` : ''}
  <main class="public-page">
    <header class="public-header">
      <div class="brand">
        <span class="brand-mark">${clinic.logoUrl ? html`<img src="${safeUrl(clinic.logoUrl, ['https:'])}" alt="" referrerpolicy="no-referrer" />` : logoTooth()}</span>
        <div><div class="brand-name">${clinic.name}</div><div class="brand-product">Reserva tu cita en línea</div></div>
      </div>
      ${themeToggleButton()}
    </header>
    <section class="card public-hero">
      <h1>${clinic.name}</h1>
      <p>${clinic.address ? html`${icon('map-pin')} ${clinic.address}${clinic.city ? `, ${clinic.city}` : ''}` : ''}
         ${clinic.phone ? html`&nbsp;${icon('phone')} ${clinic.phone}` : ''}</p>
    </section>
    ${content}
    <footer class="public-footer">Reservas con Agenda Sonrisa · Tus datos se tratan conforme a la Ley 1581 de 2012.</footer>
  </main>`;
}

function stepsMarkup(current: number): SafeHtml {
  const labels = ['Servicio', 'Profesional', 'Día y hora', 'Tus datos'];
  return html`<div class="steps">${labels.map((label, index) => html`<span class="step ${index === current ? 'is-active' : index < current ? 'is-done' : ''}">${index < current ? icon('check') : `${index + 1}.`} ${label}</span>`)}</div>`;
}

const slotCache = new Map<string, Promise<PublicSlot[]>>();

function loadSlots(clinic: PublicClinic, state: BookingState): Promise<PublicSlot[]> {
  const from = todayLocal();
  const to = addDays(from, Math.min(DAYS_TO_SHOW, clinic.bookingWindowDays));
  const key = `${state.serviceId}|${state.professionalId ?? ''}|${from}`;
  let request = slotCache.get(key);
  if (!request) {
    request = api.get<PublicSlot[]>(`/api/public/clinics/${encodeURIComponent(clinic.slug)}/availability`, {
      from, to, serviceId: state.serviceId, professionalId: state.professionalId ?? undefined,
    });
    request.catch(() => slotCache.delete(key));
    slotCache.set(key, request);
  }
  return request;
}

async function stepContent(clinic: PublicClinic, state: BookingState): Promise<SafeHtml> {
  if (!clinic.onlineBookingEnabled) {
    return html`<section class="card success-panel" style="margin-top: 16px">${icon('phone')}<h2>Reservas por teléfono</h2>
      <p class="muted">Este consultorio no tiene la reserva en línea activa. Comunícate al ${clinic.phone ?? 'consultorio'}.</p></section>`;
  }

  // Paso 1: servicio
  if (!state.serviceId) {
    return html`${stepsMarkup(0)}<section class="option-list" aria-label="Servicios">
      ${clinic.services.map((service) => html`<button class="option" data-service="${service.id}">
        <span><strong>${service.name}</strong><span class="muted">${icon('clock')} ${service.durationMinutes} min${service.category ? ` · ${service.category}` : ''}</span></span>
        <span class="money muted">${formatMoney(service.price)}${service.prepaymentAmount > 0 ? html`<br /><small class="badge badge-warning">${icon('credit-card')} Anticipo ${formatMoney(service.prepaymentAmount)}</small>` : ''}</span></button>`)}
    </section>`;
  }
  const service = clinic.services.find((candidate) => candidate.id === state.serviceId);

  // Paso 2: profesional (si hay más de uno)
  if (state.professionalId === undefined) {
    return html`${stepsMarkup(1)}
      <button class="button button-ghost button-small" data-back="service">${icon('chevron-left')} Cambiar servicio</button>
      <section class="option-list" style="margin-top: 10px">
        <button class="option" data-professional=""><span><strong>Cualquier profesional</strong><span class="muted">Te mostramos todos los horarios disponibles</span></span>${icon('sparkles')}</button>
        ${clinic.professionals.map((professional) => html`<button class="option" data-professional="${professional.id}">
          <span><strong>${professional.fullName}</strong><span class="muted">${professional.specialty ?? ''}</span></span>${icon('user')}</button>`)}
      </section>`;
  }

  // Paso 3: día y hora
  if (!state.slot) {
    const slots = await loadSlots(clinic, state);
    const today = todayLocal();
    const days = Array.from({ length: Math.min(DAYS_TO_SHOW, clinic.bookingWindowDays) + 1 }, (_unused, index) => addDays(today, index));
    const countByDay = new Map<string, number>();
    for (const slot of slots) countByDay.set(slot.start.slice(0, 10), (countByDay.get(slot.start.slice(0, 10)) ?? 0) + 1);
    state.date ??= days.find((day) => (countByDay.get(day) ?? 0) > 0);
    const daySlots = slots.filter((slot) => slot.start.slice(0, 10) === state.date);

    return html`${stepsMarkup(2)}
      <button class="button button-ghost button-small" data-back="${clinic.professionals.length > 1 ? 'professional' : 'service'}">${icon('chevron-left')} Atrás</button>
      <section class="card card-padded" style="margin-top: 10px; display: grid; gap: 14px">
        <div><strong>${service?.name}</strong> <span class="muted">· ${service?.durationMinutes} min</span></div>
        <div class="day-strip">${days.map((day) => {
          const count = countByDay.get(day) ?? 0;
          const [weekday, dayNumber, month] = formatShortDate(day).split(' ');
          return html`<button class="day-chip ${day === state.date ? 'is-selected' : ''}" data-day="${day}" ${count === 0 ? 'disabled' : ''}>
            <small>${weekday}</small><strong>${dayNumber}</strong><small>${month}</small><small>${count ? `${count} libres` : 'sin cupo'}</small></button>`;
        })}</div>
        ${!state.date
          ? html`<p class="muted">No hay horarios disponibles en los próximos días. Llámanos al ${clinic.phone ?? 'consultorio'}.</p>`
          : html`<div><p class="first-cap" style="margin-bottom: 8px"><strong>${formatLongDate(state.date)}</strong></p>
              <div class="slot-grid">${daySlots.map((slot, index) => html`<button class="slot" data-slot-index="${index}">${formatTime(slot.start)}${state.professionalId ? '' : html`<small>${slot.professionalName.split(' ').slice(0, 2).join(' ')}</small>`}</button>`)}</div></div>`}
      </section>`;
  }

  // Paso 4: datos del paciente
  return html`${stepsMarkup(3)}
    <button class="button button-ghost button-small" data-back="time">${icon('chevron-left')} Cambiar hora</button>
    <section class="card card-padded" style="margin-top: 10px">
      <p style="margin-bottom: 14px"><strong>${service?.name}</strong> con ${state.slot.professionalName}<br />
        <span class="muted first-cap">${formatLongDate(state.slot.start.slice(0, 10))} · ${formatTime(state.slot.start)}</span></p>
      <form class="form" novalidate>
        <div class="form-grid">
          <label class="field"><span>Tipo de documento</span><select name="documentType">${DOCUMENT_TYPES.map(([code, label]) => html`<option value="${code}">${label}</option>`)}</select></label>
          <label class="field"><span>Número de documento</span><input name="documentNumber" required maxlength="20" inputmode="numeric" autocomplete="off" /></label>
          <label class="field full"><span>Nombre completo</span><input name="fullName" required maxlength="120" autocomplete="name" /></label>
          <label class="field"><span>${icon('phone')} Celular (WhatsApp)</span><input name="phone" type="tel" required maxlength="20" autocomplete="tel" placeholder="300 123 4567" /></label>
          <label class="field"><span>Correo (opcional)</span><input name="email" type="email" maxlength="200" autocomplete="email" /></label>
        </div>
        <div class="honeypot" aria-hidden="true"><label>No llenar<input name="website" tabindex="-1" autocomplete="off" /></label></div>
        <div class="privacy-text">
          Autorizo a <strong>${clinic.name}</strong> a tratar mis datos personales (nombre, documento, celular y correo) con el fin de agendar y gestionar mis citas,
          enviarme recordatorios por WhatsApp o correo y contactarme sobre mi atención, de acuerdo con la Ley 1581 de 2012 y sus decretos reglamentarios.
          Puedo conocer, actualizar, rectificar o solicitar la supresión de mis datos comunicándome con el consultorio${clinic.phone ? ` al ${clinic.phone}` : ''}.
        </div>
        <label class="checkbox"><input type="checkbox" name="consent" required /><span>Acepto el tratamiento de mis datos personales.</span></label>
        ${service && service.prepaymentAmount > 0
          ? html`<div class="privacy-text">${icon('credit-card')} <strong>Este servicio requiere un anticipo de ${formatMoney(service.prepaymentAmount)}</strong> que pagas ahora en Wompi (tarjeta, PSE, Nequi…). Tu horario queda apartado mientras pagas; si no completas el pago a tiempo, se libera.${clinic.paymentPolicyText ? html`<br />${clinic.paymentPolicyText}` : ''}</div>`
          : clinic.verificationMode === 'whatsapp'
            ? html`<p class="subtle">${icon('shield-check')} Al reservar te pediremos confirmar por WhatsApp con un código.</p>`
            : ''}
        ${clinic.turnstileSiteKey ? html`<div data-turnstile data-sitekey="${clinic.turnstileSiteKey}"></div>` : ''}
        <p class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">${service && service.prepaymentAmount > 0 ? html`${icon('credit-card')} Reservar y pagar ${formatMoney(service.prepaymentAmount)}` : html`${icon('calendar-plus')} Confirmar reserva`}</button>
      </form>
    </section>`;
}

interface BookingResult {
  token: string;
  manageUrl: string;
  appointment: { startAt: string; serviceName: string; professionalName: string };
  payment?: { checkoutUrl: string; amount: number };
  verification?: { code: string; whatsappUrl: string | null; expiresAt: string } | null;
}

// ─── Turnstile (anti-robots opcional) ───────────────────────────────────────

interface TurnstileApi {
  render: (element: HTMLElement, options: { sitekey: string; language?: string }) => string;
  reset: (widgetId?: string) => void;
}
let turnstileWidgetId: string | undefined;

/** Carga el script de Cloudflare solo si el consultorio lo tiene activo. */
export function mountTurnstile(root: HTMLElement): void {
  const container = root.querySelector<HTMLElement>('[data-turnstile]');
  if (!container) return;
  const render = () => {
    const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (turnstile && container.isConnected) turnstileWidgetId = turnstile.render(container, { sitekey: container.dataset.sitekey ?? '', language: 'es' });
  };
  if ((window as unknown as { turnstile?: TurnstileApi }).turnstile) return render();
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = render;
  document.head.append(script);
}

export function readTurnstileToken(form: HTMLFormElement): string | undefined {
  const input = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
  return input?.value || undefined;
}

function resetTurnstile(): void {
  (window as unknown as { turnstile?: TurnstileApi }).turnstile?.reset(turnstileWidgetId);
}

function verificationContent(clinic: PublicClinic, result: BookingResult): SafeHtml {
  const verification = result.verification as NonNullable<BookingResult['verification']>;
  return html`<section class="card success-panel" style="margin-top: 16px">
    ${icon('shield-check')}
    <h2>Último paso: confirma por WhatsApp</h2>
    <p>Tu horario está apartado: <strong>${result.appointment.serviceName}</strong>, <span class="first-cap">${formatLongDate(result.appointment.startAt.slice(0, 10))}</span> a las ${formatTime(result.appointment.startAt)}</p>
    <p>Envía este código al consultorio desde tu celular:</p>
    <p class="verification-code">${verification.code}</p>
    ${verification.whatsappUrl
      ? html`<a class="button button-whatsapp" target="_blank" rel="noopener" href="${safeUrl(verification.whatsappUrl, ['https:'])}">${icon('message-circle')} Enviar código por WhatsApp</a>`
      : html`<p class="muted">Llama al consultorio${clinic.phone ? ` al ${clinic.phone}` : ''} y dale este código.</p>`}
    <p class="subtle">Si no lo envías antes de las ${formatTime(new Date(new Date(verification.expiresAt).getTime() - 5 * 3_600_000).toISOString().slice(0, 16))}, el horario se libera para otro paciente.</p>
    <a class="button button-ghost" href="${safeUrl(result.manageUrl)}">${icon('calendar-clock')} Ver mi reserva</a>
  </section>`;
}

function successContent(clinic: PublicClinic, result: BookingResult): SafeHtml {
  if (result.verification) return verificationContent(clinic, result);
  const calendarUrl = `/api/public/appointments/${encodeURIComponent(result.token)}/calendar.ics`;
  return html`<section class="card success-panel" style="margin-top: 16px">
    ${icon('circle-check-big')}
    <h2>¡Tu cita quedó reservada!</h2>
    <p><strong>${result.appointment.serviceName}</strong> con ${result.appointment.professionalName}<br />
      <span class="first-cap">${formatLongDate(result.appointment.startAt.slice(0, 10))}</span> a las ${formatTime(result.appointment.startAt)}</p>
    <div class="button-row" style="justify-content: center">
      <a class="button button-primary" href="${calendarUrl}">${icon('calendar-plus')} Agregar a mi calendario</a>
      <a class="button button-secondary" href="${safeUrl(result.manageUrl)}">${icon('calendar-clock')} Gestionar mi cita</a>
      ${clinic.whatsappNumber ? whatsappButton(clinic.whatsappNumber, `Hola, acabo de reservar una cita para ${result.appointment.serviceName}.`, { label: 'Escribir al consultorio' }) : ''}
    </div>
    <p class="subtle">Guarda el enlace "Gestionar mi cita": con él puedes confirmar, reprogramar o cancelar.</p>
  </section>`;
}
