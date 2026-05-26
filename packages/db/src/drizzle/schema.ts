import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  aggregateTypeEnum,
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
  scheduledActionStatus,
  scheduledActionType,
  store,
  webhookEventStatus,
  webhookSource,
} from "./enums";

// =============================================================
// Drizzle schema — canonical source of truth
// =============================================================
//
// Conventions:
//   * Columns use camelCase identifiers in TypeScript. DB column
//     names are pinned as the second argument of each column
//     helper so on-disk names stay stable across renames.
//   * FKs point at `id` in the target table; cascade behaviour
//     is declared via `.references(() => …, { onDelete })`.
//   * `timestamp({ withTimezone: true })` corresponds to
//     Postgres `timestamptz`.
//   * Ids default to `createId()` (`@paralleldrive/cuid2`),
//     emitting 22-char url-safe strings.

// =============================================================
// user (Better Auth)
// =============================================================
//
// The Better Auth Drizzle adapter reads/writes this table plus
// the session/account/verification tables below. Schema shape
// matches what `better-auth generate` produces so future CLI-
// regenerated output stays a diff-free drop-in.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  // Dashboard-side preferences. Better Auth doesn't touch these
  // columns — the dashboard's profile PATCH owns the write side
  // exclusively. BCP-47 locale tag + IANA tz database name.
  locale: text("locale").notNull().default("en-US"),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("createdAt", { withTimezone: false }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: false }).notNull(),
});

// =============================================================
// Better Auth session / account / verification tables
// =============================================================
//
// Column names + nullability match what `better-auth generate`
// produces, so swapping adapters (or regenerating the schema via
// the Better Auth CLI) is a no-op against existing rows.

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
// personal_access_tokens — Phase 2 Account / Identity
// =============================================================
//
// Per-user API tokens issued from the dashboard's account page.
// Plaintext is shown once on create; `tokenHash` is what the
// API auth path verifies against (SHA-256, mirroring how
// `api_keys.keySecretHash` is stored). `prefix` keeps the
// publicly-visible "rvn_pat_<first6>…<last4>" string so the
// dashboard can display revoked tokens without ever needing the
// plaintext again.

export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: text("tokenHash").notNull().unique(),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdIdx: index("personal_access_tokens_userId_idx").on(t.userId),
  }),
);

export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessTokens.$inferInsert;

// =============================================================
// user_preferences — Phase 2 Account / Identity
// =============================================================
//
// One row per user, keyed on userId. Two open JSON columns
// (`notifications`, `appearance`) so the schema can absorb new
// dashboard preferences without a migration each time. The
// dashboard owns the shape of each blob; the backend treats them
// as opaque storage.

export const userPreferences = pgTable("user_preferences", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  notifications: jsonb("notifications").notNull().default(sql`'{}'::jsonb`),
  appearance: jsonb("appearance").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// =============================================================
// projects
// =============================================================

export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  name: text("name").notNull(),
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
// credit_ledger (append-only by repository-layer convention — no
// DB-level enforcement; every call site uses .insert() and no
// UPDATE/DELETE paths exist in the @rovenue/db repositories)
// =============================================================

export const creditLedger = pgTable(
  "credit_ledger",
  {
    // `.primaryKey()` removed — declarative range partitioning
    // requires the partition column in every UNIQUE / PRIMARY KEY.
    // The table-level primaryKey below declares (id, createdAt). The
    // cuid2 id alone is still globally unique at the application layer.
    id: text("id").notNull().$defaultFn(() => createId()),
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
    // (id, createdAt) PK — createdAt is the monthly range partition key.
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
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
    // Nullable + ON DELETE SET NULL so deleting a project preserves
    // its audit history as orphan rows (the original project id is
    // still queryable via `resourceId` for "project.deleted"
    // entries). New inserts always set projectId at the app layer
    // — see lib/audit.ts.
    projectId: text("projectId").references(() => projects.id, {
      onDelete: "set null",
    }),
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
    id: text("id").notNull().$defaultFn(() => createId()),
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
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
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
    // `.primaryKey()` removed — declarative range partitioning requires
    // the partition column in every UNIQUE / PRIMARY KEY. The table-
    // level primaryKey below declares (id, eventDate). cuid2 keeps id
    // globally unique at the application layer; no external table FKs
    // into revenue_events, so losing the single-column DB-level
    // uniqueness is safe.
    id: text("id").notNull().$defaultFn(() => createId()),
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
    // (id, eventDate) PK — eventDate is the monthly range partition key.
    pk: primaryKey({ columns: [t.id, t.eventDate] }),
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
    hashVersion: smallint("hashVersion").notNull().default(1),
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
// outbox_events (transactional outbox feeding Kafka)
// =============================================================
//
// Written in the same transaction as the corresponding OLTP row
// (e.g., an exposure publish also writes a revenueEvent in Plan 2,
// but Plan 1 ships only EXPOSURE). The outbox-dispatcher worker
// drains unpublished rows into Redpanda and flips publishedAt.
// See apps/api/src/services/event-bus.ts for the write side.

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").notNull().primaryKey().$defaultFn(() => createId()),
    aggregateType: aggregateTypeEnum("aggregateType").notNull(),
    aggregateId: text("aggregateId").notNull(),
    eventType: text("eventType").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("publishedAt", { withTimezone: true }),
  },
  (t) => ({
    unpublishedIdx: index("outbox_events_unpublished_idx").on(t.createdAt),
  }),
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

// =============================================================
// saved_chart_views (Phase 3.5)
// =============================================================
//
// User-saved chart configurations. Each row is opaque JSON
// payload-wise so the dashboard can evolve the chart schema
// (filters, group-by, range, type) without a migration. Scoped
// to (projectId, userId) — saved views are per-user, not shared
// across the team. Stays read-light: one indexed lookup by
// project, ordered by `updatedAt` for the "recent" list.

export const savedChartViews = pgTable(
  "saved_chart_views",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Opaque JSON — chart id, type, range, filters, group-by. */
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdUpdatedAtIdx: index(
      "saved_chart_views_projectId_updatedAt_idx",
    ).on(t.projectId, t.updatedAt),
    projectIdUserIdIdx: index(
      "saved_chart_views_projectId_userId_idx",
    ).on(t.projectId, t.userId),
  }),
);

export type SavedChartView = typeof savedChartViews.$inferSelect;
export type NewSavedChartView = typeof savedChartViews.$inferInsert;

// =============================================================
// chart_annotations (Phase 3.5)
// =============================================================
//
// Project-scoped annotations pinned to a specific instant (or
// span) on chart timelines. Free-text label + optional URL +
// optional color. Authored by a user but visible to the whole
// project — annotations are how teams explain spikes & drops.

export const chartAnnotations = pgTable(
  "chart_annotations",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Author of the annotation. Null on legacy rows / imports. */
    userId: text("userId").references(() => user.id, { onDelete: "set null" }),
    /** Instant the annotation pins to. */
    occurredAt: timestamp("occurredAt", { withTimezone: true }).notNull(),
    /** Optional end of a range; null for point-in-time annotations. */
    endsAt: timestamp("endsAt", { withTimezone: true }),
    label: text("label").notNull(),
    description: text("description"),
    /** Hex color or design-token name for the annotation marker. */
    color: text("color"),
    /** Optional URL the annotation links out to (PR, ticket, blog). */
    url: text("url"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdOccurredAtIdx: index(
      "chart_annotations_projectId_occurredAt_idx",
    ).on(t.projectId, t.occurredAt),
  }),
);

export type ChartAnnotation = typeof chartAnnotations.$inferSelect;
export type NewChartAnnotation = typeof chartAnnotations.$inferInsert;

// =============================================================
// cohorts (Phase 4.4)
// =============================================================
//
// User-defined cohorts built from a structured rule JSON. The
// `rules` column stays opaque to the DB so the builder DSL can
// evolve (new filter fields, new operators) without a migration
// per change. Authoring is per-user; reading is project-wide.
// `syncDestinations` is an array of webhook endpoints the cohort
// fans members out to — runtime delivery is wired separately,
// the column just stores the config.

export const cohorts = pgTable(
  "cohorts",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Author (creator). Null on legacy rows / imports. */
    userId: text("userId").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Opaque rule JSON — see DashboardCohortRule wire shape. */
    rules: jsonb("rules")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Optional array of sync targets (webhook urls + format). */
    syncDestinations: jsonb("syncDestinations")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdUpdatedAtIdx: index("cohorts_projectId_updatedAt_idx").on(
      t.projectId,
      t.updatedAt,
    ),
    projectIdNameKey: uniqueIndex("cohorts_projectId_name_key").on(
      t.projectId,
      t.name,
    ),
  }),
);

export type Cohort = typeof cohorts.$inferSelect;
export type NewCohort = typeof cohorts.$inferInsert;

// =============================================================
// saved_queries (Phase 4.5 — queries playground)
// =============================================================
//
// Per-user saved SQL queries authored against the ClickHouse
// playground. The `sql` column stores the query text verbatim
// so the user can revise it across sessions; project isolation
// is enforced at execution time by binding `projectId` server-
// side and requiring the query body to reference
// `{projectId:String}` (rejected otherwise).

export const savedQueries = pgTable(
  "saved_queries",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sql: text("sql").notNull(),
    /** "sql" | "builder" — the editor mode this query was saved in. */
    mode: text("mode").notNull().default("sql"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdUpdatedAtIdx: index(
      "saved_queries_projectId_updatedAt_idx",
    ).on(t.projectId, t.updatedAt),
    projectIdUserIdIdx: index("saved_queries_projectId_userId_idx").on(
      t.projectId,
      t.userId,
    ),
  }),
);

export type SavedQuery = typeof savedQueries.$inferSelect;
export type NewSavedQuery = typeof savedQueries.$inferInsert;

// =============================================================
// fx_rates (daily FX snapshots, USD base)
// =============================================================
//
// Canonical source for historical currency conversion. Populated
// daily by the fx-rates worker (OpenExchangeRates /latest.json).
// `revenue_events.amountUsd` is the locked transaction-time USD
// figure; this table feeds the dashboard's display-currency switch
// by giving us the USD→quote rate for the same date as each event.
//
// PK (date, base, quote) — one row per currency per day; idempotent
// upserts.

export const fxRates = pgTable(
  "fx_rates",
  {
    date: date("date").notNull(),
    base: text("base").notNull().default("USD"),
    quote: text("quote").notNull(),
    // foreign-per-base (e.g. base=USD, quote=EUR, rate=0.93 → 1 USD = 0.93 EUR).
    rate: decimal("rate", { precision: 18, scale: 8 }).notNull(),
    fetchedAt: timestamp("fetchedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.base, t.quote] }),
    quoteDateIdx: index("fx_rates_quote_date_idx").on(t.quote, t.date),
  }),
);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;

// =============================================================
// scheduled_subscription_actions
// =============================================================

export const scheduledSubscriptionActions = pgTable(
  "scheduled_subscription_actions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    action: scheduledActionType("action").notNull(),
    dueAt: timestamp("dueAt", { withTimezone: true }).notNull(),
    status: scheduledActionStatus("status").notNull().default("PENDING"),
    payload: jsonb("payload")
      .$type<{ revokeImmediately?: boolean }>()
      .notNull()
      .default({}),
    createdBy: text("createdBy").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    executedAt: timestamp("executedAt", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    projectIdStatusIdx: index(
      "scheduled_actions_projectId_status_idx",
    ).on(t.projectId, t.status),
    statusDueAtIdx: index("scheduled_actions_status_dueAt_idx").on(
      t.status,
      t.dueAt,
    ),
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

export type ScheduledSubscriptionAction =
  typeof scheduledSubscriptionActions.$inferSelect;
export type NewScheduledSubscriptionAction =
  typeof scheduledSubscriptionActions.$inferInsert;

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
  scheduledActionStatus,
  scheduledActionType,
  store,
  webhookEventStatus,
  webhookSource,
} from "./enums";
