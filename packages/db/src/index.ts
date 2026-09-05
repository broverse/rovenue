// =============================================================
// @rovenue/db — top-level entrypoint
// =============================================================
//
// Thin compat layer:
//
//   1. Re-exports the Drizzle namespace as `drizzle` so callers
//      write `import { drizzle } from "@rovenue/db"`.
//   2. Re-exports row types + enum value objects under their
//      canonical names (MemberRole, PurchaseStatus, …) so call
//      sites don't need to reach into ./drizzle directly.
//   3. Re-exports the encryption helpers.

import * as drizzleNamespace from "./drizzle";
import {
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@rovenue/shared/subscription-status";

// =============================================================
// Enum value objects
// =============================================================
//
// Drizzle ships each pgEnum as a column-type builder whose
// `.enumValues` is a readonly tuple. We rebuild the runtime-object
// shape here (e.g. `MemberRole.OWNER === "OWNER"`) so call-site
// code can use `MemberRole.OWNER` the way TypeScript string enums
// work.

export const MemberRole = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  DEVELOPER: "DEVELOPER",
  GROWTH: "GROWTH",
  CUSTOMER_SUPPORT: "CUSTOMER_SUPPORT",
} as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

export const Environment = {
  PRODUCTION: "PRODUCTION",
  SANDBOX: "SANDBOX",
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

export const ProductType = {
  SUBSCRIPTION: "SUBSCRIPTION",
  CONSUMABLE: "CONSUMABLE",
  NON_CONSUMABLE: "NON_CONSUMABLE",
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const Store = {
  APP_STORE: "APP_STORE",
  PLAY_STORE: "PLAY_STORE",
  STRIPE: "STRIPE",
  MANUAL: "MANUAL",
} as const;
export type Store = (typeof Store)[keyof typeof Store];

/**
 * Value-and-type pair kept for ergonomics (`PurchaseStatus.ACTIVE`).
 * Built from the shared tuple rather than re-typed, so this object can
 * never list a status the Postgres enum lacks or vice versa.
 */
export const PurchaseStatus = Object.fromEntries(
  SUBSCRIPTION_STATUSES.map((s) => [s, s]),
) as { [K in SubscriptionStatus]: K };
export type PurchaseStatus = SubscriptionStatus;

// Derived status sets (access-granting, live, sweepable, reconcilable,
// terminal) plus the semantics table itself, re-exported here so api
// consumers have one import (`@rovenue/db`) instead of reaching into
// `@rovenue/shared/subscription-status` directly.
export {
  ACCESS_GRANTING_STATUSES,
  EXPIRY_SWEEP_STATUSES,
  LIVE_STATUSES,
  RECONCILABLE_STATUSES,
  SUBSCRIPTION_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  statusSqlList,
} from "@rovenue/shared/subscription-status";

// Data-layer terminal-status guard accessor (packages/db/.../purchases.ts)
// — a deliberate duplicate of TERMINAL_STATUSES above, re-exported so a
// test can pin the two together without this module importing the
// shared list. See purchaseRepoTerminalStatuses' doc comment.
export { purchaseRepoTerminalStatuses } from "./drizzle/repositories/purchases";

export const CreditLedgerType = {
  PURCHASE: "PURCHASE",
  SPEND: "SPEND",
  REFUND: "REFUND",
  BONUS: "BONUS",
  EXPIRE: "EXPIRE",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
} as const;
export type CreditLedgerType =
  (typeof CreditLedgerType)[keyof typeof CreditLedgerType];

export const WebhookSource = {
  APPLE: "APPLE",
  GOOGLE: "GOOGLE",
  STRIPE: "STRIPE",
  STRIPE_BILLING: "STRIPE_BILLING",
} as const;
export type WebhookSource = (typeof WebhookSource)[keyof typeof WebhookSource];

export const WebhookEventStatus = {
  RECEIVED: "RECEIVED",
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
} as const;
export type WebhookEventStatus =
  (typeof WebhookEventStatus)[keyof typeof WebhookEventStatus];

export const OutgoingWebhookStatus = {
  PENDING: "PENDING",
  DELIVERING: "DELIVERING",
  SENT: "SENT",
  FAILED: "FAILED",
  DEAD: "DEAD",
  DISMISSED: "DISMISSED",
} as const;
export type OutgoingWebhookStatus =
  (typeof OutgoingWebhookStatus)[keyof typeof OutgoingWebhookStatus];

export const RevenueEventType = {
  INITIAL: "INITIAL",
  RENEWAL: "RENEWAL",
  TRIAL_CONVERSION: "TRIAL_CONVERSION",
  CANCELLATION: "CANCELLATION",
  REFUND: "REFUND",
  REACTIVATION: "REACTIVATION",
  CREDIT_PURCHASE: "CREDIT_PURCHASE",
  NON_RENEWING_PURCHASE: "NON_RENEWING_PURCHASE",
} as const;
export type RevenueEventType =
  (typeof RevenueEventType)[keyof typeof RevenueEventType];

export const ExperimentType = {
  FLAG: "FLAG",
  OFFERING: "OFFERING",
  PAYWALL: "PAYWALL",
  ELEMENT: "ELEMENT",
} as const;
export type ExperimentType =
  (typeof ExperimentType)[keyof typeof ExperimentType];

export const ExperimentStatus = {
  DRAFT: "DRAFT",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
} as const;
export type ExperimentStatus =
  (typeof ExperimentStatus)[keyof typeof ExperimentStatus];

export const FeatureFlagType = {
  BOOLEAN: "BOOLEAN",
  STRING: "STRING",
  NUMBER: "NUMBER",
  JSON: "JSON",
} as const;
export type FeatureFlagType =
  (typeof FeatureFlagType)[keyof typeof FeatureFlagType];

export const FeatureFlagEnv = {
  PROD: "PROD",
  STAGING: "STAGING",
  DEVELOPMENT: "DEVELOPMENT",
} as const;
export type FeatureFlagEnv =
  (typeof FeatureFlagEnv)[keyof typeof FeatureFlagEnv];

// LeaderboardCadence is inferred from the `leaderboardCadence` pgEnum
// (Task 1) rather than hand-copied as a union above: a value added to
// the enum later must not silently fail to exist here too.
export type LeaderboardCadence =
  (typeof drizzleNamespace.leaderboardCadence)["enumValues"][number];

// LeaderboardMetric is inferred from the `leaderboardMetric` pgEnum
// (Task 1) rather than hand-copied as a union, same single-source
// rule as LeaderboardCadence above.
export type LeaderboardMetric =
  (typeof drizzleNamespace.leaderboardMetric)["enumValues"][number];

// =============================================================
// Row types
// =============================================================
//
// Canonical model names (Project, Subscriber, …) for the
// import-site surface. Definitions come from drizzle schema's
// `$inferSelect`.

export type {
  Project,
  ProjectMember,
  Subscriber,
  ApiKey,
  Product,
  Offering,
  NewOffering,
  Paywall,
  Purchase,
  Audience,
  Experiment,
  WebhookEvent,
  OutgoingWebhook,
  RevenueEvent,
  AccessRow,
  NewAccessRow,
  SubscriberAccessRow,
  AuditLogRow,
  CreditLedgerRow as CreditLedger,
  OutboxEvent,
  NewOutboxEvent,
  IntegrationConnection,
  NewIntegrationConnection,
  IntegrationDelivery,
  NewIntegrationDelivery,
} from "./drizzle/schema";

// =============================================================
// Helpers
// =============================================================

export * from "./helpers/encrypted-field";
export { currentYearMonth } from "./drizzle/repositories/copilot-usage";

// =============================================================
// Validators (re-export selected schemas commonly used by routes)
// =============================================================

export { accessIdSchema } from "./drizzle/validators";

// =============================================================
// Drizzle namespace
// =============================================================

export const drizzle = drizzleNamespace;
export type { Db } from "./drizzle";
export { getDb, createDb, db, getPool, createPool } from "./drizzle";
// Pure helper: classify a RevenueEventType into a coarse dedup-key segment.
// Exported top-level so webhook/receipt callers import it directly rather
// than through the (test-mocked) `drizzle.revenueEventRepo` namespace.
export { revenueDedupeKind } from "./drizzle";
export { productType } from "./drizzle";
export {
  monthStartsUtc,
  describeRequiredPartitionSpan,
} from "./drizzle";

// =============================================================
// Schema table objects — convenience re-exports so integration
// tests and service code can import tables directly without going
// through the `drizzle.schema.*` namespace.
// =============================================================

export {
  access,
  projects,
  subscribers,
  products,
  offerings,
  purchases,
  subscriberAccess,
  auditLogs,
  outboxEvents,
  apiKeys,
  webhookEvents,
  outgoingWebhooks,
  audiences,
  experiments,
  experimentAssignments,
  featureFlags,
  creditLedger,
  virtualCurrencies,
  revenueEvents,
  outboxEvents as outbox,
  scheduledSubscriptionActions,
  funnels,
  customDomains,
  refundShieldResponses,
  billingSubscriptions,
  billingTierLimits,
} from "./drizzle/schema";

export type {
  RefundShieldResponse,
  NewRefundShieldResponse,
} from "./drizzle/schema";
