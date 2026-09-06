import { pgEnum } from "drizzle-orm/pg-core";
import { SUBSCRIPTION_STATUSES } from "@rovenue/shared/subscription-status";

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

// Derived from @rovenue/shared/subscription-status so the Postgres type
// and the TypeScript union cannot drift. pgEnum wants a non-empty
// tuple; the shared tuple is `as const` and non-empty by construction.
export const purchaseStatus = pgEnum("PurchaseStatus", SUBSCRIPTION_STATUSES);

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
  // Platform SaaS-billing Stripe account — kept distinct from the per-project
  // store "STRIPE" so the (source, storeEventId) dedup can't collide across
  // the two independent Stripe accounts' event-id spaces.
  "STRIPE_BILLING",
]);

export const webhookEventStatus = pgEnum("WebhookEventStatus", [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
]);

export const outgoingWebhookStatus = pgEnum("OutgoingWebhookStatus", [
  "PENDING",
  // DELIVERING: a worker has atomically claimed this row (status-flip
  // under the same SELECT … FOR UPDATE SKIP LOCKED) before any HTTP runs,
  // so a second replica's `status IN ('PENDING','FAILED')` claim query
  // can't re-select it. The stale-claim reaper resets orphaned rows
  // (claimedAt older than the lease window) back to PENDING.
  "DELIVERING",
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
  // 2026-09-04 — a purchase that does not renew: a non-consumable IAP, or
  // a one-time Stripe funnel package. Distinct from INITIAL because the
  // recurring MRR decomposition must exclude it and the ad platforms must
  // not receive "Subscribe" for it.
  "NON_RENEWING_PURCHASE",
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

export const experimentPrimaryMetric = pgEnum("ExperimentPrimaryMetric", [
  "CONVERSION",
  "ARPU",
  "PROCEEDS_PER_USER",
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
  "PAYWALL_EVENT",
  "SUBSCRIPTION",
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
// Public ladder is free/indie/studio/enterprise; pro/scale/growth are
// legacy values kept because Postgres enum removal is unsafe.
export const billingTierEnum = pgEnum("billing_tier", [
  "free",
  "indie",
  "pro",
  "scale",
  "studio",
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

// Public ladder is free/indie/studio/enterprise; pro/scale/growth are
// legacy values kept because Postgres enum removal is unsafe.
export const billingTier = [
  "free",
  "indie",
  "pro",
  "scale",
  "studio",
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
  // sending: a send-worker has atomically claimed this row (single-flight
  // status-flip via claimDeliveryForSend) before the transport call runs,
  // so a second concurrent job's `status NOT IN (...,'sending')` claim
  // predicate misses it and won't double-send. Mirrors the OutgoingWebhook
  // 'DELIVERING' claim state. A row stuck 'sending' after a crash is
  // re-claimable once the BullMQ retry surfaces it as 'failed'.
  "sending",
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

// =============================================================
// Paywall versioning pgEnums
// =============================================================

export const paywallStatus = pgEnum("PaywallStatus", [
  "draft",
  "published",
  "archived",
]);

export const funnelDeferredPlatform = pgEnum("FunnelDeferredPlatform", [
  "ios",
]);

export const customDomainCertStatus = pgEnum("CustomDomainCertStatus", [
  "pending",   // row created, no cert yet
  "issuing",   // Caddy is mid-ACME (transient)
  "issued",    // cert live, edge will serve
  "failed",    // ACME failed (rate-limit, CAA, etc.) — surfaced to dashboard
]);

// =============================================================
// Integrations pgEnums
// =============================================================

export const integrationDeliveryStatus = pgEnum("IntegrationDeliveryStatus", [
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "dead_letter",
]);

// =============================================================
// Refund Shield pgEnums
// =============================================================

export const refundShieldStatusEnum = pgEnum("refund_shield_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED_NOT_FOUND",
  "SKIPPED_DISABLED",
]);

export const refundShieldOutcomeEnum = pgEnum("refund_shield_outcome", [
  "REFUND_APPROVED",
  "REFUND_DECLINED",
  "REFUND_REVERSED",
]);

// Apple's notification + transaction JWS carry an `environment`
// field — we persist it per-row at CONSUMPTION_REQUEST insert time
// so the responder worker (which runs hours later, after Apple's
// signed payload is gone) can hit the correct App Store Server API
// base URL without falling back to NODE_ENV. Apple's wire values
// are "Production" / "Sandbox" but we normalise to the canonical
// uppercase form used by ProjectAppleContext.
export const refundShieldAppleEnvironmentEnum = pgEnum(
  "refund_shield_apple_environment",
  ["PRODUCTION", "SANDBOX"],
);

// =============================================================
// Data-import pgEnums
// =============================================================

// Task 9: Phase B (store re-validation) runs after Phase A's writer sets
// COMPLETED, and can leave the job at VERIFICATION_INCOMPLETE instead —
// store-side throttling that never resolved within one run's retry
// budget. That is a real, resumable terminal-for-now outcome, never
// COMPLETED and never FAILED (Phase A's own writes already succeeded).
//
// Task 10 fix round 2 (FIX A, migration 0108): VERIFYING is Phase B's
// OWN in-progress status, written before it begins and resolved to
// COMPLETED or VERIFICATION_INCOMPLETE at the end. Before this, Phase A
// wrote COMPLETED and Phase B ran underneath that same status with
// nothing of its own persisted until its very last write — a hard crash
// (OOM, deploy restart, kill -9) during that window left the row reading
// COMPLETED with verification silently abandoned: the top-of-run guard
// treats COMPLETED as "nothing left to do", so a retry never re-entered
// Phase B, and `/resume` only accepted VERIFICATION_INCOMPLETE. VERIFYING
// is never the guard's skip-status, so a crash-interrupted run resumes
// exactly like a VERIFICATION_INCOMPLETE one does — Phase A fast-forwards
// its checkpoint as a no-op, Phase B resumes off `purchases.verifiedAt`.
export const importJobStatus = pgEnum("ImportJobStatus", [
  "PENDING_MAPPING",
  "DRY_RUN_RUNNING",
  "DRY_RUN_COMPLETE",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
]);

// Which lifecycle events a product_currency_grants row fires on.
// PURCHASE is the default so every row that existed before this
// column keeps exactly its previous behaviour.
export const currencyGrantTrigger = pgEnum("CurrencyGrantTrigger", [
  "PURCHASE",
  "RENEWAL",
  "BOTH",
]);

export const leaderboardMetric = pgEnum("LeaderboardMetric", [
  "TOP_SPENDERS",
  "TOP_CONSUMERS",
]);

export const leaderboardCadence = pgEnum("LeaderboardCadence", [
  "WEEKLY",
  "MONTHLY",
  "CUSTOM",
]);

export const leaderboardSeasonStatus = pgEnum("LeaderboardSeasonStatus", [
  "ACTIVE",
  "CLOSED",
]);

// =============================================================
// GDPR/KVKK pgEnums (ROADMAP §9.1 — self-service DSAR API)
// =============================================================

export const dsarRequestType = pgEnum("DsarRequestType", [
  "EXPORT",
  "ERASURE",
]);

export const dsarRequestStatus = pgEnum("DsarRequestStatus", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);

// An enrichment import is a fundamentally different operation from a
// history import: it creates no purchases, accepts no mapping in the
// normal sense, and has its own required-field set (a Google purchase
// token per row, not a full transaction history). Modelling it as a
// variant of the history import is what made the revenuecat_google_token
// preset detectable-but-unimportable. See ROADMAP §11.
//
// packages/shared cannot depend on @rovenue/db (layering), so
// packages/shared/src/import/canonical.ts declares the matching
// `ImportJobKind` string union independently. Keep the two lists in step —
// packages/db/tests/import-jobs-kind.test.ts asserts this Postgres enum's
// labels equal that union's members, in order.
export const importJobKind = pgEnum("ImportJobKind", [
  "HISTORY",
  "GOOGLE_TOKEN_ENRICHMENT",
]);
