# Billing — Phase 1: Data Model + Lazy Stripe Customer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the new billing tables, seed the static tier-limits reference,
auto-create a `state='free'` `billing_subscriptions` row for every project
(new + backfilled), wire the `BILLING_ENABLED` env flag, and stand up a
signature-verifying-but-no-op Stripe webhook receiver at
`/billing/stripe/webhook` so Phase 2 can hang the real upgrade flow off
it.

**Architecture:** Six new Postgres tables in the single `schema.ts`
(matching project convention — no per-table files). One backfill migration
plus the schema migration. Per-table Drizzle repositories under
`packages/db/src/drizzle/repositories/billing-*.ts`. A new Hono router at
`apps/api/src/routes/billing/` runs behind a `BILLING_ENABLED` env guard;
unsigned or disabled requests get `404`. The new platform-Stripe client
(`apps/api/src/lib/stripe-billing.ts`) is a separate `Stripe` SDK
instance from the existing customer-Stripe service (`services/stripe/*`)
because they hit different Stripe accounts.

**Tech Stack:** Drizzle ORM + drizzle-kit (Postgres 16), Hono, Zod,
Stripe Node SDK 15, BullMQ (existing — for async webhook processing),
Vitest, testcontainers.

---

## File Structure

### Created

- `packages/db/src/drizzle/schema.ts` — **modified**: 6 new tables + 7 new
  pgEnum declarations
- `packages/db/src/drizzle/enums.ts` — **modified**: 7 new TS-side enums
- `packages/db/src/drizzle/repositories/billing-subscriptions.ts`
- `packages/db/src/drizzle/repositories/billing-payment-methods.ts`
- `packages/db/src/drizzle/repositories/billing-invoices.ts`
- `packages/db/src/drizzle/repositories/billing-dunning-state.ts`
- `packages/db/src/drizzle/repositories/billing-tier-limits.ts`
- `packages/db/src/drizzle/repositories/usage-snapshots.ts`
- `packages/db/src/drizzle/repositories/index.ts` — **modified**: re-exports
- `packages/db/drizzle/migrations/0041_billing_tables.sql` — generated
- `packages/db/drizzle/migrations/0042_billing_backfill.sql` — hand-written
- `packages/db/seed.ts` — **modified**: tier_limits + billing_subscriptions
  rows for the demo project
- `apps/api/src/lib/env.ts` — **modified**: add billing env vars
- `apps/api/src/lib/stripe-billing.ts` — new platform-Stripe client
- `apps/api/src/lib/billing-flags.ts` — `BILLING_ENABLED` helper
- `apps/api/src/routes/billing/index.ts` — top-level router
- `apps/api/src/routes/billing/webhook.ts` — Stripe webhook receiver
- `apps/api/src/routes/index.ts` — **modified**: export `billingRoute`
- `apps/api/src/app.ts` — **modified**: mount billing router
- `apps/api/src/services/billing/create-free-subscription.ts` — service
  called inside the project-create transaction
- `apps/api/src/routes/dashboard/projects.ts` — **modified**: call the
  service inside the create transaction
- `apps/api/tests/billing-subscriptions-repo.test.ts`
- `apps/api/tests/billing-payment-methods-repo.test.ts`
- `apps/api/tests/billing-invoices-repo.test.ts`
- `apps/api/tests/billing-dunning-state-repo.test.ts`
- `apps/api/tests/billing-tier-limits-seed.test.ts`
- `apps/api/tests/usage-snapshots-repo.test.ts`
- `apps/api/tests/billing-project-create-hook.test.ts`
- `apps/api/tests/billing-backfill-migration.integration.test.ts`
- `apps/api/tests/billing-stripe-webhook.test.ts`
- `.env.example` — **modified**

### Responsibility boundaries

Each repository file owns CRUD for exactly one table and exposes only
the operations Phase 1 needs (no speculative methods — YAGNI). The
service file `create-free-subscription.ts` is the single place that
knows how to bootstrap a billing row for a new project; both the
project-create route and the backfill migration call it conceptually
(the backfill is SQL-only, but it mirrors the same defaults).

---

## Task 1: Add billing TS enums

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Open the existing enums file to see the export pattern**

Read: `packages/db/src/drizzle/enums.ts` end-to-end so the new enums match
the existing capitalisation, JSDoc-free style, and `as const` pattern.

- [ ] **Step 2: Write the failing test**

Append to `packages/db/src/drizzle/drizzle-foundation.test.ts`:

```ts
import {
  billingState,
  billingTier,
  billingCycle,
  billingInvoiceStatus,
  billingDunningPhase,
  billingPendingAction,
  billingMeterKey,
} from "./enums";

describe("billing enums", () => {
  it("billingState lists every state the FSM uses", () => {
    expect(billingState).toEqual([
      "free",
      "active",
      "past_due",
      "paused",
      "deleted",
    ]);
  });
  it("billingTier lists every tier in the ladder", () => {
    expect(billingTier).toEqual([
      "free",
      "indie",
      "pro",
      "scale",
      "growth",
      "enterprise",
    ]);
  });
  it("billingCycle covers monthly + annual only", () => {
    expect(billingCycle).toEqual(["monthly", "annual"]);
  });
  it("billingInvoiceStatus matches Stripe's invoice statuses", () => {
    expect(billingInvoiceStatus).toEqual([
      "draft",
      "open",
      "paid",
      "uncollectible",
      "void",
    ]);
  });
  it("billingDunningPhase covers the three dunning sub-states", () => {
    expect(billingDunningPhase).toEqual([
      "retrying",
      "past_due",
      "suspended",
    ]);
  });
  it("billingPendingAction covers the three expected deletions", () => {
    expect(billingPendingAction).toEqual([
      "downgrade_to_free",
      "pause",
      "delete",
    ]);
  });
  it("billingMeterKey lists the three metered dimensions", () => {
    expect(billingMeterKey).toEqual([
      "mtr",
      "events",
      "sql_queries",
    ]);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @rovenue/db test drizzle-foundation -- --reporter=verbose
```

Expected: 7 failures, each `is not exported by ./enums`.

- [ ] **Step 4: Add the enums**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const billingState = [
  "free",
  "active",
  "past_due",
  "paused",
  "deleted",
] as const;
export type BillingState = (typeof billingState)[number];

export const billingTier = [
  "free",
  "indie",
  "pro",
  "scale",
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
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @rovenue/db test drizzle-foundation -- --reporter=verbose
```

Expected: all 7 new assertions PASS, plus the original suite.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/enums.ts \
        packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db/billing): add billing enums (state, tier, cycle, ...)"
```

---

## Task 2: Add the six billing tables to schema.ts

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Locate the existing pgEnum block in schema.ts**

Open `packages/db/src/drizzle/schema.ts` and find the section that
declares `pgEnum` values (search for `pgEnum(`). New `pgEnum`
declarations go in that block, ordered alphabetically among existing
billing-prefixed peers.

- [ ] **Step 2: Write the failing test**

Append to `drizzle-foundation.test.ts`:

```ts
import {
  billingSubscriptions,
  billingPaymentMethods,
  billingInvoices,
  billingDunningState,
  billingTierLimits,
  usageSnapshots,
} from "./schema";

describe("billing tables", () => {
  it("billing_subscriptions has the columns the spec defines", () => {
    const cols = Object.keys(billingSubscriptions);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "stripeCustomerId",
        "stripeSubscriptionId",
        "state",
        "tier",
        "cycle",
        "currentPeriodStart",
        "currentPeriodEnd",
        "trialEnd",
        "pausedAt",
        "deletedAt",
        "pendingAction",
        "createdAt",
        "updatedAt",
      ]),
    );
  });
  it("billing_payment_methods has Stripe-PM mirror columns", () => {
    const cols = Object.keys(billingPaymentMethods);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "stripePaymentMethodId",
        "brand",
        "last4",
        "expMonth",
        "expYear",
        "isDefault",
        "createdAt",
      ]),
    );
  });
  it("billing_invoices has Stripe-invoice mirror columns + refunded", () => {
    const cols = Object.keys(billingInvoices);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "stripeInvoiceId",
        "number",
        "periodStart",
        "periodEnd",
        "amountDue",
        "amountPaid",
        "refundedAmount",
        "currency",
        "status",
        "hostedInvoiceUrl",
        "pdfUrl",
        "attemptCount",
        "nextPaymentAttempt",
        "createdAt",
      ]),
    );
  });
  it("billing_dunning_state has the FSM columns", () => {
    const cols = Object.keys(billingDunningState);
    expect(cols).toEqual(
      expect.arrayContaining([
        "projectId",
        "firstFailureAt",
        "attemptCount",
        "currentPhase",
        "uiLockedAt",
        "sdkLockedAt",
        "recoveredAt",
        "lastEmailSentAt",
        "updatedAt",
      ]),
    );
  });
  it("billing_tier_limits has reference data columns", () => {
    const cols = Object.keys(billingTierLimits);
    expect(cols).toEqual(
      expect.arrayContaining([
        "tier",
        "cycle",
        "priceUsdCents",
        "stripePriceId",
        "mtrMin",
        "mtrMax",
        "eventsLimit",
        "sqlLimit",
        "retentionDays",
        "auditLogDays",
      ]),
    );
  });
  it("usage_snapshots has the PG rollup columns", () => {
    const cols = Object.keys(usageSnapshots);
    expect(cols).toEqual(
      expect.arrayContaining([
        "projectId",
        "meterKey",
        "periodStart",
        "periodEnd",
        "currentValue",
        "limitValue",
        "softCapWarnedAt",
        "hardCapWarnedAt",
        "updatedAt",
      ]),
    );
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @rovenue/db test drizzle-foundation
```

Expected: 6 failures, each "is not exported".

- [ ] **Step 4: Add the pgEnums in schema.ts**

Inside the existing `pgEnum` block in `schema.ts`, add:

```ts
export const billingStateEnum = pgEnum("billing_state", [
  "free",
  "active",
  "past_due",
  "paused",
  "deleted",
]);
export const billingTierEnum = pgEnum("billing_tier", [
  "free",
  "indie",
  "pro",
  "scale",
  "growth",
  "enterprise",
]);
export const billingCycleEnum = pgEnum("billing_cycle", ["monthly", "annual"]);
export const billingInvoiceStatusEnum = pgEnum("billing_invoice_status", [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
]);
export const billingDunningPhaseEnum = pgEnum("billing_dunning_phase", [
  "retrying",
  "past_due",
  "suspended",
]);
export const billingPendingActionEnum = pgEnum("billing_pending_action", [
  "downgrade_to_free",
  "pause",
  "delete",
]);
export const billingMeterKeyEnum = pgEnum("billing_meter_key", [
  "mtr",
  "events",
  "sql_queries",
]);
```

- [ ] **Step 5: Add the six table definitions**

After the last existing table in `schema.ts`, append:

```ts
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

export type BillingSubscription = InferSelectModel<typeof billingSubscriptions>;
export type NewBillingSubscription = InferInsertModel<
  typeof billingSubscriptions
>;
export type BillingPaymentMethod = InferSelectModel<typeof billingPaymentMethods>;
export type NewBillingPaymentMethod = InferInsertModel<
  typeof billingPaymentMethods
>;
export type BillingInvoice = InferSelectModel<typeof billingInvoices>;
export type NewBillingInvoice = InferInsertModel<typeof billingInvoices>;
export type BillingDunningStateRow = InferSelectModel<typeof billingDunningState>;
export type NewBillingDunningStateRow = InferInsertModel<
  typeof billingDunningState
>;
export type BillingTierLimits = InferSelectModel<typeof billingTierLimits>;
export type UsageSnapshot = InferSelectModel<typeof usageSnapshots>;
```

Add any missing imports at the top of `schema.ts` (`numeric`, `integer`,
`boolean`, `uniqueIndex`, `index`, `primaryKey`, `InferSelectModel`,
`InferInsertModel`, `sql`) — most are already imported; verify before
adding.

- [ ] **Step 6: Run the test and confirm it passes**

```bash
pnpm --filter @rovenue/db test drizzle-foundation
```

Expected: 6 new tests PASS plus the original suite.

- [ ] **Step 7: Type-check the workspace**

```bash
pnpm --filter @rovenue/db build
```

Expected: success, no TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db/billing): add billing_subscriptions, payment_methods, invoices, dunning_state, tier_limits, usage_snapshots"
```

---

## Task 3: Generate the schema migration

**Files:**
- Create: `packages/db/drizzle/migrations/0041_billing_tables.sql` (generated)
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (generated)

- [ ] **Step 1: Generate the migration**

```bash
pnpm db:migrate:generate
```

Expected: drizzle-kit prints `Migration written to drizzle/migrations/0041_*.sql`
and updates `meta/_journal.json`.

- [ ] **Step 2: Open the generated SQL and verify it matches**

Open `packages/db/drizzle/migrations/0041_*.sql` and confirm:
- All six `CREATE TABLE` statements present
- All seven `CREATE TYPE ..._enum AS ENUM (...)` present
- The two partial unique indexes use `WHERE state != 'deleted'` and
  `WHERE is_default = true`
- Foreign keys `ON DELETE CASCADE` to `projects.id` everywhere
- No accidental modifications to other tables (run `git diff -U2 -- '*.sql'`
  to confirm only the new file appears)

If anything looks wrong, fix the schema and regenerate (delete the new
migration file + journal entry first).

- [ ] **Step 3: Apply the migration against a shadow DB**

```bash
pnpm --filter @rovenue/db test shadow
```

Expected: `shadow.test.ts` PASS — it spins a fresh Postgres container,
applies every migration in order, and snapshots the schema. The new
tables show up in the snapshot diff; commit the snapshot if applicable.

- [ ] **Step 4: Apply the migration against your dev DB**

```bash
pnpm db:migrate
```

Expected: prints `Migration 0041_*.sql applied`. Verify via:

```bash
psql "$DATABASE_URL" -c "\dt billing_*"
```

Expected: lists `billing_dunning_state, billing_invoices,
billing_payment_methods, billing_subscriptions, billing_tier_limits`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0041_billing_tables.sql \
        packages/db/drizzle/migrations/meta/_journal.json \
        packages/db/drizzle/migrations/meta/*.json
git commit -m "feat(db/migration): 0041 — create billing tables"
```

---

## Task 4: Seed billing_tier_limits

**Files:**
- Modify: `packages/db/seed.ts`
- Test: `apps/api/tests/billing-tier-limits-seed.test.ts`

The reference table holds 12 rows (6 tiers × 2 cycles). Annual price =
monthly × 10 (2 months free). Free tier costs $0 and has no
`stripePriceId` (no Stripe product). Enterprise has `stripePriceId: null`
because contracts are bespoke.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-tier-limits-seed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import { billingTierLimits } from "../../packages/db/src/drizzle/schema";

// This test runs against a seeded database.
// Boot Postgres + run `pnpm db:migrate && pnpm db:seed` before running.

describe("billing_tier_limits seed", () => {
  it("has exactly 12 rows (6 tiers x 2 cycles)", async () => {
    const rows = await db.select().from(billingTierLimits);
    expect(rows).toHaveLength(12);
  });

  it("Free tier is $0 both cycles", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "free"));
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.priceUsdCents).toBe(0));
  });

  it("Indie monthly = $29, annual = $290 (2 months free)", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "indie"));
    const monthly = rows.find((r) => r.cycle === "monthly")!;
    const annual = rows.find((r) => r.cycle === "annual")!;
    expect(monthly.priceUsdCents).toBe(2900);
    expect(annual.priceUsdCents).toBe(29_000);
  });

  it("Scale monthly = $399, annual = $3990", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "scale"));
    expect(rows.find((r) => r.cycle === "monthly")!.priceUsdCents).toBe(
      39_900,
    );
    expect(rows.find((r) => r.cycle === "annual")!.priceUsdCents).toBe(
      399_000,
    );
  });

  it("Free MTR bracket = $0 – $3K", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    expect(Number(free.mtrMin)).toBe(0);
    expect(Number(free.mtrMax)).toBe(3000);
  });

  it("Enterprise has no upper MTR bound and no stripe_price_id", async () => {
    const ent = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "enterprise"))
    )[0]!;
    expect(ent.mtrMax).toBeNull();
    expect(ent.stripePriceId).toBeNull();
  });

  it("Free + Indie have a finite sql_limit; Scale+ are unlimited (NULL)", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    const scale = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "scale"))
    )[0]!;
    expect(free.sqlLimit).toBe(100);
    expect(scale.sqlLimit).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm db:migrate && pnpm --filter @rovenue/api test billing-tier-limits-seed
```

Expected: all 7 tests FAIL (the table is empty).

- [ ] **Step 3: Add the seed rows**

In `packages/db/seed.ts`, **before** the demo project block, add an
import for `billingTierLimits` and append a new section:

```ts
// =============================================================
// Tier limits reference data — 6 tiers x 2 cycles
// =============================================================
//
// Idempotent: ON CONFLICT DO NOTHING. Update via a new migration when
// prices change; never patch the seed in place — production-seeded
// rows would not pick up the change.

const TIER_LIMITS = [
  // Free
  { tier: "free",       cycle: "monthly", priceCents:      0, mtrMin:    0, mtrMax:    3000, events:     5_000_000, sql:    100, retention: 30,  audit:    7 },
  { tier: "free",       cycle: "annual",  priceCents:      0, mtrMin:    0, mtrMax:    3000, events:     5_000_000, sql:    100, retention: 30,  audit:    7 },
  // Indie
  { tier: "indie",      cycle: "monthly", priceCents:   2900, mtrMin:  3000, mtrMax:   10000, events:    15_000_000, sql:    500, retention: 60,  audit:   30 },
  { tier: "indie",      cycle: "annual",  priceCents:  29000, mtrMin:  3000, mtrMax:   10000, events:    15_000_000, sql:    500, retention: 60,  audit:   30 },
  // Pro
  { tier: "pro",        cycle: "monthly", priceCents:   9900, mtrMin: 10000, mtrMax:   50000, events:    50_000_000, sql:   2500, retention: 180, audit:   90 },
  { tier: "pro",        cycle: "annual",  priceCents:  99000, mtrMin: 10000, mtrMax:   50000, events:    50_000_000, sql:   2500, retention: 180, audit:   90 },
  // Scale
  { tier: "scale",      cycle: "monthly", priceCents:  39900, mtrMin: 50000, mtrMax:  250000, events:   250_000_000, sql:   null, retention: 365, audit:  365 },
  { tier: "scale",      cycle: "annual",  priceCents: 399000, mtrMin: 50000, mtrMax:  250000, events:   250_000_000, sql:   null, retention: 365, audit:  365 },
  // Growth
  { tier: "growth",     cycle: "monthly", priceCents: 149900, mtrMin: 250000, mtrMax: 1000000, events: 1_000_000_000, sql:   null, retention: 730, audit:  730 },
  { tier: "growth",     cycle: "annual",  priceCents: 1499000, mtrMin: 250000, mtrMax: 1000000, events: 1_000_000_000, sql:   null, retention: 730, audit:  730 },
  // Enterprise
  { tier: "enterprise", cycle: "monthly", priceCents:      0, mtrMin: 1000000, mtrMax: null,   events:        null, sql:   null, retention: 1825, audit: 1825 },
  { tier: "enterprise", cycle: "annual",  priceCents:      0, mtrMin: 1000000, mtrMax: null,   events:        null, sql:   null, retention: 1825, audit: 1825 },
] as const;

await db
  .insert(billingTierLimits)
  .values(
    TIER_LIMITS.map((r) => ({
      tier: r.tier,
      cycle: r.cycle,
      priceUsdCents: r.priceCents,
      stripePriceId: null,
      mtrMin: String(r.mtrMin),
      mtrMax: r.mtrMax === null ? null : String(r.mtrMax),
      eventsLimit: r.events,
      sqlLimit: r.sql,
      retentionDays: r.retention,
      auditLogDays: r.audit,
    })),
  )
  .onConflictDoNothing();
```

`stripePriceId` is intentionally `null` for every row — Phase 2 backfills
real IDs after the Stripe products are created.

- [ ] **Step 4: Run the seed and the test**

```bash
pnpm db:seed && pnpm --filter @rovenue/api test billing-tier-limits-seed
```

Expected: all 7 assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed.ts apps/api/tests/billing-tier-limits-seed.test.ts
git commit -m "feat(db/billing): seed billing_tier_limits (6 tiers x 2 cycles)"
```

---

## Task 5: billing_subscriptions repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/billing-subscriptions.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `apps/api/tests/billing-subscriptions-repo.test.ts`

Phase 1 scope: only the operations the project-create hook and the
webhook receiver need. The fuller set (state transitions, cycle update,
etc.) ships in Phase 2.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-subscriptions-repo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingSubscriptions,
  projects,
} from "../../packages/db/src/drizzle/schema";
import {
  createFreeBillingSubscription,
  findBillingSubscriptionByProject,
} from "../../packages/db/src/drizzle/repositories/billing-subscriptions";

const TEST_PROJECT_ID = "proj_test_billing_repo";

async function seedProject() {
  await db
    .insert(projects)
    .values({
      id: TEST_PROJECT_ID,
      slug: "test-billing-repo",
      name: "Test Billing Repo",
      ownerId: "usr_demo",
    })
    .onConflictDoNothing();
}

async function cleanup() {
  await db
    .delete(billingSubscriptions)
    .where(eq(billingSubscriptions.projectId, TEST_PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
}

describe("billing-subscriptions repository", () => {
  beforeEach(async () => {
    await cleanup();
    await seedProject();
  });
  afterAll(cleanup);

  it("createFreeBillingSubscription inserts a free row", async () => {
    const row = await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    expect(row.state).toBe("free");
    expect(row.tier).toBe("free");
    expect(row.cycle).toBe("monthly");
    expect(row.stripeCustomerId).toBeNull();
    expect(row.stripeSubscriptionId).toBeNull();
    expect(row.projectId).toBe(TEST_PROJECT_ID);
  });

  it("findBillingSubscriptionByProject returns the active row", async () => {
    await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    const found = await findBillingSubscriptionByProject(db, TEST_PROJECT_ID);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("free");
  });

  it("findBillingSubscriptionByProject returns null for unknown project", async () => {
    const found = await findBillingSubscriptionByProject(
      db,
      "proj_does_not_exist",
    );
    expect(found).toBeNull();
  });

  it("createFreeBillingSubscription is unique-per-project (partial index)", async () => {
    await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    await expect(
      createFreeBillingSubscription(db, TEST_PROJECT_ID),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @rovenue/api test billing-subscriptions-repo
```

Expected: 4 failures with `Cannot find module '.../billing-subscriptions'`.

- [ ] **Step 3: Implement the repository**

Create `packages/db/src/drizzle/repositories/billing-subscriptions.ts`:

```ts
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../schema";

// =============================================================
// billing_subscriptions repository (Phase 1)
// =============================================================
// One row per project. The partial unique index
// `billing_subscriptions_project_active_uq` permits multiple rows only
// when older ones are state='deleted'; Phase 1 never deletes, so a
// duplicate insert is always a bug.

export async function createFreeBillingSubscription(
  db: Db,
  projectId: string,
): Promise<BillingSubscription> {
  const rows = await db
    .insert(billingSubscriptions)
    .values({
      projectId,
      state: "free",
      tier: "free",
      cycle: "monthly",
    })
    .returning();
  return rows[0]!;
}

export async function findBillingSubscriptionByProject(
  db: Db,
  projectId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Re-export from the repositories barrel**

Append to `packages/db/src/drizzle/repositories/index.ts`:

```ts
export * as billingSubscriptionsRepo from "./billing-subscriptions";
```

(Follow the existing capitalisation pattern — e.g. `apiKeyRepo`. If the
pattern is `projectRepo` use `billingSubscriptionRepo` singular.)

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @rovenue/api test billing-subscriptions-repo
```

Expected: all 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-subscriptions.ts \
        packages/db/src/drizzle/repositories/index.ts \
        apps/api/tests/billing-subscriptions-repo.test.ts
git commit -m "feat(db/billing): billing_subscriptions repository (create + find)"
```

---

## Task 6: billing_payment_methods repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/billing-payment-methods.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `apps/api/tests/billing-payment-methods-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-payment-methods-repo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingPaymentMethods,
  projects,
} from "../../packages/db/src/drizzle/schema";
import {
  insertPaymentMethod,
  listPaymentMethodsForProject,
  findDefaultPaymentMethod,
  setDefaultPaymentMethod,
  deletePaymentMethod,
} from "../../packages/db/src/drizzle/repositories/billing-payment-methods";

const TEST_PROJECT_ID = "proj_test_pm_repo";

async function setup() {
  await db.delete(billingPaymentMethods)
    .where(eq(billingPaymentMethods.projectId, TEST_PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
  await db.insert(projects).values({
    id: TEST_PROJECT_ID,
    slug: "test-pm-repo",
    name: "Test PM",
    ownerId: "usr_demo",
  });
}

describe("billing-payment-methods repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("insertPaymentMethod adds a row", async () => {
    const row = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_1",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    expect(row.id).toMatch(/^[a-z0-9]+$/);
    expect(row.last4).toBe("4242");
  });

  it("listPaymentMethodsForProject returns inserted rows", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_1",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_2",
      brand: "mastercard",
      last4: "5555",
      expMonth: 6,
      expYear: 2028,
      isDefault: false,
    });
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows).toHaveLength(2);
  });

  it("findDefaultPaymentMethod returns the default row", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_3",
      brand: "visa",
      last4: "1111",
      expMonth: 1,
      expYear: 2031,
      isDefault: true,
    });
    const def = await findDefaultPaymentMethod(db, TEST_PROJECT_ID);
    expect(def?.last4).toBe("1111");
  });

  it("setDefaultPaymentMethod swaps the default exclusively", async () => {
    const a = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_a",
      brand: "visa",
      last4: "aaaa",
      expMonth: 1,
      expYear: 2030,
      isDefault: true,
    });
    const b = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_b",
      brand: "visa",
      last4: "bbbb",
      expMonth: 1,
      expYear: 2030,
      isDefault: false,
    });
    await setDefaultPaymentMethod(db, TEST_PROJECT_ID, b.id);
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows.find((r) => r.id === a.id)!.isDefault).toBe(false);
    expect(rows.find((r) => r.id === b.id)!.isDefault).toBe(true);
  });

  it("deletePaymentMethod removes the row", async () => {
    const r = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_4",
      brand: "visa",
      last4: "9999",
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
    });
    await deletePaymentMethod(db, r.id);
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows).toHaveLength(0);
  });

  it("two defaults in the same project conflicts on the partial index", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_def_1",
      brand: "visa",
      last4: "1234",
      expMonth: 1,
      expYear: 2030,
      isDefault: true,
    });
    await expect(
      insertPaymentMethod(db, {
        projectId: TEST_PROJECT_ID,
        stripePaymentMethodId: "pm_def_2",
        brand: "visa",
        last4: "5678",
        expMonth: 1,
        expYear: 2030,
        isDefault: true,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @rovenue/api test billing-payment-methods-repo
```

Expected: 6 failures, `Cannot find module`.

- [ ] **Step 3: Implement the repository**

Create `packages/db/src/drizzle/repositories/billing-payment-methods.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingPaymentMethods,
  type BillingPaymentMethod,
  type NewBillingPaymentMethod,
} from "../schema";

export async function insertPaymentMethod(
  db: Db,
  row: Omit<NewBillingPaymentMethod, "id" | "createdAt">,
): Promise<BillingPaymentMethod> {
  const rows = await db
    .insert(billingPaymentMethods)
    .values(row)
    .returning();
  return rows[0]!;
}

export async function listPaymentMethodsForProject(
  db: Db,
  projectId: string,
): Promise<BillingPaymentMethod[]> {
  return db
    .select()
    .from(billingPaymentMethods)
    .where(eq(billingPaymentMethods.projectId, projectId));
}

export async function findDefaultPaymentMethod(
  db: Db,
  projectId: string,
): Promise<BillingPaymentMethod | null> {
  const rows = await db
    .select()
    .from(billingPaymentMethods)
    .where(
      and(
        eq(billingPaymentMethods.projectId, projectId),
        eq(billingPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function setDefaultPaymentMethod(
  db: Db,
  projectId: string,
  paymentMethodId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(billingPaymentMethods)
      .set({ isDefault: false })
      .where(
        and(
          eq(billingPaymentMethods.projectId, projectId),
          eq(billingPaymentMethods.isDefault, true),
        ),
      );
    await tx
      .update(billingPaymentMethods)
      .set({ isDefault: true })
      .where(eq(billingPaymentMethods.id, paymentMethodId));
  });
}

export async function deletePaymentMethod(
  db: Db,
  paymentMethodId: string,
): Promise<void> {
  await db
    .delete(billingPaymentMethods)
    .where(eq(billingPaymentMethods.id, paymentMethodId));
}
```

- [ ] **Step 4: Re-export from barrel**

Add to `repositories/index.ts`:

```ts
export * as billingPaymentMethodsRepo from "./billing-payment-methods";
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @rovenue/api test billing-payment-methods-repo
```

Expected: all 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-payment-methods.ts \
        packages/db/src/drizzle/repositories/index.ts \
        apps/api/tests/billing-payment-methods-repo.test.ts
git commit -m "feat(db/billing): billing_payment_methods repository (insert, list, default swap, delete)"
```

---

## Task 7: billing_invoices repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/billing-invoices.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `apps/api/tests/billing-invoices-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-invoices-repo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingInvoices,
  projects,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertInvoiceFromStripe,
  listInvoicesForProject,
  findInvoiceByStripeId,
  incrementRefundedAmount,
} from "../../packages/db/src/drizzle/repositories/billing-invoices";

const PID = "proj_test_inv";

async function setup() {
  await db.delete(billingInvoices).where(eq(billingInvoices.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db.insert(projects).values({
    id: PID,
    slug: "test-inv",
    name: "Test Inv",
    ownerId: "usr_demo",
  });
}

const STRIPE_FIXTURE = {
  stripeInvoiceId: "in_test_001",
  number: "INV-2026-0001",
  periodStart: new Date("2026-05-01T00:00:00Z"),
  periodEnd: new Date("2026-06-01T00:00:00Z"),
  amountDue: "9900",
  amountPaid: "9900",
  refundedAmount: "0",
  currency: "usd",
  status: "paid" as const,
  hostedInvoiceUrl: "https://stripe.test/invoice/in_test_001",
  pdfUrl: "https://stripe.test/invoice/in_test_001/pdf",
  attemptCount: 1,
  nextPaymentAttempt: null,
};

describe("billing-invoices repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsertInvoiceFromStripe inserts on first call", async () => {
    const row = await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
    });
    expect(row.status).toBe("paid");
    expect(row.amountPaid).toBe("9900.0000");
  });

  it("upsertInvoiceFromStripe updates on second call (same stripe_invoice_id)", async () => {
    await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
      status: "open",
      amountPaid: "0",
    });
    const row = await upsertInvoiceFromStripe(db, {
      projectId: PID,
      ...STRIPE_FIXTURE,
      status: "paid",
      amountPaid: "9900",
    });
    expect(row.status).toBe("paid");
    const all = await listInvoicesForProject(db, PID);
    expect(all).toHaveLength(1);
  });

  it("findInvoiceByStripeId returns the row", async () => {
    await upsertInvoiceFromStripe(db, { projectId: PID, ...STRIPE_FIXTURE });
    const found = await findInvoiceByStripeId(db, "in_test_001");
    expect(found?.number).toBe("INV-2026-0001");
  });

  it("incrementRefundedAmount adds to the existing refund", async () => {
    await upsertInvoiceFromStripe(db, { projectId: PID, ...STRIPE_FIXTURE });
    await incrementRefundedAmount(db, "in_test_001", "1000");
    await incrementRefundedAmount(db, "in_test_001", "500");
    const r = await findInvoiceByStripeId(db, "in_test_001");
    expect(r?.refundedAmount).toBe("1500.0000");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @rovenue/api test billing-invoices-repo
```

Expected: 4 failures, module not found.

- [ ] **Step 3: Implement the repository**

Create `packages/db/src/drizzle/repositories/billing-invoices.ts`:

```ts
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingInvoices,
  type BillingInvoice,
  type NewBillingInvoice,
} from "../schema";

export async function upsertInvoiceFromStripe(
  db: Db,
  row: Omit<NewBillingInvoice, "id" | "createdAt">,
): Promise<BillingInvoice> {
  const rows = await db
    .insert(billingInvoices)
    .values(row)
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        status: row.status,
        amountDue: row.amountDue,
        amountPaid: row.amountPaid,
        hostedInvoiceUrl: row.hostedInvoiceUrl ?? null,
        pdfUrl: row.pdfUrl ?? null,
        attemptCount: row.attemptCount,
        nextPaymentAttempt: row.nextPaymentAttempt ?? null,
      },
    })
    .returning();
  return rows[0]!;
}

export async function listInvoicesForProject(
  db: Db,
  projectId: string,
): Promise<BillingInvoice[]> {
  return db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.projectId, projectId))
    .orderBy(desc(billingInvoices.createdAt));
}

export async function findInvoiceByStripeId(
  db: Db,
  stripeInvoiceId: string,
): Promise<BillingInvoice | null> {
  const rows = await db
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.stripeInvoiceId, stripeInvoiceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function incrementRefundedAmount(
  db: Db,
  stripeInvoiceId: string,
  delta: string,
): Promise<void> {
  await db
    .update(billingInvoices)
    .set({
      refundedAmount: sql`${billingInvoices.refundedAmount} + ${delta}::numeric`,
    })
    .where(eq(billingInvoices.stripeInvoiceId, stripeInvoiceId));
}
```

- [ ] **Step 4: Re-export from barrel**

Add to `repositories/index.ts`:

```ts
export * as billingInvoicesRepo from "./billing-invoices";
```

- [ ] **Step 5: Run and confirm pass**

```bash
pnpm --filter @rovenue/api test billing-invoices-repo
```

Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-invoices.ts \
        packages/db/src/drizzle/repositories/index.ts \
        apps/api/tests/billing-invoices-repo.test.ts
git commit -m "feat(db/billing): billing_invoices repository (upsert, list, find, refund delta)"
```

---

## Task 8: billing_dunning_state repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/billing-dunning-state.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `apps/api/tests/billing-dunning-state-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-dunning-state-repo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingDunningState,
  projects,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertDunningState,
  findDunningStateForProject,
  clearDunningState,
} from "../../packages/db/src/drizzle/repositories/billing-dunning-state";

const PID = "proj_test_dun";

async function setup() {
  await db.delete(billingDunningState)
    .where(eq(billingDunningState.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db.insert(projects).values({
    id: PID,
    slug: "test-dun",
    name: "Test Dun",
    ownerId: "usr_demo",
  });
}

describe("billing-dunning-state repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsertDunningState inserts on first call", async () => {
    const row = await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(row.currentPhase).toBe("retrying");
  });

  it("upsertDunningState updates on second call", async () => {
    await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date("2026-05-01T00:00:00Z"),
    });
    const r = await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 4,
      currentPhase: "past_due",
      lastEmailSentAt: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.attemptCount).toBe(4);
    expect(r.currentPhase).toBe("past_due");
  });

  it("findDunningStateForProject returns null when absent", async () => {
    const r = await findDunningStateForProject(db, PID);
    expect(r).toBeNull();
  });

  it("clearDunningState removes the row", async () => {
    await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date(),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date(),
    });
    await clearDunningState(db, PID);
    const r = await findDunningStateForProject(db, PID);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test billing-dunning-state-repo
```

Expected: 4 failures.

- [ ] **Step 3: Implement**

Create `packages/db/src/drizzle/repositories/billing-dunning-state.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingDunningState,
  type BillingDunningStateRow,
  type NewBillingDunningStateRow,
} from "../schema";

export async function upsertDunningState(
  db: Db,
  row: NewBillingDunningStateRow,
): Promise<BillingDunningStateRow> {
  const rows = await db
    .insert(billingDunningState)
    .values(row)
    .onConflictDoUpdate({
      target: billingDunningState.projectId,
      set: {
        firstFailureAt: row.firstFailureAt,
        attemptCount: row.attemptCount,
        currentPhase: row.currentPhase ?? null,
        uiLockedAt: row.uiLockedAt ?? null,
        sdkLockedAt: row.sdkLockedAt ?? null,
        recoveredAt: row.recoveredAt ?? null,
        lastEmailSentAt: row.lastEmailSentAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function findDunningStateForProject(
  db: Db,
  projectId: string,
): Promise<BillingDunningStateRow | null> {
  const rows = await db
    .select()
    .from(billingDunningState)
    .where(eq(billingDunningState.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

export async function clearDunningState(
  db: Db,
  projectId: string,
): Promise<void> {
  await db
    .delete(billingDunningState)
    .where(eq(billingDunningState.projectId, projectId));
}
```

- [ ] **Step 4: Re-export from barrel**

Add `export * as billingDunningStateRepo from "./billing-dunning-state";` to
`repositories/index.ts`.

- [ ] **Step 5: Run + pass**

```bash
pnpm --filter @rovenue/api test billing-dunning-state-repo
```

Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-dunning-state.ts \
        packages/db/src/drizzle/repositories/index.ts \
        apps/api/tests/billing-dunning-state-repo.test.ts
git commit -m "feat(db/billing): billing_dunning_state repository (upsert, find, clear)"
```

---

## Task 9: usage_snapshots repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/usage-snapshots.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts`
- Test: `apps/api/tests/usage-snapshots-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/usage-snapshots-repo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  usageSnapshots,
  projects,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertUsageSnapshot,
  findUsageSnapshotsForProject,
  markSoftCapWarned,
  markHardCapWarned,
} from "../../packages/db/src/drizzle/repositories/usage-snapshots";

const PID = "proj_test_usage";
const PSTART = new Date("2026-05-01T00:00:00Z");
const PEND = new Date("2026-06-01T00:00:00Z");

async function setup() {
  await db.delete(usageSnapshots).where(eq(usageSnapshots.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db.insert(projects).values({
    id: PID,
    slug: "test-usage",
    name: "Test Usage",
    ownerId: "usr_demo",
  });
}

describe("usage-snapshots repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsert inserts on first call", async () => {
    const r = await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "1234.5678",
      limitValue: "3000.0000",
    });
    expect(r.currentValue).toBe("1234.5678");
  });

  it("upsert updates on second call (same key)", async () => {
    await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "100",
      limitValue: "3000",
    });
    const r = await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "500",
      limitValue: "3000",
    });
    expect(r.currentValue).toBe("500.0000");
  });

  it("findUsageSnapshotsForProject returns the rows", async () => {
    for (const key of ["mtr", "events", "sql_queries"] as const) {
      await upsertUsageSnapshot(db, {
        projectId: PID,
        meterKey: key,
        periodStart: PSTART,
        periodEnd: PEND,
        currentValue: "0",
        limitValue: null,
      });
    }
    const rows = await findUsageSnapshotsForProject(db, PID, PSTART);
    expect(rows).toHaveLength(3);
  });

  it("markSoftCapWarned sets the timestamp idempotently", async () => {
    await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "2500",
      limitValue: "3000",
    });
    await markSoftCapWarned(db, PID, "mtr", PSTART);
    const [row] = await db
      .select()
      .from(usageSnapshots)
      .where(
        and(
          eq(usageSnapshots.projectId, PID),
          eq(usageSnapshots.meterKey, "mtr"),
          eq(usageSnapshots.periodStart, PSTART),
        ),
      );
    expect(row.softCapWarnedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test usage-snapshots-repo
```

Expected: 4 failures.

- [ ] **Step 3: Implement**

Create `packages/db/src/drizzle/repositories/usage-snapshots.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  usageSnapshots,
  type NewUsageSnapshot,
  type UsageSnapshot,
} from "../schema";
import type { BillingMeterKey } from "../enums";

export async function upsertUsageSnapshot(
  db: Db,
  row: NewUsageSnapshot,
): Promise<UsageSnapshot> {
  const rows = await db
    .insert(usageSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [
        usageSnapshots.projectId,
        usageSnapshots.meterKey,
        usageSnapshots.periodStart,
      ],
      set: {
        currentValue: row.currentValue,
        limitValue: row.limitValue ?? null,
        periodEnd: row.periodEnd,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function findUsageSnapshotsForProject(
  db: Db,
  projectId: string,
  periodStart: Date,
): Promise<UsageSnapshot[]> {
  return db
    .select()
    .from(usageSnapshots)
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}

export async function markSoftCapWarned(
  db: Db,
  projectId: string,
  meterKey: BillingMeterKey,
  periodStart: Date,
): Promise<void> {
  await db
    .update(usageSnapshots)
    .set({ softCapWarnedAt: new Date() })
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.meterKey, meterKey),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}

export async function markHardCapWarned(
  db: Db,
  projectId: string,
  meterKey: BillingMeterKey,
  periodStart: Date,
): Promise<void> {
  await db
    .update(usageSnapshots)
    .set({ hardCapWarnedAt: new Date() })
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.meterKey, meterKey),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}
```

Note: `NewUsageSnapshot` is exported from `schema.ts` already (Task 2).

- [ ] **Step 4: Re-export from barrel**

Add `export * as usageSnapshotsRepo from "./usage-snapshots";` to
`repositories/index.ts`.

- [ ] **Step 5: Run + pass**

```bash
pnpm --filter @rovenue/api test usage-snapshots-repo
```

Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/usage-snapshots.ts \
        packages/db/src/drizzle/repositories/index.ts \
        apps/api/tests/usage-snapshots-repo.test.ts
git commit -m "feat(db/billing): usage_snapshots repository (upsert, list, cap-warn flags)"
```

---

## Task 10: Project-create hook — create a Free billing row

**Files:**
- Create: `apps/api/src/services/billing/create-free-subscription.ts`
- Modify: `apps/api/src/routes/dashboard/projects.ts` (the `.post("/", ...)`
  handler at lines 251–280)
- Test: `apps/api/tests/billing-project-create-hook.test.ts`

The existing handler already runs in a Drizzle transaction
(`await drizzle.db.transaction(async (tx) => {...}`). We add one line
inside that transaction so the billing row is part of the same atomic
write — if anything fails, the project never exists either.

- [ ] **Step 1: Open the existing handler to confirm the tx boundary**

Read `apps/api/src/routes/dashboard/projects.ts` lines 251–280 and
locate the line:
```
const createdProject = await drizzle.projectRepo.createProject(tx, { ... });
```

The new call goes immediately after `createProjectMember(tx, {...})` and
before the transaction returns.

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/billing-project-create-hook.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingSubscriptions,
  projects,
} from "../../packages/db/src/drizzle/schema";
import { createFreeSubscription } from "../src/services/billing/create-free-subscription";

const PID = "proj_test_hook";

async function cleanup() {
  await db
    .delete(billingSubscriptions)
    .where(eq(billingSubscriptions.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
}

describe("createFreeSubscription service", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("inserts a free row for a project inside a transaction", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: PID,
        slug: "test-hook",
        name: "Test Hook",
        ownerId: "usr_demo",
      });
      await createFreeSubscription(tx, PID);
    });
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.projectId, PID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("free");
    expect(rows[0]!.tier).toBe("free");
  });

  it("rolls back when the transaction fails", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(projects).values({
          id: PID,
          slug: "test-hook-rollback",
          name: "Test Hook Rollback",
          ownerId: "usr_demo",
        });
        await createFreeSubscription(tx, PID);
        throw new Error("simulated downstream failure");
      }),
    ).rejects.toThrow("simulated downstream failure");
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.projectId, PID));
    expect(rows).toHaveLength(0);
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, PID));
    expect(projectRows).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test billing-project-create-hook
```

Expected: 2 failures, `Cannot find module .../create-free-subscription`.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/billing/create-free-subscription.ts`:

```ts
import { drizzle } from "@rovenue/db";

// Wrapper around the repository so callers don't need to import the repo
// directly. Keeps the API surface narrow: the only Phase-1 entrypoint for
// creating a billing row is this service.

export async function createFreeSubscription(
  tx: Parameters<typeof drizzle.billingSubscriptionsRepo.createFreeBillingSubscription>[0],
  projectId: string,
) {
  return drizzle.billingSubscriptionsRepo.createFreeBillingSubscription(
    tx,
    projectId,
  );
}
```

(`drizzle` is the existing namespace export from `@rovenue/db` — check
`packages/db/src/index.ts` and follow the same pattern other services
use to access repositories.)

- [ ] **Step 5: Wire the hook into projects.ts**

In `apps/api/src/routes/dashboard/projects.ts`, immediately after the
`createProjectMember` call inside the `db.transaction(async (tx) => {...})`
block, add:

```ts
import { createFreeSubscription } from "../../services/billing/create-free-subscription";
// ...
await createFreeSubscription(tx, createdProject.id);
```

- [ ] **Step 6: Run the test + integration test for project create**

```bash
pnpm --filter @rovenue/api test billing-project-create-hook
pnpm --filter @rovenue/api test dashboard-routes -- -t "create.*project"
```

Expected: hook test PASS; existing dashboard-routes "create project"
test PASS (we didn't regress — but it now also leaves a billing row).
If the existing test asserts the project's response body, no shape
change is required; the billing row is a side effect not surfaced in
the API response yet.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/billing/create-free-subscription.ts \
        apps/api/src/routes/dashboard/projects.ts \
        apps/api/tests/billing-project-create-hook.test.ts
git commit -m "feat(api/billing): create free billing_subscriptions row on project create"
```

---

## Task 11: Backfill migration for existing projects

**Files:**
- Create: `packages/db/drizzle/migrations/0042_billing_backfill.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (manual)
- Test: `apps/api/tests/billing-backfill-migration.integration.test.ts`

drizzle-kit doesn't generate data-migrations, so we write this SQL by
hand. The migration inserts a `state='free'` row for every project that
doesn't already have one. It is idempotent — re-running it is a no-op.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/billing-backfill-migration.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer } from "testcontainers";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "../../packages/db/drizzle/migrations",
);

describe("backfill migration 0042", () => {
  let pool: Pool;
  let container: Awaited<ReturnType<typeof GenericContainer.prototype.start>>;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_PASSWORD: "test",
        POSTGRES_USER: "test",
        POSTGRES_DB: "test",
      })
      .withExposedPorts(5432)
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "test",
    });

    // Apply all migrations *up to and including* 0040 (pre-billing world)
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^00[0-3][0-9]_/.test(f) && f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      await pool.query(sql);
    }

    // Seed 3 legacy projects (pre-billing world)
    await pool.query(`
      INSERT INTO "user" (id, name, email, "createdAt", "updatedAt", "emailVerified")
      VALUES ('usr_legacy', 'Legacy', 'legacy@test.dev', NOW(), NOW(), true);
      INSERT INTO projects (id, slug, name, "ownerId", "createdAt", "updatedAt")
      VALUES
        ('proj_a', 'a', 'A', 'usr_legacy', NOW(), NOW()),
        ('proj_b', 'b', 'B', 'usr_legacy', NOW(), NOW()),
        ('proj_c', 'c', 'C', 'usr_legacy', NOW(), NOW());
    `);

    // Apply 0041 (creates tables) then 0042 (backfill)
    const m41 = readFileSync(
      join(MIGRATIONS_DIR, "0041_billing_tables.sql"),
      "utf-8",
    );
    await pool.query(m41);
    const m42 = readFileSync(
      join(MIGRATIONS_DIR, "0042_billing_backfill.sql"),
      "utf-8",
    );
    await pool.query(m42);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("creates one billing_subscriptions row per pre-existing project", async () => {
    const { rows } = await pool.query<{
      project_id: string;
      state: string;
      tier: string;
    }>(`
      SELECT project_id, state, tier
      FROM billing_subscriptions
      ORDER BY project_id;
    `);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.project_id)).toEqual([
      "proj_a",
      "proj_b",
      "proj_c",
    ]);
    rows.forEach((r) => {
      expect(r.state).toBe("free");
      expect(r.tier).toBe("free");
    });
  });

  it("is idempotent — re-running 0042 produces no duplicates", async () => {
    const m42 = readFileSync(
      join(MIGRATIONS_DIR, "0042_billing_backfill.sql"),
      "utf-8",
    );
    await pool.query(m42);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM billing_subscriptions",
    );
    expect(rows[0].n).toBe(3);
  });
});
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test billing-backfill-migration -- --testTimeout=60000
```

Expected: failure, `ENOENT: no such file ... 0042_billing_backfill.sql`.

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/migrations/0042_billing_backfill.sql`:

```sql
-- Backfill billing_subscriptions for any project that doesn't yet have an
-- active row. Idempotent — uses the partial unique index
-- billing_subscriptions_project_active_uq to short-circuit duplicates.

INSERT INTO billing_subscriptions (
    project_id,
    state,
    tier,
    cycle
)
SELECT
    p.id,
    'free',
    'free',
    'monthly'
FROM projects p
WHERE NOT EXISTS (
    SELECT 1
    FROM billing_subscriptions bs
    WHERE bs.project_id = p.id AND bs.state != 'deleted'
);
```

- [ ] **Step 4: Register the migration in the journal**

Open `packages/db/drizzle/migrations/meta/_journal.json` and append a new
entry mirroring the format of the previous one (look at the 0041 entry).
A typical entry is:

```json
{
  "idx": 42,
  "version": "7",
  "when": <unix-ms-timestamp>,
  "tag": "0042_billing_backfill",
  "breakpoints": true
}
```

(Use the current Unix-ms for `when`. The exact format is whatever
drizzle-kit produced for the 0041 row.)

- [ ] **Step 5: Run + confirm pass**

```bash
pnpm --filter @rovenue/api test billing-backfill-migration -- --testTimeout=60000
```

Expected: 2 PASS. The integration test takes ~30s (container boot).

- [ ] **Step 6: Apply against the dev DB**

```bash
pnpm db:migrate
```

Expected: `Migration 0042_billing_backfill.sql applied`. Verify with:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM projects;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM billing_subscriptions;"
```

Both counts must match.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/migrations/0042_billing_backfill.sql \
        packages/db/drizzle/migrations/meta/_journal.json \
        apps/api/tests/billing-backfill-migration.integration.test.ts
git commit -m "feat(db/migration): 0042 — backfill billing_subscriptions for existing projects"
```

---

## Task 12: Billing env vars

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`
- Test: `apps/api/src/lib/capabilities.test.ts` (existing) +
  `apps/api/tests/billing-env.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-env.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";

// We re-import env in each test so the Zod schema re-runs against a
// freshly-mutated process.env. Vitest doesn't reset module state by
// default — vi.resetModules() forces a fresh evaluation.

describe("billing env vars", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("BILLING_ENABLED defaults to false", async () => {
    delete process.env.BILLING_ENABLED;
    const { env } = await import("../src/lib/env");
    expect(env.BILLING_ENABLED).toBe(false);
  });

  it("BILLING_ENABLED parses 'true'", async () => {
    process.env.BILLING_ENABLED = "true";
    const { env } = await import("../src/lib/env");
    expect(env.BILLING_ENABLED).toBe(true);
  });

  it("STRIPE_BILLING_SECRET_KEY is optional in dev", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.STRIPE_BILLING_SECRET_KEY;
    const { env } = await import("../src/lib/env");
    expect(env.STRIPE_BILLING_SECRET_KEY).toBeUndefined();
  });

  it("STRIPE_BILLING_SECRET_KEY is required when BILLING_ENABLED=true in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.BILLING_ENABLED = "true";
    delete process.env.STRIPE_BILLING_SECRET_KEY;
    await expect(import("../src/lib/env")).rejects.toThrow(
      /STRIPE_BILLING_SECRET_KEY/,
    );
  });
});
```

The test uses dynamic imports + `vi.resetModules` semantics. If the
existing `env.ts` uses a singleton pattern that caches across requires,
mark these tests with `import.meta.vitest` and ensure `vi.resetModules()`
runs in `beforeEach`. Add the import at the top of the test file:

```ts
import { vi } from "vitest";
// inside beforeEach:
vi.resetModules();
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test billing-env
```

Expected: 4 failures, env exports don't include `BILLING_ENABLED`.

- [ ] **Step 3: Extend env.ts**

In `apps/api/src/lib/env.ts`, inside the `envSchema = z.object({...})`
block (next to other booleans), add:

```ts
    BILLING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    STRIPE_BILLING_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_BILLING_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_BILLING_PUBLISHABLE_KEY: z.string().min(1).optional(),
```

Inside the existing `.superRefine((data, ctx) => { ... })` block, after
the `if (data.NODE_ENV !== "production") return;` line, add:

```ts
    if (data.BILLING_ENABLED) {
      require(
        data.STRIPE_BILLING_SECRET_KEY,
        "STRIPE_BILLING_SECRET_KEY",
        "BILLING_ENABLED=true requires a Stripe secret key in production",
      );
      require(
        data.STRIPE_BILLING_WEBHOOK_SECRET,
        "STRIPE_BILLING_WEBHOOK_SECRET",
        "BILLING_ENABLED=true requires a Stripe webhook secret in production",
      );
    }
```

(`require` is the helper defined inside the existing `superRefine` block.)

- [ ] **Step 4: Update .env.example**

Append to `.env.example`:

```
# ---- Billing (Rovenue platform billing — separate Stripe account from
#       customer-subscription Stripe in /webhooks/stripe/*).
#
# When BILLING_ENABLED=false (default), the /billing/* routes return 404
# and no Stripe customer is created for upgrade attempts. Self-host
# deployments leave this off.
BILLING_ENABLED=false
STRIPE_BILLING_SECRET_KEY=
STRIPE_BILLING_WEBHOOK_SECRET=
STRIPE_BILLING_PUBLISHABLE_KEY=
```

- [ ] **Step 5: Run + pass**

```bash
pnpm --filter @rovenue/api test billing-env
```

Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/env.ts .env.example \
        apps/api/tests/billing-env.test.ts
git commit -m "feat(api/billing): BILLING_ENABLED + STRIPE_BILLING_* env vars"
```

---

## Task 13: Platform-Stripe client

**Files:**
- Create: `apps/api/src/lib/stripe-billing.ts`
- Create: `apps/api/src/lib/billing-flags.ts`
- Test: `apps/api/tests/stripe-billing-client.test.ts`

The existing `apps/api/src/services/stripe/*` constructs a Stripe SDK
instance for **customer** subscriptions (the customer's Stripe webhook
handler). The platform Stripe is a different Stripe account with
different keys; we build a separate client.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/stripe-billing-client.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("stripe-billing client", () => {
  const original = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("getPlatformStripe returns a Stripe instance when BILLING_ENABLED and secret set", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake_123";
    const mod = await import("../src/lib/stripe-billing");
    const stripe = mod.getPlatformStripe();
    expect(stripe).toBeDefined();
    expect(typeof stripe!.customers.create).toBe("function");
  });

  it("getPlatformStripe returns null when BILLING_ENABLED=false", async () => {
    process.env.BILLING_ENABLED = "false";
    const mod = await import("../src/lib/stripe-billing");
    expect(mod.getPlatformStripe()).toBeNull();
  });

  it("isBillingEnabled mirrors env", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    const mod = await import("../src/lib/billing-flags");
    expect(mod.isBillingEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test stripe-billing-client
```

Expected: 3 failures.

- [ ] **Step 3: Implement billing-flags**

Create `apps/api/src/lib/billing-flags.ts`:

```ts
import { env } from "./env";

// Single source of truth for whether the platform-billing surface is
// active. Read at runtime so test fixtures that mutate env take effect.
export function isBillingEnabled(): boolean {
  return env.BILLING_ENABLED === true;
}
```

- [ ] **Step 4: Implement stripe-billing**

Create `apps/api/src/lib/stripe-billing.ts`:

```ts
import Stripe from "stripe";
import { env } from "./env";
import { isBillingEnabled } from "./billing-flags";
import { logger } from "./logger";

// =============================================================
// Platform-Stripe client (Rovenue's own billing)
// =============================================================
//
// Separate Stripe SDK instance from apps/api/src/services/stripe/* —
// that one talks to the **customer's** Stripe (their app users'
// subscriptions). This one talks to Rovenue's own Stripe account
// (the one we charge customers for using the cloud).
//
// Returns null when BILLING_ENABLED=false so callers can early-return
// without throwing. Self-host installs always see null.

const log = logger.child("stripe-billing");

let cached: Stripe | null = null;

export function getPlatformStripe(): Stripe | null {
  if (!isBillingEnabled()) return null;
  if (!env.STRIPE_BILLING_SECRET_KEY) {
    log.warn(
      "BILLING_ENABLED=true but STRIPE_BILLING_SECRET_KEY is missing — billing is inert",
    );
    return null;
  }
  if (cached) return cached;
  cached = new Stripe(env.STRIPE_BILLING_SECRET_KEY, {
    apiVersion: "2024-12-18.acacia",
    typescript: true,
    appInfo: { name: "rovenue-platform-billing", version: "0.1.0" },
  });
  return cached;
}

// Test-only — clears the cached client so subsequent calls re-read env.
// Vitest fixtures call this between cases.
export function _resetPlatformStripeForTests(): void {
  cached = null;
}
```

- [ ] **Step 5: Run + pass**

```bash
pnpm --filter @rovenue/api test stripe-billing-client
```

Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/stripe-billing.ts apps/api/src/lib/billing-flags.ts \
        apps/api/tests/stripe-billing-client.test.ts
git commit -m "feat(api/billing): platform Stripe client + isBillingEnabled flag"
```

---

## Task 14: Stripe webhook receiver (sig-verify + log only)

**Files:**
- Create: `apps/api/src/routes/billing/index.ts`
- Create: `apps/api/src/routes/billing/webhook.ts`
- Modify: `apps/api/src/routes/index.ts` (re-export)
- Test: `apps/api/tests/billing-stripe-webhook.test.ts`

Phase 1 scope: route accepts the POST, verifies the Stripe signature
using `STRIPE_BILLING_WEBHOOK_SECRET`, logs the event type, returns
`200 { received: true }`. No state mutation — that's Phase 2+.

When `BILLING_ENABLED=false`, the route returns `404` (the router is
mounted but every handler short-circuits).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/billing-stripe-webhook.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import Stripe from "stripe";

describe("POST /billing/stripe/webhook", () => {
  const original = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  function signEvent(
    payload: string,
    secret: string,
    timestamp: number,
  ): string {
    return Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp,
    });
  }

  it("returns 404 when BILLING_ENABLED=false", async () => {
    process.env.BILLING_ENABLED = "false";
    const app = await buildApp();
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "x" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the Stripe signature is invalid", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_test_secret";
    const app = await buildApp();
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with received:true for a valid signed event", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_test_secret";
    const app = await buildApp();
    const payload = JSON.stringify({
      id: "evt_test_1",
      type: "invoice.paid",
      data: { object: { id: "in_test" } },
      api_version: "2024-12-18.acacia",
      created: Math.floor(Date.now() / 1000),
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent(payload, "whsec_test_secret", ts);
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": sig, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; eventType: string };
    expect(json.received).toBe(true);
    expect(json.eventType).toBe("invoice.paid");
  });
});
```

- [ ] **Step 2: Run + confirm failure**

```bash
pnpm --filter @rovenue/api test billing-stripe-webhook
```

Expected: 3 failures (route doesn't exist → all return 404, but the
"valid" test expects 200).

- [ ] **Step 3: Implement the webhook handler**

Create `apps/api/src/routes/billing/webhook.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";
import { isBillingEnabled } from "../../lib/billing-flags";
import { logger } from "../../lib/logger";

const log = logger.child("billing:webhook");

// =============================================================
// /billing/stripe/webhook
// =============================================================
//
// Phase 1: signature verification + audit log only. No state writes.
// Phase 2 swaps the no-op handler body for the real reducer.
//
// Verification uses Stripe's HMAC scheme via stripe.webhooks
// .constructEvent — keeps us compatible with future apiVersion bumps.
// Rejects:
//   - billing disabled              → 404
//   - missing stripe-signature      → 400
//   - signature verification fails  → 400
//   - replay-tolerance exceeded     → 400 (handled inside constructEvent)

export const billingWebhookRoute = new Hono().post("/", async (c) => {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  const stripe = getPlatformStripe();
  if (!stripe || !env.STRIPE_BILLING_WEBHOOK_SECRET) {
    log.error("BILLING_ENABLED=true but Stripe client/secret unavailable");
    throw new HTTPException(503, { message: "Billing not configured" });
  }

  const sig = c.req.header("stripe-signature");
  if (!sig) {
    throw new HTTPException(400, { message: "Missing stripe-signature" });
  }

  // We need the raw bytes; Hono's c.req.text() returns the body string
  // before any JSON parsing, which is what constructEvent expects.
  const raw = await c.req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      sig,
      env.STRIPE_BILLING_WEBHOOK_SECRET,
    );
  } catch (err) {
    log.warn("stripe webhook signature verification failed", {
      err: (err as Error).message,
    });
    throw new HTTPException(400, { message: "Invalid signature" });
  }

  log.info("billing webhook received", {
    eventId: event.id,
    eventType: event.type,
    apiVersion: event.api_version,
  });

  return c.json({ received: true, eventType: event.type }, 200);
});
```

- [ ] **Step 4: Build the billing router**

Create `apps/api/src/routes/billing/index.ts`:

```ts
import { Hono } from "hono";
import { billingWebhookRoute } from "./webhook";

// =============================================================
// /billing route tree
// =============================================================
//
// Phase 1: only /billing/stripe/webhook is live. The platform Stripe
// webhook is mounted at /billing/stripe/webhook (not /webhooks/stripe
// — that path is for the *customer's* Stripe account). Keeping the
// paths distinct prevents accidental cross-pollination of secrets.

export const billingRoute = new Hono().route(
  "/stripe/webhook",
  billingWebhookRoute,
);
```

- [ ] **Step 5: Re-export from the top-level routes barrel**

In `apps/api/src/routes/index.ts`, add:

```ts
export { billingRoute } from "./billing";
```

- [ ] **Step 6: Mount in app.ts**

In `apps/api/src/app.ts`, near the other `.route()` calls on the chained
expression, add:

```ts
    .route("/billing", billingRoute)
```

And add `billingRoute` to the existing import from `./routes`:

```ts
import {
  authRoute,
  billingRoute,
  dashboardRoute,
  healthRoute,
  v1Route,
  webhooksRoute,
} from "./routes";
```

- [ ] **Step 7: Run + pass**

```bash
pnpm --filter @rovenue/api test billing-stripe-webhook
```

Expected: 3 PASS.

- [ ] **Step 8: Smoke-test the route locally**

```bash
BILLING_ENABLED=true \
STRIPE_BILLING_SECRET_KEY=sk_test_fake \
STRIPE_BILLING_WEBHOOK_SECRET=whsec_test_secret \
pnpm --filter @rovenue/api dev &
sleep 3
curl -i -X POST http://localhost:3000/billing/stripe/webhook \
  -H "content-type: application/json" \
  -H "stripe-signature: t=$(date +%s),v1=deadbeef" \
  -d '{}'
```

Expected: `400 Invalid signature` (the signature is fake but the route
is reachable). Then kill the dev server.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/billing/index.ts \
        apps/api/src/routes/billing/webhook.ts \
        apps/api/src/routes/index.ts \
        apps/api/src/app.ts \
        apps/api/tests/billing-stripe-webhook.test.ts
git commit -m "feat(api/billing): /billing/stripe/webhook (signature verify + log only, Phase 1)"
```

---

## Task 15: Run the whole suite + close the phase

**Files:** none new — verification only.

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: every existing test still passes; new billing tests all
green.

- [ ] **Step 2: Run typecheck across the workspace**

```bash
pnpm build
```

Expected: success, no TS errors anywhere in the monorepo.

- [ ] **Step 3: Verify the project-create flow end-to-end**

Boot a clean dev DB:

```bash
docker compose down -v
docker compose up -d db redis
pnpm db:migrate
pnpm db:seed
```

Hit the dashboard's "Create project" endpoint (via the existing
dashboard E2E test or the seed script's helper). After it runs:

```bash
psql "$DATABASE_URL" -c "SELECT project_id, state, tier FROM billing_subscriptions;"
```

Expected: one row per project, all `(free, free)`.

- [ ] **Step 4: Tag the phase**

```bash
git tag billing-phase-1-complete
```

(Or open a PR — see Execution Handoff below.)

---

## Self-Review Notes

After all 15 tasks land, this plan delivers exactly what the Phase 1
section of the spec promises:

| Spec line | Task |
|---|---|
| "New tables" | Tasks 1, 2, 3 |
| "no charges" | Tasks 13, 14 (Stripe client is null when disabled) |
| "every project gets a state='free' row on creation" | Task 10 |
| "Backfill migration for existing projects" | Task 11 |
| "Webhook endpoint accepts events but only logs" | Task 14 |
| `BILLING_ENABLED` flag | Tasks 12, 13, 14 |

No Phase 2+ work leaks in: there is no upgrade endpoint, no Stripe
customer creation, no metering pipeline, no UI changes, no paywall, no
dunning. Each of those is a separate plan.
