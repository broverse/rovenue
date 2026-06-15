import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  aggregateTypeEnum,
  billingCycleEnum,
  billingDunningPhaseEnum,
  billingInvoiceStatusEnum,
  billingMeterKeyEnum,
  billingPendingActionEnum,
  billingStateEnum,
  billingTierEnum,
  creditLedgerType,
  customDomainCertStatus,
  environment,
  experimentStatus,
  experimentType,
  featureFlagEnv,
  featureFlagType,
  funnelDeferredPlatform,
  funnelPurchaseStatus,
  funnelSessionState,
  funnelStatus,
  funnelTemplateScope,
  integrationDeliveryStatus,
  integrationProvider,
  invitationDeliveryStatus,
  memberRole,
  notificationChannel,
  notificationDeliveryStatus,
  notificationSuppressionReason,
  outgoingWebhookStatus,
  productType,
  purchaseStatus,
  pushPlatform,
  refundShieldAppleEnvironmentEnum,
  refundShieldOutcomeEnum,
  refundShieldStatusEnum,
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
  // Maintained by Better Auth's twoFactor plugin; flipped to true
  // after the user verifies the first TOTP code, back to false on
  // disable. Mirroring the plugin's schema declaration here so the
  // drizzle adapter can read/write it.
  twoFactorEnabled: boolean("twoFactorEnabled").notNull().default(false),
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
// twoFactor (Better Auth — `twoFactor` plugin)
// =============================================================
//
// One row per user with 2FA enrolled. `secret` and `backupCodes`
// are AES-encrypted by the plugin (using BETTER_AUTH_SECRET) so
// the dashboard never sees plaintext after the initial enable
// response. `verified=false` after `/two-factor/enable`,
// flipped to `true` by `/two-factor/verify-totp`.

export const twoFactor = pgTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
  },
  (t) => ({
    userIdIdx: index("twoFactor_userId_idx").on(t.userId),
    secretIdx: index("twoFactor_secret_idx").on(t.secret),
  }),
);

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
  // Profile-page fields that don't live on Better Auth's `user`
  // row: displayName, phone, role, company, bio, avatarColor.
  // Kept opaque on the backend — the dashboard owns the shape.
  profile: jsonb("profile").notNull().default(sql`'{}'::jsonb`),
  // Locale + timezone surface on user_preferences (not just on
  // push_devices) so email/digest templates can render even when
  // the user has no registered push device.
  locale: text("locale").notNull().default("en"),
  timezone: text("timezone").notNull().default("UTC"),
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
  description: text("description"),
  appleCredentials: jsonb("appleCredentials"),
  googleCredentials: jsonb("googleCredentials"),
  stripeCredentials: jsonb("stripeCredentials"),
  webhookUrl: text("webhookUrl"),
  webhookSecret: text("webhookSecret"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  refundShieldEnabled: boolean("refund_shield_enabled").notNull().default(false),
  refundShieldConsentAcknowledgedAt: timestamp("refund_shield_consent_acknowledged_at", { withTimezone: true }),
  refundShieldConsentAcknowledgedBy: text("refund_shield_consent_acknowledged_by").references(() => user.id, { onDelete: "set null" }),
  refundShieldResponseDelayMinutes: integer("refund_shield_response_delay_minutes").notNull().default(60),
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
// project_invitations
// =============================================================

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // always lowercased before insert
    role: memberRole("role").notNull(),
    tokenHash: text("tokenHash").notNull(),
    invitedByUserId: text("invitedByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("acceptedAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    deliveryStatus: invitationDeliveryStatus("deliveryStatus")
      .notNull()
      .default("PENDING"),
    deliveryError: text("deliveryError"),
    lastSentAt: timestamp("lastSentAt", { withTimezone: true }),
    sesMessageId: text("sesMessageId"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Partial unique: only one pending invite per (project, email).
    pendingUniq: uniqueIndex("project_invitations_pending_uniq")
      .on(t.projectId, t.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
    tokenHashUniq: uniqueIndex("project_invitations_token_hash_key").on(
      t.tokenHash,
    ),
    expiresAtIdx: index("project_invitations_expiresAt_idx").on(t.expiresAt),
    sesMessageIdIdx: index("project_invitations_sesMessageId_idx").on(
      t.sesMessageId,
    ),
    projectIdEmailIdx: index("project_invitations_projectId_email_idx").on(
      t.projectId,
      t.email,
    ),
  }),
);

export type ProjectInvitation = typeof projectInvitations.$inferSelect;
export type NewProjectInvitation = typeof projectInvitations.$inferInsert;

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
    rovenueId: text("rovenueId").notNull(),
    appUserId: text("appUserId"),
    firstSeenAt: timestamp("firstSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    deletedAt: timestamp("deletedAt", { withTimezone: true }),
    mergedInto: text("mergedInto"),
    identifiedAt: timestamp("identifiedAt", { withTimezone: true }),
    // Apple StoreKit `appAccountToken` (UUID v4) — opaque per-user
    // identifier sent with the purchase and echoed in every
    // ASSN v2 notification for that transaction. Persisted so the
    // CONSUMPTION_REQUEST responder can look up the owning
    // subscriber from an inbound webhook payload. See Refund Shield
    // design spec (docs/superpowers/specs/2026-05-28-refund-shield-design.md).
    appleAppAccountToken: uuid("apple_app_account_token"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdRovenueIdKey: uniqueIndex(
      "subscribers_projectId_rovenueId_key",
    ).on(t.projectId, t.rovenueId),
    projectIdAppUserIdKey: uniqueIndex("subscribers_projectId_appUserId_key")
      .on(t.projectId, t.appUserId)
      .where(sql`${t.appUserId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    appleTokenIdx: uniqueIndex("idx_subscribers_apple_app_account_token")
      .on(t.projectId, t.appleAppAccountToken)
      .where(sql`${t.appleAppAccountToken} IS NOT NULL`),
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
    // Plain text column — no FK to "user". Programmatic operations
    // (e.g. grantComp) may pass an opaque actorUserId that isn't a
    // Better Auth row, and the audit trail must still record it.
    // Dashboard routes pass the session user.id (always present in
    // the user table). Nullable so future batch operations can omit it.
    userId: text("userId"),
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
// access (catalog of access rights — replaces free-form
// entitlement key strings). One row per (projectId, identifier).
// Referenced from products.accessIds[] and subscriber_access.accessId.
// =============================================================

export const access = pgTable(
  "access",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    displayName: text("displayName").notNull(),
    description: text("description"),
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
      "access_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
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
    accessIds: text("accessIds")
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
// offerings (paywall configurations — was product_groups)
//
// Each offering is scoped to one Access; A/B variants land here.
// =============================================================

export const offerings = pgTable(
  "offerings",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    accessId: text("accessId")
      .notNull()
      .references(() => access.id, { onDelete: "cascade" }),
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
      "offerings_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
    accessIdIsDefaultIdx: index(
      "offerings_accessId_isDefault_idx",
    ).on(t.accessId, t.isDefault),
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
    accessId: text("accessId")
      .notNull()
      .references(() => access.id, { onDelete: "restrict" }),
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
    subscriberIdAccessIdIdx: index(
      "subscriber_access_subscriberId_accessId_idx",
    ).on(t.subscriberId, t.accessId),
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
// refund_shield_responses (CONSUMPTION_REQUEST work queue + outcome log)
// =============================================================
// One row per Apple CONSUMPTION_REQUEST notification: serves as both
// (a) the work queue consumed by the polling responder worker, and
// (b) the long-lived outcome log used for win-rate analytics. The
// outcome / outcomeReceivedAt columns are populated later when the
// matching REFUND / REFUND_DECLINED / REFUND_REVERSED notification
// arrives (lookup by appleOriginalTransactionId).

export const refundShieldResponses = pgTable(
  "refund_shield_responses",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: text("subscriber_id").references(() => subscribers.id, {
      onDelete: "set null",
    }),
    appleNotificationUuid: text("apple_notification_uuid").notNull(),
    appleOriginalTransactionId: text(
      "apple_original_transaction_id",
    ).notNull(),
    appleTransactionId: text("apple_transaction_id").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    requestPayload: jsonb("request_payload"),
    appleHttpStatus: integer("apple_http_status"),
    appleResponseBody: text("apple_response_body"),
    status: refundShieldStatusEnum("status").notNull().default("PENDING"),
    // Apple environment captured from the JWS at webhook receipt time.
    // The responder worker reads it back to pick the correct App
    // Store Server API base URL — see refund-shield-responder.ts
    // `loadAppleContextForProject`.
    appleEnvironment: refundShieldAppleEnvironmentEnum("apple_environment")
      .notNull()
      .default("PRODUCTION"),
    outcome: refundShieldOutcomeEnum("outcome"),
    outcomeReceivedAt: timestamp("outcome_received_at", {
      withTimezone: true,
    }),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    notificationUniq: uniqueIndex("idx_rss_notification_uniq").on(
      t.appleNotificationUuid,
    ),
    dueIdx: index("idx_rss_due")
      .on(t.status, t.scheduledFor)
      .where(sql`${t.status} = 'PENDING'`),
    outcomeLookupIdx: index("idx_rss_outcome_lookup").on(
      t.projectId,
      t.appleOriginalTransactionId,
    ),
    dashboardIdx: index("idx_rss_dashboard").on(t.projectId, t.detectedAt),
  }),
);

export type RefundShieldResponse = typeof refundShieldResponses.$inferSelect;
export type NewRefundShieldResponse = typeof refundShieldResponses.$inferInsert;

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
    env: featureFlagEnv("env").notNull().default("PROD"),
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
    // (projectId, env, key) is unique so the same key can carry a
    // different config per environment — the SDK looks up flags by
    // (projectId, env, key), never just (projectId, key).
    projectIdEnvKeyKey: uniqueIndex("feature_flags_projectId_env_key_key").on(
      t.projectId,
      t.env,
      t.key,
    ),
    projectIdEnvIsEnabledIdx: index(
      "feature_flags_projectId_env_isEnabled_idx",
    ).on(t.projectId, t.env, t.isEnabled),
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
// custom_charts (Phase 3.5 — extended)
// =============================================================
//
// Per-project, project-shared chart definitions authored by
// dashboard users. Shipped alongside a hard-coded "system"
// catalog (defined server-side, non-deletable). The opaque
// `config` jsonb holds filters, group-by, and any other slice
// state so the catalog wire schema can evolve without DB
// migrations. Writes require ADMIN — viewers can read but not
// mutate the shared library.

export const customCharts = pgTable(
  "custom_charts",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Author. Null if the creator was later removed from the project. */
    createdByUserId: text("createdByUserId").references(() => user.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    /** Free-form category string; system entries pick a fixed taxonomy
     * but customs are free to define their own grouping. */
    category: text("category").notNull(),
    chartType: text("chartType").notNull(),
    rangeOption: text("rangeOption").notNull(),
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
      "custom_charts_projectId_updatedAt_idx",
    ).on(t.projectId, t.updatedAt),
  }),
);

export type CustomChart = typeof customCharts.$inferSelect;
export type NewCustomChart = typeof customCharts.$inferInsert;

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
// notifications
// =============================================================
//
// User-facing notification inbox. NOT partitioned at v1 scale —
// `(userId, eventId)` idempotency forces the partition key into
// the unique constraint under native partitioning, which would
// break the spec §3.4 contract. Volume fits in a single table;
// revisit partitioning if/when row counts demand it.

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("projectId").references(() => projects.id, {
      onDelete: "cascade",
    }),
    eventKey: text("eventKey").notNull(),
    eventId: text("eventId").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp("readAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdEventIdKey: uniqueIndex("notifications_userId_eventId_key").on(
      t.userId,
      t.eventId,
    ),
    userIdFeedIdx: index("notifications_userId_feed_idx").on(
      t.userId,
      t.readAt,
      t.createdAt,
    ),
  }),
);

// =============================================================
// notification_deliveries
// =============================================================
//
// Per-channel delivery record for each notification. Plain
// (non-partitioned) table for v1 — pg_partman is not installed on
// this stack and the existing hot tables are also unmanaged plain
// partitions. Add cron retention later if volume demands.

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    notificationId: text("notificationId")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    status: notificationDeliveryStatus("status").notNull(),
    providerMessageId: text("providerMessageId"),
    providerResponse: jsonb("providerResponse"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("lastAttemptAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    notificationIdIdx: index(
      "notification_deliveries_notificationId_idx",
    ).on(t.notificationId),
    statusIdx: index("notification_deliveries_status_idx").on(
      t.status,
      t.createdAt,
    ),
  }),
);

// =============================================================
// push_devices
// =============================================================
//
// Registered push tokens per user. Unique on (platform, token) so
// the same device cannot register twice; partial index on userId
// where revokedAt IS NULL accelerates the active-devices lookup
// the dispatcher does on every push delivery.

export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: pushPlatform("platform").notNull(),
    token: text("token").notNull(),
    appBundleId: text("appBundleId").notNull(),
    locale: text("locale").notNull(),
    timezone: text("timezone").notNull(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    platformTokenKey: uniqueIndex("push_devices_platform_token_key").on(
      t.platform,
      t.token,
    ),
    userIdActiveIdx: index("push_devices_userId_active_idx")
      .on(t.userId)
      .where(sql`"revokedAt" IS NULL`),
  }),
);

export type PushDevice = typeof pushDevices.$inferSelect;
export type NewPushDevice = typeof pushDevices.$inferInsert;

// =============================================================
// notification_suppression_list — global "do not email" set
// =============================================================
//
// Populated by the SES feedback consumer (hard bounces +
// complaints) and by manual ops. Keyed by lowercased email so
// the pre-send check is a single PK lookup.

export const notificationSuppressionList = pgTable(
  "notification_suppression_list",
  {
    email: text("email").primaryKey(),
    reason: notificationSuppressionReason("reason").notNull(),
    source: text("source"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type NotificationSuppression =
  typeof notificationSuppressionList.$inferSelect;
export type NewNotificationSuppression =
  typeof notificationSuppressionList.$inferInsert;

// =============================================================
// user_known_devices
// =============================================================
//
// Per-user device fingerprint registry. The notifier producer
// for `security.signin.new_device` upserts (userId, fingerprint)
// on every sign-in and emits the notification when the row was
// newly inserted (i.e. first time we've seen this UA+IP for the
// user).

export const userKnownDevices = pgTable(
  "user_known_devices",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdFingerprintKey: uniqueIndex(
      "user_known_devices_userId_fingerprint_key",
    ).on(t.userId, t.fingerprint),
    userIdIdx: index("user_known_devices_userId_idx").on(t.userId),
  }),
);

export type UserKnownDevice = typeof userKnownDevices.$inferSelect;
export type NewUserKnownDevice = typeof userKnownDevices.$inferInsert;

// =============================================================
// user_project_notification_prefs + project_notification_defaults
// =============================================================
//
// Per-(user, project) override map keyed by event_key — opaque
// JSONB owned by the dashboard. project_notification_defaults
// holds the project-wide defaults a workspace admin sets; the
// resolver merges defaults <- per-user overrides at send time.

export const userProjectNotificationPrefs = pgTable(
  "user_project_notification_prefs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    overrides: jsonb("overrides").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdProjectIdKey: uniqueIndex(
      "user_project_notification_prefs_userId_projectId_key",
    ).on(t.userId, t.projectId),
    userIdIdx: index("user_project_notification_prefs_userId_idx").on(t.userId),
    projectIdIdx: index("user_project_notification_prefs_projectId_idx").on(
      t.projectId,
    ),
  }),
);

export const projectNotificationDefaults = pgTable(
  "project_notification_defaults",
  {
    projectId: text("projectId")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    defaults: jsonb("defaults").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type UserProjectNotificationPrefs =
  typeof userProjectNotificationPrefs.$inferSelect;
export type NewUserProjectNotificationPrefs =
  typeof userProjectNotificationPrefs.$inferInsert;
export type ProjectNotificationDefaults =
  typeof projectNotificationDefaults.$inferSelect;
export type NewProjectNotificationDefaults =
  typeof projectNotificationDefaults.$inferInsert;

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

export type AccessRow = typeof access.$inferSelect;
export type NewAccessRow = typeof access.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export type Offering = typeof offerings.$inferSelect;
export type NewOffering = typeof offerings.$inferInsert;

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

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type NotificationDelivery =
  typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery =
  typeof notificationDeliveries.$inferInsert;

// Re-export enum helpers so downstream code can `import { memberRole }
// from "@rovenue/db/drizzle"` without reaching into the `drizzle`
// namespace on the top-level `@rovenue/db` export.
export {
  billingCycleEnum,
  billingDunningPhaseEnum,
  billingInvoiceStatusEnum,
  billingMeterKeyEnum,
  billingPendingActionEnum,
  billingStateEnum,
  billingTierEnum,
  creditLedgerType,
  customDomainCertStatus,
  environment,
  experimentStatus,
  experimentType,
  featureFlagEnv,
  featureFlagType,
  funnelDeferredPlatform,
  funnelPurchaseStatus,
  funnelSessionState,
  funnelStatus,
  funnelTemplateScope,
  invitationDeliveryStatus,
  memberRole,
  notificationChannel,
  notificationDeliveryStatus,
  notificationSuppressionReason,
  outgoingWebhookStatus,
  productType,
  purchaseStatus,
  pushPlatform,
  revenueEventType,
  scheduledActionStatus,
  scheduledActionType,
  store,
  webhookEventStatus,
  webhookSource,
} from "./enums";

// =============================================================
// Billing tables (Phase 1)
// =============================================================
// One row per project (partial unique on projectId WHERE state != 'deleted')
// captures the project's lifetime billing state. Stripe identifiers stay
// NULL while the project is on Free — the Stripe customer is created
// lazily on first upgrade.

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    state: billingStateEnum("state").notNull().default("free"),
    tier: billingTierEnum("tier").notNull().default("free"),
    cycle: billingCycleEnum("cycle").notNull().default("monthly"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    pendingAction: billingPendingActionEnum("pending_action"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeProjectUnique: uniqueIndex("billing_subscriptions_project_active_uq")
      .on(t.projectId)
      .where(sql`${t.state} != 'deleted'`),
    stripeSubscriptionIdUnique: uniqueIndex(
      "billing_subscriptions_stripe_subscription_id_uq",
    ).on(t.stripeSubscriptionId),
  }),
);

export const billingPaymentMethods = pgTable(
  "billing_payment_methods",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull().unique(),
    brand: text("brand").notNull(),
    last4: text("last4").notNull(),
    expMonth: integer("exp_month").notNull(),
    expYear: integer("exp_year").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    oneDefaultPerProject: uniqueIndex("billing_payment_methods_default_uq")
      .on(t.projectId)
      .where(sql`${t.isDefault} = true`),
    projectIdx: index("billing_payment_methods_project_idx").on(t.projectId),
  }),
);

export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stripeInvoiceId: text("stripe_invoice_id").notNull().unique(),
    number: text("number").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountDue: numeric("amount_due", { precision: 12, scale: 4 }).notNull(),
    amountPaid: numeric("amount_paid", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    refundedAmount: numeric("refunded_amount", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    currency: text("currency").notNull().default("usd"),
    status: billingInvoiceStatusEnum("status").notNull(),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    pdfUrl: text("pdf_url"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextPaymentAttempt: timestamp("next_payment_attempt", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index("billing_invoices_project_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
  }),
);

export const billingDunningState = pgTable("billing_dunning_state", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  firstFailureAt: timestamp("first_failure_at", { withTimezone: true }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  currentPhase: billingDunningPhaseEnum("current_phase"),
  uiLockedAt: timestamp("ui_locked_at", { withTimezone: true }),
  sdkLockedAt: timestamp("sdk_locked_at", { withTimezone: true }),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  lastEmailSentAt: timestamp("last_email_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const billingTierLimits = pgTable(
  "billing_tier_limits",
  {
    tier: billingTierEnum("tier").notNull(),
    cycle: billingCycleEnum("cycle").notNull(),
    priceUsdCents: integer("price_usd_cents").notNull(),
    stripePriceId: text("stripe_price_id"),
    mtrMin: numeric("mtr_min", { precision: 12, scale: 4 }).notNull(),
    mtrMax: numeric("mtr_max", { precision: 12, scale: 4 }),
    eventsLimit: integer("events_limit"),
    sqlLimit: integer("sql_limit"),
    retentionDays: integer("retention_days").notNull(),
    auditLogDays: integer("audit_log_days").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tier, t.cycle] }),
  }),
);

export const usageSnapshots = pgTable(
  "usage_snapshots",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    meterKey: billingMeterKeyEnum("meter_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    currentValue: numeric("current_value", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    limitValue: numeric("limit_value", { precision: 18, scale: 4 }),
    softCapWarnedAt: timestamp("soft_cap_warned_at", { withTimezone: true }),
    hardCapWarnedAt: timestamp("hard_cap_warned_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.projectId, t.meterKey, t.periodStart],
    }),
  }),
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
export type BillingPaymentMethod = typeof billingPaymentMethods.$inferSelect;
export type NewBillingPaymentMethod = typeof billingPaymentMethods.$inferInsert;
export type BillingInvoice = typeof billingInvoices.$inferSelect;
export type NewBillingInvoice = typeof billingInvoices.$inferInsert;
export type BillingDunningStateRow = typeof billingDunningState.$inferSelect;
export type NewBillingDunningStateRow = typeof billingDunningState.$inferInsert;
export type BillingTierLimits = typeof billingTierLimits.$inferSelect;
export type UsageSnapshot = typeof usageSnapshots.$inferSelect;
export type NewUsageSnapshot = typeof usageSnapshots.$inferInsert;

// =============================================================
// Funnels — onboarding builder (sub-project A)
// =============================================================

export const funnels = pgTable(
  "funnels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: funnelStatus("status").notNull().default("draft"),
    currentVersionId: text("current_version_id"),
    draftPagesJson: jsonb("draft_pages_json").notNull().default(sql`'[]'::jsonb`),
    draftThemeJson: jsonb("draft_theme_json").notNull().default(sql`'{}'::jsonb`),
    draftSettingsJson: jsonb("draft_settings_json").notNull().default(sql`'{}'::jsonb`),
    // BCP47 fallback locale + the full set of locales this funnel renders
    // in. The renderer falls back to defaultLocale whenever a string is
    // missing for the active locale. Both are draft-side: published
    // versions snapshot them into funnel_versions.metadata.
    defaultLocale: text("default_locale").notNull().default("en"),
    locales: jsonb("locales").$type<string[]>().notNull().default(sql`'["en"]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    projectStatusIdx: index("funnels_project_status_idx").on(t.projectId, t.status),
    slugUnique: uniqueIndex("funnels_project_slug_unique").on(t.projectId, t.slug),
  }),
);

export const funnelVersions = pgTable(
  "funnel_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    pagesJson: jsonb("pages_json").notNull(),
    themeJson: jsonb("theme_json").notNull(),
    settingsJson: jsonb("settings_json").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    funnelVersionUnique: uniqueIndex("funnel_versions_funnel_version_unique").on(
      t.funnelId,
      t.versionNo,
    ),
  }),
);

export const funnelTemplates = pgTable(
  "funnel_templates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    previewImageUrl: text("preview_image_url"),
    pagesJson: jsonb("pages_json").notNull(),
    themeJson: jsonb("theme_json").notNull(),
    settingsJson: jsonb("settings_json").notNull(),
    scope: funnelTemplateScope("scope").notNull().default("system"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeCategoryIdx: index("funnel_templates_scope_category_idx").on(t.scope, t.category),
    projectIdx: index("funnel_templates_project_idx").on(t.projectId),
  }),
);

export type Funnel = typeof funnels.$inferSelect;
export type NewFunnel = typeof funnels.$inferInsert;
export type FunnelVersion = typeof funnelVersions.$inferSelect;
export type NewFunnelVersion = typeof funnelVersions.$inferInsert;
export type FunnelTemplate = typeof funnelTemplates.$inferSelect;
export type NewFunnelTemplate = typeof funnelTemplates.$inferInsert;

export const funnelSessions = pgTable(
  "funnel_sessions",
  {
    // `.primaryKey()` removed — declarative range partitioning on
    // started_at requires the partition column in every UNIQUE /
    // PRIMARY KEY. Table-level pk below is (id, startedAt). Other
    // funnel_* tables therefore reference funnel_sessions only via
    // session_id index, not a real FK (PG can't FK partitioned
    // tables without including the partition key).
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    funnelVersionId: text("funnel_version_id")
      .notNull()
      .references(() => funnelVersions.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    anonId: text("anon_id")
      .notNull()
      .$defaultFn(() => createId()),
    state: funnelSessionState("state").notNull().default("in_progress"),
    currentPageId: text("current_page_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    utmJson: jsonb("utm_json").notNull().default(sql`'{}'::jsonb`),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.startedAt] }),
    funnelStartedIdx: index("funnel_sessions_funnel_started_idx").on(t.funnelId, t.startedAt),
    stateActivityIdx: index("funnel_sessions_state_activity_idx").on(t.state, t.lastActivityAt),
    projectStartedIdx: index("funnel_sessions_project_started_idx").on(t.projectId, t.startedAt),
  }),
);

export const funnelAnswers = pgTable(
  "funnel_answers",
  {
    // Partitioned by answered_at; composite PK (id, answeredAt).
    // session_id is a plain text column (no FK) — funnel_sessions
    // is partitioned and PG won't allow FKs into it.
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    sessionId: text("session_id").notNull(),
    pageId: text("page_id").notNull(),
    questionId: text("question_id").notNull(),
    answerJson: jsonb("answer_json").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.answeredAt] }),
    // (session_id, question_id) was UNIQUE in the original design
    // but native partitioning forbids UNIQUEs that omit the partition
    // key. Dedup is enforced at the repository layer.
    sessionQuestionIdx: index("funnel_answers_session_question_idx").on(
      t.sessionId,
      t.questionId,
    ),
    sessionIdx: index("funnel_answers_session_idx").on(t.sessionId),
  }),
);

export const funnelPurchases = pgTable(
  "funnel_purchases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    // session_id intentionally has no FK — funnel_sessions is
    // partitioned. .unique() still enforces 1:1 at this table.
    sessionId: text("session_id").notNull().unique(),
    projectId: text("project_id").notNull(),
    productId: text("product_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    status: funnelPurchaseStatus("status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    projectStatusIdx: index("funnel_purchases_project_status_idx").on(
      t.projectId,
      t.status,
      t.paidAt,
    ),
    stripeSubIdx: index("funnel_purchases_stripe_sub_idx").on(t.stripeSubscriptionId),
  }),
);

export const funnelClaimTokens = pgTable(
  "funnel_claim_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    tokenHash: text("token_hash").notNull().unique(),
    // session_id intentionally has no FK — funnel_sessions is
    // partitioned. .unique() still enforces 1:1 at this table.
    sessionId: text("session_id").notNull().unique(),
    projectId: text("project_id").notNull(),
    emailHash: text("email_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBySubscriberId: text("claimed_by_subscriber_id"),
  },
  (t) => ({
    emailIdx: index("funnel_claim_tokens_email_idx").on(t.emailHash),
    expiresIdx: index("funnel_claim_tokens_expires_idx").on(t.expiresAt),
  }),
);

export const funnelDeferredClaims = pgTable(
  "funnel_deferred_claims",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    tokenId: text("token_id")
      .notNull()
      .references(() => funnelClaimTokens.id, { onDelete: "cascade" }),
    platform: funnelDeferredPlatform("platform").notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent").notNull(),
    locale: text("locale").notNull(),
    timezone: text("timezone").notNull(),
    screenDims: text("screen_dims").notNull(),
    deviceModel: text("device_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    matchedInstallId: text("matched_install_id"),
  },
  (t) => ({
    ipExpiresIdx: index("funnel_deferred_claims_ip_expires_idx").on(t.ipHash, t.expiresAt),
    tokenIdx: index("funnel_deferred_claims_token_idx").on(t.tokenId),
  }),
);

// =============================================================
// Custom domains — host-based serving for funnels
// =============================================================
//
// Maps an arbitrary hostname (e.g. `quiz.acme.com`) to a single
// funnel. Verification is two-factor: a CNAME pointing at the
// canonical edge plus a TXT challenge at `_rovenue.{hostname}`
// containing `verificationToken`. Only rows with non-null
// `verifiedAt` AND `certStatus = 'issued'` are eligible for
// serving — the edge resolver enforces both.

export const customDomains = pgTable(
  "custom_domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    // Canonical (lowercased) hostname — no scheme, no port, no path.
    hostname: text("hostname").notNull(),
    // 32-byte hex; surfaced as the TXT value `rv-verify=<token>`.
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verificationFailureReason: text("verification_failure_reason"),
    certStatus: customDomainCertStatus("cert_status").notNull().default("pending"),
    certIssuedAt: timestamp("cert_issued_at", { withTimezone: true }),
    certFailureReason: text("cert_failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    // Hostnames are global — DNS does not care about project boundaries.
    hostnameUnique: uniqueIndex("custom_domains_hostname_unique").on(t.hostname),
    // One custom domain per funnel; enforce at the DB layer so we never
    // accidentally route a hostname to two funnels.
    funnelUnique: uniqueIndex("custom_domains_funnel_unique").on(t.funnelId),
    projectIdx: index("custom_domains_project_idx").on(t.projectId),
    // Partial index — keep tiny since verified rows dominate. Used by
    // the retry job to scan unverified rows.
    pendingIdx: index("custom_domains_pending_idx")
      .on(t.verifiedAt)
      .where(sql`verified_at IS NULL`),
  }),
);

export type FunnelSession = typeof funnelSessions.$inferSelect;
export type NewFunnelSession = typeof funnelSessions.$inferInsert;
export type FunnelAnswer = typeof funnelAnswers.$inferSelect;
export type NewFunnelAnswer = typeof funnelAnswers.$inferInsert;
export type FunnelPurchase = typeof funnelPurchases.$inferSelect;
export type NewFunnelPurchase = typeof funnelPurchases.$inferInsert;
export type FunnelClaimToken = typeof funnelClaimTokens.$inferSelect;
export type NewFunnelClaimToken = typeof funnelClaimTokens.$inferInsert;
export type FunnelDeferredClaim = typeof funnelDeferredClaims.$inferSelect;
export type NewFunnelDeferredClaim = typeof funnelDeferredClaims.$inferInsert;
export type CustomDomain = typeof customDomains.$inferSelect;
export type NewCustomDomain = typeof customDomains.$inferInsert;

// ====================== Rovi (AI copilot) ======================

export const copilotThreads = pgTable(
  "copilot_threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    byUserRecent: index("copilot_threads_by_user_recent").on(
      t.projectId,
      t.userId,
      t.lastMessageAt,
    ),
  }),
);

export const copilotMessages = pgTable(
  "copilot_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    parts: jsonb("parts").notNull(),
    tokenIn: integer("token_in"),
    tokenOut: integer("token_out"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byThreadCreated: index("copilot_messages_by_thread").on(
      t.threadId,
      t.createdAt,
    ),
  }),
);

export const copilotIntents = pgTable(
  "copilot_intents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => copilotMessages.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    payload: jsonb("payload").notNull(),
    preview: jsonb("preview").notNull(),
    requiresRole: text("requires_role").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "executed", "expired", "failed"],
    })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    result: jsonb("result"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingByProject: index("copilot_intents_pending_by_project")
      .on(t.projectId, t.expiresAt)
      .where(sql`status = 'pending'`),
  }),
);

// AMENDMENT A1: credentials use a single encrypted-string column,
// matching the repo's existing crypto helper (`encrypt()` returns
// "iv:tag:data" as one string).
export const copilotCredentials = pgTable("copilot_credentials", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  defaultModel: text("default_model").notNull(),
  baseUrl: text("base_url"),
  updatedByUserId: text("updated_by_user_id")
    .notNull()
    .references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const copilotUsageMonthly = pgTable(
  "copilot_usage_monthly",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    yearMonth: text("year_month").notNull(),
    messages: integer("messages").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.yearMonth] }),
  }),
);

// === Integrations tables ===

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: integrationProvider("provider_id").notNull(),
    displayName: text("display_name").notNull(),
    credentialsCipher: text("credentials_cipher").notNull(),
    credentialsHint: text("credentials_hint").notNull(),
    enabledEvents: text("enabled_events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    eventMapping: jsonb("event_mapping")
      .$type<Record<string, { eventName?: string; skip?: true }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actionSource: text("action_source").notNull().default("app"),
    testEventCode: text("test_event_code"),
    isEnabled: boolean("is_enabled").notNull().default(false),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    projectProviderUidx: uniqueIndex(
      "integration_connections_project_provider_uidx",
    ).on(t.projectId, t.providerId),
    enabledIdx: index("integration_connections_enabled_idx")
      .on(t.projectId)
      .where(sql`is_enabled = true`),
    actionSourceChk: check(
      "integration_connections_action_source_chk",
      sql`action_source IN ('app', 'website', 'system_generated')`,
    ),
  }),
);

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;

export const integrationDeliveries = pgTable(
  "integration_deliveries",
  {
    id: text("id").notNull(),
    connectionId: text("connection_id").notNull(),
    projectId: text("project_id").notNull(),
    providerId: integrationProvider("provider_id").notNull(),
    outboxEventId: text("outbox_event_id").notNull(),
    eventKey: text("event_key").notNull(),
    providerEvent: text("provider_event"),
    status: integrationDeliveryStatus("status").notNull(),
    attempt: smallint("attempt").notNull().default(0),
    skipReason: text("skip_reason"),
    httpStatus: smallint("http_status"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
    dedupeUidx: uniqueIndex("integration_deliveries_dedupe_uidx").on(
      t.connectionId, t.outboxEventId, t.createdAt,
    ),
    connStatusIdx: index("integration_deliveries_connection_status_idx").on(
      t.connectionId, t.status, t.createdAt,
    ),
    deadLetterIdx: index("integration_deliveries_project_dead_letter_idx")
      .on(t.projectId, t.createdAt)
      .where(sql`status = 'dead_letter'`),
  }),
);

export type IntegrationDelivery = typeof integrationDeliveries.$inferSelect;
export type NewIntegrationDelivery = typeof integrationDeliveries.$inferInsert;
