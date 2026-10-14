-- ============================================================================
-- Agenda Sonrisa — migración 0002
--   • Reservas retenidas (hold): por pago, por verificación o por confirmación.
--   • Blindaje de dobles reservas con TRIGGERS (aunque falle el código).
--   • Pago anticipado con Wompi (configuración por consultorio e intentos).
--   • Configuración de WhatsApp y reglas anti-reservas fantasma.
--
-- Solo usa ALTER TABLE ADD COLUMN, CREATE TABLE/INDEX/TRIGGER e INSERT:
-- no reconstruye tablas, así que es segura sobre datos existentes en D1.
-- ============================================================================

-- ─── Consultorio: reglas de reserva en línea y WhatsApp ─────────────────────
ALTER TABLE tenants ADD COLUMN whatsapp_number TEXT;
ALTER TABLE tenants ADD COLUMN whatsapp_reminder_template TEXT;
ALTER TABLE tenants ADD COLUMN online_verification_mode TEXT NOT NULL DEFAULT 'ninguna'
  CHECK (online_verification_mode IN ('ninguna', 'whatsapp'));
ALTER TABLE tenants ADD COLUMN verification_window_minutes INTEGER NOT NULL DEFAULT 60
  CHECK (verification_window_minutes BETWEEN 10 AND 1440);
ALTER TABLE tenants ADD COLUMN max_pending_online_per_patient INTEGER NOT NULL DEFAULT 2
  CHECK (max_pending_online_per_patient BETWEEN 1 AND 20);
ALTER TABLE tenants ADD COLUMN auto_release_hours INTEGER NOT NULL DEFAULT 0
  CHECK (auto_release_hours BETWEEN 0 AND 72);
ALTER TABLE tenants ADD COLUMN payment_window_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (payment_window_minutes BETWEEN 20 AND 120);

-- ─── Servicios: anticipo obligatorio al reservar en línea ───────────────────
ALTER TABLE services ADD COLUMN prepayment_mode TEXT NOT NULL DEFAULT 'ninguno'
  CHECK (prepayment_mode IN ('ninguno', 'porcentaje', 'valor'));
ALTER TABLE services ADD COLUMN prepayment_value INTEGER NOT NULL DEFAULT 0
  CHECK (prepayment_value >= 0);

-- ─── Citas retenidas ────────────────────────────────────────────────────────
-- hold_reason:
--   'pago'          espera el pago anticipado.
--   'verificacion'  espera que el paciente escriba por WhatsApp con su código.
--   'confirmacion'  se libera si el paciente no confirma antes del límite.
-- hold_expires_at: fecha/hora UTC ISO 8601. Al vencer, la cita deja de ocupar
-- el horario inmediatamente (aunque la limpieza aún no la haya cancelado).
ALTER TABLE appointments ADD COLUMN hold_reason TEXT
  CHECK (hold_reason IS NULL OR hold_reason IN ('pago', 'verificacion', 'confirmacion'));
ALTER TABLE appointments ADD COLUMN hold_expires_at TEXT;
ALTER TABLE appointments ADD COLUMN verification_code TEXT;
ALTER TABLE appointments ADD COLUMN prepayment_amount INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_appointments_hold ON appointments(hold_expires_at);

-- ─── Recaudos: origen e idempotencia de pagos externos ──────────────────────
ALTER TABLE payments ADD COLUMN source TEXT NOT NULL DEFAULT 'caja' CHECK (source IN ('caja', 'wompi'));
ALTER TABLE payments ADD COLUMN external_id TEXT;
ALTER TABLE payments ADD COLUMN appointment_id TEXT REFERENCES appointments(id);
-- Una misma transacción de Wompi NUNCA puede generar dos recibos.
CREATE UNIQUE INDEX ux_payments_external ON payments(tenant_id, external_id);
CREATE INDEX idx_payments_appointment ON payments(appointment_id);

-- ─── Configuración de Wompi por consultorio ─────────────────────────────────
-- Los secretos se guardan cifrados (AES-256-GCM) por la aplicación.
CREATE TABLE payment_gateways (
  tenant_id             TEXT PRIMARY KEY REFERENCES tenants(id),
  provider              TEXT NOT NULL DEFAULT 'wompi' CHECK (provider IN ('wompi')),
  environment           TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  public_key            TEXT NOT NULL,
  integrity_secret_enc  TEXT NOT NULL,
  events_secret_enc     TEXT NOT NULL,
  webhook_key           TEXT NOT NULL UNIQUE,
  is_enabled            INTEGER NOT NULL DEFAULT 0,
  policy_text           TEXT,
  last_verified_at      TEXT,
  last_event_at         TEXT,
  updated_by            TEXT,
  updated_at            TEXT NOT NULL
);

-- Cada intento de pago (una referencia de Wompi).
CREATE TABLE payment_intents (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  appointment_id        TEXT NOT NULL REFERENCES appointments(id),
  patient_id            TEXT NOT NULL REFERENCES patients(id),
  reference             TEXT NOT NULL UNIQUE,
  amount_in_cents       INTEGER NOT NULL CHECK (amount_in_cents > 0),
  currency              TEXT NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  environment           TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR', 'EXPIRED')),
  outcome               TEXT CHECK (outcome IS NULL OR outcome IN ('cita_confirmada', 'sin_cupo', 'pago_duplicado', 'anulado_en_wompi', 'monto_no_coincide')),
  needs_attention       INTEGER NOT NULL DEFAULT 0,
  attention_resolved_at TEXT,
  attention_resolved_by TEXT,
  wompi_transaction_id  TEXT,
  payment_method_type   TEXT,
  payment_id            TEXT REFERENCES payments(id),
  checkout_expires_at   TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_intents_tenant_date ON payment_intents(tenant_id, created_at);
CREATE INDEX idx_intents_appointment ON payment_intents(appointment_id);

-- ─── Blindaje de dobles reservas en la base de datos ────────────────────────
-- Aunque un error futuro del código intentara guardar dos citas cruzadas para
-- el mismo profesional, la base de datos lo rechaza con 'HORARIO_OCUPADO'.
-- Una cita ocupa su horario si no está cancelada y su retención no ha vencido.
CREATE TRIGGER trg_appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status <> 'cancelada'
  AND (NEW.hold_expires_at IS NULL OR NEW.hold_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN
  SELECT RAISE(ABORT, 'HORARIO_OCUPADO')
  WHERE EXISTS (
    SELECT 1 FROM appointments o
    WHERE o.tenant_id = NEW.tenant_id
      AND o.professional_id = NEW.professional_id
      AND o.status <> 'cancelada'
      AND (o.hold_expires_at IS NULL OR o.hold_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND o.start_at < NEW.end_at
      AND o.end_at > NEW.start_at
  );
END;

CREATE TRIGGER trg_appointments_no_overlap_update
BEFORE UPDATE OF start_at, end_at, professional_id, status, hold_expires_at ON appointments
WHEN NEW.status <> 'cancelada'
  AND (NEW.hold_expires_at IS NULL OR NEW.hold_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN
  SELECT RAISE(ABORT, 'HORARIO_OCUPADO')
  WHERE EXISTS (
    SELECT 1 FROM appointments o
    WHERE o.tenant_id = NEW.tenant_id
      AND o.professional_id = NEW.professional_id
      AND o.id <> NEW.id
      AND o.status <> 'cancelada'
      AND (o.hold_expires_at IS NULL OR o.hold_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND o.start_at < NEW.end_at
      AND o.end_at > NEW.start_at
  );
END;

-- ─── Nuevos permisos para consultorios existentes ───────────────────────────
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'pagos.configurar' FROM roles WHERE is_system = 1;
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'pagos.ver' FROM roles WHERE is_system = 1 OR name IN ('Recepción', 'Auxiliar contable');
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'agenda.verificar' FROM roles WHERE is_system = 1 OR name = 'Recepción';
