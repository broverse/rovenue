# Billing — Phase 2: Upgrade Flow + Invoice Mirror

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first cloud-billing money path: a project OWNER/ADMIN clicks
"Upgrade" in the dashboard, completes Stripe Elements with a test card, the
project flips `billing_subscriptions.state='active'` on the lowest paid tier
(Indie / monthly), and every subsequent Stripe lifecycle event (subscription
create / update, invoice create / finalize / payment_succeeded, charge.refunded,
payment_method.detached) mirrors into the Phase-1 tables.

**Architecture:** The Phase-1 webhook receiver currently logs and returns 200.
Phase 2 replaces the no-op body with a typed dispatch table that resolves the
project by `customer.id`, dedupes via `webhook_events`, and calls one handler
per event type inside a Drizzle transaction (write + audit + outbox commit
together). A new sub-router `apps/api/src/routes/dashboard/billing/` exposes
the four endpoints the dashboard needs (summary, upgrade, payment-methods CRUD,
invoices list). The dashboard adds three project-scoped settings pages — the
existing `account/billing.tsx` and `account/invoices.tsx` mocks are deleted
because per-account billing has no meaning in a project-scoped model.

Phase 2 only ships **Indie / monthly** as the upgrade target. The bracket
evaluator (P4) is what later moves a project to Pro / Scale / Growth at cycle
end based on MTR; without `usage_snapshots` (P3) we cannot yet derive a tier
from MTR, so every Free→Paid transition starts at Indie. The upgrade endpoint
accepts a `cycle` field but Zod-rejects anything other than `"monthly"` —
removing that single check is the only blocker to annual support, which P6
ships alongside the cycle-switch endpoint. Dunning / paywall / suspension all
remain P5; `invoice.payment_failed` is logged-only in this phase.

**Tech Stack:** Hono + Zod, Drizzle ORM (Postgres 16), Stripe Node SDK 15
(platform client introduced in Phase 1), `@stripe/stripe-js` +
`@stripe/react-stripe-js` (new dashboard deps), TanStack Router + Query,
Vitest + testcontainers.

---

## File Structure

### Created

**API — shared types:**
- `packages/shared/src/billing.ts` — `BillingSummary`, `PaymentMethodSummary`,
  `InvoiceSummary`, `UpgradeResponse` wire types
- `packages/shared/src/index.ts` — **modified**: re-export billing types

**API — db layer additions:**
- `packages/db/src/drizzle/repositories/billing-subscriptions.ts` —
  **modified**: add `findBySubscriptionId`, `findByStripeCustomerId`,
  `updateAfterStripeCreated`, `updateAfterStripeUpdated`,
  `setStripeCustomerId`
- `packages/db/src/drizzle/repositories/billing-payment-methods.ts` —
  **modified**: add `findByStripePaymentMethodId`,
  `deleteByStripePaymentMethodId`
- `packages/db/src/drizzle/repositories/billing-invoices.ts` — already has
  `upsertInvoiceFromStripe`, `incrementRefundedAmount`; no changes
- `packages/db/src/drizzle/repositories/billing-tier-limits.ts` — **new**;
  `findByTierAndCycle`, returns the `stripe_price_id` for a `(tier, cycle)`
  pair
- `packages/db/src/drizzle/index.ts` — **modified**: re-export
  `billingTierLimitsRepo`
- `packages/db/src/drizzle/enums.ts` — **modified**: append `"BILLING"` to
  `aggregateTypeEnum`
- `packages/db/drizzle/migrations/0043_aggregate_type_billing.sql` —
  generated; `ALTER TYPE aggregate_type ADD VALUE 'BILLING'`
- `packages/db/seed.ts` — **modified**: set real test-mode `stripe_price_id`
  values from `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` (env, dev only) so the
  seeded tier-limits row matches what the upgrade flow looks up

**API — services + webhook handlers:**
- `apps/api/src/services/billing/billing-summary.ts` — builds
  `BillingSummary` wire payload for a project
- `apps/api/src/services/billing/upgrade-project.ts` — orchestrates
  customer create + SetupIntent for the **upgrade-from-free** path
- `apps/api/src/services/billing/add-payment-method.ts` — orchestrates
  SetupIntent for the **add-card-while-active** path
- `apps/api/src/services/billing/billing-events.ts` — outbox publishers
  (`publishBillingActivated`, `publishBillingPaymentMethodAdded`,
  `publishBillingInvoicePaid`)
- `apps/api/src/services/billing/webhook-handlers/index.ts` — dispatcher
  exporting a `Map<eventType, handler>`
- `apps/api/src/services/billing/webhook-handlers/handle-setup-intent-succeeded.ts`
- `apps/api/src/services/billing/webhook-handlers/handle-subscription-created.ts`
- `apps/api/src/services/billing/webhook-handlers/handle-subscription-updated.ts`
- `apps/api/src/services/billing/webhook-handlers/handle-invoice-upsert.ts`
  (handles `invoice.created`, `invoice.finalized`, `invoice.updated`)
- `apps/api/src/services/billing/webhook-handlers/handle-invoice-payment-succeeded.ts`
- `apps/api/src/services/billing/webhook-handlers/handle-charge-refunded.ts`
- `apps/api/src/services/billing/webhook-handlers/handle-payment-method-detached.ts`

**API — dashboard endpoints:**
- `apps/api/src/routes/dashboard/billing/index.ts` — sub-router; mounts the
  four billing handlers
- `apps/api/src/routes/dashboard/billing/summary.ts`
- `apps/api/src/routes/dashboard/billing/upgrade.ts`
- `apps/api/src/routes/dashboard/billing/payment-methods.ts`
- `apps/api/src/routes/dashboard/billing/invoices.ts`
- `apps/api/src/routes/dashboard/index.ts` — **modified**: mount
  `/projects/:projectId/billing` → billing sub-router
- `apps/api/src/routes/billing/webhook.ts` — **modified**: swap the no-op
  body for the dispatcher

**API — env:**
- `apps/api/src/lib/env.ts` — **modified**: optional
  `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` (required at runtime when
  `BILLING_ENABLED=true`)
- `.env.example` — **modified**

**API — tests:**
- `apps/api/tests/billing-summary-service.test.ts` (unit)
- `apps/api/tests/billing-upgrade-route.test.ts` (unit, Stripe mocked)
- `apps/api/tests/billing-payment-methods-route.test.ts` (unit)
- `apps/api/tests/billing-invoices-route.test.ts` (unit)
- `apps/api/tests/billing-webhook-dispatch.test.ts` (unit, dispatcher)
- `apps/api/tests/billing-webhook-handlers.integration.test.ts` —
  testcontainers; replays Stripe fixture events end-to-end
- `apps/api/tests/fixtures/stripe-webhooks/setup_intent.succeeded.json`
- `apps/api/tests/fixtures/stripe-webhooks/customer.subscription.created.json`
- `apps/api/tests/fixtures/stripe-webhooks/customer.subscription.updated.json`
- `apps/api/tests/fixtures/stripe-webhooks/invoice.created.json`
- `apps/api/tests/fixtures/stripe-webhooks/invoice.finalized.json`
- `apps/api/tests/fixtures/stripe-webhooks/invoice.payment_succeeded.json`
- `apps/api/tests/fixtures/stripe-webhooks/charge.refunded.json`
- `apps/api/tests/fixtures/stripe-webhooks/payment_method.detached.json`

**Dashboard:**
- `apps/dashboard/package.json` — **modified**: add
  `@stripe/stripe-js` ^4, `@stripe/react-stripe-js` ^3
- `apps/dashboard/src/lib/api-billing.ts` — typed wrappers over `rpc` for
  the four endpoints (mirrors `lib/audit-format.ts` / `dashboard-mappers.ts`
  style)
- `apps/dashboard/src/hooks/useBillingSummary.ts`
- `apps/dashboard/src/hooks/useInvoices.ts`
- `apps/dashboard/src/hooks/usePaymentMethods.ts`
- `apps/dashboard/src/hooks/useUpgradeMutation.ts`
- `apps/dashboard/src/components/billing/index.ts` — barrel
- `apps/dashboard/src/components/billing/plan-card.tsx` — copied from
  `components/account/plan-card.tsx` (mock visual kept)
- `apps/dashboard/src/components/billing/payment-method-row.tsx` —
  copied from `components/account/payment-method-row.tsx`
- `apps/dashboard/src/components/billing/invoice-status-chip.tsx` — copied
  from `components/account/invoice-status-chip.tsx`
- `apps/dashboard/src/components/billing/upgrade-modal.tsx` — new; hosts
  `<Elements>` + `<PaymentElement>` + confirmSetup flow
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/billing.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/payment-methods.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/invoices.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/route.tsx`
  — **modified**: add three nav items
- `apps/dashboard/src/routes/_authed/account/billing.tsx` — **deleted**
- `apps/dashboard/src/routes/_authed/account/invoices.tsx` — **deleted**
- `apps/dashboard/src/components/account/account-nav-config.ts` —
  **modified**: drop the `billing` and `invoices` entries
- `apps/dashboard/src/components/account/index.ts` — **modified**: drop the
  `PlanCard`, `PaymentMethodRow`, `InvoiceStatusChip` re-exports (the
  mocks now live under `components/billing/`); existing callers in the
  remaining `account/*` pages get switched to inline placeholders or
  removed

### Responsibility boundaries

- **Webhook handlers** are pure functions of `(stripe: Stripe, db: Db, event:
  Stripe.Event)`. The dispatcher in `webhook.ts` resolves the project, calls
  `upsertWebhookEvent(STRIPE, event.id)` for idempotency, runs the handler
  inside a Drizzle tx, then marks the row PROCESSED. No handler opens its
  own outer tx.
- **Service files** (`upgrade-project.ts`, `add-payment-method.ts`) only own
  the Stripe-API-side concerns (customer creation, SetupIntent issuance,
  later `subscriptions.create`). They never write domain state; that's the
  webhook handler's job once Stripe confirms.
- **Repository methods** stay thin: one SQL statement each, no business
  logic. The handler composes them.

---

## Task 1: Append `BILLING` to `aggregate_type` enum

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Create: `packages/db/drizzle/migrations/0043_aggregate_type_billing.sql`
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Read the existing enum block**

Read `packages/db/src/drizzle/enums.ts` around line 124 (`aggregateTypeEnum`)
so the new value matches surrounding capitalisation and ordering.

- [ ] **Step 2: Append `"BILLING"` to the enum**

```ts
export const aggregateTypeEnum = pgEnum("aggregate_type", [
  "EXPOSURE",
  "REVENUE_EVENT",
  "CREDIT_LEDGER",
  "BILLING",
]);
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:migrate:generate`
Expected: a new file `packages/db/drizzle/migrations/0043_*.sql` containing
`ALTER TYPE "public"."aggregate_type" ADD VALUE 'BILLING';`. Rename the
generated file to `0043_aggregate_type_billing.sql` if drizzle-kit picked a
random suffix. If drizzle-kit instead produces a no-op or fails to detect
the enum change, hand-write the migration containing the single statement
above.

- [ ] **Step 4: Add a smoke test in the foundation suite**

Open `packages/db/src/drizzle/drizzle-foundation.test.ts` and add:

```ts
it("aggregate_type includes BILLING", () => {
  expect(aggregateTypeEnum.enumValues).toContain("BILLING");
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @rovenue/db test -- drizzle-foundation`
Expected: PASS including the new assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/enums.ts \
        packages/db/drizzle/migrations/0043_aggregate_type_billing.sql \
        packages/db/src/drizzle/drizzle-foundation.test.ts
git commit -m "feat(db/billing): add BILLING aggregate_type for outbox events"
```

---

## Task 2: Add Stripe-side lookup methods on `billing_subscriptions`

**Files:**
- Modify: `packages/db/src/drizzle/repositories/billing-subscriptions.ts`
- Test: `packages/db/src/drizzle/repositories/billing-subscriptions.test.ts`
  (new file)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFreeBillingSubscription,
  findBillingSubscriptionByProject,
  findBySubscriptionId,
  findByStripeCustomerId,
  setStripeCustomerId,
  updateAfterStripeCreated,
  updateAfterStripeUpdated,
} from "./billing-subscriptions";
import { setupTestDb, teardownTestDb, withProject } from "../../../test/db-harness";

describe("billing-subscriptions repo (Phase 2 additions)", () => {
  beforeEach(setupTestDb);
  afterAll(teardownTestDb);

  it("setStripeCustomerId mutates customer id only", async () => {
    const { db, projectId } = await withProject();
    await createFreeBillingSubscription(db, projectId);
    await setStripeCustomerId(db, projectId, "cus_test_123");
    const row = await findBillingSubscriptionByProject(db, projectId);
    expect(row?.stripeCustomerId).toBe("cus_test_123");
    expect(row?.state).toBe("free");
  });

  it("findByStripeCustomerId returns the project's row", async () => {
    const { db, projectId } = await withProject();
    await createFreeBillingSubscription(db, projectId);
    await setStripeCustomerId(db, projectId, "cus_lookup");
    const row = await findByStripeCustomerId(db, "cus_lookup");
    expect(row?.projectId).toBe(projectId);
  });

  it("updateAfterStripeCreated flips state to active and stamps period", async () => {
    const { db, projectId } = await withProject();
    await createFreeBillingSubscription(db, projectId);
    await setStripeCustomerId(db, projectId, "cus_x");
    const periodStart = new Date("2026-06-01T00:00:00Z");
    const periodEnd = new Date("2026-07-01T00:00:00Z");
    await updateAfterStripeCreated(db, projectId, {
      stripeSubscriptionId: "sub_x",
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    const row = await findBillingSubscriptionByProject(db, projectId);
    expect(row?.state).toBe("active");
    expect(row?.stripeSubscriptionId).toBe("sub_x");
    expect(row?.tier).toBe("indie");
    expect(row?.currentPeriodStart?.toISOString()).toBe(periodStart.toISOString());
  });

  it("findBySubscriptionId returns null when missing", async () => {
    const { db } = await withProject();
    expect(await findBySubscriptionId(db, "sub_nope")).toBeNull();
  });

  it("updateAfterStripeUpdated patches period fields without touching state", async () => {
    const { db, projectId } = await withProject();
    await createFreeBillingSubscription(db, projectId);
    await setStripeCustomerId(db, projectId, "cus_y");
    await updateAfterStripeCreated(db, projectId, {
      stripeSubscriptionId: "sub_y",
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    });
    await updateAfterStripeUpdated(db, "sub_y", {
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    });
    const row = await findBillingSubscriptionByProject(db, projectId);
    expect(row?.currentPeriodStart?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});
```

Note: if `test/db-harness.ts` (or equivalent) does not yet exist for this
package, use the pattern from `packages/db/src/drizzle/repositories/credit-ledger.test.ts`
verbatim — same package already runs in-process Postgres-on-tmpfs via the
existing test harness. Match that file's `beforeEach` import path.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @rovenue/db test -- billing-subscriptions`
Expected: FAIL on `setStripeCustomerId` not defined (and the other names).

- [ ] **Step 3: Implement the new methods**

Append to `packages/db/src/drizzle/repositories/billing-subscriptions.ts`:

```ts
import { eq } from "drizzle-orm";

export async function setStripeCustomerId(
  db: Db,
  projectId: string,
  stripeCustomerId: string,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({ stripeCustomerId, updatedAt: new Date() })
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    );
}

export async function findByStripeCustomerId(
  db: Db,
  stripeCustomerId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBySubscriptionId(
  db: Db,
  stripeSubscriptionId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpdateAfterStripeCreatedInput {
  stripeSubscriptionId: string;
  tier: "indie" | "pro" | "scale" | "growth" | "enterprise";
  cycle: "monthly" | "annual";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export async function updateAfterStripeCreated(
  db: Db,
  projectId: string,
  input: UpdateAfterStripeCreatedInput,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      state: "active",
      stripeSubscriptionId: input.stripeSubscriptionId,
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(billingSubscriptions.projectId, projectId));
}

export interface UpdateAfterStripeUpdatedInput {
  tier: "indie" | "pro" | "scale" | "growth" | "enterprise";
  cycle: "monthly" | "annual";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export async function updateAfterStripeUpdated(
  db: Db,
  stripeSubscriptionId: string,
  input: UpdateAfterStripeUpdatedInput,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/db test -- billing-subscriptions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-subscriptions.ts \
        packages/db/src/drizzle/repositories/billing-subscriptions.test.ts
git commit -m "feat(db/billing): add Stripe-side lookups + post-create/update mutators"
```

---

## Task 3: Add tier-limits repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/billing-tier-limits.ts`
- Create: `packages/db/src/drizzle/repositories/billing-tier-limits.test.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { findByTierAndCycle } from "./billing-tier-limits";
import { setupTestDb, withSeededTierLimits } from "../../../test/db-harness";

describe("billing-tier-limits repo", () => {
  beforeEach(setupTestDb);

  it("returns the indie/monthly row", async () => {
    const db = await withSeededTierLimits();
    const row = await findByTierAndCycle(db, "indie", "monthly");
    expect(row).not.toBeNull();
    expect(row?.priceUsdCents).toBe(2900);
  });

  it("returns null for unknown combination", async () => {
    const db = await withSeededTierLimits();
    // 'free' rows have cycle='monthly' only — annual is intentionally absent
    expect(await findByTierAndCycle(db, "free", "annual")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/db test -- billing-tier-limits`
Expected: FAIL with "findByTierAndCycle not exported".

- [ ] **Step 3: Implement the repo**

Create `packages/db/src/drizzle/repositories/billing-tier-limits.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingTierLimits,
  type BillingTierLimits,
} from "../schema";

export async function findByTierAndCycle(
  db: Db,
  tier: BillingTierLimits["tier"],
  cycle: BillingTierLimits["cycle"],
): Promise<BillingTierLimits | null> {
  const rows = await db
    .select()
    .from(billingTierLimits)
    .where(
      and(
        eq(billingTierLimits.tier, tier),
        eq(billingTierLimits.cycle, cycle),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Re-export from the drizzle barrel**

Edit `packages/db/src/drizzle/index.ts`, append after `usageSnapshotRepo`:

```ts
export * as billingTierLimitsRepo from "./repositories/billing-tier-limits";
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/db test -- billing-tier-limits`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-tier-limits.ts \
        packages/db/src/drizzle/repositories/billing-tier-limits.test.ts \
        packages/db/src/drizzle/index.ts
git commit -m "feat(db/billing): tier-limits repo for (tier, cycle) lookup"
```

---

## Task 4: Add Stripe-side lookup methods on `billing_payment_methods`

**Files:**
- Modify: `packages/db/src/drizzle/repositories/billing-payment-methods.ts`
- Test: `packages/db/src/drizzle/repositories/billing-payment-methods.test.ts`
  (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  insertPaymentMethod,
  findByStripePaymentMethodId,
  deleteByStripePaymentMethodId,
  listPaymentMethodsForProject,
} from "./billing-payment-methods";
import { setupTestDb, withProject } from "../../../test/db-harness";

describe("billing-payment-methods repo (Phase 2 additions)", () => {
  beforeEach(setupTestDb);

  it("findByStripePaymentMethodId returns the inserted row", async () => {
    const { db, projectId } = await withProject();
    await insertPaymentMethod(db, {
      projectId,
      stripePaymentMethodId: "pm_test",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    const row = await findByStripePaymentMethodId(db, "pm_test");
    expect(row?.projectId).toBe(projectId);
  });

  it("deleteByStripePaymentMethodId removes the row", async () => {
    const { db, projectId } = await withProject();
    await insertPaymentMethod(db, {
      projectId,
      stripePaymentMethodId: "pm_detach",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    await deleteByStripePaymentMethodId(db, "pm_detach");
    expect(await listPaymentMethodsForProject(db, projectId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/db test -- billing-payment-methods`
Expected: FAIL with "findByStripePaymentMethodId is not exported".

- [ ] **Step 3: Implement the methods**

Append to `packages/db/src/drizzle/repositories/billing-payment-methods.ts`:

```ts
export async function findByStripePaymentMethodId(
  db: Db,
  stripePaymentMethodId: string,
): Promise<BillingPaymentMethod | null> {
  const rows = await db
    .select()
    .from(billingPaymentMethods)
    .where(eq(billingPaymentMethods.stripePaymentMethodId, stripePaymentMethodId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteByStripePaymentMethodId(
  db: Db,
  stripePaymentMethodId: string,
): Promise<void> {
  await db
    .delete(billingPaymentMethods)
    .where(eq(billingPaymentMethods.stripePaymentMethodId, stripePaymentMethodId));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/db test -- billing-payment-methods`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/billing-payment-methods.ts \
        packages/db/src/drizzle/repositories/billing-payment-methods.test.ts
git commit -m "feat(db/billing): payment-methods lookups by Stripe id + delete-by-stripe-id"
```

---

## Task 5: Add billing wire types to `@rovenue/shared`

**Files:**
- Create: `packages/shared/src/billing.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Read `packages/shared/src/index.ts`**

Confirm the existing re-export pattern (e.g. `export * from "./projects"`).

- [ ] **Step 2: Create `packages/shared/src/billing.ts`**

```ts
// Shared wire types for the dashboard billing surface (Phase 2).
// Money is sent over the wire as decimal strings to preserve
// numeric(12,4) precision (consistent with revenue_events).

export type BillingState = "free" | "active" | "past_due" | "paused" | "deleted";
export type BillingTier =
  | "free"
  | "indie"
  | "pro"
  | "scale"
  | "growth"
  | "enterprise";
export type BillingCycle = "monthly" | "annual";
export type InvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "uncollectible"
  | "void";

export interface PaymentMethodSummary {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  createdAt: string; // ISO 8601
}

export interface BillingSummary {
  state: BillingState;
  tier: BillingTier;
  cycle: BillingCycle;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  defaultPaymentMethod: PaymentMethodSummary | null;
  hasStripeCustomer: boolean;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  status: InvoiceStatus;
  amountDue: string;      // decimal string in USD
  amountPaid: string;     // decimal string in USD
  refundedAmount: string; // decimal string in USD
  currency: string;       // ISO-4217, lowercase, e.g. "usd"
  periodStart: string;    // ISO 8601
  periodEnd: string;      // ISO 8601
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  createdAt: string;      // ISO 8601
}

export interface UpgradeResponse {
  clientSecret: string;
  publishableKey: string;
}
```

- [ ] **Step 3: Re-export from `index.ts`**

Append:

```ts
export * from "./billing";
```

- [ ] **Step 4: Build the package**

Run: `pnpm --filter @rovenue/shared build`
Expected: succeeds; no TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/billing.ts packages/shared/src/index.ts
git commit -m "feat(shared): billing summary + invoice + upgrade wire types"
```

---

## Task 6: Wire `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` into env

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`
- Modify: `packages/db/seed.ts`

- [ ] **Step 1: Read the existing billing env block in `env.ts`**

Find the `STRIPE_BILLING_*` block around line 78.

- [ ] **Step 2: Add the price-id field**

```ts
STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID: z.string().min(1).optional(),
```

And in the production validation block where `STRIPE_BILLING_SECRET_KEY` is
checked, add:

```ts
requireInProd(
  data.STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID,
  "STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID",
  "BILLING_ENABLED=true requires the Indie monthly Stripe price id",
);
```

- [ ] **Step 3: Add to `.env.example`**

Place under the existing `STRIPE_BILLING_*` lines:

```
# Stripe Price IDs for platform billing. Required when BILLING_ENABLED=true.
# Phase 2 only ships Indie/monthly; further tiers added in P4/P6.
STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID=
```

- [ ] **Step 4: Patch the seed to write the value into `billing_tier_limits`**

Read `packages/db/seed.ts` around the tier_limits insert (line 89). Replace
the hard-coded `stripePriceId: null` for the `(indie, monthly)` row with:

```ts
{
  tier: "indie" as const,
  cycle: "monthly" as const,
  // ... existing price / mtr / limits fields ...
  stripePriceId: process.env.STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID ?? null,
},
```

Other rows keep `stripePriceId: null` for now (Phase 4 adds Pro/Scale/Growth
price ids; Phase 6 adds annual rows).

- [ ] **Step 5: Run the seed in CI-mode to sanity-check no parse errors**

Run: `pnpm --filter @rovenue/db typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/env.ts .env.example packages/db/seed.ts
git commit -m "feat(api/billing): STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID env + seed wiring"
```

---

## Task 7: `billing-summary` service

**Files:**
- Create: `apps/api/src/services/billing/billing-summary.ts`
- Create: `apps/api/tests/billing-summary-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildBillingSummary } from "../src/services/billing/billing-summary";

const mockDb = {} as never;

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject: vi.fn(),
      },
      billingPaymentMethodRepo: {
        findDefaultPaymentMethod: vi.fn(),
      },
    },
  };
});

import { drizzle } from "@rovenue/db";

describe("buildBillingSummary", () => {
  it("returns a Free summary when no Stripe customer exists", async () => {
    (drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject as any)
      .mockResolvedValue({
        projectId: "p1",
        state: "free",
        tier: "free",
        cycle: "monthly",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      });
    (drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod as any)
      .mockResolvedValue(null);
    const summary = await buildBillingSummary(mockDb, "p1");
    expect(summary).toEqual({
      state: "free",
      tier: "free",
      cycle: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      hasStripeCustomer: false,
    });
  });

  it("returns an Active summary with default PM when paid", async () => {
    (drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject as any)
      .mockResolvedValue({
        projectId: "p2",
        state: "active",
        tier: "indie",
        cycle: "monthly",
        stripeCustomerId: "cus_x",
        stripeSubscriptionId: "sub_x",
        currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      });
    (drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod as any)
      .mockResolvedValue({
        id: "pm_row",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      });
    const summary = await buildBillingSummary(mockDb, "p2");
    expect(summary.state).toBe("active");
    expect(summary.tier).toBe("indie");
    expect(summary.hasStripeCustomer).toBe(true);
    expect(summary.defaultPaymentMethod?.last4).toBe("4242");
    expect(summary.currentPeriodEnd).toBe("2026-07-01T00:00:00.000Z");
  });

  it("throws when no billing_subscriptions row exists", async () => {
    (drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject as any)
      .mockResolvedValue(null);
    await expect(buildBillingSummary(mockDb, "ghost")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-summary-service`
Expected: FAIL on missing import.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/billing/billing-summary.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";
import type { BillingSummary } from "@rovenue/shared";

export async function buildBillingSummary(
  db: Db,
  projectId: string,
): Promise<BillingSummary> {
  const sub =
    await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
      db,
      projectId,
    );
  if (!sub) {
    throw new Error(
      `billing_subscriptions row missing for project ${projectId}`,
    );
  }

  const defaultPm =
    await drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod(
      db,
      projectId,
    );

  return {
    state: sub.state,
    tier: sub.tier,
    cycle: sub.cycle,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    defaultPaymentMethod: defaultPm
      ? {
          id: defaultPm.id,
          brand: defaultPm.brand,
          last4: defaultPm.last4,
          expMonth: defaultPm.expMonth,
          expYear: defaultPm.expYear,
          isDefault: defaultPm.isDefault,
          createdAt: defaultPm.createdAt.toISOString(),
        }
      : null,
    hasStripeCustomer: sub.stripeCustomerId !== null,
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @rovenue/api test -- billing-summary-service`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billing/billing-summary.ts \
        apps/api/tests/billing-summary-service.test.ts
git commit -m "feat(api/billing): billing-summary service (read-only assembly)"
```

---

## Task 8: `upgrade-project` service (customer + SetupIntent)

**Files:**
- Create: `apps/api/src/services/billing/upgrade-project.ts`
- Create: `apps/api/tests/billing-upgrade-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const customersCreate = vi.fn();
const setupIntentsCreate = vi.fn();

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    customers: { create: customersCreate },
    setupIntents: { create: setupIntentsCreate },
  }),
}));

const setStripeCustomerId = vi.fn();
const findSub = vi.fn();

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingSubscriptionRepo: {
        findBillingSubscriptionByProject: findSub,
        setStripeCustomerId,
      },
    },
  };
});

import { upgradeProject } from "../src/services/billing/upgrade-project";

describe("upgradeProject", () => {
  beforeEach(() => {
    customersCreate.mockReset();
    setupIntentsCreate.mockReset();
    setStripeCustomerId.mockReset();
    findSub.mockReset();
  });

  it("creates customer + SetupIntent on first upgrade", async () => {
    findSub.mockResolvedValue({
      projectId: "p1",
      state: "free",
      tier: "free",
      cycle: "monthly",
      stripeCustomerId: null,
    });
    customersCreate.mockResolvedValue({ id: "cus_new" });
    setupIntentsCreate.mockResolvedValue({
      client_secret: "seti_cs_xyz",
      id: "seti_xyz",
    });

    const out = await upgradeProject({
      db: {} as never,
      projectId: "p1",
      cycle: "monthly",
    });

    expect(customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { rovenue_project_id: "p1" },
      }),
    );
    expect(setStripeCustomerId).toHaveBeenCalledWith(
      {},
      "p1",
      "cus_new",
    );
    expect(setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_new",
        usage: "off_session",
        metadata: expect.objectContaining({
          rovenue_project_id: "p1",
          rovenue_flow: "upgrade",
          rovenue_target_tier: "indie",
          rovenue_target_cycle: "monthly",
        }),
      }),
    );
    expect(out.clientSecret).toBe("seti_cs_xyz");
  });

  it("reuses the existing customer when retrying", async () => {
    findSub.mockResolvedValue({
      projectId: "p2",
      state: "free",
      tier: "free",
      cycle: "monthly",
      stripeCustomerId: "cus_existing",
    });
    setupIntentsCreate.mockResolvedValue({
      client_secret: "seti_cs_2",
    });
    await upgradeProject({ db: {} as never, projectId: "p2", cycle: "monthly" });
    expect(customersCreate).not.toHaveBeenCalled();
    expect(setStripeCustomerId).not.toHaveBeenCalled();
    expect(setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("rejects with 409 already_active when state != 'free'", async () => {
    findSub.mockResolvedValue({
      projectId: "p3",
      state: "active",
      tier: "indie",
      cycle: "monthly",
      stripeCustomerId: "cus_x",
    });
    await expect(
      upgradeProject({ db: {} as never, projectId: "p3", cycle: "monthly" }),
    ).rejects.toMatchObject({ code: "already_active" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-upgrade-service`
Expected: FAIL on missing import.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/billing/upgrade-project.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";

export interface UpgradeProjectInput {
  db: Db;
  projectId: string;
  cycle: "monthly"; // Phase 2: monthly only. Annual ships in P6.
}

export interface UpgradeError extends Error {
  code: "already_active" | "billing_disabled" | "config_missing";
}

function err(code: UpgradeError["code"], message: string): UpgradeError {
  const e = new Error(message) as UpgradeError;
  e.code = code;
  return e;
}

export async function upgradeProject(input: UpgradeProjectInput): Promise<{
  clientSecret: string;
  publishableKey: string;
}> {
  const stripe = getPlatformStripe();
  if (!stripe) throw err("billing_disabled", "Billing disabled");
  if (!env.STRIPE_BILLING_PUBLISHABLE_KEY) {
    throw err("config_missing", "Missing STRIPE_BILLING_PUBLISHABLE_KEY");
  }

  const sub =
    await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
      input.db,
      input.projectId,
    );
  if (!sub) throw err("config_missing", "No billing_subscriptions row");
  if (sub.state !== "free") {
    throw err("already_active", `state=${sub.state}`);
  }

  let customerId = sub.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { rovenue_project_id: input.projectId },
    });
    customerId = customer.id;
    await drizzle.billingSubscriptionRepo.setStripeCustomerId(
      input.db,
      input.projectId,
      customerId,
    );
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      rovenue_project_id: input.projectId,
      rovenue_flow: "upgrade",
      rovenue_target_tier: "indie",
      rovenue_target_cycle: input.cycle,
    },
  });

  if (!setupIntent.client_secret) {
    throw err("config_missing", "SetupIntent missing client_secret");
  }

  return {
    clientSecret: setupIntent.client_secret,
    publishableKey: env.STRIPE_BILLING_PUBLISHABLE_KEY,
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/api test -- billing-upgrade-service`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billing/upgrade-project.ts \
        apps/api/tests/billing-upgrade-service.test.ts
git commit -m "feat(api/billing): upgrade-project service (lazy customer + SetupIntent)"
```

---

## Task 9: `add-payment-method` service (SetupIntent for existing active customer)

**Files:**
- Create: `apps/api/src/services/billing/add-payment-method.ts`
- Create: `apps/api/tests/billing-add-payment-method-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const setupIntentsCreate = vi.fn();
vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({ setupIntents: { create: setupIntentsCreate } }),
}));

const findSub = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingSubscriptionRepo: { findBillingSubscriptionByProject: findSub },
    },
  };
});

import { startAddPaymentMethod } from "../src/services/billing/add-payment-method";

describe("startAddPaymentMethod", () => {
  beforeEach(() => {
    findSub.mockReset();
    setupIntentsCreate.mockReset();
  });

  it("issues a SetupIntent for the existing Stripe customer", async () => {
    findSub.mockResolvedValue({
      projectId: "p1",
      state: "active",
      stripeCustomerId: "cus_x",
    });
    setupIntentsCreate.mockResolvedValue({ client_secret: "seti_cs_add" });
    const out = await startAddPaymentMethod({
      db: {} as never,
      projectId: "p1",
    });
    expect(setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_x",
        metadata: expect.objectContaining({ rovenue_flow: "add_pm" }),
      }),
    );
    expect(out.clientSecret).toBe("seti_cs_add");
  });

  it("rejects when no Stripe customer exists yet (free project)", async () => {
    findSub.mockResolvedValue({
      projectId: "p2",
      state: "free",
      stripeCustomerId: null,
    });
    await expect(
      startAddPaymentMethod({ db: {} as never, projectId: "p2" }),
    ).rejects.toMatchObject({ code: "no_customer" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-add-payment-method-service`
Expected: FAIL.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/billing/add-payment-method.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";

export interface StartAddPaymentMethodInput {
  db: Db;
  projectId: string;
}

export interface AddPmError extends Error {
  code: "no_customer" | "billing_disabled" | "config_missing";
}

function err(code: AddPmError["code"], message: string): AddPmError {
  const e = new Error(message) as AddPmError;
  e.code = code;
  return e;
}

export async function startAddPaymentMethod(
  input: StartAddPaymentMethodInput,
): Promise<{ clientSecret: string; publishableKey: string }> {
  const stripe = getPlatformStripe();
  if (!stripe) throw err("billing_disabled", "Billing disabled");
  if (!env.STRIPE_BILLING_PUBLISHABLE_KEY) {
    throw err("config_missing", "Missing STRIPE_BILLING_PUBLISHABLE_KEY");
  }

  const sub =
    await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
      input.db,
      input.projectId,
    );
  if (!sub?.stripeCustomerId) {
    throw err("no_customer", "Project has no Stripe customer yet");
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: sub.stripeCustomerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      rovenue_project_id: input.projectId,
      rovenue_flow: "add_pm",
    },
  });

  if (!setupIntent.client_secret) {
    throw err("config_missing", "SetupIntent missing client_secret");
  }

  return {
    clientSecret: setupIntent.client_secret,
    publishableKey: env.STRIPE_BILLING_PUBLISHABLE_KEY,
  };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @rovenue/api test -- billing-add-payment-method-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billing/add-payment-method.ts \
        apps/api/tests/billing-add-payment-method-service.test.ts
git commit -m "feat(api/billing): add-payment-method service (SetupIntent for active project)"
```

---

## Task 10: `billing-events` outbox publishers

**Files:**
- Create: `apps/api/src/services/billing/billing-events.ts`
- Create: `apps/api/tests/billing-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";

const insertOutbox = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      outboxRepo: { insert: insertOutbox },
    },
  };
});

import {
  publishBillingActivated,
  publishBillingInvoicePaid,
} from "../src/services/billing/billing-events";

describe("billing-events", () => {
  it("publishes billing.subscription.activated", async () => {
    await publishBillingActivated({} as never, {
      projectId: "p1",
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    });
    expect(insertOutbox).toHaveBeenCalledWith({}, expect.objectContaining({
      aggregateType: "BILLING",
      aggregateId: "p1",
      eventType: "billing.subscription.activated",
    }));
  });

  it("publishes billing.invoice.paid", async () => {
    insertOutbox.mockClear();
    await publishBillingInvoicePaid({} as never, {
      projectId: "p2",
      invoiceId: "inv_row",
      stripeInvoiceId: "in_x",
      amountPaid: "29.0000",
    });
    expect(insertOutbox).toHaveBeenCalledWith({}, expect.objectContaining({
      aggregateType: "BILLING",
      aggregateId: "p2",
      eventType: "billing.invoice.paid",
    }));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-events`
Expected: FAIL on missing imports.

- [ ] **Step 3: Implement the publishers**

Create `apps/api/src/services/billing/billing-events.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";

export interface BillingActivatedInput {
  projectId: string;
  tier: string;
  cycle: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export async function publishBillingActivated(
  tx: Db,
  input: BillingActivatedInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.subscription.activated",
    payload: {
      projectId: input.projectId,
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart.toISOString(),
      currentPeriodEnd: input.currentPeriodEnd.toISOString(),
    },
  });
}

export interface BillingPaymentMethodAddedInput {
  projectId: string;
  paymentMethodId: string;
  brand: string;
  last4: string;
}

export async function publishBillingPaymentMethodAdded(
  tx: Db,
  input: BillingPaymentMethodAddedInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.payment_method.added",
    payload: input,
  });
}

export interface BillingInvoicePaidInput {
  projectId: string;
  invoiceId: string;
  stripeInvoiceId: string;
  amountPaid: string;
}

export async function publishBillingInvoicePaid(
  tx: Db,
  input: BillingInvoicePaidInput,
): Promise<void> {
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "BILLING",
    aggregateId: input.projectId,
    eventType: "billing.invoice.paid",
    payload: input,
  });
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/api test -- billing-events`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billing/billing-events.ts \
        apps/api/tests/billing-events.test.ts
git commit -m "feat(api/billing): outbox publishers for BILLING aggregate events"
```

---

## Task 11: Webhook handler — `setup_intent.succeeded`

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-setup-intent-succeeded.ts`
- Test: covered by the dispatcher integration test in Task 18.

This handler runs inside the dispatcher's `db.transaction(async (tx) => {...})`.

- [ ] **Step 1: Implement the handler**

```ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { getPlatformStripe } from "../../../lib/stripe-billing";
import { logger } from "../../../lib/logger";
import { env } from "../../../lib/env";
import { publishBillingPaymentMethodAdded } from "../billing-events";

const log = logger.child("billing:webhook:setup_intent_succeeded");

export interface SetupIntentSucceededContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleSetupIntentSucceeded(
  ctx: SetupIntentSucceededContext,
): Promise<{ followUp?: () => Promise<void> }> {
  const intent = ctx.event.data.object as Stripe.SetupIntent;
  if (intent.status !== "succeeded" || !intent.payment_method) {
    log.warn("setup_intent without succeeded status or pm", {
      id: intent.id,
      status: intent.status,
    });
    return {};
  }

  const stripe = getPlatformStripe();
  if (!stripe) throw new Error("Stripe client unavailable");

  // Retrieve PM details from Stripe — the webhook payload lists only
  // the id by default.
  const pmId = typeof intent.payment_method === "string"
    ? intent.payment_method
    : intent.payment_method.id;
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.type !== "card" || !pm.card) {
    log.warn("non-card payment method ignored", { pmId });
    return {};
  }

  // Insert the PM row inside the tx. The partial unique index on
  // (project_id) WHERE is_default=true means we can safely set
  // isDefault=true only if there is no existing default.
  const existing =
    await drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod(
      ctx.tx,
      ctx.projectId,
    );
  const isDefault = existing === null;

  const inserted = await drizzle.billingPaymentMethodRepo.insertPaymentMethod(
    ctx.tx,
    {
      projectId: ctx.projectId,
      stripePaymentMethodId: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      isDefault,
    },
  );

  await publishBillingPaymentMethodAdded(ctx.tx, {
    projectId: ctx.projectId,
    paymentMethodId: inserted.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
  });

  // Decide whether this SetupIntent should also bootstrap a
  // subscription. The metadata key `rovenue_flow=upgrade` is set
  // by upgrade-project.ts; `add_pm` flow only adds a card.
  const flow = intent.metadata?.rovenue_flow;
  if (flow !== "upgrade") return {};

  // Fetch the indie/monthly price id now so we fail loudly inside
  // the tx if mis-seeded; the actual subscription create happens
  // OUTSIDE the tx (Stripe call must not span DB tx boundaries).
  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits?.stripePriceId) {
    throw new Error("missing indie/monthly stripe_price_id");
  }
  const priceId = limits.stripePriceId;
  const customerId = intent.customer as string;

  // Set the new PM as the customer's default for invoices, then
  // schedule the subscription.create call via the returned follow-up.
  return {
    followUp: async () => {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
      try {
        await stripe.subscriptions.create(
          {
            customer: customerId,
            items: [{ price: priceId }],
            default_payment_method: pmId,
            payment_behavior: "default_incomplete",
            expand: ["latest_invoice.payment_intent"],
            metadata: { rovenue_project_id: ctx.projectId },
          },
          { idempotencyKey: `sub-create-${ctx.projectId}` },
        );
      } catch (e) {
        log.error("subscriptions.create failed", {
          projectId: ctx.projectId,
          err: (e as Error).message,
        });
        // Surfacing 500 from the webhook causes Stripe to retry the
        // setup_intent.succeeded. Idempotency-keyed retries are safe.
        throw e;
      }
    },
  };
}
```

- [ ] **Step 2: No standalone test runs here — verified by Task 18 integration test. Commit:**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-setup-intent-succeeded.ts
git commit -m "feat(api/billing): webhook handler — setup_intent.succeeded"
```

---

## Task 12: Webhook handler — `customer.subscription.created`

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-subscription-created.ts`

- [ ] **Step 1: Implement the handler**

```ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { audit } from "../../../lib/audit";
import { publishBillingActivated } from "../billing-events";

export interface SubscriptionCreatedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

function tierFromPriceId(priceId: string, indieMonthlyPriceId: string): "indie" {
  // Phase 2 only knows about Indie/monthly. Any other price id means
  // the platform Stripe account is mis-seeded (P4/P6 expand this map).
  if (priceId === indieMonthlyPriceId) return "indie";
  throw new Error(`Unknown stripe_price_id: ${priceId}`);
}

export async function handleSubscriptionCreated(
  ctx: SubscriptionCreatedContext,
): Promise<void> {
  const sub = ctx.event.data.object as Stripe.Subscription;
  const item = sub.items.data[0];
  if (!item) throw new Error("subscription has no items");

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits?.stripePriceId) {
    throw new Error("missing indie/monthly stripe_price_id");
  }
  const tier = tierFromPriceId(item.price.id, limits.stripePriceId);
  const currentPeriodStart = new Date(sub.current_period_start * 1000);
  const currentPeriodEnd = new Date(sub.current_period_end * 1000);

  await drizzle.billingSubscriptionRepo.updateAfterStripeCreated(
    ctx.tx,
    ctx.projectId,
    {
      stripeSubscriptionId: sub.id,
      tier,
      cycle: "monthly",
      currentPeriodStart,
      currentPeriodEnd,
    },
  );

  await audit(
    {
      projectId: ctx.projectId,
      userId: "stripe-webhook",
      action: "billing.subscription.activated",
      resource: "billing_subscription",
      resourceId: sub.id,
      before: null,
      after: {
        tier,
        cycle: "monthly",
        state: "active",
        currentPeriodStart: currentPeriodStart.toISOString(),
        currentPeriodEnd: currentPeriodEnd.toISOString(),
      },
    },
    ctx.tx,
  );

  await publishBillingActivated(ctx.tx, {
    projectId: ctx.projectId,
    tier,
    cycle: "monthly",
    currentPeriodStart,
    currentPeriodEnd,
  });
}
```

Note: if the `AuditAction` / `AuditResource` enums don't already include
`billing.subscription.activated` / `billing_subscription`, extend them in
the same commit — see `apps/api/src/lib/audit.ts` for the enum definitions.

- [ ] **Step 2: Extend audit enums if needed**

Open `apps/api/src/lib/audit.ts`. If the `AuditAction` literal type does
not include `"billing.subscription.activated"`, add it. Same for
`AuditResource` and `"billing_subscription"`. Add `"stripe-webhook"` to
whatever `userId` shape audit already accepts (likely no change — `userId`
is a free-form string FK constraint allows arbitrary strings; check the
schema `audit_logs.user_id` column for the FK — if it FK's to `user`, you'll
need to allow NULL `userId` here instead and pass `userId: null`). Match
the existing audit pattern.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-subscription-created.ts \
        apps/api/src/lib/audit.ts
git commit -m "feat(api/billing): webhook handler — subscription.created"
```

---

## Task 13: Webhook handler — `customer.subscription.updated`

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-subscription-updated.ts`

- [ ] **Step 1: Implement the handler**

```ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";

const log = logger.child("billing:webhook:subscription_updated");

export interface SubscriptionUpdatedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleSubscriptionUpdated(
  ctx: SubscriptionUpdatedContext,
): Promise<void> {
  const sub = ctx.event.data.object as Stripe.Subscription;
  const existing = await drizzle.billingSubscriptionRepo.findBySubscriptionId(
    ctx.tx,
    sub.id,
  );
  if (!existing) {
    // Out-of-order: subscription.updated arrived before .created.
    // No-op; the next subscription sync (P4 cron) will reconcile.
    log.warn("subscription.updated arrived before .created", {
      stripeSubscriptionId: sub.id,
    });
    return;
  }

  const item = sub.items.data[0];
  if (!item) throw new Error("subscription has no items");

  const limits = await drizzle.billingTierLimitsRepo.findByTierAndCycle(
    ctx.tx,
    "indie",
    "monthly",
  );
  if (!limits?.stripePriceId) {
    throw new Error("missing indie/monthly stripe_price_id");
  }
  // Phase 2: only Indie/monthly is recognized; any other price id is
  // refused so a Phase-4 price swap can't silently downgrade us.
  if (item.price.id !== limits.stripePriceId) {
    throw new Error(`unexpected price_id in P2: ${item.price.id}`);
  }

  await drizzle.billingSubscriptionRepo.updateAfterStripeUpdated(
    ctx.tx,
    sub.id,
    {
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    },
  );

  // P2: past_due / dunning state is not yet driven by this handler;
  // P5 layers the dunning_state writes on top.
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-subscription-updated.ts
git commit -m "feat(api/billing): webhook handler — subscription.updated"
```

---

## Task 14: Webhook handler — invoice lifecycle (create / finalize / updated)

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-invoice-upsert.ts`

- [ ] **Step 1: Implement the handler**

```ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";

export interface InvoiceUpsertContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

function statusFromStripe(s: Stripe.Invoice.Status | null): "draft" | "open" | "paid" | "uncollectible" | "void" {
  switch (s) {
    case "draft":
    case "open":
    case "paid":
    case "uncollectible":
    case "void":
      return s;
    default:
      return "draft";
  }
}

export async function handleInvoiceUpsert(
  ctx: InvoiceUpsertContext,
): Promise<void> {
  const inv = ctx.event.data.object as Stripe.Invoice;
  await drizzle.billingInvoiceRepo.upsertInvoiceFromStripe(ctx.tx, {
    projectId: ctx.projectId,
    stripeInvoiceId: inv.id,
    number: inv.number ?? inv.id,
    status: statusFromStripe(inv.status),
    amountDue: (inv.amount_due / 100).toFixed(4),
    amountPaid: (inv.amount_paid / 100).toFixed(4),
    currency: inv.currency,
    periodStart: new Date(inv.period_start * 1000),
    periodEnd: new Date(inv.period_end * 1000),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
    attemptCount: inv.attempt_count,
    nextPaymentAttempt: inv.next_payment_attempt
      ? new Date(inv.next_payment_attempt * 1000)
      : null,
    refundedAmount: "0",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-invoice-upsert.ts
git commit -m "feat(api/billing): webhook handler — invoice.created/finalized/updated"
```

---

## Task 15: Webhook handler — `invoice.payment_succeeded`

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-invoice-payment-succeeded.ts`

- [ ] **Step 1: Implement the handler**

```ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { publishBillingInvoicePaid } from "../billing-events";

export interface InvoicePaidContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleInvoicePaymentSucceeded(
  ctx: InvoicePaidContext,
): Promise<void> {
  const inv = ctx.event.data.object as Stripe.Invoice;
  await drizzle.billingInvoiceRepo.upsertInvoiceFromStripe(ctx.tx, {
    projectId: ctx.projectId,
    stripeInvoiceId: inv.id,
    number: inv.number ?? inv.id,
    status: "paid",
    amountDue: (inv.amount_due / 100).toFixed(4),
    amountPaid: (inv.amount_paid / 100).toFixed(4),
    currency: inv.currency,
    periodStart: new Date(inv.period_start * 1000),
    periodEnd: new Date(inv.period_end * 1000),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
    attemptCount: inv.attempt_count,
    nextPaymentAttempt: null,
    refundedAmount: "0",
  });

  const stored = await drizzle.billingInvoiceRepo.findInvoiceByStripeId(
    ctx.tx,
    inv.id,
  );
  if (!stored) throw new Error("invoice row missing after upsert");

  await publishBillingInvoicePaid(ctx.tx, {
    projectId: ctx.projectId,
    invoiceId: stored.id,
    stripeInvoiceId: inv.id,
    amountPaid: (inv.amount_paid / 100).toFixed(4),
  });

  // P5 will additionally clear billing_dunning_state and publish
  // billing.recovered. Phase 2 stops short of that — recovery semantics
  // require the dunning row, which P5 introduces writes for.
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-invoice-payment-succeeded.ts
git commit -m "feat(api/billing): webhook handler — invoice.payment_succeeded"
```

---

## Task 16: Webhook handlers — `charge.refunded` and `payment_method.detached`

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/handle-charge-refunded.ts`
- Create: `apps/api/src/services/billing/webhook-handlers/handle-payment-method-detached.ts`

- [ ] **Step 1: Implement charge.refunded**

```ts
// handle-charge-refunded.ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../../lib/logger";

const log = logger.child("billing:webhook:charge_refunded");

export interface ChargeRefundedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handleChargeRefunded(
  ctx: ChargeRefundedContext,
): Promise<void> {
  const charge = ctx.event.data.object as Stripe.Charge;
  if (!charge.invoice) {
    log.info("charge.refunded with no invoice — skipping", { id: charge.id });
    return;
  }
  const stripeInvoiceId =
    typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id;
  const delta = (charge.amount_refunded / 100).toFixed(4);
  await drizzle.billingInvoiceRepo.incrementRefundedAmount(
    ctx.tx,
    stripeInvoiceId,
    delta,
  );
}
```

- [ ] **Step 2: Implement payment_method.detached**

```ts
// handle-payment-method-detached.ts
import type Stripe from "stripe";
import { drizzle, type Db } from "@rovenue/db";

export interface PaymentMethodDetachedContext {
  tx: Db;
  event: Stripe.Event;
  projectId: string;
}

export async function handlePaymentMethodDetached(
  ctx: PaymentMethodDetachedContext,
): Promise<void> {
  const pm = ctx.event.data.object as Stripe.PaymentMethod;
  await drizzle.billingPaymentMethodRepo.deleteByStripePaymentMethodId(
    ctx.tx,
    pm.id,
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/handle-charge-refunded.ts \
        apps/api/src/services/billing/webhook-handlers/handle-payment-method-detached.ts
git commit -m "feat(api/billing): webhook handlers — charge.refunded + payment_method.detached"
```

---

## Task 17: Webhook dispatcher (replaces the no-op body)

**Files:**
- Create: `apps/api/src/services/billing/webhook-handlers/index.ts`
- Modify: `apps/api/src/routes/billing/webhook.ts`
- Test: `apps/api/tests/billing-webhook-dispatch.test.ts`

- [ ] **Step 1: Write the failing dispatcher unit test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findByCustomer = vi.fn();
const upsertWh = vi.fn();
const updateWh = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingSubscriptionRepo: { findByStripeCustomerId: findByCustomer },
      webhookEventRepo: {
        upsertWebhookEvent: upsertWh,
        updateWebhookEvent: updateWh,
      },
      db: {
        transaction: (fn: any) => fn({}),
      },
    },
  };
});

import { dispatchStripeBillingEvent } from
  "../src/services/billing/webhook-handlers";

describe("dispatchStripeBillingEvent", () => {
  beforeEach(() => {
    findByCustomer.mockReset();
    upsertWh.mockReset();
    updateWh.mockReset();
  });

  it("returns ignored=true for unknown event types", async () => {
    findByCustomer.mockResolvedValue({ projectId: "p1" });
    upsertWh.mockResolvedValue({ id: "wh_row", status: "PENDING" });
    const out = await dispatchStripeBillingEvent({
      id: "evt_x",
      type: "balance.available",
      data: { object: { customer: "cus_x" } },
    } as any);
    expect(out).toEqual({ status: "ignored" });
    expect(updateWh).not.toHaveBeenCalled();
  });

  it("returns skipped=true on duplicate webhook id", async () => {
    findByCustomer.mockResolvedValue({ projectId: "p1" });
    upsertWh.mockResolvedValue({ id: "wh_row", status: "PROCESSED" });
    const out = await dispatchStripeBillingEvent({
      id: "evt_dup",
      type: "invoice.created",
      data: { object: { customer: "cus_x" } },
    } as any);
    expect(out).toEqual({ status: "duplicate" });
  });

  it("returns project_not_found when no billing_subscriptions row exists", async () => {
    findByCustomer.mockResolvedValue(null);
    const out = await dispatchStripeBillingEvent({
      id: "evt_y",
      type: "invoice.created",
      data: { object: { customer: "cus_missing" } },
    } as any);
    expect(out).toEqual({ status: "project_not_found" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-webhook-dispatch`
Expected: FAIL on missing import.

- [ ] **Step 3: Implement the dispatcher**

Create `apps/api/src/services/billing/webhook-handlers/index.ts`:

```ts
import type Stripe from "stripe";
import { drizzle, db } from "@rovenue/db";
import { logger } from "../../../lib/logger";
import { handleSetupIntentSucceeded } from "./handle-setup-intent-succeeded";
import { handleSubscriptionCreated } from "./handle-subscription-created";
import { handleSubscriptionUpdated } from "./handle-subscription-updated";
import { handleInvoiceUpsert } from "./handle-invoice-upsert";
import { handleInvoicePaymentSucceeded } from "./handle-invoice-payment-succeeded";
import { handleChargeRefunded } from "./handle-charge-refunded";
import { handlePaymentMethodDetached } from "./handle-payment-method-detached";

const log = logger.child("billing:webhook:dispatch");

export type DispatchResult =
  | { status: "ok" }
  | { status: "ignored" }
  | { status: "duplicate" }
  | { status: "project_not_found" };

// Map each Stripe event type to a (ctx) -> Promise<{ followUp? }>
// handler. setup_intent.succeeded is the only handler that
// returns a follow-up (to call stripe.subscriptions.create
// outside the tx).
type HandlerResult = { followUp?: () => Promise<void> } | void;

interface Ctx {
  tx: import("@rovenue/db").Db;
  event: Stripe.Event;
  projectId: string;
}

const handlers: Record<string, (ctx: Ctx) => Promise<HandlerResult>> = {
  "setup_intent.succeeded": (ctx) => handleSetupIntentSucceeded(ctx),
  "customer.subscription.created": (ctx) => handleSubscriptionCreated(ctx),
  "customer.subscription.updated": (ctx) => handleSubscriptionUpdated(ctx),
  "invoice.created": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.finalized": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.updated": (ctx) => handleInvoiceUpsert(ctx),
  "invoice.payment_succeeded": (ctx) => handleInvoicePaymentSucceeded(ctx),
  "charge.refunded": (ctx) => handleChargeRefunded(ctx),
  "payment_method.detached": (ctx) => handlePaymentMethodDetached(ctx),
};

function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data.object as { customer?: string | { id: string } | null };
  if (!obj.customer) return null;
  return typeof obj.customer === "string" ? obj.customer : obj.customer.id;
}

export async function dispatchStripeBillingEvent(
  event: Stripe.Event,
): Promise<DispatchResult> {
  const handler = handlers[event.type];
  if (!handler) {
    log.debug("ignored event type", { type: event.type, id: event.id });
    return { status: "ignored" };
  }

  const customerId = extractCustomerId(event);
  if (!customerId) {
    log.warn("event has no customer field", { type: event.type, id: event.id });
    return { status: "project_not_found" };
  }

  const sub =
    await drizzle.billingSubscriptionRepo.findByStripeCustomerId(db, customerId);
  if (!sub) {
    log.warn("no billing_subscriptions row for customer", {
      customerId,
      eventId: event.id,
    });
    return { status: "project_not_found" };
  }

  const projectId = sub.projectId;

  // Idempotency check via webhook_events dedupe table.
  const whRow = await drizzle.webhookEventRepo.upsertWebhookEvent(db, {
    projectId,
    source: "STRIPE",
    eventType: event.type,
    storeEventId: event.id,
    payload: event as unknown,
    status: "PENDING",
  });
  if (whRow.status === "PROCESSED") {
    return { status: "duplicate" };
  }

  let followUp: (() => Promise<void>) | undefined;

  await db.transaction(async (tx) => {
    const result = await handler({ tx, event, projectId });
    if (result && "followUp" in result && result.followUp) {
      followUp = result.followUp;
    }
    await drizzle.webhookEventRepo.updateWebhookEvent(tx, whRow.id, {
      status: "PROCESSED",
      processedAt: new Date(),
    });
  });

  // Stripe API call AFTER tx commit. If it throws, Stripe will
  // retry the webhook; our webhook_events dedupe means handlers
  // are no-ops on the second attempt. The follow-up itself uses
  // stripe.subscriptions.create with idempotencyKey, so a retry
  // is a no-op there too.
  if (followUp) {
    await followUp();
  }

  return { status: "ok" };
}
```

- [ ] **Step 4: Run the dispatcher test to confirm it passes**

Run: `pnpm --filter @rovenue/api test -- billing-webhook-dispatch`
Expected: PASS (all three cases).

- [ ] **Step 5: Replace the no-op body in `webhook.ts`**

Edit `apps/api/src/routes/billing/webhook.ts`. Keep the signature verify
block; replace the `log.info(...); return c.json(...)` tail with:

```ts
import { dispatchStripeBillingEvent } from "../../services/billing/webhook-handlers";

// ... unchanged signature-verify code ...

const result = await dispatchStripeBillingEvent(event);
log.info("billing webhook dispatched", {
  eventId: event.id,
  eventType: event.type,
  result: result.status,
});
return c.json({ received: true, result: result.status }, 200);
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/billing/webhook-handlers/index.ts \
        apps/api/src/routes/billing/webhook.ts \
        apps/api/tests/billing-webhook-dispatch.test.ts
git commit -m "feat(api/billing): webhook dispatcher (dedup + tx + follow-up)"
```

---

## Task 18: Webhook handlers integration test

**Files:**
- Create: `apps/api/tests/billing-webhook-handlers.integration.test.ts`
- Create: 8 fixture files under `apps/api/tests/fixtures/stripe-webhooks/`

- [ ] **Step 1: Capture Stripe fixture events**

For each event type listed below, paste a minimised JSON payload (only the
fields the handler reads) into the fixture directory. Use Stripe's CLI
(`stripe trigger setup_intent.succeeded ...`) against a sandbox or copy
from Stripe's webhook event examples in the docs. Each fixture file is a
valid `Stripe.Event` JSON.

```
apps/api/tests/fixtures/stripe-webhooks/setup_intent.succeeded.json
apps/api/tests/fixtures/stripe-webhooks/customer.subscription.created.json
apps/api/tests/fixtures/stripe-webhooks/customer.subscription.updated.json
apps/api/tests/fixtures/stripe-webhooks/invoice.created.json
apps/api/tests/fixtures/stripe-webhooks/invoice.finalized.json
apps/api/tests/fixtures/stripe-webhooks/invoice.payment_succeeded.json
apps/api/tests/fixtures/stripe-webhooks/charge.refunded.json
apps/api/tests/fixtures/stripe-webhooks/payment_method.detached.json
```

Each fixture must set:
- top-level `id`: unique per fixture
- `type`: matching event type
- `data.object.customer`: a fixed string `cus_test_phase2`
- For invoice fixtures: `id` (Stripe invoice id), `number`, `amount_due` (cents),
  `amount_paid`, `currency: "usd"`, `period_start`, `period_end`,
  `attempt_count`, `status`
- For subscription fixtures: `id: "sub_test_phase2"`,
  `current_period_start`, `current_period_end`,
  `items.data[0].price.id` = the test-mode Indie monthly price id
- For setup_intent.succeeded: `payment_method: "pm_test_phase2"`,
  `customer: "cus_test_phase2"`, `status: "succeeded"`,
  `metadata.rovenue_project_id: "<placeholder>"`,
  `metadata.rovenue_flow: "upgrade"`

The test below mutates `metadata.rovenue_project_id` at runtime to the
project id seeded in the integration DB, so the fixture's placeholder
value is overwritten.

- [ ] **Step 2: Write the integration test**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchStripeBillingEvent } from
  "../src/services/billing/webhook-handlers";
import { drizzle, db } from "@rovenue/db";
import {
  startPostgresContainer,
  applyMigrations,
  stopContainer,
  seedTierLimits,
  createTestProjectWithBilling,
  // ↑ helpers already used in apps/api/tests/billing-backfill-migration.integration.test.ts
} from "./_helpers/integration-bootstrap";

const FIXTURES = "tests/fixtures/stripe-webhooks";
function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(__dirname, "fixtures/stripe-webhooks", name), "utf8"));
}

const PROJECT_ID = "proj_phase2_test";
const CUSTOMER_ID = "cus_test_phase2";

const pmRetrieve = vi.fn(async () => ({
  id: "pm_test_phase2",
  type: "card",
  card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
}));
const customersUpdate = vi.fn();
const subscriptionsCreate = vi.fn(async () => ({
  id: "sub_test_phase2",
  status: "incomplete",
}));

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    paymentMethods: { retrieve: pmRetrieve },
    customers: { update: customersUpdate },
    subscriptions: { create: subscriptionsCreate },
  }),
}));

beforeAll(async () => {
  await startPostgresContainer();
  await applyMigrations();
  await seedTierLimits({ indieMonthlyPriceId: "price_test_indie_monthly" });
  await createTestProjectWithBilling({
    projectId: PROJECT_ID,
    stripeCustomerId: CUSTOMER_ID,
  });
});

afterAll(async () => {
  await stopContainer();
});

describe("Stripe webhook handlers — integration", () => {
  it("setup_intent.succeeded inserts PM and schedules subscriptions.create", async () => {
    const event = loadFixture("setup_intent.succeeded.json");
    event.data.object.metadata.rovenue_project_id = PROJECT_ID;
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const pms = await drizzle.billingPaymentMethodRepo
      .listPaymentMethodsForProject(db, PROJECT_ID);
    expect(pms).toHaveLength(1);
    expect(pms[0].last4).toBe("4242");
    expect(pms[0].isDefault).toBe(true);
    expect(subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: CUSTOMER_ID }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining(PROJECT_ID) }),
    );
  });

  it("customer.subscription.created flips state=active + writes audit + outbox", async () => {
    const event = loadFixture("customer.subscription.created.json");
    event.data.object.customer = CUSTOMER_ID;
    event.data.object.items.data[0].price.id = "price_test_indie_monthly";
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const sub = await drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject(db, PROJECT_ID);
    expect(sub?.state).toBe("active");
    expect(sub?.tier).toBe("indie");

    // Outbox row asserted via raw SQL since the public API of outboxRepo
    // is dispatcher-facing.
    const { rows } = await db.execute(
      `select event_type from outbox_events where aggregate_id = $1`,
      [PROJECT_ID],
    );
    expect(rows.map((r: any) => r.event_type)).toContain(
      "billing.subscription.activated",
    );
  });

  it("invoice.created mirrors into billing_invoices", async () => {
    const event = loadFixture("invoice.created.json");
    event.data.object.customer = CUSTOMER_ID;
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const invoices = await drizzle.billingInvoiceRepo.listInvoicesForProject(
      db,
      PROJECT_ID,
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe("draft");
  });

  it("invoice.payment_succeeded flips status=paid and emits billing.invoice.paid", async () => {
    const event = loadFixture("invoice.payment_succeeded.json");
    event.data.object.customer = CUSTOMER_ID;
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const invoices = await drizzle.billingInvoiceRepo.listInvoicesForProject(
      db,
      PROJECT_ID,
    );
    expect(invoices.find((i) => i.stripeInvoiceId === event.data.object.id)?.status)
      .toBe("paid");
  });

  it("charge.refunded increments refunded_amount", async () => {
    const event = loadFixture("charge.refunded.json");
    event.data.object.customer = CUSTOMER_ID;
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const invoice = await drizzle.billingInvoiceRepo.findInvoiceByStripeId(
      db,
      event.data.object.invoice,
    );
    expect(parseFloat(invoice!.refundedAmount)).toBeGreaterThan(0);
  });

  it("payment_method.detached removes the PM row", async () => {
    const event = loadFixture("payment_method.detached.json");
    event.data.object.customer = CUSTOMER_ID;
    event.data.object.id = "pm_test_phase2";
    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });
    const pms = await drizzle.billingPaymentMethodRepo
      .listPaymentMethodsForProject(db, PROJECT_ID);
    expect(pms.find((p) => p.stripePaymentMethodId === "pm_test_phase2")).toBeUndefined();
  });

  it("duplicate event id returns status='duplicate'", async () => {
    const event = loadFixture("invoice.created.json");
    event.data.object.customer = CUSTOMER_ID;
    const first = await dispatchStripeBillingEvent(event);
    const second = await dispatchStripeBillingEvent(event);
    expect(first.status === "ok" || first.status === "duplicate").toBe(true);
    expect(second).toEqual({ status: "duplicate" });
  });
});
```

Note: `_helpers/integration-bootstrap.ts` may not yet exist as a single
file — if it doesn't, factor the testcontainer + migrations + tier-seed
setup out of `apps/api/tests/billing-backfill-migration.integration.test.ts`
into that helper as a one-time refactor in this commit.

- [ ] **Step 3: Run it**

Run: `pnpm --filter @rovenue/api test -- billing-webhook-handlers.integration --run`
Expected: PASS (all seven cases). Allow up to 60s for the testcontainer.

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/billing-webhook-handlers.integration.test.ts \
        apps/api/tests/fixtures/stripe-webhooks/ \
        apps/api/tests/_helpers/integration-bootstrap.ts
git commit -m "test(api/billing): integration test for Stripe webhook handlers"
```

---

## Task 19: Dashboard endpoint — `GET /dashboard/projects/:projectId/billing` (summary)

**Files:**
- Create: `apps/api/src/routes/dashboard/billing/summary.ts`
- Create: `apps/api/src/routes/dashboard/billing/index.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`
- Create: `apps/api/tests/billing-summary-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/billing-flags", () => ({
  isBillingEnabled: () => true,
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    c.set("session", { id: "s1" });
    await next();
  },
}));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
}));

const buildBillingSummary = vi.fn();
vi.mock("../src/services/billing/billing-summary", () => ({
  buildBillingSummary,
}));

import { billingSubRouter } from "../src/routes/dashboard/billing";

describe("GET /dashboard/projects/:projectId/billing", () => {
  it("returns the summary inside { data }", async () => {
    buildBillingSummary.mockResolvedValue({
      state: "free",
      tier: "free",
      cycle: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      hasStripeCustomer: false,
    });
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.state).toBe("free");
  });

  it("returns 404 when billing is disabled", async () => {
    const mod = await import("../src/lib/billing-flags");
    (mod.isBillingEnabled as any) = () => false;
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-summary-route`
Expected: FAIL on missing import.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/dashboard/billing/summary.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, db, MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { ok } from "../../../lib/response";
import { buildBillingSummary } from "../../../services/billing/billing-summary";

export const summaryRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    if (!isBillingEnabled()) {
      throw new HTTPException(404, { message: "Not found" });
    }
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const summary = await buildBillingSummary(db, projectId);
    return c.json(ok(summary));
  });
```

- [ ] **Step 4: Create the billing sub-router**

Create `apps/api/src/routes/dashboard/billing/index.ts`:

```ts
import { Hono } from "hono";
import { summaryRoute } from "./summary";

export const billingSubRouter = new Hono().route("/", summaryRoute);
```

- [ ] **Step 5: Mount on dashboard router**

Open `apps/api/src/routes/dashboard/index.ts`. Add `import { billingSubRouter }
from "./billing";` and chain a route like the others:

```ts
.route("/projects/:projectId/billing", billingSubRouter)
```

Put it next to where projects routes are mounted so the path order is
stable.

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @rovenue/api test -- billing-summary-route`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/billing/summary.ts \
        apps/api/src/routes/dashboard/billing/index.ts \
        apps/api/src/routes/dashboard/index.ts \
        apps/api/tests/billing-summary-route.test.ts
git commit -m "feat(api/billing): GET /dashboard/projects/:id/billing (summary)"
```

---

## Task 20: Dashboard endpoint — `POST .../billing/upgrade`

**Files:**
- Create: `apps/api/src/routes/dashboard/billing/upgrade.ts`
- Modify: `apps/api/src/routes/dashboard/billing/index.ts`
- Create: `apps/api/tests/billing-upgrade-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const upgradeProject = vi.fn();
vi.mock("../src/services/billing/upgrade-project", () => ({ upgradeProject }));
vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled: () => true }));
vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    c.set("session", { id: "s1" });
    await next();
  },
}));
vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
}));

import { billingSubRouter } from "../src/routes/dashboard/billing";

describe("POST /dashboard/projects/:projectId/billing/upgrade", () => {
  it("returns clientSecret + publishableKey on success", async () => {
    upgradeProject.mockResolvedValue({
      clientSecret: "seti_cs_xyz",
      publishableKey: "pk_test_xxx",
    });
    const app = new Hono().route(
      "/projects/:projectId/billing",
      billingSubRouter,
    );
    const res = await app.request("/projects/p1/billing/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycle: "monthly" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.clientSecret).toBe("seti_cs_xyz");
  });

  it("returns 409 when already active", async () => {
    upgradeProject.mockRejectedValue(
      Object.assign(new Error("state=active"), { code: "already_active" }),
    );
    const app = new Hono().route(
      "/projects/:projectId/billing",
      billingSubRouter,
    );
    const res = await app.request("/projects/p2/billing/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycle: "monthly" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 when cycle != monthly (annual deferred to P6)", async () => {
    const app = new Hono().route(
      "/projects/:projectId/billing",
      billingSubRouter,
    );
    const res = await app.request("/projects/p1/billing/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycle: "annual" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-upgrade-route`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/dashboard/billing/upgrade.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { ok } from "../../../lib/response";
import { upgradeProject } from "../../../services/billing/upgrade-project";

const bodySchema = z.object({
  cycle: z.literal("monthly"), // Phase 2: monthly only. P6 adds "annual".
});

export const upgradeRoute = new Hono()
  .use("*", requireDashboardAuth)
  .post("/", zValidator("json", bodySchema), async (c) => {
    if (!isBillingEnabled()) {
      throw new HTTPException(404, { message: "Not found" });
    }
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const { cycle } = c.req.valid("json");

    try {
      const out = await upgradeProject({ db, projectId, cycle });
      return c.json(ok(out));
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "already_active") {
        throw new HTTPException(409, { message: "Project already active" });
      }
      if (code === "billing_disabled") {
        throw new HTTPException(404, { message: "Not found" });
      }
      if (code === "config_missing") {
        throw new HTTPException(503, { message: "Billing misconfigured" });
      }
      throw e;
    }
  });
```

- [ ] **Step 4: Add it to the billing sub-router**

Edit `apps/api/src/routes/dashboard/billing/index.ts`:

```ts
import { Hono } from "hono";
import { summaryRoute } from "./summary";
import { upgradeRoute } from "./upgrade";

export const billingSubRouter = new Hono()
  .route("/", summaryRoute)
  .route("/upgrade", upgradeRoute);
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @rovenue/api test -- billing-upgrade-route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/billing/upgrade.ts \
        apps/api/src/routes/dashboard/billing/index.ts \
        apps/api/tests/billing-upgrade-route.test.ts
git commit -m "feat(api/billing): POST /dashboard/projects/:id/billing/upgrade"
```

---

## Task 21: Dashboard endpoint — payment-methods CRUD

**Files:**
- Create: `apps/api/src/routes/dashboard/billing/payment-methods.ts`
- Modify: `apps/api/src/routes/dashboard/billing/index.ts`
- Create: `apps/api/tests/billing-payment-methods-route.test.ts`

The route exposes:
- `GET    /` — list payment methods for project
- `POST   /` — start add-card flow (calls `startAddPaymentMethod`)
- `POST   /:pmId/default` — promote to default
- `DELETE /:pmId` — detach (Phase-2 hard rule: only allowed when there is
  more than one card OR the project is currently in state='free'. The
  "downgrade-then-detach" last-card flow is P6.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const listPMs = vi.fn();
const startAdd = vi.fn();
const findDefault = vi.fn();
const setDefault = vi.fn();
const deletePM = vi.fn();
const findPMById = vi.fn();
const detachStripe = vi.fn();
const findSub = vi.fn();

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingPaymentMethodRepo: {
        listPaymentMethodsForProject: listPMs,
        findDefaultPaymentMethod: findDefault,
        setDefaultPaymentMethod: setDefault,
        deletePaymentMethod: deletePM,
        findPaymentMethodById: findPMById,
      },
      billingSubscriptionRepo: { findBillingSubscriptionByProject: findSub },
    },
  };
});

vi.mock("../src/services/billing/add-payment-method", () => ({
  startAddPaymentMethod: startAdd,
}));

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    paymentMethods: { detach: detachStripe },
  }),
}));

vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled: () => true }));
vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    c.set("session", { id: "s1" });
    await next();
  },
}));
vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
}));

import { billingSubRouter } from "../src/routes/dashboard/billing";

describe("payment-methods routes", () => {
  it("GET / returns the list", async () => {
    listPMs.mockResolvedValue([{
      id: "pm_row",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    }]);
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/payment-methods");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].last4).toBe("4242");
  });

  it("POST / returns clientSecret for add-card flow", async () => {
    startAdd.mockResolvedValue({
      clientSecret: "seti_cs_add",
      publishableKey: "pk_test_xxx",
    });
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/payment-methods", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.clientSecret).toBe("seti_cs_add");
  });

  it("POST /:pmId/default swaps default", async () => {
    findPMById.mockResolvedValue({
      id: "pm_row",
      projectId: "p1",
      stripePaymentMethodId: "pm_x",
    });
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/payment-methods/pm_row/default", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(setDefault).toHaveBeenCalledWith({}, "p1", "pm_row");
  });

  it("DELETE /:pmId refuses last card on active project", async () => {
    listPMs.mockResolvedValue([
      { id: "pm_row", stripePaymentMethodId: "pm_x", isDefault: true },
    ]);
    findPMById.mockResolvedValue({
      id: "pm_row",
      projectId: "p1",
      stripePaymentMethodId: "pm_x",
    });
    findSub.mockResolvedValue({ projectId: "p1", state: "active" });
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/payment-methods/pm_row", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    expect(detachStripe).not.toHaveBeenCalled();
  });

  it("DELETE /:pmId detaches when not the last card", async () => {
    listPMs.mockResolvedValue([
      { id: "pm_row", stripePaymentMethodId: "pm_x", isDefault: false },
      { id: "pm_row2", stripePaymentMethodId: "pm_y", isDefault: true },
    ]);
    findPMById.mockResolvedValue({
      id: "pm_row",
      projectId: "p1",
      stripePaymentMethodId: "pm_x",
    });
    findSub.mockResolvedValue({ projectId: "p1", state: "active" });
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/payment-methods/pm_row", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(detachStripe).toHaveBeenCalledWith("pm_x");
    // payment_method.detached webhook is what actually removes the row;
    // the route does not call deletePM directly.
    expect(deletePM).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-payment-methods-route`
Expected: FAIL.

- [ ] **Step 3: Add `findPaymentMethodById` to the repo**

Edit `packages/db/src/drizzle/repositories/billing-payment-methods.ts`:

```ts
export async function findPaymentMethodById(
  db: Db,
  paymentMethodId: string,
): Promise<BillingPaymentMethod | null> {
  const rows = await db
    .select()
    .from(billingPaymentMethods)
    .where(eq(billingPaymentMethods.id, paymentMethodId))
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Implement the route**

Create `apps/api/src/routes/dashboard/billing/payment-methods.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, db, MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { getPlatformStripe } from "../../../lib/stripe-billing";
import { ok } from "../../../lib/response";
import { startAddPaymentMethod } from "../../../services/billing/add-payment-method";

function ensureEnabled() {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
}

export const paymentMethodsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const rows = await drizzle.billingPaymentMethodRepo
      .listPaymentMethodsForProject(db, projectId);
    return c.json(
      ok(rows.map((r) => ({
        id: r.id,
        brand: r.brand,
        last4: r.last4,
        expMonth: r.expMonth,
        expYear: r.expYear,
        isDefault: r.isDefault,
        createdAt: r.createdAt.toISOString(),
      }))),
    );
  })
  .post("/", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    try {
      const out = await startAddPaymentMethod({ db, projectId });
      return c.json(ok(out));
    } catch (e) {
      if ((e as { code?: string }).code === "no_customer") {
        throw new HTTPException(409, { message: "Upgrade the project first" });
      }
      throw e;
    }
  })
  .post("/:pmId/default", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    const pmId = c.req.param("pmId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const pm = await drizzle.billingPaymentMethodRepo.findPaymentMethodById(db, pmId);
    if (!pm || pm.projectId !== projectId) {
      throw new HTTPException(404, { message: "Payment method not found" });
    }
    await drizzle.billingPaymentMethodRepo.setDefaultPaymentMethod(
      db,
      projectId,
      pmId,
    );
    // Also propagate to Stripe so future invoices pick the new default.
    const stripe = getPlatformStripe();
    const sub = await drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject(db, projectId);
    if (stripe && sub?.stripeCustomerId) {
      await stripe.customers.update(sub.stripeCustomerId, {
        invoice_settings: { default_payment_method: pm.stripePaymentMethodId },
      });
    }
    return c.json(ok({ id: pmId }));
  })
  .delete("/:pmId", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    const pmId = c.req.param("pmId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const pm = await drizzle.billingPaymentMethodRepo.findPaymentMethodById(db, pmId);
    if (!pm || pm.projectId !== projectId) {
      throw new HTTPException(404, { message: "Payment method not found" });
    }
    const all = await drizzle.billingPaymentMethodRepo
      .listPaymentMethodsForProject(db, projectId);
    const sub = await drizzle.billingSubscriptionRepo
      .findBillingSubscriptionByProject(db, projectId);
    const isLast = all.length <= 1;
    const isPaid = sub?.state === "active" || sub?.state === "past_due";
    if (isLast && isPaid) {
      throw new HTTPException(409, {
        message: "Cannot remove the last card on a paid project (P6: downgrade-then-detach)",
      });
    }
    const stripe = getPlatformStripe();
    if (!stripe) throw new HTTPException(503, { message: "Billing misconfigured" });
    await stripe.paymentMethods.detach(pm.stripePaymentMethodId);
    // payment_method.detached webhook removes the DB row.
    return c.json(ok({ detaching: true }));
  });
```

- [ ] **Step 5: Mount on the billing sub-router**

Edit `apps/api/src/routes/dashboard/billing/index.ts`:

```ts
import { Hono } from "hono";
import { summaryRoute } from "./summary";
import { upgradeRoute } from "./upgrade";
import { paymentMethodsRoute } from "./payment-methods";

export const billingSubRouter = new Hono()
  .route("/", summaryRoute)
  .route("/upgrade", upgradeRoute)
  .route("/payment-methods", paymentMethodsRoute);
```

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @rovenue/api test -- billing-payment-methods-route`
Expected: PASS (all five cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/billing/payment-methods.ts \
        apps/api/src/routes/dashboard/billing/index.ts \
        packages/db/src/drizzle/repositories/billing-payment-methods.ts \
        apps/api/tests/billing-payment-methods-route.test.ts
git commit -m "feat(api/billing): /dashboard/projects/:id/billing/payment-methods CRUD"
```

---

## Task 22: Dashboard endpoint — `GET .../billing/invoices`

**Files:**
- Create: `apps/api/src/routes/dashboard/billing/invoices.ts`
- Modify: `apps/api/src/routes/dashboard/billing/index.ts`
- Create: `apps/api/tests/billing-invoices-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const listInvoices = vi.fn();
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<any>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingInvoiceRepo: { listInvoicesForProject: listInvoices },
    },
  };
});
vi.mock("../src/lib/billing-flags", () => ({ isBillingEnabled: () => true }));
vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    c.set("session", { id: "s1" });
    await next();
  },
}));
vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
}));

import { billingSubRouter } from "../src/routes/dashboard/billing";

describe("GET /dashboard/projects/:projectId/billing/invoices", () => {
  it("returns the wire-serialised list", async () => {
    listInvoices.mockResolvedValue([{
      id: "inv_row",
      number: "RV-001",
      status: "paid",
      amountDue: "29.0000",
      amountPaid: "29.0000",
      refundedAmount: "0",
      currency: "usd",
      periodStart: new Date("2026-06-01T00:00:00Z"),
      periodEnd: new Date("2026-07-01T00:00:00Z"),
      hostedInvoiceUrl: "https://stripe.test/invoice/x",
      pdfUrl: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    }]);
    const app = new Hono().route("/projects/:projectId/billing", billingSubRouter);
    const res = await app.request("/projects/p1/billing/invoices");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].number).toBe("RV-001");
    expect(body.data[0].periodStart).toBe("2026-06-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- billing-invoices-route`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/dashboard/billing/invoices.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, db, MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { ok } from "../../../lib/response";

export const invoicesRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    if (!isBillingEnabled()) {
      throw new HTTPException(404, { message: "Not found" });
    }
    const projectId = c.req.param("projectId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const rows = await drizzle.billingInvoiceRepo.listInvoicesForProject(
      db,
      projectId,
    );
    return c.json(
      ok(rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        amountDue: r.amountDue,
        amountPaid: r.amountPaid,
        refundedAmount: r.refundedAmount ?? "0",
        currency: r.currency,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        hostedInvoiceUrl: r.hostedInvoiceUrl,
        pdfUrl: r.pdfUrl,
        createdAt: r.createdAt.toISOString(),
      }))),
    );
  });
```

- [ ] **Step 4: Mount on sub-router**

```ts
// apps/api/src/routes/dashboard/billing/index.ts
import { invoicesRoute } from "./invoices";

export const billingSubRouter = new Hono()
  .route("/", summaryRoute)
  .route("/upgrade", upgradeRoute)
  .route("/payment-methods", paymentMethodsRoute)
  .route("/invoices", invoicesRoute);
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @rovenue/api test -- billing-invoices-route`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/billing/invoices.ts \
        apps/api/src/routes/dashboard/billing/index.ts \
        apps/api/tests/billing-invoices-route.test.ts
git commit -m "feat(api/billing): GET /dashboard/projects/:id/billing/invoices"
```

---

## Task 23: Dashboard deps — `@stripe/stripe-js` + `@stripe/react-stripe-js`

**Files:**
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Add the packages**

Run from repo root:

```bash
pnpm --filter @rovenue/dashboard add @stripe/stripe-js@^4 @stripe/react-stripe-js@^3
```

- [ ] **Step 2: Verify the dashboard still type-checks**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "chore(dashboard): add @stripe/stripe-js + @stripe/react-stripe-js"
```

---

## Task 24: Dashboard — billing component re-exports

**Files:**
- Create: `apps/dashboard/src/components/billing/plan-card.tsx` (copy from
  `components/account/plan-card.tsx`)
- Create: `apps/dashboard/src/components/billing/payment-method-row.tsx` (copy
  from `components/account/payment-method-row.tsx`)
- Create: `apps/dashboard/src/components/billing/invoice-status-chip.tsx`
  (copy from `components/account/invoice-status-chip.tsx`)
- Create: `apps/dashboard/src/components/billing/index.ts` — barrel
- Modify: `apps/dashboard/src/components/account/index.ts` — remove the
  three re-exports that are now under `components/billing/`

- [ ] **Step 1: Copy files**

```bash
cp apps/dashboard/src/components/account/plan-card.tsx \
   apps/dashboard/src/components/billing/plan-card.tsx
cp apps/dashboard/src/components/account/payment-method-row.tsx \
   apps/dashboard/src/components/billing/payment-method-row.tsx
cp apps/dashboard/src/components/account/invoice-status-chip.tsx \
   apps/dashboard/src/components/billing/invoice-status-chip.tsx
```

- [ ] **Step 2: Write the barrel**

```ts
// apps/dashboard/src/components/billing/index.ts
export { PlanCard } from "./plan-card";
export { PaymentMethodRow } from "./payment-method-row";
export { InvoiceStatusChip } from "./invoice-status-chip";
export { UpgradeModal } from "./upgrade-modal"; // Task 25
```

- [ ] **Step 3: Drop the account-side re-exports**

Open `apps/dashboard/src/components/account/index.ts` and remove the lines
that export `PlanCard`, `PaymentMethodRow`, `InvoiceStatusChip`. Delete
the source files in `components/account/` too — no caller will be left
once Tasks 28-31 land.

Note: the line above is a forward reference to Task 25's UpgradeModal —
add it to the barrel after Task 25 lands (re-order the commit if you
prefer; leaving the export to Task 25 keeps the commit reviewable).

- [ ] **Step 4: Run the dashboard typecheck**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS (or fail with "Cannot find module './upgrade-modal'" — if
so, drop that line for now and add it back in Task 25).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/billing/ \
        apps/dashboard/src/components/account/index.ts \
        apps/dashboard/src/components/account/plan-card.tsx \
        apps/dashboard/src/components/account/payment-method-row.tsx \
        apps/dashboard/src/components/account/invoice-status-chip.tsx
git commit -m "refactor(dashboard): move billing components under components/billing/"
```

---

## Task 25: Dashboard — `UpgradeModal` (Stripe Elements host)

**Files:**
- Create: `apps/dashboard/src/components/billing/upgrade-modal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
import { useEffect, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Button } from "../../ui/button";

interface UpgradeModalProps {
  clientSecret: string;
  publishableKey: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function UpgradeModal(props: UpgradeModalProps) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    setStripePromise(loadStripe(props.publishableKey));
  }, [props.publishableKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Upgrade to Indie</h2>
        <p className="mt-1 text-sm text-rv-mute-600">
          $29 / month. Cancellable any time.
        </p>
        {stripePromise && (
          <Elements
            stripe={stripePromise}
            options={{ clientSecret: props.clientSecret }}
          >
            <InnerForm onClose={props.onClose} onSuccess={props.onSuccess} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function InnerForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? "Payment confirmation failed");
      return;
    }
    onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p className="text-sm text-rv-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="flat" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid-primary" type="submit" disabled={submitting}>
          {submitting ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Add the export to the billing barrel** (if not already from
  Task 24)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/billing/upgrade-modal.tsx \
        apps/dashboard/src/components/billing/index.ts
git commit -m "feat(dashboard): UpgradeModal (Stripe Elements + confirmSetup)"
```

---

## Task 26: Dashboard — typed API wrappers + TanStack hooks

**Files:**
- Create: `apps/dashboard/src/lib/api-billing.ts`
- Create: `apps/dashboard/src/hooks/useBillingSummary.ts`
- Create: `apps/dashboard/src/hooks/useInvoices.ts`
- Create: `apps/dashboard/src/hooks/usePaymentMethods.ts`
- Create: `apps/dashboard/src/hooks/useUpgradeMutation.ts`

- [ ] **Step 1: Add the typed wrappers**

Create `apps/dashboard/src/lib/api-billing.ts`:

```ts
import { rpc, unwrap } from "./api";
import type {
  BillingSummary,
  InvoiceSummary,
  PaymentMethodSummary,
  UpgradeResponse,
} from "@rovenue/shared";

export async function fetchBillingSummary(projectId: string): Promise<BillingSummary> {
  const res = await rpc.dashboard.projects[":projectId"].billing.$get({
    param: { projectId },
  });
  return unwrap<BillingSummary>(res);
}

export async function fetchInvoices(projectId: string): Promise<InvoiceSummary[]> {
  const res = await rpc.dashboard.projects[":projectId"].billing.invoices.$get({
    param: { projectId },
  });
  return unwrap<InvoiceSummary[]>(res);
}

export async function fetchPaymentMethods(projectId: string): Promise<PaymentMethodSummary[]> {
  const res = await rpc.dashboard.projects[":projectId"].billing["payment-methods"].$get({
    param: { projectId },
  });
  return unwrap<PaymentMethodSummary[]>(res);
}

export async function startUpgrade(projectId: string): Promise<UpgradeResponse> {
  const res = await rpc.dashboard.projects[":projectId"].billing.upgrade.$post({
    param: { projectId },
    json: { cycle: "monthly" },
  });
  return unwrap<UpgradeResponse>(res);
}

export async function startAddCard(projectId: string): Promise<UpgradeResponse> {
  const res = await rpc.dashboard.projects[":projectId"].billing["payment-methods"].$post({
    param: { projectId },
  });
  return unwrap<UpgradeResponse>(res);
}

export async function setDefaultPaymentMethod(
  projectId: string,
  pmId: string,
): Promise<void> {
  const res = await rpc.dashboard.projects[":projectId"].billing["payment-methods"][":pmId"].default.$post({
    param: { projectId, pmId },
  });
  await unwrap(res);
}

export async function detachPaymentMethod(
  projectId: string,
  pmId: string,
): Promise<void> {
  const res = await rpc.dashboard.projects[":projectId"].billing["payment-methods"][":pmId"].$delete({
    param: { projectId, pmId },
  });
  await unwrap(res);
}
```

(If the Hono RPC path inference produces a different shape, follow the
patterns in existing dashboard wrappers — see `apps/dashboard/src/lib/api.ts`
docstring + how `apps/dashboard/src/hooks/...` consume it.)

- [ ] **Step 2: Add hooks**

`apps/dashboard/src/hooks/useBillingSummary.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchBillingSummary } from "../lib/api-billing";

export function useBillingSummary(projectId: string) {
  return useQuery({
    queryKey: ["billing", "summary", projectId],
    queryFn: () => fetchBillingSummary(projectId),
  });
}
```

`apps/dashboard/src/hooks/useInvoices.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchInvoices } from "../lib/api-billing";

export function useInvoices(projectId: string) {
  return useQuery({
    queryKey: ["billing", "invoices", projectId],
    queryFn: () => fetchInvoices(projectId),
  });
}
```

`apps/dashboard/src/hooks/usePaymentMethods.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchPaymentMethods } from "../lib/api-billing";

export function usePaymentMethods(projectId: string) {
  return useQuery({
    queryKey: ["billing", "payment-methods", projectId],
    queryFn: () => fetchPaymentMethods(projectId),
  });
}
```

`apps/dashboard/src/hooks/useUpgradeMutation.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startUpgrade } from "../lib/api-billing";

export function useUpgradeMutation(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => startUpgrade(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing", "summary", projectId] });
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/api-billing.ts \
        apps/dashboard/src/hooks/useBillingSummary.ts \
        apps/dashboard/src/hooks/useInvoices.ts \
        apps/dashboard/src/hooks/usePaymentMethods.ts \
        apps/dashboard/src/hooks/useUpgradeMutation.ts
git commit -m "feat(dashboard): typed RPC wrappers + TanStack hooks for billing"
```

---

## Task 27: Dashboard — `projects/:projectId/settings/billing.tsx`

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/billing.tsx`

- [ ] **Step 1: Implement the page**

```tsx
import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useBillingSummary } from "../../../../../hooks/useBillingSummary";
import { useUpgradeMutation } from "../../../../../hooks/useUpgradeMutation";
import { PlanCard, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/billing",
)({
  component: BillingPage,
});

function BillingPage() {
  const { projectId } = useParams({ from: Route.id });
  const summary = useBillingSummary(projectId);
  const upgrade = useUpgradeMutation(projectId);
  const [setupSecret, setSetupSecret] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (summary.isLoading) return <div className="p-6">Loading…</div>;
  if (summary.isError) return <div className="p-6">Failed to load billing</div>;
  const s = summary.data!;

  return (
    <div className="flex flex-col gap-6 p-6">
      <PlanCard
        eyebrow="Plan"
        name={tierLabel(s.tier)}
        description={
          s.state === "free"
            ? "Free tier — upgrade to unlock paid features."
            : `${s.cycle === "monthly" ? "Monthly" : "Annual"} cycle.`
        }
        stats={s.currentPeriodEnd ? [{
          label: "Next bill",
          value: new Date(s.currentPeriodEnd).toLocaleDateString(),
          mono: true,
        }] : []}
        actions={
          s.state === "free" ? (
            <Button
              variant="solid-primary"
              disabled={upgrade.isPending}
              onClick={async () => {
                const res = await upgrade.mutateAsync();
                setSetupSecret(res);
              }}
            >
              {upgrade.isPending ? "Preparing…" : "Upgrade to Indie ($29 / mo)"}
            </Button>
          ) : null
        }
      />

      {setupSecret && (
        <UpgradeModal
          clientSecret={setupSecret.clientSecret}
          publishableKey={setupSecret.publishableKey}
          onClose={() => setSetupSecret(null)}
          onSuccess={() => {
            setSetupSecret(null);
            summary.refetch();
          }}
        />
      )}
    </div>
  );
}

function tierLabel(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
```

- [ ] **Step 2: Typecheck + dev build**

Run: `pnpm --filter @rovenue/dashboard typecheck && pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/billing.tsx
git commit -m "feat(dashboard): project-scoped billing page (upgrade flow)"
```

---

## Task 28: Dashboard — payment-methods page

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/payment-methods.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePaymentMethods } from "../../../../../hooks/usePaymentMethods";
import {
  detachPaymentMethod,
  setDefaultPaymentMethod,
  startAddCard,
} from "../../../../../lib/api-billing";
import { PaymentMethodRow, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/payment-methods",
)({
  component: PaymentMethodsPage,
});

function PaymentMethodsPage() {
  const { projectId } = useParams({ from: Route.id });
  const pms = usePaymentMethods(projectId);
  const qc = useQueryClient();
  const [setupSecret, setSetupSecret] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  const addCard = useMutation({
    mutationFn: () => startAddCard(projectId),
    onSuccess: (res) => setSetupSecret(res),
  });
  const setDefault = useMutation({
    mutationFn: (pmId: string) => setDefaultPaymentMethod(projectId, pmId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing", "payment-methods", projectId] }),
  });
  const detach = useMutation({
    mutationFn: (pmId: string) => detachPaymentMethod(projectId, pmId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing", "payment-methods", projectId] }),
  });

  if (pms.isLoading) return <div className="p-6">Loading…</div>;
  const rows = pms.data ?? [];

  return (
    <div className="flex flex-col gap-3 p-6">
      {rows.map((pm) => (
        <PaymentMethodRow
          key={pm.id}
          brand={pm.brand.toUpperCase()}
          number={`${pm.brand} •••• ${pm.last4}`}
          meta={`Expires ${String(pm.expMonth).padStart(2, "0")}/${pm.expYear}`}
          isDefault={pm.isDefault}
          actions={
            <div className="flex gap-2">
              {!pm.isDefault && (
                <Button variant="light" onClick={() => setDefault.mutate(pm.id)}>
                  Set default
                </Button>
              )}
              <Button variant="light" onClick={() => detach.mutate(pm.id)}>
                Remove
              </Button>
            </div>
          }
        />
      ))}

      <Button variant="flat" onClick={() => addCard.mutate()} disabled={addCard.isPending}>
        Add card
      </Button>

      {setupSecret && (
        <UpgradeModal
          clientSecret={setupSecret.clientSecret}
          publishableKey={setupSecret.publishableKey}
          onClose={() => setSetupSecret(null)}
          onSuccess={() => {
            setSetupSecret(null);
            pms.refetch();
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/payment-methods.tsx
git commit -m "feat(dashboard): project-scoped payment-methods page"
```

---

## Task 29: Dashboard — invoices page

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/invoices.tsx`

- [ ] **Step 1: Implement**

```tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useInvoices } from "../../../../../hooks/useInvoices";
import { InvoiceStatusChip } from "../../../../../components/billing";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/invoices",
)({
  component: InvoicesPage,
});

function InvoicesPage() {
  const { projectId } = useParams({ from: Route.id });
  const invoices = useInvoices(projectId);

  if (invoices.isLoading) return <div className="p-6">Loading…</div>;
  const rows = invoices.data ?? [];

  return (
    <div className="flex flex-col gap-3 p-6">
      {rows.length === 0 && (
        <p className="text-sm text-rv-mute-600">No invoices yet.</p>
      )}
      {rows.map((inv) => {
        const refunded = parseFloat(inv.refundedAmount ?? "0") > 0;
        return (
          <div
            key={inv.id}
            className="flex items-center justify-between rounded-md border border-rv-mute-200 p-3"
          >
            <div className="flex flex-col">
              <span className="font-medium">{inv.number}</span>
              <span className="text-xs text-rv-mute-500">
                {new Date(inv.periodStart).toLocaleDateString()} –{" "}
                {new Date(inv.periodEnd).toLocaleDateString()}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <InvoiceStatusChip status={refunded ? "Refunded" : invStatusLabel(inv.status)} />
              <span className="font-mono text-sm">
                ${parseFloat(inv.amountDue).toFixed(2)}
              </span>
              {inv.pdfUrl && (
                <a className="text-sm text-rv-primary underline" href={inv.pdfUrl}>
                  PDF
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function invStatusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

If `InvoiceStatusChip`'s prop type doesn't accept arbitrary strings, expand
its prop union to include `"Refunded"` in this commit.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/invoices.tsx \
        apps/dashboard/src/components/billing/invoice-status-chip.tsx
git commit -m "feat(dashboard): project-scoped invoices page"
```

---

## Task 30: Dashboard — settings nav + delete old account billing pages

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/route.tsx`
- Delete: `apps/dashboard/src/routes/_authed/account/billing.tsx`
- Delete: `apps/dashboard/src/routes/_authed/account/invoices.tsx`
- Modify: `apps/dashboard/src/components/account/account-nav-config.ts`

- [ ] **Step 1: Add three nav entries to the settings sidebar**

Open `apps/dashboard/src/routes/_authed/projects/$projectId/settings/route.tsx`.
Add three entries (`Billing`, `Payment methods`, `Invoices`) to the
existing settings nav. Match the structure of the existing entries (eg.
`{ to: "/projects/$projectId/settings/billing", label: "Billing" }`).

- [ ] **Step 2: Delete the account-level mocks**

```bash
git rm apps/dashboard/src/routes/_authed/account/billing.tsx \
       apps/dashboard/src/routes/_authed/account/invoices.tsx
```

- [ ] **Step 3: Drop them from the account nav config**

Open `apps/dashboard/src/components/account/account-nav-config.ts`. Remove
the entries that link to the two deleted routes. `account/usage.tsx` stays
as a mock for now — it will be re-scoped in Phase 3 alongside real usage
data.

- [ ] **Step 4: Verify routes**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS. (TanStack Router's file-route plugin will regenerate the
route tree; any stale references in the auto-generated `routeTree.gen.ts`
must be regenerated — run the dashboard dev server briefly if needed to
trigger that.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/route.tsx \
        apps/dashboard/src/components/account/account-nav-config.ts \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "refactor(dashboard): move billing pages under project settings; delete account mocks"
```

---

## Task 31: End-to-end smoke test (manual + dev-server walkthrough)

**Files:** none.

- [ ] **Step 1: Set up local Stripe sandbox**

```bash
# Get a test-mode product + price in your Stripe sandbox.
stripe products create --name "Rovenue Indie"
stripe prices create --product=<product_id> --unit-amount=2900 --currency=usd --recurring[interval]=month
```

Copy the returned `price_id` into `.env` as `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID`.

- [ ] **Step 2: Forward Stripe webhooks to the local API**

```bash
stripe listen --forward-to localhost:3000/billing/stripe/webhook
```

Copy the `whsec_...` value into `STRIPE_BILLING_WEBHOOK_SECRET`.

- [ ] **Step 3: Run the stack**

```bash
BILLING_ENABLED=true pnpm dev
```

- [ ] **Step 4: Walk the flow**

1. Open `http://localhost:5173`, sign in, create a project (or pick existing).
2. Navigate to Settings → Billing. Confirm the PlanCard shows "Free".
3. Click "Upgrade to Indie ($29/mo)". The modal opens.
4. Enter Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
5. Submit. Modal closes. PlanCard refreshes within ~2s and shows "Indie /
   Next bill ...".
6. Navigate to Settings → Payment methods. Confirm the card is listed and
   marked default.
7. Click Add card. Repeat with `5555 5555 5555 4444`. Confirm it appears
   as non-default.
8. Click Set default on the second card. Refresh; default badge moved.
9. Click Remove on the non-default card. Confirm it disappears within ~2s.
10. Try Remove on the remaining (default) card. Expect a 409 with the
    "Cannot remove last card" message.
11. Navigate to Settings → Invoices. Confirm one invoice is listed with
    status "paid".
12. In Stripe dashboard, issue a partial refund. Confirm the invoice page
    flips to "Refunded" badge within ~2s of the webhook arriving.

- [ ] **Step 5: Document any deviations in a follow-up issue, not in the
       plan**

- [ ] **Step 6: No commit needed — close the plan**

---

## Out of scope (for reviewer reference)

These spec items are explicitly **not** delivered by Phase 2 and live in
later plans:

- Dunning / past_due transitions / D30 suspender — **P5**
- SDK `billing-gate` middleware (`/v1/*` returns 402) — **P5**
- Dashboard `paywall-redirect` middleware + Paywall component — **P5**
- Usage metering (ClickHouse MV, `usage_snapshots`, banner) — **P3**
- Tier auto-derive from MTR + nightly bracket evaluator — **P4**
- Pro / Scale / Growth / Enterprise tiers — **P4** (price seeds) and **P6**
- Annual cycle + monthly↔annual switcher — **P6**
- Downgrade to Free / Pause / Resume — **P6**
- Last-card "Downgrade & remove" flow — **P6** (this plan returns 409)
- Project delete + 30d grace + GDPR/KVKK anonymise — **P7**
- Billing details form (tax ID, legal entity, address) — **P7**

Each of the eight Stripe events Phase 2 handles is the *narrow* version
of what the spec ultimately requires — handlers here intentionally skip
state writes that downstream phases own.

## Spec coverage self-review

| Spec section | Phase-2 task(s) |
|---|---|
| Lazy customer creation (Stripe customer on first upgrade) | T8, T11 |
| SetupIntent flow | T8, T11 |
| `setup_intent.succeeded` → insert PM + create subscription | T11 |
| `customer.subscription.created` → state=active | T12 |
| `customer.subscription.updated` → sync period | T13 |
| `invoice.created` / `.finalized` mirror | T14 |
| `invoice.payment_succeeded` → status=paid + outbox | T15 |
| `charge.refunded` → refunded_amount | T16 |
| `payment_method.detached` → remove row | T16 |
| Webhook idempotency via `webhook_events` | T17 |
| Audit + outbox per state mutation | T10, T12, T15 |
| Dashboard endpoints (summary, upgrade, PM CRUD, invoices) | T19–T22 |
| Project-scoped pages replace account/billing,invoices | T27–T30 |
| OWNER/ADMIN gating | T19, T20, T21, T22 (assertProjectAccess) |
| Stripe Elements UI | T25 |
| Last-card refusal on active project | T21 |
| `BILLING_ENABLED=false` returns 404 | T19, T20, T21, T22 |
| `aggregate_type` enum extension | T1 |
| Tier-limits repo for `stripe_price_id` lookup | T3 |
