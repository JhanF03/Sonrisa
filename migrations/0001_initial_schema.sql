-- ============================================================================
-- Agenda Sonrisa — esquema inicial (Fase 1)
-- Compatible con Cloudflare D1 y SQLite.
--
-- Convenciones:
--   • Todas las tablas de negocio llevan tenant_id (un consultorio = un tenant).
--   • Dinero en pesos enteros (COP no usa centavos en la práctica).
--   • Fechas/horas de agenda en hora local del consultorio: 'YYYY-MM-DDTHH:MM'.
--   • Marcas de auditoría (created_at, etc.) en ISO 8601 UTC.
--   • Los registros financieros nunca se borran: se anulan con motivo.
-- ============================================================================

-- ─── Consultorios ───────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id                        TEXT PRIMARY KEY,
  slug                      TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  phone                     TEXT,
  address                   TEXT,
  city                      TEXT,
  brand_color               TEXT NOT NULL DEFAULT '#3f6f68',
  logo_url                  TEXT,
  utc_offset_minutes        INTEGER NOT NULL DEFAULT -300,
  slot_interval_minutes     INTEGER NOT NULL DEFAULT 30,
  min_booking_notice_hours  INTEGER NOT NULL DEFAULT 2,
  booking_window_days       INTEGER NOT NULL DEFAULT 30,
  reactivation_months       INTEGER NOT NULL DEFAULT 6,
  online_booking_enabled    INTEGER NOT NULL DEFAULT 1,
  close_on_holidays         INTEGER NOT NULL DEFAULT 1,
  privacy_policy_version    TEXT NOT NULL DEFAULT '1',
  is_showcase               INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL
);

-- ─── Seguridad ──────────────────────────────────────────────────────────────
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name      TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT,
  is_system    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE role_permissions (
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (
  bucket_key    TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  hit_count     INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant_date ON audit_log(tenant_id, created_at);

-- Consecutivos por consultorio (recibos de caja, etc.).
CREATE TABLE counters (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

-- ─── Configuración de agenda ────────────────────────────────────────────────
CREATE TABLE professionals (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  full_name   TEXT NOT NULL,
  specialty   TEXT,
  color       TEXT NOT NULL DEFAULT '#4f6d8a',
  user_id     TEXT REFERENCES users(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_professionals_tenant ON professionals(tenant_id);

-- Bloques de atención por día de la semana (0 = domingo). Varios bloques
-- por día permiten pausas (ej. 08:00–12:00 y 14:00–18:00).
CREATE TABLE schedules (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  professional_id  TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  weekday          INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX idx_schedules_professional ON schedules(professional_id);

-- Bloqueos puntuales (vacaciones, congresos). professional_id NULL = todo el consultorio.
CREATE TABLE time_blocks (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  professional_id  TEXT REFERENCES professionals(id) ON DELETE CASCADE,
  start_at         TEXT NOT NULL,
  end_at           TEXT NOT NULL,
  reason           TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  CHECK (start_at < end_at)
);
CREATE INDEX idx_blocks_tenant_dates ON time_blocks(tenant_id, start_at);

-- ─── Catálogo ───────────────────────────────────────────────────────────────
CREATE TABLE services (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT,
  item_type           TEXT NOT NULL DEFAULT 'servicio' CHECK (item_type IN ('servicio', 'insumo')),
  price               INTEGER NOT NULL CHECK (price >= 0),
  duration_minutes    INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  tax_rate_bps        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  is_bookable_online  INTEGER NOT NULL DEFAULT 1,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

-- ─── Pacientes ──────────────────────────────────────────────────────────────
CREATE TABLE patients (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  document_type    TEXT NOT NULL,
  document_number  TEXT NOT NULL,
  full_name        TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT,
  birth_date       TEXT,
  guardian_name    TEXT,
  guardian_phone   TEXT,
  admin_notes      TEXT,
  consent_at       TEXT,
  consent_version  TEXT,
  consent_channel  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (tenant_id, document_type, document_number)
);
CREATE INDEX idx_patients_tenant_name ON patients(tenant_id, full_name);

-- ─── Citas ──────────────────────────────────────────────────────────────────
CREATE TABLE appointments (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  patient_id           TEXT NOT NULL REFERENCES patients(id),
  professional_id      TEXT NOT NULL REFERENCES professionals(id),
  service_id           TEXT NOT NULL REFERENCES services(id),
  start_at             TEXT NOT NULL,
  end_at               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (status IN ('pendiente', 'confirmada', 'atendida', 'no_asistio', 'cancelada')),
  source               TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('online', 'manual')),
  price                INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  recurrence_group_id  TEXT,
  reminder_sent_at     TEXT,
  confirmed_at         TEXT,
  cancelled_at         TEXT,
  cancel_reason        TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (start_at < end_at)
);
CREATE INDEX idx_appointments_slot ON appointments(tenant_id, professional_id, start_at);
CREATE INDEX idx_appointments_patient ON appointments(patient_id);
CREATE INDEX idx_appointments_tenant_start ON appointments(tenant_id, start_at);

CREATE TABLE waitlist_entries (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  service_id       TEXT REFERENCES services(id),
  professional_id  TEXT REFERENCES professionals(id),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa', 'resuelta')),
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_waitlist_tenant ON waitlist_entries(tenant_id, status);

-- ─── Cartera y caja ─────────────────────────────────────────────────────────
-- Cargo = cuenta por cobrar (servicio prestado o ítem de un plan de tratamiento).
CREATE TABLE charges (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  appointment_id  TEXT UNIQUE REFERENCES appointments(id),
  service_id      TEXT REFERENCES services(id),
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'anulado')),
  void_reason     TEXT,
  voided_by       TEXT,
  voided_at       TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_charges_patient ON charges(tenant_id, patient_id);

-- Recaudo = dinero recibido. Lo no aplicado a cargos queda como anticipo (saldo a favor).
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  receipt_number  INTEGER NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'nequi', 'daviplata', 'tarjeta', 'otro')),
  reference       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'anulado')),
  void_reason     TEXT,
  voided_by       TEXT,
  voided_at       TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (tenant_id, receipt_number)
);
CREATE INDEX idx_payments_patient ON payments(tenant_id, patient_id);
CREATE INDEX idx_payments_date ON payments(tenant_id, created_at);

-- Aplicación de un recaudo a un cargo (abono).
CREATE TABLE payment_allocations (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  charge_id   TEXT NOT NULL REFERENCES charges(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_allocations_charge ON payment_allocations(charge_id);
