/**
 * Contenedor de dependencias: construye todos los servicios a partir de la
 * base de datos y la configuración. Es el único lugar donde se "cablea" la app.
 */
import type { SqlDatabase } from './db/database.js';
import type { AppConfig } from './http/context.js';
import { AppointmentService } from './modules/appointments/appointmentService.js';
import { AvailabilityService } from './modules/appointments/availabilityService.js';
import { WaitlistService } from './modules/appointments/waitlistService.js';
import { AuditService } from './modules/audit/auditService.js';
import { BillingService } from './modules/billing/billingService.js';
import { CatalogService } from './modules/catalog/catalogService.js';
import { InventoryService } from './modules/inventory/inventoryService.js';
import { PurchaseService } from './modules/inventory/purchaseService.js';
import { EInvoiceService } from './modules/einvoicing/einvoiceService.js';
import { PlanService } from './modules/plans/planService.js';
import { PlatformService } from './modules/platform/platformService.js';
import { PlatformAuthService } from './modules/platform/platformAuthService.js';
import { MailService } from './modules/mail/mailService.js';
import { NotificationService } from './modules/mail/notificationService.js';
import type { OpenSocket } from './modules/mail/smtpClient.js';
import { PasswordResetService } from './modules/users/passwordResetService.js';
import { MaintenanceService } from './modules/maintenance/maintenanceService.js';
import { PatientService } from './modules/patients/patientService.js';
import { PaymentService } from './modules/payments/paymentService.js';
import { WompiApi } from './modules/payments/wompiClient.js';
import { ProfessionalService } from './modules/professionals/professionalService.js';
import { ReportService } from './modules/reports/reportService.js';
import { TenantService } from './modules/tenants/tenantService.js';
import { UserService } from './modules/users/userService.js';
import { AuthService } from './security/authService.js';
import { RateLimiter } from './security/rateLimiter.js';
import { TurnstileVerifier } from './security/turnstile.js';

export interface AppServices {
  audit: AuditService;
  rateLimiter: RateLimiter;
  auth: AuthService;
  tenants: TenantService;
  professionals: ProfessionalService;
  catalog: CatalogService;
  patients: PatientService;
  availability: AvailabilityService;
  appointments: AppointmentService;
  waitlist: WaitlistService;
  billing: BillingService;
  reports: ReportService;
  users: UserService;
  payments: PaymentService;
  maintenance: MaintenanceService;
  inventory: InventoryService;
  purchases: PurchaseService;
  einvoices: EInvoiceService;
  platform: PlatformService;
  plans: PlanService;
  platformAuth: PlatformAuthService;
  turnstile: TurnstileVerifier;
  mail: MailService;
  notifications: NotificationService;
  passwordResets: PasswordResetService;
}

export interface ExternalDependencies {
  /** Cliente HTTP para Wompi y Turnstile (inyectable en pruebas). */
  fetch: typeof fetch;
  /** Conexión TLS para el correo (Workers: cloudflare:sockets; Node: tls). Sin ella, los correos quedan "omitidos". */
  openSocket?: OpenSocket;
}

export function createServices(db: SqlDatabase, config: AppConfig, external: ExternalDependencies): AppServices {
  const audit = new AuditService(db);
  const rateLimiter = new RateLimiter(db);
  const auth = new AuthService(db, config, rateLimiter, audit);
  const tenants = new TenantService(db, audit);
  const plans = new PlanService(db);
  const professionals = new ProfessionalService(db, audit, plans);
  const catalog = new CatalogService(db, audit);
  const patients = new PatientService(db, audit);
  const availability = new AvailabilityService(db);
  const appointments = new AppointmentService(db, audit, availability, catalog, patients, professionals);
  const billing = new BillingService(db, audit, patients, catalog);
  const payments = new PaymentService(db, config, audit, appointments, patients, new WompiApi(external.fetch));

  const inventory = new InventoryService(db, audit);
  const platform = new PlatformService(db, config, auth, new WompiApi(external.fetch), plans);
  const mail = new MailService(db, config, external.openSocket ?? null);
  const notifications = new NotificationService(db, mail, platform);

  // Cada pago aplicado (Wompi o manual) envía su comprobante al consultorio.
  platform.onPaymentRegistered = (paymentId) => mail.queue(notifications.paymentReceived(paymentId));

  // Al atender una cita: los anticipos pagados en línea se abonan a su cargo
  // y se descuentan los insumos de la receta del servicio.
  appointments.onAttended = async (tenantId, appointmentId) => {
    await billing.applyAppointmentPrepayments(tenantId, appointmentId);
    try {
      await inventory.consumeForAppointment(tenantId, appointmentId);
    } catch (error) {
      // La cita ya quedó atendida; el inventario se puede corregir con un ajuste.
      console.error('[inventario] No se pudo descontar el consumo de la cita', appointmentId, error);
    }
  };

  return {
    audit,
    rateLimiter,
    auth,
    tenants,
    professionals,
    catalog,
    patients,
    availability,
    appointments,
    waitlist: new WaitlistService(db, audit, patients),
    billing,
    reports: new ReportService(db),
    users: new UserService(db, audit, auth, plans),
    payments,
    maintenance: new MaintenanceService(db, appointments, payments, platform),
    inventory,
    purchases: new PurchaseService(db, audit, inventory),
    einvoices: new EInvoiceService(db, config, audit, external.fetch),
    platform,
    plans,
    platformAuth: new PlatformAuthService(db, config, auth, rateLimiter),
    turnstile: new TurnstileVerifier(config.turnstileSecretKey, external.fetch),
    mail,
    notifications,
    passwordResets: new PasswordResetService(db, auth, audit, rateLimiter, mail, platform),
  };
}
