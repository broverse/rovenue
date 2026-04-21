// =============================================================
// @rovenue/db — top-level entrypoint
// =============================================================
//
// Prisma has been fully removed from the runtime path as of Phase
// 7e. Every call-site reads/writes via Drizzle (see
// `./drizzle/*`). This file is now a thin compatibility layer
// that:
//
//   1. Re-exports the Drizzle namespace as `drizzle` so callers
//      keep writing `import { drizzle } from "@rovenue/db"`.
//   2. Re-exports the row types + enum value objects Prisma used
//      to own (MemberRole, PurchaseStatus, etc.) so existing
//      import sites don't need to know the Drizzle module layout.
//   3. Re-exports the encryption helpers.
//
// Prisma (@prisma/client) remains only as a devDependency — used
// by the Prisma migrate CLI during the migration window. See
// drizzle.config.ts for the upcoming drizzle-kit migration
// runner.

import * as drizzleNamespace from "./drizzle";

// =============================================================
// Enum value objects
// =============================================================
//
// Prisma exposes each enum as a const object (e.g. `MemberRole.
// OWNER === "OWNER"`). Drizzle only ships the pgEnum as a
// column-type builder whose `.enumValues` is a readonly tuple. We
// rebuild the Prisma-style objects here so call-site imports
// (`import { MemberRole } from "@rovenue/db"`) keep compiling.

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
// Re-exported under the Prisma names (Project, Subscriber, …) for
// import-site compat. The underlying definitions come from
// drizzle schema's `$inferSelect` — structurally compatible with
// Prisma's generated models for every field call sites read.

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
