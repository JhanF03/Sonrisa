/**
 * Planes y precios del panel del dueño, con submenú lateral (#/planes/<grupo>):
 * cada plan (precio, límites y módulos), adicionales y descuento anual. Lo que se guarda aquí
 * es lo que ven los interesados en /registro y los consultorios en "Mi plan".
 */
import { api } from '../../core/api.js';
import { $, html, readForm, setContent } from '../../core/dom.js';
import { formatMoney } from '../../core/format.js';
import { mountLocalSections, pickSection, sectionLayout, type SectionNavItem } from '../../core/sectionNav.js';
import { icon, refreshIcons, toast } from '../../core/ui.js';
import { ALL_PLAN_MODULES, PLAN_MODULES, priceForMonths, type AddonDefinition, type PlanCatalog, type PlanDefinition } from '../../../src/shared/plans.js';
import type { Summary } from '../types.js';

export async function renderPlansView(content: HTMLElement, params: string[] = []): Promise<void> {
  const [catalog, summary] = await Promise.all([api.get<PlanCatalog>('/api/platform/plans'), api.get<Summary>('/api/platform/summary')]);

  const planHint = (price: number, isActive: boolean, clinics: number) =>
    isActive ? `${formatMoney(price)}/mes · ${clinics} ${clinics === 1 ? 'consultorio' : 'consultorios'}` : 'No se vende';
  const sections: SectionNavItem[] = [
    ...catalog.plans.map((plan) => ({
      id: plan.id,
      label: plan.name,
      iconName: 'crown',
      hint: planHint(plan.monthlyPrice, plan.isActive, summary.byPlan[plan.id] ?? 0),
      description: 'Precio, cuántos profesionales y usuarios admite y qué módulos incluye. Lo básico va en todos los planes: agenda, pacientes, reservas en línea, recordatorios, servicios, usuarios y roles.',
    })),
    { id: 'adicionales', label: 'Adicionales', iconName: 'plus', hint: `${catalog.addons.filter((addon) => addon.isActive).length} a la venta`,
      description: 'El consultorio los agrega desde Mi plan, sobre cualquier plan. Desactiva uno para dejar de venderlo por separado.' },
    { id: 'anual', label: 'Pago anual', iconName: 'gift', hint: catalog.annualFreeMonths ? `${catalog.annualFreeMonths} meses gratis` : 'Sin descuento',
      description: 'Descuento para quien paga 12 meses por adelantado.' },
  ];
  const active = pickSection(sections, params[0]) as SectionNavItem;

  setContent(
    content,
    html`<form class="form" novalidate>${sectionLayout({
      items: sections,
      active,
      baseHref: '#/planes',
      label: 'Planes y precios',
      mode: 'local',
      panes: html`${catalog.plans.map((plan) => html`<div data-section-pane="${plan.id}">${planEditor(plan, summary.byPlan[plan.id] ?? 0)}</div>`)}
        <div data-section-pane="adicionales"><section class="card card-padded">
          <div class="table-wrapper"><table class="data-table">
            <thead><tr><th>Se vende</th><th>Nombre</th><th class="align-right">Valor mensual (COP)</th></tr></thead>
            <tbody>${catalog.addons.map((addon) => addonEditor(addon))}</tbody>
          </table></div>
        </section></div>
        <div data-section-pane="anual"><section class="card card-padded">
          <label class="field" style="max-width: 320px"><span>Meses gratis al pagar 12 <span class="hint" data-tooltip="2 = paga 10 meses y usa 12. 0 = sin descuento.">${icon('info')}</span></span>
            <input name="annualFreeMonths" type="number" min="0" max="6" value="${catalog.annualFreeMonths}" /></label>
          <p class="subtle" data-annual-example></p>
        </section></div>`,
      footer: html`<div class="save-bar">
        <span class="subtle">${icon('info')} Todos los planes, adicionales y el pago anual se guardan juntos.</span>
        <a class="button button-ghost" href="/registro" target="_blank" rel="noopener">${icon('external-link')} Ver cómo lo ven los clientes</a>
        <button class="button button-primary" type="submit">${icon('check')} Guardar planes y precios</button>
        <p class="form-error" role="alert" hidden></p>
      </div>`,
    })}</form>`,
  );
  refreshIcons(content);
  const showSection = mountLocalSections(content, sections, '#/planes', active.id);

  const form = content.querySelector('form') as HTMLFormElement;
  const updateExample = () => {
    const values = readForm(form);
    const free = Number(values.annualFreeMonths || 0);
    const price = Number(values[`price_${catalog.plans[1]?.id ?? catalog.plans[0]?.id}`] || 0);
    $('[data-annual-example]', form).textContent = price
      ? `Ejemplo: un plan de ${formatMoney(price)}/mes queda en ${formatMoney(priceForMonths(price, 12, free))} al año.`
      : '';
  };
  form.addEventListener('input', (event) => {
    updateExample();
    // El menú refleja al instante el nombre y el precio que se están editando.
    const values = readForm(form);
    const name = (event.target as HTMLInputElement).name ?? '';
    const plan = catalog.plans.find((candidate) => name.endsWith(`_${candidate.id}`));
    if (!plan) return;
    const link = content.querySelector<HTMLElement>(`[data-section="${plan.id}"]`);
    if (!link) return;
    $('strong', link).textContent = values[`name_${plan.id}`] || plan.name;
    $('small', link).textContent = planHint(Number(values[`price_${plan.id}`] || 0), values[`active_${plan.id}`] === '1', summary.byPlan[plan.id] ?? 0);
  });
  // Si un campo obligatorio está vacío en un grupo oculto, se abre ese grupo.
  form.addEventListener('invalid', (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('[data-section-pane]');
    if (pane?.hidden) showSection(pane.dataset.sectionPane ?? '');
  }, true);
  updateExample();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorElement = $('.form-error', form);
    errorElement.hidden = true;
    const values = readForm(form);
    try {
      await api.put('/api/platform/plans', {
        plans: catalog.plans.map((plan) => ({
          id: plan.id,
          name: values[`name_${plan.id}`],
          description: values[`description_${plan.id}`] ?? '',
          monthlyPrice: Number(values[`price_${plan.id}`] || 0),
          maxProfessionals: Number(values[`maxProfessionals_${plan.id}`] || 1),
          maxUsers: Number(values[`maxUsers_${plan.id}`] || 1),
          modules: ALL_PLAN_MODULES.filter((module) => values[`module_${plan.id}_${module}`] === '1'),
          sortOrder: plan.sortOrder,
          isActive: values[`active_${plan.id}`] === '1',
        })),
        addons: catalog.addons.map((addon) => ({
          id: addon.id,
          name: values[`addonName_${addon.id}`],
          monthlyPrice: Number(values[`addonPrice_${addon.id}`] || 0),
          isActive: values[`addonActive_${addon.id}`] === '1',
        })),
        annualFreeMonths: Number(values.annualFreeMonths || 0),
      });
      toast('Planes y precios guardados. Los consultorios sin precio especial ya tienen el valor nuevo.', 'success');
      await renderPlansView(content, [window.location.hash.split('/')[2] ?? '']);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : 'No se pudo guardar.';
      errorElement.hidden = false;
    }
  });
}

function planEditor(plan: PlanDefinition, clinics: number) {
  return html`<section class="card card-padded"><div class="plan-edit-grid">
    <div class="form">
      <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center">
        <label class="checkbox"><input type="checkbox" name="active_${plan.id}" value="1" ${plan.isActive ? 'checked' : ''} /> <span><strong>Se vende</strong> <small class="subtle">(aparece en /registro)</small></span></label>
        <span class="badge badge-neutral" data-tooltip="Consultorios reales en este plan">${clinics} ${clinics === 1 ? 'consultorio' : 'consultorios'}</span>
      </div>
      <div class="form-grid">
        <label class="field"><span>Nombre</span><input name="name_${plan.id}" required maxlength="40" value="${plan.name}" /></label>
        <label class="field"><span>Valor mensual (COP)</span><input name="price_${plan.id}" type="number" min="0" step="1000" value="${plan.monthlyPrice}" /></label>
        <label class="field full"><span>Descripción corta</span><textarea name="description_${plan.id}" rows="2" maxlength="300">${plan.description}</textarea></label>
        <label class="field"><span>Profesionales <span class="hint" data-tooltip="Profesionales con agenda activos.">${icon('info')}</span></span><input name="maxProfessionals_${plan.id}" type="number" min="1" max="500" value="${plan.maxProfessionals}" /></label>
        <label class="field"><span>Usuarios <span class="hint" data-tooltip="Personas que ingresan al panel, incluido el administrador.">${icon('info')}</span></span><input name="maxUsers_${plan.id}" type="number" min="1" max="1000" value="${plan.maxUsers}" /></label>
      </div>
    </div>
    <div class="plan-edit-side">
      <h4>${icon('boxes')} Módulos incluidos</h4>
      <div class="option-list">${ALL_PLAN_MODULES.map((module) => html`<label class="checkbox"><input type="checkbox" name="module_${plan.id}_${module}" value="1" ${plan.modules.includes(module) ? 'checked' : ''} />
        <span>${PLAN_MODULES[module].name} <span class="hint" data-tooltip="${PLAN_MODULES[module].description}">${icon('info')}</span></span></label>`)}</div>
    </div>
  </div></section>`;
}

function addonEditor(addon: AddonDefinition) {
  return html`<tr>
    <td><input type="checkbox" name="addonActive_${addon.id}" value="1" ${addon.isActive ? 'checked' : ''} aria-label="Activo" /></td>
    <td><input name="addonName_${addon.id}" required maxlength="60" value="${addon.name}" /></td>
    <td class="align-right"><input name="addonPrice_${addon.id}" type="number" min="0" step="1000" value="${addon.monthlyPrice}" style="max-width: 140px; text-align: right" /></td>
  </tr>`;
}
