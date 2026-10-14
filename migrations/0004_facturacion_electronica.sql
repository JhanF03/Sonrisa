-- Fase 3: facturación electrónica con el proveedor tecnológico del consultorio.
--
-- Modos (einvoice_settings.provider):
--   'externo' → el consultorio factura en su software actual y registra aquí número y CUFE (costo cero).
--   'factus'  → emisión directa por la API de Factus (OAuth). Credenciales cifradas.
--   'webhook' → se envía la factura firmada (HMAC) a una URL propia (Make, n8n u otro proveedor).
--
-- Reglas:
-- • Un cargo solo puede estar en UNA factura vigente (índice único parcial).
-- • Un cargo facturado no se puede anular (trigger): primero se anula la factura (nota crédito).
-- • reference_code es único y se reutiliza en los reintentos (el proveedor no duplica).

CREATE TABLE einvoice_settings (
  tenant_id           TEXT PRIMARY KEY REFERENCES tenants(id),
  provider            TEXT NOT NULL DEFAULT 'externo' CHECK (provider IN ('externo', 'factus', 'webhook')),
  environment         TEXT NOT NULL DEFAULT 'pruebas' CHECK (environment IN ('pruebas', 'produccion')),
  -- JSON cifrado con AES-GCM: credenciales del proveedor.
  credentials_enc     TEXT,
  -- Datos no secretos (URL del webhook, rango de numeración, client_id, usuario…).
  public_config       TEXT NOT NULL DEFAULT '{}',
  token_enc           TEXT,
  token_expires_at    TEXT,
  is_enabled          INTEGER NOT NULL DEFAULT 0,
  last_verified_at    TEXT,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL
);

CREATE TABLE sales_invoices (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  reference_code   TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('externo', 'factus', 'webhook')),
  status           TEXT NOT NULL CHECK (status IN ('pendiente', 'emitida', 'rechazada', 'anulada')),
  number           TEXT,
  cufe             TEXT,
  qr_url           TEXT,
  public_url       TEXT,
  customer         TEXT NOT NULL, -- JSON: datos del adquiriente al momento de facturar
  payment_form     TEXT NOT NULL CHECK (payment_form IN ('contado', 'credito')),
  payment_method   TEXT NOT NULL,
  due_date         TEXT,
  observation      TEXT,
  subtotal         INTEGER NOT NULL CHECK (subtotal >= 0),
  tax_total        INTEGER NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total            INTEGER NOT NULL CHECK (total > 0),
  last_error       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  void_reason      TEXT,
  credit_note_ref  TEXT,
  created_by       TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  issued_at        TEXT,
  UNIQUE (tenant_id, reference_code)
);
CREATE INDEX ix_sales_invoices_date ON sales_invoices (tenant_id, created_at);
CREATE INDEX ix_sales_invoices_patient ON sales_invoices (patient_id);
CREATE UNIQUE INDEX ux_sales_invoices_cufe ON sales_invoices (tenant_id, cufe) WHERE cufe IS NOT NULL AND status = 'emitida';

CREATE TABLE sales_invoice_lines (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  invoice_id    TEXT NOT NULL REFERENCES sales_invoices(id),
  charge_id     TEXT NOT NULL REFERENCES charges(id),
  code          TEXT NOT NULL,
  description   TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  tax_rate_bps  INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL CHECK (line_total >= 0),
  -- 0 cuando la factura se rechaza o anula: el cargo vuelve a estar disponible.
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_invoice_lines_charge ON sales_invoice_lines (charge_id) WHERE is_active = 1;
CREATE INDEX ix_invoice_lines_invoice ON sales_invoice_lines (invoice_id);

CREATE TRIGGER trg_charges_no_void_if_invoiced
BEFORE UPDATE OF status ON charges
WHEN NEW.status = 'anulado' AND OLD.status = 'activo'
  AND EXISTS (SELECT 1 FROM sales_invoice_lines WHERE charge_id = NEW.id AND is_active = 1)
BEGIN
  SELECT RAISE(ABORT, 'CARGO_FACTURADO');
END;

INSERT OR IGNORE INTO counters (tenant_id, name, value) SELECT id, 'factura_ref', 0 FROM tenants;

-- ─── Permisos nuevos para consultorios existentes ───────────────────────────
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, p.permission FROM roles,
    (SELECT 'facturacion.ver' AS permission UNION ALL SELECT 'facturacion.emitir' UNION ALL SELECT 'facturacion.anular'
     UNION ALL SELECT 'facturacion.configurar') AS p
  WHERE is_system = 1;
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, p.permission FROM roles,
    (SELECT 'facturacion.ver' AS permission UNION ALL SELECT 'facturacion.emitir' UNION ALL SELECT 'facturacion.anular') AS p
  WHERE name = 'Auxiliar contable';
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, p.permission FROM roles,
    (SELECT 'facturacion.ver' AS permission UNION ALL SELECT 'facturacion.emitir') AS p
  WHERE name = 'Recepción';
