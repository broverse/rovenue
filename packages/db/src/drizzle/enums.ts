import { pgEnum } from "drizzle-orm/pg-core";

// =============================================================
// Postgres enums
// =============================================================
//
// The string labels below are the on-disk variant names. Adding
// a new variant requires a drizzle-kit migration (ALTER TYPE …
// ADD VALUE) — generate it via `pnpm db:migrate:generate`.

export const memberRole = pgEnum("MemberRole", [
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
]);

export const environment = pgEnum("Environment", [
  "PRODUCTION",
  "SANDBOX",
]);

export const productType = pgEnum("ProductType", [
  "SUBSCRIPTION",
  "CONSUMABLE",
  "NON_CONSUMABLE",
]);

export const store = pgEnum("Store", [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "MANUAL",
]);

export const scheduledActionType = pgEnum("ScheduledActionType", ["CANCEL"]);

export const scheduledActionStatus = pgEnum("ScheduledActionStatus", [
  "PENDING",
  "EXECUTED",
  "CANCELED",
  "FAILED",
]);

export const purchaseStatus = pgEnum("PurchaseStatus", [
  "TRIAL",
  "ACTIVE",
  "EXPIRED",
  "REFUNDED",
  "REVOKED",
  "PAUSED",
  "GRACE_PERIOD",
]);

export const creditLedgerType = pgEnum("CreditLedgerType", [
  "PURCHASE",
  "SPEND",
  "REFUND",
  "BONUS",
  "EXPIRE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
]);

export const webhookSource = pgEnum("WebhookSource", [
  "APPLE",
  "GOOGLE",
  "STRIPE",
]);

export const webhookEventStatus = pgEnum("WebhookEventStatus", [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
]);

export const outgoingWebhookStatus = pgEnum("OutgoingWebhookStatus", [
  "PENDING",
  "SENT",
  "FAILED",
  "DEAD",
  "DISMISSED",
]);

export const revenueEventType = pgEnum("RevenueEventType", [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "CANCELLATION",
  "REFUND",
  "REACTIVATION",
  "CREDIT_PURCHASE",
]);

export const experimentType = pgEnum("ExperimentType", [
  "FLAG",
  "OFFERING",
  "PAYWALL",
  "ELEMENT",
]);

export const experimentStatus = pgEnum("ExperimentStatus", [
  "DRAFT",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
]);

export const featureFlagType = pgEnum("FeatureFlagType", [
  "BOOLEAN",
  "STRING",
  "NUMBER",
  "JSON",
]);

export const featureFlagEnv = pgEnum("FeatureFlagEnv", [
  "PROD",
  "STAGING",
  "DEVELOPMENT",
]);

export const aggregateTypeEnum = pgEnum("aggregate_type", [
  "EXPOSURE",
  "REVENUE_EVENT",
  "CREDIT_LEDGER",
  "BILLING",
  "NOTIFICATION",
  "FUNNEL",
]);

export const invitationDeliveryStatus = pgEnum("InvitationDeliveryStatus", [
  "PENDING",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
]);

// =============================================================
// Billing pgEnums (Phase 1)
// =============================================================

export const billingCycleEnum = pgEnum("billing_cycle", ["monthly", "annual"]);
export const billingDunningPhaseEnum = pgEnum("billing_dunning_phase", [
  "retrying",
  "past_due",
  "suspended",
]);
export const billingInvoiceStatusEnum = pgEnum("billing_invoice_status", [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
]);
export const billingMeterKeyEnum = pgEnum("billing_meter_key", [
  "mtr",
  "events",
  "sql_queries",
]);
export const billingPendingActionEnum = pgEnum("billing_pending_action", [
  "downgrade_to_free",
  "pause",
  "delete",
]);
export const billingStateEnum = pgEnum("billing_state", [
  "free",
  "active",
  "past_due",
  "paused",
  "deleted",
]);
export const billingTierEnum = pgEnum("billing_tier", [
  "free",
  "indie",
  "pro",
  "scale",
  "growth",
  "enterprise",
]);

// =============================================================
// Billing enums (TS-only — not Postgres pgEnum; stored as text)
// =============================================================

export const billingState = [
  "free",
  "active",
  "past_due",
  "paused",
  "deleted",
] as const;
export type BillingState = (typeof billingState)[number];

export const billingTier = [
  "free",
  "indie",
  "pro",
  "scale",
  "growth",
  "enterprise",
] as const;
export type BillingTier = (typeof billingTier)[number];

export const billingCycle = ["monthly", "annual"] as const;
export type BillingCycle = (typeof billingCycle)[number];

export const billingInvoiceStatus = [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
] as const;
export type BillingInvoiceStatus = (typeof billingInvoiceStatus)[number];

export const billingDunningPhase = [
  "retrying",
  "past_due",
  "suspended",
] as const;
export type BillingDunningPhase = (typeof billingDunningPhase)[number];

export const billingPendingAction = [
  "downgrade_to_free",
  "pause",
  "delete",
] as const;
export type BillingPendingAction = (typeof billingPendingAction)[number];

export const billingMeterKey = ["mtr", "events", "sql_queries"] as const;
export type BillingMeterKey = (typeof billingMeterKey)[number];

// =============================================================
// Notifications pgEnums
// =============================================================

export const notificationChannel = pgEnum("NotificationChannel", [
  "email",
  "push",
  "inapp",
]);

export const notificationDeliveryStatus = pgEnum("NotificationDeliveryStatus", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
]);

export const pushPlatform = pgEnum("PushPlatform", ["ios", "android"]);

export const notificationSuppressionReason = pgEnum(
  "NotificationSuppressionReason",
  ["hard_bounce", "complaint", "manual"],
);

// =============================================================
// Funnels pgEnums
// =============================================================

export const funnelStatus = pgEnum("FunnelStatus", [
  "draft",
  "published",
  "archived",
]);

export const funnelSessionState = pgEnum("FunnelSessionState", [
  "in_progress",
  "paid",
  "completed",
  "abandoned",
]);

export const funnelPurchaseStatus = pgEnum("FunnelPurchaseStatus", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

export const funnelTemplateScope = pgEnum("FunnelTemplateScope", [
  "system",
  "user",
]);

export const funnelDeferredPlatform = pgEnum("FunnelDeferredPlatform", [
  "ios",
]);
