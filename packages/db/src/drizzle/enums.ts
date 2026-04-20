import { pgEnum } from "drizzle-orm/pg-core";

// =============================================================
// Postgres enums
// =============================================================
//
// Mirrored from schema.prisma. The string union literals MUST
// match Prisma's enum labels byte-for-byte — the underlying DB
// type is shared, so a mismatch would either break migrations
// (drizzle-kit generates ALTER TYPE diffs) or break reads
// (Prisma and Drizzle disagree on whether "INITIAL" is a member).
//
// When adding a new variant, add it to BOTH Prisma and Drizzle in
// the same commit. drizzle-kit `check` flags divergence in CI.

export const memberRole = pgEnum("MemberRole", [
  "OWNER",
  "ADMIN",
  "VIEWER",
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
