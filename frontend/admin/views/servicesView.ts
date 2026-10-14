/**
 * Catálogo de servicios (productos): código, precio, duración e impuesto.
 */
import { api } from '../../core/api.js';
import { emptyToNull, html, readForm, setContent } from '../../core/dom.js';
import { formatMoney } from '../../core/format.js';
import { emptyState, icon, loadingState, openFormModal, refreshIcons, toast } from '../../core/ui.js';
import { prepaymentAmountOf, type ServiceItem } from '../components.js';
import { can } from '../session.js';

export async function renderServicesView(container: HTMLElement): Promise<void> {
  setContent(container, loadingState());
  const [services, gateway] = await Promise.all([
    api.get<ServiceItem[]>('/api/services'),
    can('pagos.configurar') ? api.get<{ configured: boolean; isEnabled: boolean }>('/api/settings/payments').catch(() => null) : Promise.resolve(null),
  ]);
  const canManage = can('servicios.gestionar');
  const paymentsActive = gateway ? gateway.configured && gateway.isEnabled : null;
  const hasPrepaidServices = services.some((service) => prepaymentAmountOf(service) > 0);

  setContent(
    container,
    html`<section class="card">
      <div class="card-header"><h3>${icon('stethoscope')} Servicios</h3>
        ${canManage ? html`<button class="button button-primary" data-action="new">${icon('plus')} Nuevo servicio</button>` : ''}</div>
      ${hasPrepaidServices && paymentsActive === false
        ? html`<div class="card-padded"><p class="form-error">${icon('triangle-alert')} Hay servicios con anticipo pero el pago en línea no está activo: esos servicios NO se ofrecen en la reserva en línea. <a href="#/configuracion/pagos">Configurar Wompi</a></p></div>`
        : ''}
      ${services.length === 0
        ? emptyState('stethoscope', 'Sin servicios', 'Crea los servicios que ofreces con su precio y duración.')
        : html`<div class="table-wrapper"><table class="data-table">
          <thead><tr><th>Código</th><th>Servicio</th><th>Categoría</th><th>Duración</th><th class="align-right">Precio</th><th>Anticipo en línea</th><th>En línea</th><th>Estado</th><th></th></tr></thead>
          <tbody>${services.map((service) => html`<tr>
            <td><code>${service.code}</code></td>
            <td><strong>${service.name}</strong></td>
            <td>${service.category ?? '—'}</td>
            <td>${service.duration_minutes} min</td>
            <td class="align-right money">${formatMoney(service.price)}</td>
            <td>${prepaymentAmountOf(service) > 0
              ? html`<span class="badge badge-warning" data-tooltip="${service.prepayment_mode === 'porcentaje' ? `${service.prepayment_value} % del precio` : 'Valor fijo'}">${icon('credit-card')} ${formatMoney(prepaymentAmountOf(service))}</span>`
              : html`<span class="subtle">—</span>`}</td>
            <td>${service.is_bookable_online ? html`<span class="badge badge-info">Sí</span>` : html`<span class="badge badge-neutral">Solo recepción</span>`}</td>
            <td>${service.is_active ? html`<span class="badge badge-success">Activo</span>` : html`<span class="badge badge-neutral">Inactivo</span>`}</td>
            <td class="align-right">${canManage ? html`<button class="icon-button" data-edit="${service.id}" aria-label="Editar" data-tooltip="Editar">${icon('pencil')}</button>` : ''}</td>
          </tr>`)}</tbody></table></div>`}
    </section>`,
  );
  refreshIcons(container);

  container.onclick = (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="new"]')) openServiceModal(null, () => renderServicesView(container));
    const editId = target.closest<HTMLElement>('[data-edit]')?.dataset.edit;
    const service = services.find((candidate) => candidate.id === editId);
    if (service) openServiceModal(service, () => renderServicesView(container));
  };
}

function openServiceModal(service: ServiceItem | null, onDone: () => Promise<void>): void {
  const modal = openFormModal({
    title: service ? 'Editar servicio' : 'Nuevo servicio',
    iconName: 'stethoscope',
    submitLabel: 'Guardar',
    fields: html`<div class="form-grid">
      <label class="field"><span>Código <span class="hint" data-tooltip="Corto y único, ej. PRO, RES-01">${icon('info')}</span></span><input name="code" required maxlength="12" value="${service?.code ?? ''}" /></label>
      <label class="field"><span>Categoría</span><input name="category" maxlength="60" value="${service?.category ?? ''}" placeholder="Prevención, Ortodoncia…" /></label>
      <label class="field full"><span>Nombre</span><input name="name" required maxlength="120" value="${service?.name ?? ''}" /></label>
      <label class="field"><span>Precio (COP)</span><input name="price" type="number" min="0" step="1" required value="${service?.price ?? ''}" /></label>
      <label class="field"><span>Duración (minutos)</span><input name="durationMinutes" type="number" min="5" max="480" step="5" required value="${service?.duration_minutes ?? 30}" /></label>
      <label class="field"><span>Impuesto (%) <span class="hint" data-tooltip="Informativo para facturación electrónica futura. La mayoría de servicios de salud no lleva IVA; confírmalo con tu contador.">${icon('info')}</span></span>
        <input name="taxRate" type="number" min="0" max="100" step="0.01" value="${service ? service.tax_rate_bps / 100 : 0}" /></label>
      <span></span>
      <label class="checkbox"><input type="checkbox" name="isBookableOnline" ${service === null || service.is_bookable_online ? 'checked' : ''} /> <span>Se puede reservar en línea</span></label>
      <label class="checkbox"><input type="checkbox" name="isActive" ${service === null || service.is_active ? 'checked' : ''} /> <span>Activo</span></label>
      <fieldset class="full prepayment-box">
        <legend>${icon('credit-card')} Pago anticipado al reservar en línea</legend>
        <div class="form-grid">
          <label class="field"><span>¿Exige anticipo?</span>
            <select name="prepaymentMode">
              <option value="ninguno" ${!service || service.prepayment_mode === 'ninguno' ? 'selected' : ''}>No exige anticipo</option>
              <option value="porcentaje" ${service?.prepayment_mode === 'porcentaje' ? 'selected' : ''}>Sí: un porcentaje del precio</option>
              <option value="valor" ${service?.prepayment_mode === 'valor' ? 'selected' : ''}>Sí: un valor fijo</option>
            </select></label>
          <label class="field" data-prepayment-value><span data-prepayment-label>Valor</span>
            <input name="prepaymentValue" type="number" min="1" step="1" value="${service && service.prepayment_mode !== 'ninguno' ? service.prepayment_value : ''}" /></label>
        </div>
        <p class="subtle" data-prepayment-preview></p>
      </fieldset>
    </div>`,
    onSubmit: async (form) => {
      const values = readForm(form);
      const payload = {
        code: values.code.toUpperCase(),
        name: values.name,
        category: emptyToNull(values.category),
        price: Number(values.price),
        durationMinutes: Number(values.durationMinutes),
        taxRateBps: Math.round(Number(values.taxRate || 0) * 100),
        isBookableOnline: (form.elements.namedItem('isBookableOnline') as HTMLInputElement).checked,
        isActive: (form.elements.namedItem('isActive') as HTMLInputElement).checked,
        prepaymentMode: values.prepaymentMode,
        prepaymentValue: values.prepaymentMode === 'ninguno' ? 0 : Number(values.prepaymentValue || 0),
      };
      if (service) await api.put(`/api/services/${service.id}`, payload);
      else await api.post('/api/services', payload);
      toast('Servicio guardado.', 'success');
      await onDone();
    },
  });

  // Vista previa del anticipo mientras se escribe.
  const form = modal.body.querySelector('form') as HTMLFormElement;
  const valueField = form.querySelector('[data-prepayment-value]') as HTMLElement;
  const valueLabel = form.querySelector('[data-prepayment-label]') as HTMLElement;
  const preview = form.querySelector('[data-prepayment-preview]') as HTMLElement;
  const updatePreview = () => {
    const values = readForm(form);
    const mode = values.prepaymentMode as ServiceItem['prepayment_mode'];
    valueField.hidden = mode === 'ninguno';
    valueLabel.textContent = mode === 'porcentaje' ? 'Porcentaje (1 a 100)' : 'Valor en pesos';
    const amount = prepaymentAmountOf({ price: Number(values.price || 0), prepayment_mode: mode, prepayment_value: Number(values.prepaymentValue || 0) });
    preview.textContent =
      mode === 'ninguno'
        ? 'El paciente reserva sin pagar.'
        : amount >= 1000
          ? `Al reservar en línea el paciente pagará ${formatMoney(amount)} con Wompi (tarjeta, PSE, Nequi…). Si no paga a tiempo, el horario se libera.`
          : 'El anticipo debe ser de al menos $1.000.';
  };
  form.addEventListener('input', updatePreview);
  updatePreview();
}
