-- Migración 0009: bitácora inmutable y registros financieros protegidos.
--
-- Garantías a nivel de base de datos (aplican aunque alguien edite la base
-- directamente, no solo desde la aplicación):
--   • audit_log y platform_audit nunca se modifican ni se borran
--     (solo se borra la bitácora de una DEMO cuando se elimina la demo).
--   • Pagos, cargos, abonos, facturas, compras, pagos a proveedores,
--     movimientos de inventario, citas y pacientes no se pueden borrar
--     (se anulan, quedando el motivo y quién lo hizo). Excepción: demos.
--   • En pagos, cargos y pagos de suscripción el valor, el paciente y la
--     fecha no se pueden cambiar, y lo anulado no se puede "revivir".
--   • platform_audit guarda qué cuenta de dueño hizo cada acción.

ALTER TABLE platform_audit ADD COLUMN admin_id TEXT;
ALTER TABLE audit_log ADD COLUMN user_agent TEXT;

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'BITACORA_INMUTABLE'); END;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'BITACORA_INMUTABLE'); END;

CREATE TRIGGER trg_platform_audit_no_update BEFORE UPDATE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'BITACORA_INMUTABLE'); END;
CREATE TRIGGER trg_platform_audit_no_delete BEFORE DELETE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'BITACORA_INMUTABLE'); END;

CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_charges_no_delete BEFORE DELETE ON charges
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_payment_allocations_no_delete BEFORE DELETE ON payment_allocations
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_sales_invoices_no_delete BEFORE DELETE ON sales_invoices
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_sales_invoice_lines_no_delete BEFORE DELETE ON sales_invoice_lines
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_purchases_no_delete BEFORE DELETE ON purchases
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_supplier_payments_no_delete BEFORE DELETE ON supplier_payments
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_subscription_payments_no_delete BEFORE DELETE ON subscription_payments
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_appointments_no_delete BEFORE DELETE ON appointments
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_patients_no_delete BEFORE DELETE ON patients
WHEN (SELECT is_showcase FROM tenants WHERE id = OLD.tenant_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

-- Valores que nunca cambian después de registrados.
CREATE TRIGGER trg_payments_immutable BEFORE UPDATE OF tenant_id, patient_id, receipt_number, amount, method, created_by, created_at ON payments
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;
CREATE TRIGGER trg_payments_no_revive BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'anulado' AND NEW.status <> 'anulado'
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_charges_immutable BEFORE UPDATE OF tenant_id, patient_id, amount, quantity, created_by, created_at ON charges
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;
CREATE TRIGGER trg_charges_no_revive BEFORE UPDATE OF status ON charges
WHEN OLD.status = 'anulado' AND NEW.status <> 'anulado'
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_payment_allocations_no_update BEFORE UPDATE ON payment_allocations
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_subscription_payments_immutable BEFORE UPDATE OF tenant_id, amount, months, previous_paid_until, new_paid_until, created_at ON subscription_payments
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;
CREATE TRIGGER trg_subscription_payments_no_revive BEFORE UPDATE OF status ON subscription_payments
WHEN OLD.status = 'anulado' AND NEW.status <> 'anulado'
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;

CREATE TRIGGER trg_supplier_payments_immutable BEFORE UPDATE OF tenant_id, purchase_id, amount, created_at ON supplier_payments
BEGIN SELECT RAISE(ABORT, 'REGISTRO_PROTEGIDO'); END;
