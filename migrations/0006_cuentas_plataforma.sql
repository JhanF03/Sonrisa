-- Cuentas del dueño de la plataforma: ingreso con correo + contraseña
-- (y verificación en dos pasos opcional con app autenticadora).
-- La clave PLATFORM_ADMIN_KEY ya no se usa a diario: solo para crear la
-- primera cuenta y para recuperar el acceso.

CREATE TABLE platform_admins (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name        TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  totp_secret_enc  TEXT,
  totp_pending_enc TEXT,
  totp_last_step   INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_login_at    TEXT,
  created_at       TEXT NOT NULL
);

-- Las sesiones abiertas con la clave dejan de valer: ahora pertenecen a una cuenta.
DELETE FROM platform_sessions;
ALTER TABLE platform_sessions ADD COLUMN admin_id TEXT REFERENCES platform_admins(id);
CREATE INDEX ix_platform_sessions_admin ON platform_sessions (admin_id);
