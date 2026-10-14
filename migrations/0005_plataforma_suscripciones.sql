-- Plataforma del dueño y suscripciones de los consultorios.
--
-- • paid_until: último día (fecha local) cubierto por el pago. Después hay
--   grace_days de gracia y luego el acceso se suspende AUTOMÁTICAMENTE
--   (se calcula en cada petición; no depende de un proceso programado).
-- • billing_mode: 'auto' (cobro normal) · 'exento' (cortesía) · 'suspendido' (manual).
-- • Las demos (is_showcase) nunca se cobran.

ALTER TABLE tenants ADD COLUMN paid_until TEXT;
ALTER TABLE tenants ADD COLUMN monthly_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tenants ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE tenants ADD COLUMN owner_notes TEXT;

-- Consultorios reales existentes: 30 días para ponerse al día.
UPDATE tenants SET paid_until = date('now', '-5 hours', '+30 days') WHERE is_showcase = 0 AND paid_until IS NULL;

CREATE TABLE subscription_payments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  months        INTEGER NOT NULL CHECK (months BETWEEN 1 AND 24),
  previous_paid_until TEXT,
  new_paid_until TEXT NOT NULL,
  method        TEXT NOT NULL,
  reference     TEXT,
  external_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'aprobado' CHECK (status IN ('aprobado', 'anulado')),
  notes         TEXT,
  void_reason   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_subscription_payments_tenant ON subscription_payments (tenant_id, created_at);
-- Un pago de Wompi se registra una sola vez aunque el evento llegue repetido.
CREATE UNIQUE INDEX ux_subscription_payments_external ON subscription_payments (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE subscription_checkouts (
  reference     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  months        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobado', 'rechazado')),
  transaction_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_subscription_checkouts_tenant ON subscription_checkouts (tenant_id, created_at);

-- Configuración del dueño (una sola fila).
CREATE TABLE platform_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  owner_name            TEXT,
  owner_whatsapp        TEXT,
  payment_instructions  TEXT,
  default_monthly_price INTEGER NOT NULL DEFAULT 0,
  default_grace_days    INTEGER NOT NULL DEFAULT 3,
  default_trial_days    INTEGER NOT NULL DEFAULT 15,
  wompi_environment     TEXT CHECK (wompi_environment IN ('sandbox', 'production')),
  wompi_public_key      TEXT,
  wompi_integrity_enc   TEXT,
  wompi_events_enc      TEXT,
  updated_at            TEXT NOT NULL
);
INSERT INTO platform_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE platform_sessions (
  token_hash  TEXT PRIMARY KEY,
  ip          TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE platform_audit (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  tenant_id   TEXT,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_platform_audit_date ON platform_audit (created_at);

-- Permiso para ver y pagar la suscripción desde el panel del consultorio.
INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'suscripcion.pagar' FROM roles WHERE is_system = 1;
