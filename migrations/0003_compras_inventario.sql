-- Fase 2: proveedores, insumos, compras (con factura / XML DIAN), cuentas por pagar,
-- inventario por movimientos y consumo de insumos por servicio (receta).
--
-- Reglas:
-- • El stock NO se guarda: es la suma de stock_movements (no se puede descuadrar).
-- • Nada se borra: compras y pagos a proveedores se anulan con motivo.
-- • El consumo por cita es idempotente (índice único cita + insumo).

CREATE TABLE suppliers (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  nit           TEXT,
  phone         TEXT,
  email         TEXT,
  contact_name  TEXT,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_suppliers_nit ON suppliers (tenant_id, nit) WHERE nit IS NOT NULL;
CREATE INDEX ix_suppliers_tenant ON suppliers (tenant_id, name);

CREATE TABLE supplies (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'unidad',
  min_stock   REAL NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  -- Costo promedio ponderado por unidad (pesos, puede tener decimales).
  avg_cost    REAL NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE purchases (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  supplier_id     TEXT NOT NULL REFERENCES suppliers(id),
  invoice_number  TEXT NOT NULL,
  cufe            TEXT,
  issue_date      TEXT NOT NULL,
  due_date        TEXT,
  subtotal        INTEGER NOT NULL CHECK (subtotal >= 0),
  tax_total       INTEGER NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total           INTEGER NOT NULL CHECK (total >= 0),
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'xml')),
  status          TEXT NOT NULL DEFAULT 'registrada' CHECK (status IN ('registrada', 'anulada')),
  void_reason     TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
);
-- Una misma factura del mismo proveedor no se puede registrar dos veces.
CREATE UNIQUE INDEX ux_purchases_invoice ON purchases (tenant_id, supplier_id, invoice_number) WHERE status = 'registrada';
CREATE UNIQUE INDEX ux_purchases_cufe ON purchases (tenant_id, cufe) WHERE cufe IS NOT NULL AND status = 'registrada';
CREATE INDEX ix_purchases_date ON purchases (tenant_id, issue_date);

CREATE TABLE purchase_lines (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  purchase_id        TEXT NOT NULL REFERENCES purchases(id),
  supply_id          TEXT REFERENCES supplies(id), -- NULL = gasto que no es inventario
  description        TEXT NOT NULL,
  supplier_code      TEXT,
  quantity           REAL NOT NULL CHECK (quantity > 0),
  -- Unidades de inventario por cada unidad comprada (ej. caja x 100 guantes = 100).
  conversion_factor  REAL NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  line_total         INTEGER NOT NULL CHECK (line_total >= 0),
  tax_amount         INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0)
);
CREATE INDEX ix_purchase_lines_purchase ON purchase_lines (purchase_id);

CREATE TABLE supplier_payments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  purchase_id   TEXT NOT NULL REFERENCES purchases(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  method        TEXT NOT NULL,
  payment_date  TEXT NOT NULL,
  reference     TEXT,
  status        TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'anulado')),
  void_reason   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_supplier_payments_purchase ON supplier_payments (purchase_id);

CREATE TABLE stock_movements (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  supply_id       TEXT NOT NULL REFERENCES supplies(id),
  kind            TEXT NOT NULL CHECK (kind IN ('compra', 'consumo', 'ajuste', 'anulacion_compra')),
  quantity        REAL NOT NULL, -- positivo entra, negativo sale
  unit_cost       REAL NOT NULL DEFAULT 0,
  purchase_id     TEXT REFERENCES purchases(id),
  appointment_id  TEXT REFERENCES appointments(id),
  reason          TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_stock_movements_supply ON stock_movements (tenant_id, supply_id, created_at);
CREATE INDEX ix_stock_movements_date ON stock_movements (tenant_id, created_at);
CREATE UNIQUE INDEX ux_stock_consumption ON stock_movements (appointment_id, supply_id) WHERE kind = 'consumo';

-- Receta: insumos que gasta cada servicio.
CREATE TABLE service_supplies (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  service_id  TEXT NOT NULL REFERENCES services(id),
  supply_id   TEXT NOT NULL REFERENCES supplies(id),
  quantity    REAL NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (service_id, supply_id)
);

-- Recuerda qué insumo es cada código de producto del proveedor (para importar XML).
CREATE TABLE supplier_item_links (
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  supplier_id    TEXT NOT NULL REFERENCES suppliers(id),
  supplier_code  TEXT NOT NULL,
  supply_id      TEXT NOT NULL REFERENCES supplies(id),
  conversion_factor REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, supplier_id, supplier_code)
);

INSERT OR IGNORE INTO counters (tenant_id, name, value) SELECT id, 'insumo', 0 FROM tenants;

-- ─── Permisos nuevos para consultorios existentes ───────────────────────────
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, p.permission FROM roles,
    (SELECT 'inventario.ver' AS permission UNION ALL SELECT 'inventario.gestionar' UNION ALL SELECT 'compras.ver'
     UNION ALL SELECT 'compras.gestionar' UNION ALL SELECT 'compras.pagar') AS p
  WHERE is_system = 1;
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, p.permission FROM roles,
    (SELECT 'inventario.ver' AS permission UNION ALL SELECT 'compras.ver' UNION ALL SELECT 'compras.gestionar' UNION ALL SELECT 'compras.pagar') AS p
  WHERE name = 'Auxiliar contable';
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'inventario.ver' FROM roles WHERE name = 'Recepción';
