// Shared wire types for the dashboard billing surface (Phase 2).
// Money is serialised as decimal strings to preserve numeric(12,4)
// precision (matches the convention used by revenue_events).

export type BillingState =
  | "free"
  | "active"
  | "past_due"
  | "paused"
  | "deleted";

// Public ladder is free/indie/studio/enterprise; pro/scale/growth are
// legacy values kept for rows created before the 2026-07 consolidation.
export type BillingTier =
  | "free"
  | "indie"
  | "pro"
  | "scale"
  | "studio"
  | "growth"
  | "enterprise";

export type BillingCycle = "monthly" | "annual";

export type InvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "uncollectible"
  | "void";

export interface PaymentMethodSummary {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  createdAt: string; // ISO 8601
}

export interface BillingSummary {
  state: BillingState;
  tier: BillingTier;
  cycle: BillingCycle;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  defaultPaymentMethod: PaymentMethodSummary | null;
  hasStripeCustomer: boolean;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  status: InvoiceStatus;
  amountDue: string;       // decimal string, USD
  amountPaid: string;      // decimal string, USD
  refundedAmount: string;  // decimal string, USD
  currency: string;        // ISO-4217, lowercase ("usd")
  periodStart: string;     // ISO 8601
  periodEnd: string;       // ISO 8601
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: string;       // ISO 8601
}

export interface UpgradeResponse {
  clientSecret: string;
  publishableKey: string;
}

// ---------------------------------------------------------------------------
// Billing usage metering (Task 5 / Phase 2 billing-usage surface)
// ---------------------------------------------------------------------------

export type UsageMeterKey = "mtr" | "events" | "sql_queries";

export interface UsageMeter {
  key: UsageMeterKey;
  current: number | null;
  limit: number | null;
  cap: "hard" | "soft";
  unit: "usd" | "count";
  available: boolean;
}

export interface BillingUsage {
  tier: string;
  cycle: string;
  periodStart: string;
  periodEnd: string;
  meters: UsageMeter[];
}
