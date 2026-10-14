-- Migración 0008: planes por módulos, registro autogestionado y demos con vencimiento.
--
-- • plans / plan_addons: catálogo que el dueño edita en /plataforma → Configuración.
--   Los precios de ejemplo se pueden cambiar sin tocar código.
-- • tenants: plan elegido, módulos extra, profesionales/usuarios adicionales,
--   precio especial opcional y los valores ya calculados (enabled_modules,
--   max_professionals, max_users) para no recalcularlos en cada petición.
-- • Demos: vencen (demo_expires_at) y se borran solas; guardan el contacto
--   del interesado y, si creó su prueba, a qué consultorio se convirtió.
-- • Los consultorios que ya existían quedan en el plan Completo y conservan
--   su valor mensual actual como precio especial (no se les cambia nada).
-- • El numero 0007 se reservó para el ingreso con Google/Microsoft.

CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  monthly_price     INTEGER NOT NULL CHECK (monthly_price >= 0),
  max_professionals INTEGER NOT NULL CHECK (max_professionals >= 1),
  max_users         INTEGER NOT NULL CHECK (max_users >= 1),
  modules           TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1
);

INSERT INTO plans (id, name, description, monthly_price, max_professionals, max_users, modules, sort_order) VALUES
  ('basico', 'Básico', 'Para el odontólogo independiente: agenda, pacientes y reservas en línea.', 59000, 1, 2, '', 1),
  ('profesional', 'Profesional', 'Para consultorios pequeños que también llevan caja, cartera e indicadores.', 119000, 3, 6, 'finanzas', 2),
  ('completo', 'Completo', 'Clínicas con inventario, compras, facturación electrónica y auditoría.', 189000, 5, 12, 'finanzas,inventario,facturacion,auditoria', 3);

CREATE TABLE plan_addons (
  id            TEXT PRIMARY KEY CHECK (id IN ('finanzas', 'inventario', 'facturacion', 'auditoria', 'profesional', 'usuario')),
  name          TEXT NOT NULL,
  monthly_price INTEGER NOT NULL CHECK (monthly_price >= 0),
  is_active     INTEGER NOT NULL DEFAULT 1
);

INSERT INTO plan_addons (id, name, monthly_price, is_active) VALUES
  ('finanzas', 'Caja y finanzas', 45000, 1),
  ('inventario', 'Compras e inventario', 35000, 1),
  ('facturacion', 'Facturación electrónica', 45000, 1),
  ('auditoria', 'Auditoría', 15000, 1),
  ('profesional', 'Profesional adicional', 29000, 1),
  ('usuario', 'Usuario adicional', 9000, 1);

ALTER TABLE tenants ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'completo';
ALTER TABLE tenants ADD COLUMN addon_modules TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN extra_professionals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN extra_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN custom_price INTEGER;
ALTER TABLE tenants ADD COLUMN enabled_modules TEXT NOT NULL DEFAULT 'finanzas,inventario,facturacion,auditoria';
ALTER TABLE tenants ADD COLUMN max_professionals INTEGER NOT NULL DEFAULT 5;
ALTER TABLE tenants ADD COLUMN max_users INTEGER NOT NULL DEFAULT 12;
ALTER TABLE tenants ADD COLUMN pending_plan TEXT;
ALTER TABLE tenants ADD COLUMN on_trial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN signup_source TEXT NOT NULL DEFAULT 'dueno';
ALTER TABLE tenants ADD COLUMN demo_expires_at TEXT;
ALTER TABLE tenants ADD COLUMN contact_name TEXT;
ALTER TABLE tenants ADD COLUMN contact_email TEXT;
ALTER TABLE tenants ADD COLUMN contact_phone TEXT;
ALTER TABLE tenants ADD COLUMN converted_tenant_id TEXT;
CREATE INDEX ix_tenants_demo_expires ON tenants (demo_expires_at) WHERE demo_expires_at IS NOT NULL;

-- Consultorios existentes: conservan su precio y no pierden profesionales ni usuarios.
UPDATE tenants SET custom_price = monthly_price WHERE is_showcase = 0 AND monthly_price > 0;
UPDATE tenants SET extra_professionals = MAX(0, (SELECT COUNT(*) FROM professionals p WHERE p.tenant_id = tenants.id AND p.is_active = 1) - 5),
                   extra_users = MAX(0, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = tenants.id AND u.is_active = 1) - 12);
UPDATE tenants SET max_professionals = 5 + extra_professionals, max_users = 12 + extra_users;
UPDATE tenants SET on_trial = 1
  WHERE is_showcase = 0 AND billing_mode = 'auto'
    AND NOT EXISTS (SELECT 1 FROM subscription_payments sp WHERE sp.tenant_id = tenants.id AND sp.status = 'aprobado');

ALTER TABLE platform_settings ADD COLUMN annual_free_months INTEGER NOT NULL DEFAULT 2;
ALTER TABLE platform_settings ADD COLUMN demo_days INTEGER NOT NULL DEFAULT 5;
ALTER TABLE platform_settings ADD COLUMN self_signup_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE platform_settings ADD COLUMN self_demo_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE platform_settings ADD COLUMN max_self_demos INTEGER NOT NULL DEFAULT 30;

-- Pagos: ahora también hay pagos por cambio de plan (0 meses: no mueven la fecha).
CREATE TABLE subscription_payments_new (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  months        INTEGER NOT NULL CHECK (months BETWEEN 0 AND 24),
  previous_paid_until TEXT,
  new_paid_until TEXT NOT NULL,
  method        TEXT NOT NULL,
  reference     TEXT,
  external_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'aprobado' CHECK (status IN ('aprobado', 'anulado')),
  notes         TEXT,
  void_reason   TEXT,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'renovacion' CHECK (kind IN ('renovacion', 'cambio_plan'))
);
INSERT INTO subscription_payments_new (id, tenant_id, amount, months, previous_paid_until, new_paid_until, method, reference, external_id, status, notes, void_reason, created_at)
  SELECT id, tenant_id, amount, months, previous_paid_until, new_paid_until, method, reference, external_id, status, notes, void_reason, created_at FROM subscription_payments;
DROP TABLE subscription_payments;
ALTER TABLE subscription_payments_new RENAME TO subscription_payments;
CREATE INDEX ix_subscription_payments_tenant ON subscription_payments (tenant_id, created_at);
CREATE UNIQUE INDEX ux_subscription_payments_external ON subscription_payments (external_id) WHERE external_id IS NOT NULL;

ALTER TABLE subscription_checkouts ADD COLUMN kind TEXT NOT NULL DEFAULT 'renovacion';
ALTER TABLE subscription_checkouts ADD COLUMN plan_snapshot TEXT;
