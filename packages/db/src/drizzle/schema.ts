import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  creditLedgerType,
  environment,
  experimentStatus,
  experimentType,
  featureFlagType,
  memberRole,
  outgoingWebhookStatus,
  productType,
  purchaseStatus,
  revenueEventType,
  store,
  webhookEventStatus,
  webhookSource,
} from "./enums";

// =============================================================
// Drizzle schema — full mirror of schema.prisma
// =============================================================
//
// Every Prisma model is mirrored 1:1 here. Column names, nullability,
// FK cascades, and composite indexes match the init migration byte
// for byte so Drizzle and Prisma can read each other's writes during
// the coexistence window.
//
// Conventions:
//   * Columns use camelCase identifiers in TypeScript but snake_case
//     or Prisma's original quoted camelCase on disk — we pin the DB
//     column name as the second argument of each column helper so
//     coexistence with Prisma is byte-exact.
//   * FKs point at `id` in the target table; cascade behaviour
//     matches the Prisma @relation() onDelete directive.
//   * `@db.Timestamptz` maps to `timestamp({ withTimezone: true })`.
//   * `@default(cuid(2))` is replaced with a Drizzle `$defaultFn`
//     running `@paralleldrive/cuid2.createId`, which emits the same
//     format (22 chars, url-safe) so dashboards and API consumers
//     don't notice the swap.

// =============================================================
// user (Better Auth — owned shape, referenced via FK)
// =============================================================
//
// The Better Auth adapter creates and migrates this table from
// `better-auth generate --adapter prisma`. We redeclare a minimum
// subset here so Drizzle joins can reach email/name without
// importing Prisma types. Any schema drift should be resolved on
// the Prisma side (source of truth) and mirrored here.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: false }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: false }).notNull(),
});

// =============================================================
// Better Auth session / account / verification tables
// =============================================================
//
// These mirror the Prisma models Better Auth's CLI generates;
// keeping column names + nullability byte-for-byte identical so
// the drizzleAdapter reads/writes the same rows Prisma does during
// the swap window.

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { withTimezone: false }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: false }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: false }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
    withTimezone: false,
  }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
    withTimezone: false,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: false }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: false }).notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: false }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: false }),
  updatedAt: timestamp("updatedAt", { withTimezone: false }),
});

// =============================================================
// projects
// =============================================================

export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  appleCredentials: jsonb("appleCredentials"),
  googleCredentials: jsonb("googleCredentials"),
  stripeCredentials: jsonb("stripeCredentials"),
  webhookUrl: text("webhookUrl"),
  webhookSecret: text("webhookSecret"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// =============================================================
// project_members
// =============================================================

export const projectMembers = pgTable(
  "project_members",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdUserIdKey: uniqueIndex("project_members_projectId_userId_key").on(
      t.projectId,
      t.userId,
    ),
    userIdIdx: index("project_members_userId_idx").on(t.userId),
  }),
);

// =============================================================
// subscribers
// =============================================================

export const subscribers = pgTable(
  "subscribers",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    appUserId: text("appUserId").notNull(),
    firstSeenAt: timestamp("firstSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    deletedAt: timestamp("deletedAt", { withTimezone: true }),
    mergedInto: text("mergedInto"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdAppUserIdKey: uniqueIndex(
      "subscribers_projectId_appUserId_key",
    ).on(t.projectId, t.appUserId),
  }),
);

// =============================================================
// credit_ledger (append-only; mutations blocked by DB trigger)
// =============================================================

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    type: creditLedgerType("type").notNull(),
    // `amount` is a signed integer — positive for credit, negative for debit.
    amount: integer("amount").notNull(),
    // Running balance AFTER this row's mutation. Enforces
    // invariant-by-construction: any reader can grab the latest
    // row and trust the balance without aggregating deltas.
    balance: integer("balance").notNull(),
    referenceType: text("referenceType"),
    referenceId: text("referenceId"),
    description: text("description"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    subscriberIdCreatedAtIdx: index(
      "credit_ledger_subscriberId_createdAt_idx",
    ).on(t.subscriberId, t.createdAt),
    projectIdSubscriberIdIdx: index(
      "credit_ledger_projectId_subscriberId_idx",
    ).on(t.projectId, t.subscriberId),
  }),
);

// =============================================================
// audit_logs (tamper-evident hash chain)
// =============================================================

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    resourceId: text("resourceId").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    // Hash-chain columns. Both nullable at the DB level — rows
    // predating the chain have no hash state. New rows are always
    // written with both set by apps/api/src/lib/audit.ts.
    prevHash: text("prevHash"),
    rowHash: text("rowHash").unique(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdCreatedAtIdx: index(
      "audit_logs_projectId_createdAt_idx",
    ).on(t.projectId, t.createdAt),
    actionIdx: index("audit_logs_action_idx").on(t.action),
    resourceIdIdx: index("audit_logs_resourceId_idx").on(t.resourceId),
    userIdIdx: index("audit_logs_userId_idx").on(t.userId),
  }),
);

// =============================================================
// api_keys
// =============================================================

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    keyPublic: text("keyPublic").notNull().unique(),
    keySecretHash: text("keySecretHash").notNull(),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    environment: environment("environment").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdIdx: index("api_keys_projectId_idx").on(t.projectId),
  }),
);

// =============================================================
// products
// =============================================================

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    type: productType("type").notNull(),
    // Store-specific ids map: { apple: "com.x.pro", google: "pro_sub" }
    storeIds: jsonb("storeIds").notNull(),
    displayName: text("displayName").notNull(),
    // Postgres TEXT[] column — Drizzle typing tracks the array shape.
    entitlementKeys: text("entitlementKeys")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    creditAmount: integer("creditAmount"),
    isActive: boolean("isActive").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex(
      "products_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
    projectIdIsActiveIdx: index("products_projectId_isActive_idx").on(
      t.projectId,
      t.isActive,
    ),
  }),
);

// =============================================================
// product_groups
// =============================================================

export const productGroups = pgTable(
  "product_groups",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    isDefault: boolean("isDefault").notNull().default(false),
    // Array of product references with order/promoted flags.
    products: jsonb("products").notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex(
      "product_groups_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
    projectIdIsDefaultIdx: index(
      "product_groups_projectId_isDefault_idx",
    ).on(t.projectId, t.isDefault),
  }),
);

// =============================================================
// purchases
// =============================================================

export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    productId: text("productId")
      .notNull()
      .references(() => products.id),
    store: store("store").notNull(),
    storeTransactionId: text("storeTransactionId").notNull(),
    originalTransactionId: text("originalTransactionId").notNull(),
    status: purchaseStatus("status").notNull(),
    isTrial: boolean("isTrial").notNull().default(false),
    isIntroOffer: boolean("isIntroOffer").notNull().default(false),
    isSandbox: boolean("isSandbox").notNull().default(false),
    purchaseDate: timestamp("purchaseDate", { withTimezone: true }).notNull(),
    expiresDate: timestamp("expiresDate", { withTimezone: true }),
    originalPurchaseDate: timestamp("originalPurchaseDate", {
      withTimezone: true,
    }).notNull(),
    priceAmount: decimal("priceAmount", { precision: 12, scale: 4 }),
    priceCurrency: text("priceCurrency"),
    environment: environment("environment").notNull(),
    autoRenewStatus: boolean("autoRenewStatus"),
    cancellationDate: timestamp("cancellationDate", { withTimezone: true }),
    refundDate: timestamp("refundDate", { withTimezone: true }),
    gracePeriodExpires: timestamp("gracePeriodExpires", {
      withTimezone: true,
    }),
    ownershipType: text("ownershipType"),
    verifiedAt: timestamp("verifiedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    storeStoreTransactionIdKey: uniqueIndex(
      "purchases_store_storeTransactionId_key",
    ).on(t.store, t.storeTransactionId),
    originalTransactionIdIdx: index(
      "purchases_originalTransactionId_idx",
    ).on(t.originalTransactionId),
    subscriberIdStatusIdx: index("purchases_subscriberId_status_idx").on(
      t.subscriberId,
      t.status,
    ),
    expiresDateIdx: index("purchases_expiresDate_idx").on(t.expiresDate),
  }),
);

// =============================================================
// subscriber_access (denormalised entitlement lookups)
// =============================================================

export const subscriberAccess = pgTable(
  "subscriber_access",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    entitlementKey: text("entitlementKey").notNull(),
    isActive: boolean("isActive").notNull().default(true),
    expiresDate: timestamp("expiresDate", { withTimezone: true }),
    store: store("store").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    subscriberIdIsActiveIdx: index(
      "subscriber_access_subscriberId_isActive_idx",
    ).on(t.subscriberId, t.isActive),
    subscriberIdEntitlementKeyIdx: index(
      "subscriber_access_subscriberId_entitlementKey_idx",
    ).on(t.subscriberId, t.entitlementKey),
  }),
);

// =============================================================
// webhook_events (incoming store → us)
// =============================================================

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: webhookSource("source").notNull(),
    eventType: text("eventType").notNull(),
    storeEventId: text("storeEventId").notNull(),
    payload: jsonb("payload").notNull(),
    status: webhookEventStatus("status").notNull().default("RECEIVED"),
    subscriberId: text("subscriberId").references(() => subscribers.id),
    purchaseId: text("purchaseId").references(() => purchases.id),
    errorMessage: text("errorMessage"),
    processedAt: timestamp("processedAt", { withTimezone: true }),
    retryCount: integer("retryCount").notNull().default(0),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sourceStoreEventIdKey: uniqueIndex(
      "webhook_events_source_storeEventId_key",
    ).on(t.source, t.storeEventId),
    statusRetryCountIdx: index(
      "webhook_events_status_retryCount_idx",
    ).on(t.status, t.retryCount),
  }),
);

// =============================================================
// outgoing_webhooks (us → customer endpoints)
// =============================================================

export const outgoingWebhooks = pgTable(
  "outgoing_webhooks",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventType: text("eventType").notNull(),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId").references(() => purchases.id),
    payload: jsonb("payload").notNull(),
    url: text("url").notNull(),
    status: outgoingWebhookStatus("status").notNull().default("PENDING"),
    httpStatus: integer("httpStatus"),
    responseBody: text("responseBody"),
    lastErrorMessage: text("lastErrorMessage"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("nextRetryAt", { withTimezone: true }),
    sentAt: timestamp("sentAt", { withTimezone: true }),
    deadAt: timestamp("deadAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusNextRetryAtIdx: index(
      "outgoing_webhooks_status_nextRetryAt_idx",
    ).on(t.status, t.nextRetryAt),
    projectIdStatusIdx: index(
      "outgoing_webhooks_projectId_status_idx",
    ).on(t.projectId, t.status),
  }),
);

// =============================================================
// revenue_events (materialised financial log)
// =============================================================

export const revenueEvents = pgTable(
  "revenue_events",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id),
    type: revenueEventType("type").notNull(),
    amount: decimal("amount", { precision: 12, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    amountUsd: decimal("amountUsd", { precision: 12, scale: 4 }).notNull(),
    store: store("store").notNull(),
    productId: text("productId")
      .notNull()
      .references(() => products.id),
    eventDate: timestamp("eventDate", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdEventDateIdx: index(
      "revenue_events_projectId_eventDate_idx",
    ).on(t.projectId, t.eventDate),
    subscriberIdTypeIdx: index(
      "revenue_events_subscriberId_type_idx",
    ).on(t.subscriberId, t.type),
  }),
);

// =============================================================
// audiences (sift-style targeting rules)
// =============================================================

export const audiences = pgTable(
  "audiences",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    rules: jsonb("rules").notNull().default(sql`'{}'::jsonb`),
    isDefault: boolean("isDefault").notNull().default(false),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdNameKey: uniqueIndex("audiences_projectId_name_key").on(
      t.projectId,
      t.name,
    ),
    projectIdIdx: index("audiences_projectId_idx").on(t.projectId),
  }),
);

// =============================================================
// experiments
// =============================================================

export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    type: experimentType("type").notNull(),
    key: text("key").notNull(),
    audienceId: text("audienceId")
      .notNull()
      .references(() => audiences.id),
    status: experimentStatus("status").notNull().default("DRAFT"),
    variants: jsonb("variants").notNull(),
    metrics: jsonb("metrics"),
    mutualExclusionGroup: text("mutualExclusionGroup"),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    winnerVariantId: text("winnerVariantId"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdKeyKey: uniqueIndex("experiments_projectId_key_key").on(
      t.projectId,
      t.key,
    ),
    projectIdStatusIdx: index("experiments_projectId_status_idx").on(
      t.projectId,
      t.status,
    ),
    mutualExclusionGroupIdx: index(
      "experiments_mutualExclusionGroup_idx",
    ).on(t.mutualExclusionGroup),
  }),
);

// =============================================================
// experiment_assignments (sticky assignment + funnel log)
// =============================================================

export const experimentAssignments = pgTable(
  "experiment_assignments",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    experimentId: text("experimentId")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    variantId: text("variantId").notNull(),
    assignedAt: timestamp("assignedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    events: jsonb("events").notNull().default(sql`'[]'::jsonb`),
    convertedAt: timestamp("convertedAt", { withTimezone: true }),
    purchaseId: text("purchaseId"),
    revenue: decimal("revenue", { precision: 12, scale: 4 }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    experimentIdSubscriberIdKey: uniqueIndex(
      "experiment_assignments_experimentId_subscriberId_key",
    ).on(t.experimentId, t.subscriberId),
    subscriberIdIdx: index(
      "experiment_assignments_subscriberId_idx",
    ).on(t.subscriberId),
    experimentIdConvertedAtIdx: index(
      "experiment_assignments_experimentId_convertedAt_idx",
    ).on(t.experimentId, t.convertedAt),
  }),
);

// =============================================================
// feature_flags (standalone, rule-ordered)
// =============================================================

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    type: featureFlagType("type").notNull(),
    defaultValue: jsonb("defaultValue").notNull(),
    rules: jsonb("rules").notNull().default(sql`'[]'::jsonb`),
    isEnabled: boolean("isEnabled").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdKeyKey: uniqueIndex("feature_flags_projectId_key_key").on(
      t.projectId,
      t.key,
    ),
    projectIdIsEnabledIdx: index(
      "feature_flags_projectId_isEnabled_idx",
    ).on(t.projectId, t.isEnabled),
  }),
);

// =============================================================
// Inferred types
// =============================================================
//
// `$inferSelect` / `$inferInsert` produce the exact shape Drizzle
// returns/accepts — use these instead of hand-rolled interfaces
// so new columns surface as type errors rather than runtime
// surprises. Environment-specific columns (enums) are returned as
// the literal-union types derived from the pgEnum definitions.

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;

export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type NewCreditLedgerRow = typeof creditLedger.$inferInsert;

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export type ProductGroup = typeof productGroups.$inferSelect;
export type NewProductGroup = typeof productGroups.$inferInsert;

export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;

export type SubscriberAccessRow = typeof subscriberAccess.$inferSelect;
export type NewSubscriberAccessRow = typeof subscriberAccess.$inferInsert;

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export type OutgoingWebhook = typeof outgoingWebhooks.$inferSelect;
export type NewOutgoingWebhook = typeof outgoingWebhooks.$inferInsert;

export type RevenueEvent = typeof revenueEvents.$inferSelect;
export type NewRevenueEvent = typeof revenueEvents.$inferInsert;

export type Audience = typeof audiences.$inferSelect;
export type NewAudience = typeof audiences.$inferInsert;

export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

export type ExperimentAssignment = typeof experimentAssignments.$inferSelect;
export type NewExperimentAssignment =
  typeof experimentAssignments.$inferInsert;

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;

// Re-export enum helpers so downstream code can `import { memberRole }
// from "@rovenue/db/drizzle"` without reaching into the `drizzle`
// namespace on the top-level `@rovenue/db` export.
export {
  creditLedgerType,
  environment,
  experimentStatus,
  experimentType,
  featureFlagType,
  memberRole,
  outgoingWebhookStatus,
  productType,
  purchaseStatus,
  revenueEventType,
  store,
  webhookEventStatus,
  webhookSource,
} from "./enums";
