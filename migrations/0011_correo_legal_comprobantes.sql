-- Migración 0011: correo (Gmail), datos legales del dueño, comprobantes de pago,
-- recordatorios automáticos, recuperación de contraseña y aceptación de términos.

-- Correo saliente con la cuenta de Gmail del dueño (contraseña de aplicación cifrada).
ALTER TABLE platform_settings ADD COLUMN smtp_user TEXT;
ALTER TABLE platform_settings ADD COLUMN smtp_password_enc TEXT;
ALTER TABLE platform_settings ADD COLUMN smtp_from_name TEXT;
ALTER TABLE platform_settings ADD COLUMN notify_owner INTEGER NOT NULL DEFAULT 1;

-- Datos de quien presta el servicio (aparecen en términos, política de datos y comprobantes).
ALTER TABLE platform_settings ADD COLUMN legal_name TEXT;
ALTER TABLE platform_settings ADD COLUMN legal_id TEXT;
ALTER TABLE platform_settings ADD COLUMN legal_city TEXT;
ALTER TABLE platform_settings ADD COLUMN legal_email TEXT;
ALTER TABLE platform_settings ADD COLUMN tax_regime TEXT NOT NULL DEFAULT 'no_responsable_iva'
  CHECK (tax_regime IN ('no_responsable_iva', 'responsable_iva'));
ALTER TABLE platform_settings ADD COLUMN uvt_value INTEGER NOT NULL DEFAULT 52374;
ALTER TABLE platform_settings ADD COLUMN receipt_counter INTEGER NOT NULL DEFAULT 0;
-- Dirección pública del sistema (para los enlaces de los correos).
ALTER TABLE platform_settings ADD COLUMN public_url TEXT;

-- Comprobante de pago consecutivo (no es factura electrónica).
ALTER TABLE subscription_payments ADD COLUMN receipt_number INTEGER;
CREATE UNIQUE INDEX ux_subscription_payments_receipt ON subscription_payments (receipt_number) WHERE receipt_number IS NOT NULL;

-- Aceptación de términos y política de datos (versión, fecha e IP).
ALTER TABLE tenants ADD COLUMN terms_version TEXT;
ALTER TABLE tenants ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE tenants ADD COLUMN terms_accepted_ip TEXT;

-- Registro de correos enviados (para saber qué se envió y qué falló).
CREATE TABLE email_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id),
  kind        TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('enviado', 'fallido', 'omitido')),
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_email_log_date ON email_log (created_at);

-- Avisos ya enviados (para no repetir el mismo recordatorio).
CREATE TABLE subscription_notices (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  kind        TEXT NOT NULL,
  period_key  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind, period_key)
);

-- Enlaces para restablecer la contraseña (un solo uso, 1 hora).
CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  expires_at  INTEGER NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
