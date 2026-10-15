/** Tipos que devuelve la API de plataforma. */
import type { SubscriptionStatus } from '../../src/shared/subscription.js';
import type { PlanModule, PlanSelection } from '../../src/shared/plans.js';

export interface TenantOverview {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  isShowcase: boolean;
  createdAt: string;
  adminEmail: string | null;
  users: number;
  patients: number;
  appointmentsLast30: number;
  lastLoginAt: string | null;
  monthlyPrice: number;
  graceDays: number;
  billingMode: 'auto' | 'exento' | 'suspendido';
  ownerNotes: string | null;
  subscription: SubscriptionStatus;
  lastPaymentAt: string | null;
  planId: string;
  planSelection: PlanSelection;
  customPrice: number | null;
  modules: PlanModule[];
  maxProfessionals: number;
  maxUsers: number;
  professionals: number;
  pendingPlan: (PlanSelection & { monthlyPrice: number; effectiveOn: string }) | null;
  onTrial: boolean;
  signupSource: 'dueno' | 'registro' | 'autoservicio';
  demoExpiresAt: string | null;
  contact: { name: string | null; email: string | null; phone: string | null };
  convertedTenantId: string | null;
}

export interface Summary {
  realClinics: number;
  demos: number;
  active: number;
  dueSoon: number;
  inGrace: number;
  suspended: number;
  monthlyRecurring: number;
  collectedThisMonth: number;
  trials: number;
  selfDemos: number;
  conversions: number;
  byPlan: Record<string, number>;
  /** Recaudado en el año calendario (para el tope de IVA). */
  yearCollected: number;
  /** 3.500 UVT en pesos: si los ingresos del año lo superan, se vuelve responsable de IVA. */
  ivaThreshold: number;
  taxRegime: 'no_responsable_iva' | 'responsable_iva';
}

export interface MailSettings {
  smtpUser: string;
  smtpFromName: string;
  maskedPassword: string | null;
  configured: boolean;
  notifyOwner: boolean;
}

export interface LegalSettings {
  providerName: string;
  providerId: string;
  city: string;
  contactEmail: string;
  whatsapp: string;
  taxRegime: 'no_responsable_iva' | 'responsable_iva';
  termsVersion: string;
  uvtValue: number;
  publicUrl: string;
}

export interface EmailLogRow {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  status: 'enviado' | 'fallido' | 'omitido';
  error: string | null;
  created_at: string;
  tenant_name: string | null;
}

export interface PlatformSettings {
  ownerName: string;
  ownerWhatsapp: string;
  paymentInstructions: string;
  defaultMonthlyPrice: number;
  defaultGraceDays: number;
  defaultTrialDays: number;
  wompiEnvironment: 'sandbox' | 'production' | null;
  wompiPublicKey: string;
  maskedIntegritySecret: string | null;
  maskedEventsSecret: string | null;
  wompiConfigured: boolean;
  demoDays: number;
  selfSignupEnabled: boolean;
  selfDemoEnabled: boolean;
  maxSelfDemos: number;
  webhookUrl: string;
  defaults: { trialUntil: string; monthlyPrice: number; graceDays: number };
}

export interface PaymentRow {
  id: string;
  amount: number;
  months: number;
  new_paid_until: string;
  method: string;
  reference: string | null;
  status: 'aprobado' | 'anulado';
  notes: string | null;
  void_reason: string | null;
  created_at: string;
  kind: 'renovacion' | 'cambio_plan';
  receipt_number: number | null;
}

export interface PlatformAdmin {
  id: string;
  email: string;
  fullName: string;
  twoFactorEnabled: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const OFFSET = -300;

export const PAYMENT_METHODS: Array<[string, string]> = [
  ['transferencia', 'Transferencia'], ['nequi', 'Nequi'], ['daviplata', 'Daviplata'], ['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['otro', 'Otro'],
];
