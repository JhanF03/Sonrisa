/** Tipos que devuelve la API de plataforma. */
import type { SubscriptionStatus } from '../../src/shared/subscription.js';

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
