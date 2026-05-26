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
  "PRODUCT_GROUP",
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
  "NOTIFICATION",
]);

export const invitationDeliveryStatus = pgEnum("InvitationDeliveryStatus", [
  "PENDING",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
]);

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
