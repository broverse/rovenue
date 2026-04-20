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
  memberRole,
} from "./enums";

// =============================================================
// Drizzle schema — Phase 0 foundation
// =============================================================
//
// This file mirrors the subset of schema.prisma that Phase 0 needs
// to prove the setup end-to-end: a table with FKs (project_member),
// a table with enums + append-only semantics (credit_ledger), and
// the hash-chained audit log. Remaining tables follow in Phase 1
// once the drizzle-kit introspection output is reconciled with
// these hand-written definitions.
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

// Re-export enum helpers so downstream code can `import { memberRole }
// from "@rovenue/db"` without reaching into the drizzle namespace.
export {
  creditLedgerType,
  environment,
  memberRole,
} from "./enums";
