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
  VIEWER: "VIEWER",
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
} as const;
export type Store = (typeof Store)[keyof typeof Store];

export const PurchaseStatus = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  REVOKED: "REVOKED",
  PAUSED: "PAUSED",
  GRACE_PERIOD: "GRACE_PERIOD",
} as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

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
} as const;
export type RevenueEventType =
  (typeof RevenueEventType)[keyof typeof RevenueEventType];

export const ExperimentType = {
  FLAG: "FLAG",
  PRODUCT_GROUP: "PRODUCT_GROUP",
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
  ProductGroup,
  Purchase,
  Audience,
  Experiment,
  WebhookEvent,
  OutgoingWebhook,
  RevenueEvent,
  SubscriberAccessRow,
  AuditLogRow,
  CreditLedgerRow as CreditLedger,
} from "./drizzle/schema";

// =============================================================
// Helpers
// =============================================================

export * from "./helpers/encrypted-field";

// =============================================================
// Drizzle namespace
// =============================================================

export const drizzle = drizzleNamespace;
export type { Db } from "./drizzle";
