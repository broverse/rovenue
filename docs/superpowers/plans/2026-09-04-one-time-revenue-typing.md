# One-Time Purchase Revenue Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and correctly type the revenue of one-time (non-subscription) purchases on all three stores, so it reaches integration providers, ClickHouse, and every revenue report.

**Architecture:** A single pure rule maps `ProductType` to a revenue type; a new `NON_RENEWING_PURCHASE` enum value carries the distinction into ClickHouse; the fourteen hand-written SQL type allow-lists collapse into five named groupings so a future enum value forces one decision per grouping instead of vanishing; two new public event keys reach the fourteen integration providers, guarded by a compile-time bijection between the Postgres enum and the public catalog.

**Tech Stack:** TypeScript (strict), Hono, Drizzle ORM, PostgreSQL 16 (range-partitioned `revenue_events`), ClickHouse, Vitest + testcontainers, React (dashboard).

**Spec:** `docs/superpowers/specs/2026-09-04-one-time-revenue-typing-design.md`

## Global Constraints

- **Stay on the current branch.** Do not create, switch, or delete branches or worktrees. Do not create a git worktree for any task.
- **Throttle test runs.** The machine strains under full-suite runs. Use `nice -n 19 npx vitest run --maxWorkers=2 <path>` and run suites strictly sequentially — never two test commands in parallel. Builds use `--concurrency=2`.
- **No magic values.** Hoist repeated literals into named constants. Structured data tables (mapping tables, fixture tables) are not magic values and stay as they are.
- **Self-confirming tests prove nothing.** A test that constructs the error it asserts on, mocks the transaction it claims rolls back, or mocks ClickHouse and then asserts on the mock is not evidence. Revenue-path tests run against a real Postgres/ClickHouse testcontainer.
- **Never stage files you did not change.** `git add` exact paths only. `apps/dashboard/src/components/assets/asset-library.tsx`, `packages/db/seed.ts`, `docker-compose.yml`, `.dockerignore` and the various `package.json` files carry unrelated in-flight work; they must never appear in a commit from this plan.
- **`revenue_events` is append-only by convention and range-partitioned.** Never `UPDATE` an existing row; never propose a migration that rewrites the table.
- **Refund `amountUsd` is stored POSITIVE.** Do not introduce a negative-amount convention anywhere.
- **In Drizzle `sql` templates, qualify columns** (`"revenue_events"."type"`). A bare `${table.col}` renders unqualified and breaks correlated subqueries.
- **Integration tests need Docker running.** `docker ps` first — vitest hangs silently otherwise. After adding a Postgres migration, drop the template database (`rovenue_test_tpl`) or the new migration will not be applied to test databases.
- **`@rovenue/db` vitest runs need `DATABASE_URL` exported** in the shell.
- **Test-helper names in this plan are illustrative, not binding.** Where a task's test code calls a helper (`verifyAndCapture`, `seedPendingOneTimeSession`, `insertRawRevenueEvent`, `runMigration`, …), use the helper the target test file already has, or write one in that file's existing style. Do not invent a new helper module because this plan spelled a name.
- **`@rovenue/shared` must not import `@rovenue/db`** — the dashboard and the SDK consume shared. Lists in shared are literals guarded by `satisfies`; the correspondence to the Postgres enum is held in `apps/api`, which can see both (Task 9).
- **In `apps/api` tests, top-of-file `process.env` assignments before imports are dead code** (hoisting). Use `vi.hoisted` or `tests/setup.ts`.
- **ClickHouse from the host fails with "password is incorrect"** — that is the IP allow-list, not the credentials. Run CH commands from inside the compose network, or use the socat bridge documented in CLAUDE.md.

---

## File Structure

**Created:**
- `packages/db/drizzle/migrations/0121_revenue_non_renewing_purchase.sql` — hand-authored `ADD VALUE`
- `packages/db/drizzle/migrations/meta/0121_snapshot.json` — hand-authored
- `packages/db/drizzle/migrations/0122_integration_connections_purchase_keys.sql` — widen existing connections
- `packages/db/drizzle/migrations/meta/0122_snapshot.json`
- `packages/db/clickhouse/migrations/0024_lifetime_revenue_one_time.sql` — redefine `v_revenue_lifetime_subscriber`
- `packages/shared/src/revenue-types.ts` — the five named groupings
- `packages/shared/src/revenue-types.test.ts`
- `apps/api/src/services/revenue/one-time-type.ts` — the `ProductType` → revenue-type rule
- `apps/api/src/services/revenue/one-time-type.test.ts`
- `apps/api/src/services/integrations/revenue-key-bijection.ts` — compile-time guard
- `apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts`

**Modified (principal):**
- `packages/db/src/drizzle/enums.ts` — enum value
- `packages/db/src/drizzle/repositories/revenue-events.ts:32` — `revenueDedupeKind` becomes total
- `packages/shared/src/dashboard.ts:1096` — `RevenueEventTypeName`
- `packages/shared/src/integrations.ts:1` — two new public keys
- `apps/api/src/services/integrations/types.ts:58` — `RevenueEventKind`
- `apps/api/src/services/integrations/event-mapping.ts` — 14 provider tables
- `apps/api/src/services/receipt-verify.ts:338,760` — apply the rule
- `apps/api/src/services/funnel/complete-purchase.ts:92,205` — emit revenue
- `apps/api/src/services/apple/apple-webhook.ts` — `metadata.reason`
- `apps/api/src/services/import/write.ts:567` — apply the rule
- `apps/api/src/services/metrics/{overview,transactions,charts,summary,mrr-decomposition,ltv-prediction}.ts` — groupings
- `apps/api/src/services/analytics-router.ts:288,354,369,442,521` — groupings
- `apps/dashboard/src/routes/_authed/projects/$projectId/{index,transactions}.tsx`, `apps/dashboard/src/components/live-events/mappers.ts`, `apps/dashboard/src/components/apps/integration-drawer/step-events.tsx`
- `apps/docs/content/docs/integrations/outbound-webhooks.mdx`

---

### Task 1: The `NON_RENEWING_PURCHASE` enum value

Makes the value exist end to end. Every total `Record<RevenueEventTypeName, …>` in the dashboard breaks the moment the union widens, so those sites are part of this task — splitting them out would leave `tsc` red between tasks.

**Files:**
- Create: `packages/db/drizzle/migrations/0121_revenue_non_renewing_purchase.sql`
- Create: `packages/db/drizzle/migrations/meta/0121_snapshot.json`
- Modify: `packages/db/src/drizzle/enums.ts:93-101`
- Modify: `packages/db/src/drizzle/repositories/revenue-events.ts:32-48`
- Modify: `packages/shared/src/dashboard.ts:1089-1096`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx:103-113`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx:166-175`
- Modify: `apps/dashboard/src/components/live-events/mappers.ts:14-23`
- Test: `packages/db/src/drizzle/repositories/revenue-events.test.ts`

**Interfaces:**
- Produces: `RevenueEventType` gains the literal `"NON_RENEWING_PURCHASE"`; `RevenueEventTypeName` (from `@rovenue/shared`) gains the same member; `revenueDedupeKind(type: RevenueEventType): string` keeps its signature but becomes a total `Record` lookup.

- [ ] **Step 1: Write the failing test for dedupe-kind convergence**

In `packages/db/src/drizzle/repositories/revenue-events.test.ts`:

```ts
import { revenueDedupeKind } from "./revenue-events";
import { revenueEventType } from "../enums";

describe("revenueDedupeKind", () => {
  it("files a non-renewing purchase under the shared purchase key", () => {
    // Convergence matters: if a store webhook ever writes INITIAL for the
    // same transaction a receipt typed NON_RENEWING_PURCHASE, the two must
    // claim ONE dedupe key or the charge is counted twice.
    expect(revenueDedupeKind("NON_RENEWING_PURCHASE")).toBe("purchase");
    expect(revenueDedupeKind("INITIAL")).toBe("purchase");
    expect(revenueDedupeKind("CREDIT_PURCHASE")).toBe("purchase");
  });

  it("names a kind for every enum value — no silent fallback", () => {
    // The old switch ended in `default: return type`, so a new enum value
    // silently became its own dedupe class. Enumerating from the enum
    // itself is what makes this test fail on the next added value.
    for (const type of revenueEventType.enumValues) {
      expect(
        ["purchase", "reactivation", "refund", "cancel"],
        `no dedupe kind declared for ${type}`,
      ).toContain(revenueDedupeKind(type));
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Volumes/Development/rovenue && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run --maxWorkers=2 packages/db/src/drizzle/repositories/revenue-events.test.ts -t "revenueDedupeKind"
```

Expected: FAIL — `NON_RENEWING_PURCHASE` is not assignable to `RevenueEventType`.

- [ ] **Step 3: Add the enum value**

`packages/db/src/drizzle/enums.ts`:

```ts
export const revenueEventType = pgEnum("RevenueEventType", [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "CANCELLATION",
  "REFUND",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  // 2026-09-04 — a purchase that does not renew: a non-consumable IAP, or
  // a one-time Stripe funnel package. Distinct from INITIAL because the
  // recurring MRR decomposition must exclude it and the ad platforms must
  // not receive "Subscribe" for it.
  "NON_RENEWING_PURCHASE",
]);
```

- [ ] **Step 4: Hand-author the migration**

`packages/db/drizzle/migrations/0121_revenue_non_renewing_purchase.sql`:

```sql
-- A purchase that does not renew (non-consumable IAP, one-time Stripe
-- funnel package). See docs/superpowers/specs/2026-09-04-one-time-revenue-typing-design.md
--
-- Bare ADD VALUE, deliberately NOT the type-recreate shape of
-- 0115_billing_issue_status.sql. That migration had to recreate its type
-- because it USED the new value in index predicates; PG16 permits ADD
-- VALUE inside drizzle's single migration transaction as long as nothing
-- in the same run uses the value. Nothing here does. The precedent is
-- 0107_import_verification_incomplete.sql and 0108_import_verifying.sql.
--
-- This matters more here than it did there: revenue_events is
-- range-partitioned, so a type recreate would rewrite EVERY partition
-- under an ACCESS EXCLUSIVE lock.
--
-- hand-written, NOT `drizzle-kit generate` output — with only enums.ts
-- touched, generate has repeatedly proposed DROP TYPE against this repo's
-- drifted meta snapshot (see 0107/0108's own headers). The snapshot was
-- hand-authored from 0120_snapshot.json.
ALTER TYPE "public"."RevenueEventType" ADD VALUE IF NOT EXISTS 'NON_RENEWING_PURCHASE';
```

Copy `meta/0120_snapshot.json` to `meta/0121_snapshot.json`, bump its `id`/`prevId` following the pattern in `meta/_journal.json`, add `NON_RENEWING_PURCHASE` to the `RevenueEventType` enum's `values` array, and append the 0121 entry to `_journal.json`. Do not run `drizzle-kit generate`.

- [ ] **Step 5: Make `revenueDedupeKind` total**

`packages/db/src/drizzle/repositories/revenue-events.ts`, replacing the switch:

```ts
/**
 * Coarse economic class for a revenue event, used as the trailing segment
 * of a `dedupeKey` (`<store>:<transactionId>:<kind>`). Using the class —
 * not the fine-grained `RevenueEventType` — lets the client receipt-verify
 * path and the store webhook converge on the SAME key for one transaction
 * even when they classify it differently (e.g. receipt sees INITIAL,
 * webhook sees RENEWAL), while keeping genuinely distinct events on the
 * same transaction id apart (a REACTIVATION after a REFUND must not
 * collide with the original purchase).
 *
 * A total Record, not a switch with a `default`. The old default returned
 * the type verbatim, so a newly added enum value silently became its own
 * dedupe class — the same failure shape as a `Partial<Record>` with a
 * missing key. A new value is now a compile error that forces the author
 * to decide whether it converges with an existing charge or stands alone.
 */
const DEDUPE_KIND: Record<RevenueEventType, string> = {
  INITIAL: "purchase",
  RENEWAL: "purchase",
  TRIAL_CONVERSION: "purchase",
  CREDIT_PURCHASE: "purchase",
  NON_RENEWING_PURCHASE: "purchase",
  REACTIVATION: "reactivation",
  REFUND: "refund",
  CANCELLATION: "cancel",
};

export function revenueDedupeKind(type: RevenueEventType): string {
  return DEDUPE_KIND[type];
}
```

- [ ] **Step 6: Widen the dashboard-facing union and its total maps**

`packages/shared/src/dashboard.ts` — add `| "NON_RENEWING_PURCHASE"` to `RevenueEventTypeName`. Then run `tsc` and fix every site it names. The three known ones:

`apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx` — alongside `CREDIT_PURCHASE`:

```tsx
NON_RENEWING_PURCHASE: { icon: "up", color: "var(--color-rv-cyan)", labelKey: "new_purchase", signAmount: 1 },
```

`apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx` — in `TYPE_MAP`:

```tsx
NON_RENEWING_PURCHASE: "purchase",
```

`apps/dashboard/src/components/live-events/mappers.ts`:

```ts
NON_RENEWING_PURCHASE: "non_renewing_purchase",
```

Add the `new_purchase` and `non_renewing_purchase` i18n strings next to their neighbours in the same locale files. Do not use a template-literal `t()` key.

- [ ] **Step 7: Run the tests and the type check**

```bash
cd /Volumes/Development/rovenue && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run --maxWorkers=2 packages/db/src/drizzle/repositories/revenue-events.test.ts
nice -n 19 npx tsc -p apps/dashboard --noEmit
nice -n 19 npx tsc -p packages/shared --noEmit
```

Expected: PASS, and no `tsc` errors.

- [ ] **Step 8: Apply the migration against a scratch database and prove it does not rewrite**

```bash
docker ps   # confirm Postgres is up first
cd /Volumes/Development/rovenue && pnpm db:migrate
psql "$DATABASE_URL" -c "SELECT unnest(enum_range(NULL::\"RevenueEventType\"));"
```

Expected: the eight values including `NON_RENEWING_PURCHASE`, and the migration completes in well under a second on a populated database. If drizzle reports `unsafe use of new value`, a later migration in the same run references the literal — find it and move that reference into application code.

- [ ] **Step 9: Drop the test template database**

```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl;'
```

Without this, integration tests run against a template that predates 0121 and fail with an unrelated enum error.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/drizzle/enums.ts \
        packages/db/src/drizzle/repositories/revenue-events.ts \
        packages/db/src/drizzle/repositories/revenue-events.test.ts \
        packages/db/drizzle/migrations/0121_revenue_non_renewing_purchase.sql \
        packages/db/drizzle/migrations/meta/0121_snapshot.json \
        packages/db/drizzle/migrations/meta/_journal.json \
        packages/shared/src/dashboard.ts \
        apps/dashboard/src/routes/_authed/projects/\$projectId/index.tsx \
        apps/dashboard/src/routes/_authed/projects/\$projectId/transactions.tsx \
        apps/dashboard/src/components/live-events/mappers.ts
git commit -m "feat(db): add NON_RENEWING_PURCHASE revenue event type"
```

---

### Task 2: The `ProductType` → revenue-type rule

**Files:**
- Create: `apps/api/src/services/revenue/one-time-type.ts`
- Create: `apps/api/src/services/revenue/one-time-type.test.ts`

**Interfaces:**
- Consumes: `RevenueEventType` from Task 1.
- Produces: `oneTimeRevenueTypeFor(productType: ProductType): RevenueEventType | null` — `null` means "not a one-time purchase; the caller keeps its own classification". Tasks 6 and 7 both call it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ProductType } from "@rovenue/db";
import { productType as productTypeEnum } from "@rovenue/db";
import { oneTimeRevenueTypeFor } from "./one-time-type";

describe("oneTimeRevenueTypeFor", () => {
  it("returns null for a subscription so the caller keeps its own classification", () => {
    // Returning null rather than echoing INITIAL/RENEWAL is what makes it
    // impossible for this function to change subscription behaviour.
    expect(oneTimeRevenueTypeFor(ProductType.SUBSCRIPTION)).toBeNull();
  });

  it("types a consumable as a credit purchase", () => {
    expect(oneTimeRevenueTypeFor(ProductType.CONSUMABLE)).toBe("CREDIT_PURCHASE");
  });

  it("types a non-consumable as a non-renewing purchase", () => {
    expect(oneTimeRevenueTypeFor(ProductType.NON_CONSUMABLE)).toBe("NON_RENEWING_PURCHASE");
  });

  it("has an answer for every ProductType", () => {
    // Falsifies "the map is total" against the enum itself rather than
    // against a hand-copied list that could drift with it.
    for (const t of productTypeEnum.enumValues) {
      expect(() => oneTimeRevenueTypeFor(t)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/revenue/one-time-type.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ProductType, RevenueEventType } from "@rovenue/db";

// =============================================================
// One-time purchase revenue typing
// =============================================================
//
// A purchase that does not renew must not be recorded as INITIAL. Three
// things go wrong when it is: the recurring MRR decomposition counts it
// as new recurring revenue, the ad platforms receive "Subscribe" for a
// coin pack, and credit-pack revenue reporting has no way to find it.
//
// A TOTAL Record, so a fourth ProductType is a compile error rather than
// a value that quietly falls through to the subscription branch.
//
// CREDIT_PURCHASE means "a consumable IAP was bought". A CONSUMABLE with
// no product_currency_grants rows grants nothing at all — a
// misconfiguration — and will still be filed here. Keying on the grants
// table instead was considered and rejected in the spec: it adds a read
// to every revenue write and makes the type a function of mutable
// configuration, so two purchases of the same product could carry
// different types over time.
const ONE_TIME_REVENUE_TYPE: Record<ProductType, RevenueEventType | null> = {
  SUBSCRIPTION: null,
  CONSUMABLE: "CREDIT_PURCHASE",
  NON_CONSUMABLE: "NON_RENEWING_PURCHASE",
};

/**
 * The revenue type for a purchase of this product, or `null` when the
 * product is a subscription and the caller's own INITIAL / RENEWAL /
 * TRIAL_CONVERSION classification stands.
 */
export function oneTimeRevenueTypeFor(
  productType: ProductType,
): RevenueEventType | null {
  return ONE_TIME_REVENUE_TYPE[productType];
}
```

- [ ] **Step 4: Run the test**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/revenue/one-time-type.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/revenue/one-time-type.ts apps/api/src/services/revenue/one-time-type.test.ts
git commit -m "feat(api): product-type rule for one-time purchase revenue"
```

---

### Task 3: Named revenue-type groupings (no behaviour change)

Pure refactor. The next task changes behaviour using these constants; keeping the two apart means a reviewer can see exactly which lines change meaning.

**Files:**
- Create: `packages/shared/src/revenue-types.ts`
- Create: `packages/shared/src/revenue-types.test.ts`
- Modify: `packages/shared/src/index.ts` (barrel export)
- Modify: `apps/api/src/services/metrics/overview.ts:39-47`
- Modify: `apps/api/src/services/metrics/transactions.ts:171-179`

**Interfaces:**
- Produces: `ALL_REVENUE_TYPES`, `REVENUE_TYPES_MONEY_OUT`, `REVENUE_TYPES_PURCHASE_COUNT`, `REVENUE_TYPES_NEW_RECURRING`, `REVENUE_TYPES_LIFETIME_PURCHASED`, and `sqlTypeList(types: readonly string[]): string` returning `'A','B'` for interpolation into a ClickHouse `IN (…)`. Tasks 4 and 5 consume all of them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  ALL_REVENUE_TYPES,
  REVENUE_TYPES_LIFETIME_PURCHASED,
  REVENUE_TYPES_MONEY_OUT,
  REVENUE_TYPES_NEW_RECURRING,
  REVENUE_TYPES_PURCHASE_COUNT,
  sqlTypeList,
} from "./revenue-types";

describe("revenue type groupings", () => {
  it("counts a one-time purchase as a purchase", () => {
    expect(REVENUE_TYPES_PURCHASE_COUNT).toContain("NON_RENEWING_PURCHASE");
    expect(REVENUE_TYPES_PURCHASE_COUNT).toContain("CREDIT_PURCHASE");
  });

  it("keeps one-time revenue OUT of the recurring decomposition", () => {
    // The entire reason NON_RENEWING_PURCHASE exists. If this ever passes
    // by accident, the decomposition silently starts reporting one-time
    // sales as new MRR again.
    expect(REVENUE_TYPES_NEW_RECURRING).not.toContain("NON_RENEWING_PURCHASE");
    expect(REVENUE_TYPES_NEW_RECURRING).not.toContain("CREDIT_PURCHASE");
  });

  it("counts money the subscriber actually paid toward lifetime value", () => {
    expect(REVENUE_TYPES_LIFETIME_PURCHASED).toContain("NON_RENEWING_PURCHASE");
    // CANCELLATION is a $0 marker, not money in.
    expect(REVENUE_TYPES_LIFETIME_PURCHASED).not.toContain("CANCELLATION");
  });

  it("lists every enum value exactly once", () => {
    expect(new Set(ALL_REVENUE_TYPES).size).toBe(ALL_REVENUE_TYPES.length);
    expect(ALL_REVENUE_TYPES).toContain("NON_RENEWING_PURCHASE");
  });

  it("renders a quoted SQL list", () => {
    expect(sqlTypeList(["REFUND", "CHARGEBACK"])).toBe("'REFUND','CHARGEBACK'");
  });

  it("keeps CHARGEBACK in the money-out set although the enum has never had it", () => {
    // Not a mistake to clean up silently: CHARGEBACK appears in eight
    // predicates and has never been a RevenueEventType, so no row can
    // carry it. It is retained so behaviour is byte-identical, and
    // declared here so the next reader does not "fix" it into a real
    // value or copy it into a new predicate.
    expect(REVENUE_TYPES_MONEY_OUT).toContain("CHARGEBACK");
    expect(ALL_REVENUE_TYPES).not.toContain("CHARGEBACK");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/revenue-types.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the groupings**

`packages/shared/src/revenue-types.ts`:

```ts
import type { RevenueEventTypeName } from "./dashboard";

// =============================================================
// Revenue-type groupings
// =============================================================
//
// Revenue types were enumerated by hand in fourteen places across the
// metrics services, the analytics router and the ClickHouse views. An
// `IN (…)` allow-list DROPS a newly added type silently — the SQL form of
// the `Partial<Record>` failure this project has been bitten by twice.
//
// Evidence the lists had already drifted: `CHARGEBACK` appears in eight
// predicates and has never been a RevenueEventType value.
//
// These live in @rovenue/shared rather than apps/api because the
// dashboard needs the same sets for its filters. The ClickHouse views
// cannot import them at all — that axis is held by the contract test in
// apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts.

/** Every value of the Postgres `RevenueEventType` enum. */
export const ALL_REVENUE_TYPES = [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "CANCELLATION",
  "REFUND",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * Money out. `CHARGEBACK` is a phantom: it has never been a
 * RevenueEventType value, so no row can carry it, and it is retained only
 * so the predicates that already name it keep byte-identical behaviour.
 * Do not add new uses.
 */
export const REVENUE_TYPES_MONEY_OUT = ["REFUND", "CHARGEBACK"] as const;

/** "A purchase happened" — used for counts, not sums. A one-time buy is one. */
export const REVENUE_TYPES_PURCHASE_COUNT = [
  "INITIAL",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * New RECURRING revenue. One-time types are deliberately absent — that
 * exclusion is the whole reason NON_RENEWING_PURCHASE exists.
 */
export const REVENUE_TYPES_NEW_RECURRING = [
  "INITIAL",
  "TRIAL_CONVERSION",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * Money the subscriber actually paid, for lifetime/LTV rollups.
 * CANCELLATION is excluded: it is a $0 lifecycle marker, not a payment.
 */
export const REVENUE_TYPES_LIFETIME_PURCHASED = [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/** `['A','B']` → `'A','B'`, for interpolation into a ClickHouse `IN (…)`. */
export function sqlTypeList(types: readonly string[]): string {
  return types.map((t) => `'${t}'`).join(",");
}
```

Export it from `packages/shared/src/index.ts` alongside the other barrels.

- [ ] **Step 4: Replace the two hand-copied full lists**

In `apps/api/src/services/metrics/overview.ts` delete the local `ALL_REVENUE_TYPES` array and import it from `@rovenue/shared`, keeping `isKnownRevenueType` as it is. Do the same in `apps/api/src/services/metrics/transactions.ts`. Both files kept byte-identical copies of the enum; that duplication is what let them both miss a new value.

- [ ] **Step 5: Run the tests**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/revenue-types.test.ts
nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/metrics
```

Expected: PASS, with no behaviour change in the metrics suites.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/revenue-types.ts packages/shared/src/revenue-types.test.ts \
        packages/shared/src/index.ts \
        apps/api/src/services/metrics/overview.ts apps/api/src/services/metrics/transactions.ts
git commit -m "refactor(shared): name the revenue-type groupings"
```

---

### Task 4: Apply the rulings to the TypeScript allow-lists

This is the behaviour change. Each site gets its ruling from the spec's §3.8 table; record any site whose ruling you disagree with in the ledger rather than silently deviating.

**Files:**
- Modify: `apps/api/src/services/metrics/transactions.ts:55,611`
- Modify: `apps/api/src/services/metrics/charts.ts:729`
- Modify: `apps/api/src/services/analytics-router.ts:288,354,369,442,521`
- Modify: `apps/api/src/services/metrics/mrr-decomposition.ts:58,61,133`
- Modify: `apps/api/src/services/metrics/summary.ts:73-75`
- Modify: `apps/api/src/services/metrics/ltv-prediction.ts:56` (comment only)
- Test: `apps/api/src/services/metrics/transactions.test.ts`, `apps/api/src/services/analytics-router.test.ts`

**Interfaces:**
- Consumes: the grouping constants and `sqlTypeList` from Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/metrics/transactions.test.ts`:

```ts
it("counts a one-time purchase in the purchase scope", () => {
  expect(SCOPE_TYPES.purchase).toContain("NON_RENEWING_PURCHASE");
});
```

Add to `apps/api/src/services/analytics-router.test.ts` — assert against the built SQL string, which is what actually ships:

```ts
it("counts one-time revenue in an experiment's gross", () => {
  // analytics-router's gross list excluded CREDIT_PURCHASE, so a paywall
  // experiment has never counted coin-pack revenue it caused. Ruled in:
  // an experiment's revenue must count every sale it caused.
  const sql = buildExperimentResultsQuery({ projectId: "p", windowDays: 30 });
  expect(sql).toContain("'NON_RENEWING_PURCHASE'");
  expect(sql).toContain("'CREDIT_PURCHASE'");
});
```

If `buildExperimentResultsQuery` is not currently exported, export it — asserting on a string the test itself constructs would prove nothing.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/metrics/transactions.test.ts apps/api/src/services/analytics-router.test.ts
```

Expected: FAIL on both new assertions.

- [ ] **Step 3: Apply the rulings**

`transactions.ts` — `SCOPE_TYPES.purchase` becomes `REVENUE_TYPES_PURCHASE_COUNT`, and line 611's `countIf(type IN ('INITIAL','REACTIVATION','CREDIT_PURCHASE'))` becomes:

```ts
`toString(countIf(type IN (${sqlTypeList(REVENUE_TYPES_PURCHASE_COUNT)}))) AS purchases,`
```

`analytics-router.ts` — all five `type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION')` predicates become
`type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})`, with this comment at the first one:

```ts
// Ruled IN 2026-09-04: this list excluded CREDIT_PURCHASE, so a paywall
// experiment never counted the coin-pack revenue it caused, and would
// have gone on to miss one-time purchases too. An experiment's revenue
// counts every sale it caused.
```

`charts.ts` — `PURCHASE_NUMERATOR_EVENT_TYPE` stops being a single quoted literal:

```ts
/**
 * … (keep the existing lag argument verbatim; it still decides the
 * exclusions) …
 *
 * 2026-09-04: NON_RENEWING_PURCHASE and CREDIT_PURCHASE join the
 * numerator. The lag argument that excludes RENEWAL / REACTIVATION /
 * TRIAL_CONVERSION does not apply to them — a one-time purchase happens
 * at the paywall view that earned it, which is exactly the same-day
 * conversion this numerator exists to count.
 */
const PURCHASE_NUMERATOR_EVENT_TYPES = sqlTypeList([
  "INITIAL",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
]);
```

Update its single call site from `type = ${…}` to `type IN (${PURCHASE_NUMERATOR_EVENT_TYPES})`.

`mrr-decomposition.ts`, `summary.ts` — swap the inline literals for the constants. Membership does **not** change: `REVENUE_TYPES_NEW_RECURRING` is still `INITIAL`+`TRIAL_CONVERSION`, and the `NOT IN` money-out predicates already include a new type automatically. Add one line at `mrr-decomposition.ts:58`:

```ts
// NON_RENEWING_PURCHASE and CREDIT_PURCHASE stay out by construction —
// this is the RECURRING decomposition. Before 2026-09-04 one-time sales
// arrived typed INITIAL and landed here anyway, which is what made this
// file's documented scope untrue.
```

`ltv-prediction.ts:56` — no code change; add:

```ts
// Ruled UNCHANGED 2026-09-04: the cohort anchor stays INITIAL +
// TRIAL_CONVERSION. A coin-pack or one-time buyer is not a member of a
// subscription cohort; anchoring them here would project recurring
// revenue for someone who bought once.
```

- [ ] **Step 4: Run the tests**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/metrics apps/api/src/services/analytics-router.test.ts
```

Expected: PASS, including the pre-existing assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/transactions.ts apps/api/src/services/metrics/charts.ts \
        apps/api/src/services/metrics/mrr-decomposition.ts apps/api/src/services/metrics/summary.ts \
        apps/api/src/services/metrics/ltv-prediction.ts apps/api/src/services/analytics-router.ts \
        apps/api/src/services/metrics/transactions.test.ts apps/api/src/services/analytics-router.test.ts
git commit -m "fix(metrics): count one-time purchases in revenue allow-lists"
```

---

### Task 5: ClickHouse lifetime view + the contract test

**Files:**
- Create: `packages/db/clickhouse/migrations/0024_lifetime_revenue_one_time.sql`
- Create: `apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts`

**Interfaces:**
- Consumes: `ALL_REVENUE_TYPES`, `REVENUE_TYPES_LIFETIME_PURCHASED` from Task 3.

- [ ] **Step 1: Write the failing contract test**

```ts
// Runs the REAL view SQL against a testcontainer ClickHouse. A view is a
// SQL file and cannot import the TypeScript grouping constants, so this
// test is the only thing holding the two in step. Mocking ClickHouse here
// would assert that our mock agrees with itself.
import { ALL_REVENUE_TYPES, REVENUE_TYPES_LIFETIME_PURCHASED } from "@rovenue/shared";

it("v_revenue_lifetime_subscriber counts every type the grouping says it should", async () => {
  const projectId = "ctr_" + Date.now();
  // One $10 row of EVERY enum value, so a dropped type shows up as a
  // $10 shortfall attributable by name.
  for (const type of ALL_REVENUE_TYPES) {
    await insertRawRevenueEvent(ch, { projectId, type, amountUsd: 10, subscriberId: "s1" });
  }

  const [row] = await ch.query({
    query: `SELECT lifetime_dollars_purchased_cents AS c
            FROM rovenue.v_revenue_lifetime_subscriber
            WHERE projectId = {p:String} AND subscriberId = 's1'`,
    query_params: { p: projectId },
  }).then((r) => r.json<{ c: string }>());

  const expected = REVENUE_TYPES_LIFETIME_PURCHASED.length * 1000; // cents
  const missing = ALL_REVENUE_TYPES.filter(
    (t) => REVENUE_TYPES_LIFETIME_PURCHASED.includes(t as never),
  );
  expect(
    Number(row!.c),
    `view total ${row!.c} != ${expected}; the view's IN list has drifted from ` +
      `REVENUE_TYPES_LIFETIME_PURCHASED (${missing.join(",")})`,
  ).toBe(expected);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker ps
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts
```

Expected: FAIL — the view total is short by $10, because `NON_RENEWING_PURCHASE` is not in its `IN` list.

- [ ] **Step 3: Write the migration**

`packages/db/clickhouse/migrations/0024_lifetime_revenue_one_time.sql` — copy the current definition from `0014_refund_sign_robust_aggregates.sql` and add `'NON_RENEWING_PURCHASE'` to the purchased bucket:

```sql
-- 0024_lifetime_revenue_one_time.sql
-- NON_RENEWING_PURCHASE joins the purchased bucket: it is money the
-- subscriber actually paid, so it belongs in lifetime value. Without this
-- the type introduced on 2026-09-04 would be recorded and then silently
-- dropped from every LTV rollup.
--
-- A query-time view, so this redefinition rewrites no data.
-- Statements must not be comment-prefixed on the same line as the
-- statement itself — the migrate splitter has dropped such statements
-- before ("applied but objects missing").
CREATE OR REPLACE VIEW rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION', 'CREDIT_PURCHASE', 'NON_RENEWING_PURCHASE')) AS lifetime_dollars_purchased_cents,
  -- … carry the remaining columns over from 0014 verbatim …
FROM …;
```

Read `0014_refund_sign_robust_aggregates.sql` in full and carry every other column and clause over unchanged. Do not paraphrase them.

- [ ] **Step 4: Apply and re-run**

The ClickHouse client cannot reach the container from the host — that failure reports as "password is incorrect" and is really the IP allow-list. Use the compose `migrate` service, or the socat bridge from CLAUDE.md:

```bash
docker run -d --rm --name ch-devfwd --network rovenue_default -p 8125:8125 \
  alpine/socat tcp-listen:8125,fork,reuseaddr tcp-connect:clickhouse:8123
CLICKHOUSE_URL=http://localhost:8125 CLICKHOUSE_USER=rovenue \
  pnpm --filter @rovenue/db db:clickhouse:migrate
docker rm -f ch-devfwd
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Falsify the test**

Temporarily remove `'CREDIT_PURCHASE'` from the view's `IN` list, re-apply, and confirm the test fails and names the shortfall. Restore it. A guard that has never failed is not evidence.

- [ ] **Step 6: Commit**

```bash
git add packages/db/clickhouse/migrations/0024_lifetime_revenue_one_time.sql \
        apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts
git commit -m "fix(clickhouse): count one-time purchases in lifetime revenue"
```

---

### Task 6: Type Apple and Google one-time purchases

**Files:**
- Modify: `apps/api/src/services/receipt-verify.ts:335-360` (Apple), `:755-785` (Google one-time)
- Modify: `apps/api/src/services/import/write.ts:567`
- Test: `apps/api/src/services/receipt-verify.test.ts`

**Interfaces:**
- Consumes: `oneTimeRevenueTypeFor` (Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
it("records a consumable Apple purchase as CREDIT_PURCHASE", async () => {
  const { revenueEvents } = await verifyAndCapture({
    store: "APP_STORE",
    productType: "CONSUMABLE",
    transaction: { transactionId: "t1", originalTransactionId: "t1", price: 4_990_000, currency: "USD" },
  });
  expect(revenueEvents).toHaveLength(1);
  expect(revenueEvents[0]!.type).toBe("CREDIT_PURCHASE");
});

it("records a non-consumable Google purchase as NON_RENEWING_PURCHASE", async () => {
  const { revenueEvents } = await verifyAndCapture({
    store: "PLAY_STORE",
    productType: "NON_CONSUMABLE",
    pricing: { amount: 9.99, currency: "USD" },
  });
  expect(revenueEvents[0]!.type).toBe("NON_RENEWING_PURCHASE");
});

it("leaves a subscription receipt classified exactly as before", async () => {
  // Regression pin: the rule must be incapable of touching the
  // subscription branch. A renewal stays RENEWAL.
  const { revenueEvents } = await verifyAndCapture({
    store: "APP_STORE",
    productType: "SUBSCRIPTION",
    transaction: { transactionId: "t2", originalTransactionId: "t1", price: 9_990_000, currency: "USD" },
  });
  expect(revenueEvents[0]!.type).toBe("RENEWAL");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/receipt-verify.test.ts
```

Expected: the first two FAIL with `INITIAL`; the third already passes and must keep passing.

- [ ] **Step 3: Apply the rule in the Apple path**

`receipt-verify.ts`, replacing the `const type = …` at line 338:

```ts
// A non-subscription product is never INITIAL/RENEWAL: see
// services/revenue/one-time-type.ts. Subscriptions fall through to the
// transaction-id classification unchanged.
const type =
  oneTimeRevenueTypeFor(product.type) ??
  (transaction.transactionId === transaction.originalTransactionId
    ? "INITIAL"
    : "RENEWAL");
```

- [ ] **Step 4: Apply the rule in the Google one-time path**

`receipt-verify.ts` line 760 — `verifyGoogleProductReceipt` only ever handles non-subscription products, so the `??` fallback is unreachable there; keep it anyway so the two call sites read identically and neither becomes a special case:

```ts
const type = oneTimeRevenueTypeFor(product.type) ?? RevenueEventType.INITIAL;
```

- [ ] **Step 5: Apply the rule in the importer**

`apps/api/src/services/import/write.ts:567` — `deriveRevenueEventType(normalized, storeTransactionId)` becomes:

```ts
type: oneTimeRevenueTypeFor(product.type) ??
  deriveRevenueEventType(normalized, storeTransactionId),
```

The imported data is historical, but the write is new: an import run after this release must not create fresh mistyped rows.

- [ ] **Step 6: Prove the metric that read zero now reads money**

Add to `apps/api/tests/metrics-credits.integration.test.ts` (create it if it does not exist), against a real ClickHouse testcontainer:

```ts
it("reports credit-pack revenue that a consumable purchase produced", async () => {
  // credits.ts:299 and :391 filter `type = 'CREDIT_PURCHASE'`, and
  // nothing in the repository has ever written that type — so both of
  // these dashboard numbers have always been zero. This is the assertion
  // that says they are not any more.
  await recordConsumablePurchase({ projectId, amountUsd: 9.99 });
  const summary = await getCreditsSummary({ projectId, window });
  expect(Number(summary.revenueUsd)).toBeCloseTo(9.99, 2);

  const packages = await getTopCreditPackages({ projectId, window });
  expect(packages).toHaveLength(1);
});
```

- [ ] **Step 7: Run the tests**

```bash
docker ps
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/receipt-verify.test.ts apps/api/src/services/import
nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/metrics-credits.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/receipt-verify.ts apps/api/src/services/import/write.ts \
        apps/api/src/services/receipt-verify.test.ts \
        apps/api/tests/metrics-credits.integration.test.ts
git commit -m "fix(receipts): type one-time store purchases as one-time"
```

---

### Task 7: Record revenue for Stripe one-time funnel purchases

**Files:**
- Modify: `apps/api/src/services/funnel/complete-purchase.ts:92-203` (`grantOneTimePurchase`), `:205-330` (`completeFunnelPurchase`)
- Test: `apps/api/src/services/funnel/complete-purchase.integration.test.ts`

**Interfaces:**
- Consumes: `oneTimeRevenueTypeFor` (Task 2), `createRevenueEvent` (`drizzle.revenueEventRepo`), `convertToUsd` (`apps/api/src/services/fx.ts`).
- `grantOneTimePurchase` gains one argument: `amountUsd: string | null` — precomputed by the caller before the transaction opens.

- [ ] **Step 1: Write the failing integration test**

Against a real Postgres testcontainer, not a mocked transaction:

```ts
it("records revenue for a one-time funnel purchase", async () => {
  const { sessionId, paymentIntentId } = await seedPendingOneTimeSession({
    amountCents: 4999,
    currency: "usd",
    productType: "NON_CONSUMABLE",
  });

  await completeFunnelPurchase({
    sessionId,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: null,
    stripePaymentIntentId: paymentIntentId,
  });

  const rows = await db.select().from(schema.revenueEvents)
    .where(eq(schema.revenueEvents.projectId, projectId));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.type).toBe("NON_RENEWING_PURCHASE");
  expect(rows[0]!.amount).toBe("49.9900");

  const outbox = await db.select().from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"));
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.eventType).toBe("revenue.event.recorded");
});

it("does not record a second revenue row when /confirm is replayed", async () => {
  // Both /confirm and the webhook backstop can arrive. The second caller
  // must not double-count the charge.
  await completeFunnelPurchase({ …same args… });
  await completeFunnelPurchase({ …same args… });
  const rows = await db.select().from(schema.revenueEvents)…;
  expect(rows).toHaveLength(1);
});

it("still mints a claim token when the funnel row has no price", async () => {
  // The file's existing contract: nothing here may throw, because a throw
  // rolls back the paid transition and strands a buyer who really paid.
  const { sessionId } = await seedPendingOneTimeSession({ amountCents: null, currency: null });
  const result = await completeFunnelPurchase({ … });
  expect(result.alreadyIssued).toBe(false);
  expect(result.token).toBeTruthy();
});

it("puts the revenue row on the integrations fan-out envelope", async () => {
  // A recorded row is not a delivered event. Assert the envelope the
  // consumer would build, not just the outbox row.
  const envelope = toFanoutEnvelope("rovenue.revenue", publishedMessageFor(outbox[0]!));
  expect(envelope?.eventType).toBe("revenue.event.recorded");
  expect(envelope?.revenueEventKind).toBe("NON_RENEWING_PURCHASE");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
docker ps
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/funnel/complete-purchase.integration.test.ts
```

Expected: FAIL — zero `revenue_events` rows.

- [ ] **Step 3: Hoist the FX conversion out of the transaction**

In `completeFunnelPurchase`, before `drizzle.db.transaction(...)`:

```ts
// FX BEFORE the transaction, deliberately. convertToUsd's ladder is
// Redis -> fx_rates -> a static table (services/fx.ts): no HTTP, but two
// Redis round trips. This transaction sits on the paid-conversion
// critical path and holds the funnel_claim_tokens.session_id race; a
// cache round trip does not belong inside it.
//
// The row is read again inside the transaction — that read is what
// decides the paid/already-paid race — so this extra read changes no
// semantics.
const preRead = await drizzle.funnelPurchaseRepo.findBySession(
  drizzle.db,
  input.sessionId,
);
const amountUsd =
  preRead?.amountCents != null && preRead.currency
    ? (
        await convertToUsd(preRead.amountCents / 100, preRead.currency)
      ).toString()
    : null;
```

Pass `amountUsd` into the `grantOneTimePurchase` call.

- [ ] **Step 4: Emit the revenue event**

At the end of `grantOneTimePurchase`, after the access loop and before the closing log:

```ts
// The money finally counts. Before this, a one-time funnel purchase
// wrote a purchases row and an entitlement and nothing else: no
// revenue_events row means no REVENUE_EVENT outbox row, which means no
// rovenue.revenue topic, which means no ClickHouse and no integration
// provider. The sale was invisible everywhere but the funnel tables.
//
// INSIDE the transaction, not after it: both /confirm and the webhook
// backstop short-circuit on `status === "paid"`, so a post-commit emit
// that failed would never be retried by anything.
//
// Skips rather than throws on missing data, matching this function's
// documented contract — a throw would roll back the paid transition and
// leave a buyer who really paid with no claim token.
const revenueType = oneTimeRevenueTypeFor(product.type);
if (revenueType == null) {
  log.error("one-time funnel purchase names a subscription product", {
    sessionId: args.sessionId,
    productId: args.productId,
  });
} else if (priceAmount == null || priceCurrency == null || args.amountUsd == null) {
  log.error("one-time funnel purchase has no price to record as revenue", {
    sessionId: args.sessionId,
    purchaseId: purchase.id,
  });
} else {
  await drizzle.revenueEventRepo.createRevenueEvent(tx, {
    projectId: args.projectId,
    subscriberId: args.subscriberId,
    purchaseId: purchase.id,
    productId: args.productId,
    type: revenueType,
    amount: priceAmount,
    currency: priceCurrency,
    amountUsd: args.amountUsd,
    store: Store.STRIPE,
    eventDate: purchasedAt,
    // Both racers converge on one key; the loser's transaction rolls
    // back anyway, and a redelivered webhook is a no-op.
    dedupeKey: `stripe:${args.stripePaymentIntentId}:${revenueDedupeKind(revenueType)}`,
    // No country: a PaymentIntent carries no per-transaction country, and
    // reading the Charge would put a Stripe call inside an open
    // transaction. Same documented gap, same reason, as applyInvoicePaid.
  });
}
```

- [ ] **Step 5: Run the tests**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/funnel
```

Expected: PASS, including the pre-existing race and token tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/funnel/complete-purchase.ts apps/api/src/services/funnel/complete-purchase.integration.test.ts
git commit -m "fix(funnel): record revenue for one-time Stripe purchases"
```

---

### Task 8: Disambiguate `REACTIVATION` before publishing it

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (`applyRefundReversed`, near `:1017`)
- Test: `apps/api/src/services/apple/apple-webhook.test.ts`

**Interfaces:**
- Produces: `revenue.event.recorded` payloads whose `metadata.reason` is `"refund_reversed"` for the compensating row. Task 9 documents it.

- [ ] **Step 1: Write the failing test**

```ts
it("marks the compensating reactivation so a consumer can tell it from a win-back", async () => {
  // REACTIVATION carries two economic meanings — a lapsed subscriber
  // returning, and a refund being undone. The codebase already holds them
  // apart at the dedupe key (see APPLE_FIRST_CHARGE_DEDUPE_KIND), but that
  // never reaches the outbox payload, so a consumer cannot tell "they came
  // back" from "we un-refunded them".
  await processAppleNotification(refundReversedNotification());
  const [outbox] = await outboxRowsOfType("revenue.event.recorded");
  expect(outbox!.payload).toMatchObject({
    type: "REACTIVATION",
    metadata: { reason: "refund_reversed" },
  });
});

it("leaves a win-back reactivation unmarked", async () => {
  await processAppleNotification(resubscribeNotification());
  const [outbox] = await outboxRowsOfType("revenue.event.recorded");
  expect(outbox!.payload).toMatchObject({ type: "REACTIVATION" });
  expect((outbox!.payload as Record<string, unknown>).metadata).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch the first fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/apple/apple-webhook.test.ts -t reactivation
```

Expected: the first FAILs (no `metadata`), the second passes.

- [ ] **Step 3: Stamp the reason**

In `applyRefundReversed`'s `emitRevenueEvent` call, add:

```ts
// REACTIVATION means two different things. This one is an accounting
// reversal, not a subscriber coming back — a consumer that treats it as
// a win-back would fire a "welcome back" campaign at someone whose
// refund was simply declined. `metadata` flows into the outbox payload
// and nowhere else, which is exactly what it is for; the precedent is
// subscription.product_changed's `phase`.
metadata: { reason: "refund_reversed" },
```

If `emitRevenueEvent` does not currently forward `metadata`, thread it through `EmitRevenueArgs` — do not write a second `createRevenueEvent` call site.

- [ ] **Step 4: Run the tests**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/apple
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple/apple-webhook.ts apps/api/src/services/apple/apple-webhook.test.ts
git commit -m "feat(apple): mark the compensating reactivation with a reason"
```

---

### Task 9: Publish the two new public keys

Adding to `ROVENUE_EVENT_KEYS` widens `REVENUE_EVENT_KEYS` → `STANDARD_PROVIDER_EVENT_KEYS`, so every standard provider starts advertising both keys in the same commit and the existing coverage guard goes red until each has a name or a declared omission. That tripwire is by design; satisfying it is part of this task.

**Files:**
- Modify: `packages/shared/src/integrations.ts:1-41`
- Modify: `apps/api/src/services/integrations/types.ts:58-65`
- Modify: `apps/api/src/services/integrations/event-mapping.ts` (all 14 tables)
- Modify: `apps/api/src/services/integrations/event-mapping.catalog-coverage.test.ts`
- Create: `apps/api/src/services/integrations/revenue-key-bijection.ts`
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-events.tsx:38`
- Modify: `packages/shared/src/integrations.test.ts:13-36`

**Interfaces:**
- Consumes: the enum value (Task 1), the `metadata.reason` discriminator (Task 8).
- Produces: `RovenueEventKey` gains `"revenue.NON_RENEWING_PURCHASE"` and `"revenue.REACTIVATION"`; `RevenueEventKind` gains `"NON_RENEWING_PURCHASE"` and `"REACTIVATION"`.

- [ ] **Step 1: Write the failing bijection guard**

`apps/api/src/services/integrations/revenue-key-bijection.ts` — a compile-time assertion, not a test:

```ts
import type { RevenueEventType } from "@rovenue/db";
import type { RovenueEventKey } from "@rovenue/shared";

// =============================================================
// Postgres enum <-> public revenue key bijection
// =============================================================
//
// `deriveRevenueEventKey` builds `revenue.${revenueEventKind}` and CASTS
// the result to RovenueEventKey. Nothing checked that the cast was true.
// It was not: REACTIVATION has been produced since Apple's RESUBSCRIBE
// handler shipped, and `revenue.REACTIVATION` was never in the catalog —
// so `enabledEvents.includes()` was false for every provider and the
// event was skipped silently, CUSTOM_WEBHOOK included.
//
// A compile error rather than a test: a SQL string literal is invisible
// to tsc, but this correspondence is not, and a compile error beats a
// test somebody can skip. The SQL allow-list axis is held instead by the
// named groupings in @rovenue/shared and the ClickHouse contract test.

import { ALL_REVENUE_TYPES } from "@rovenue/shared";

type RevenueKeyFor<T extends string> = `revenue.${T}`;

/**
 * Fails to instantiate unless `T` is `never`.
 *
 * NOT `const x: SomeType = undefined as never` — `never` is assignable to
 * every type, so that form compiles no matter what `SomeType` resolves to
 * and the guard would assert nothing. The constraint is what does the
 * work here.
 */
type AssertNever<T extends never> = T;

/** Every RevenueEventType has a public key. */
type MissingKeys = Exclude<RevenueKeyFor<RevenueEventType>, RovenueEventKey>;

/** Every revenue.* key names a real RevenueEventType. */
type OrphanKeys = Exclude<
  Extract<RovenueEventKey, `revenue.${string}`>,
  RevenueKeyFor<RevenueEventType>
>;

/**
 * @rovenue/shared cannot import @rovenue/db (the dashboard and the SDK
 * consume shared), so ALL_REVENUE_TYPES is a literal list there. This is
 * the one place that can see both, so this is where the list is held to
 * the enum.
 */
type UnlistedTypes = Exclude<RevenueEventType, (typeof ALL_REVENUE_TYPES)[number]>;

// A failure reads as "Type '"revenue.REACTIVATION"' does not satisfy the
// constraint 'never'", which names the missing key directly.
type _EveryRevenueTypeHasAKey = AssertNever<MissingKeys>;
type _EveryRevenueKeyHasAType = AssertNever<OrphanKeys>;
type _AllRevenueTypesCoversTheEnum = AssertNever<UnlistedTypes>;
```

- [ ] **Step 2: Run tsc and watch it fail**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx tsc -p apps/api --noEmit
```

Expected: FAIL naming `revenue.REACTIVATION` and `revenue.NON_RENEWING_PURCHASE`.

- [ ] **Step 3: Add the keys**

`packages/shared/src/integrations.ts`, in catalog order after `revenue.CREDIT_PURCHASE`:

```ts
  // 2026-09-04 — a purchase that does not renew (non-consumable IAP, or a
  // one-time Stripe funnel package). Distinct from revenue.INITIAL
  // because the ad platforms map INITIAL to "Subscribe", which is wrong
  // for a purchase that never becomes a subscription.
  "revenue.NON_RENEWING_PURCHASE",
  // 2026-09-04 — REACTIVATION has been PRODUCED since Apple's RESUBSCRIBE
  // handler shipped, but had no key, so every provider skipped it with
  // `filtered_by_event_scope` and nothing logged. It carries two
  // meanings — a lapsed subscriber returning, and a refund being undone —
  // and the payload's `metadata.reason: "refund_reversed"` is what tells
  // them apart. See apple-webhook.ts's applyRefundReversed.
  "revenue.REACTIVATION",
```

Update the count and the array in `packages/shared/src/integrations.test.ts` from 21 to 23 keys.

- [ ] **Step 4: Widen `RevenueEventKind`**

`apps/api/src/services/integrations/types.ts`:

```ts
export type RevenueEventKind =
  | "INITIAL"
  | "TRIAL_CONVERSION"
  | "RENEWAL"
  | "CREDIT_PURCHASE"
  | "NON_RENEWING_PURCHASE"
  | "REACTIVATION"
  | "REFUND"
  | "CANCELLATION";
```

- [ ] **Step 5: Run the coverage guard and watch it go red**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/integrations/event-mapping.catalog-coverage.test.ts
```

Expected: FAIL, naming every `(provider, key)` pair still missing a name. That list is the work for the next step.

- [ ] **Step 6: Name both keys for all 14 providers**

Each entry needs either a vendor event name taken from that vendor's own documentation, or a `DECLARED_OMISSIONS` row carrying the reason — the Wave-2 discipline. Cite the doc URL and the date you fetched it in the comment, exactly as the existing AIRBRIDGE and SINGULAR comments do. Starting points, each still to be verified against the vendor's docs:

- `ANALYTICS_DEFAULT_EVENT_NAMES` (AMPLITUDE / MIXPANEL / ONESIGNAL): `non_renewing_purchase`, `reactivation`.
- `APPSFLYER`: `af_purchase` is already the INITIAL name; a non-renewing purchase is a purchase — check whether AppsFlyer documents a distinct one before reusing it.
- `FIREBASE_GA4`: `revenue.NON_RENEWING_PURCHASE` → `purchase` (GA4's recommended event); `revenue.REACTIVATION` → `rovenueCustomEventName`.
- `SLACK` / `DISCORD`: identity, automatic — both derive from `ROVENUE_EVENT_KEYS`.
- `META_CAPI` / `TIKTOK_EVENTS`: `NON_RENEWING_PURCHASE` → their `Purchase` / `CompletePayment` events, **not** `Subscribe`. `REACTIVATION` is expected to be a declared omission: it is a lifecycle signal, and both providers keep a narrow catalog precisely so lifecycle signals do not corrupt conversion optimization.
- `SINGULAR`: check the 32-ASCII cap on `n` before choosing a name.
- `BRAZE` / `ITERABLE`: revenue keys ride the purchase object; follow their existing revenue-key treatment.
- `ADJUST`: no defaults exist by design; nothing to add.

Add a `DECLARED_OMISSIONS` entry with a reason for every pair you leave unnamed.

- [ ] **Step 7: Add the keys to the dashboard event picker**

`apps/dashboard/src/components/apps/integration-drawer/step-events.tsx` — add both keys next to `revenue.CREDIT_PURCHASE`, with the labels in the same locale files as their neighbours.

- [ ] **Step 8: Run everything**

```bash
cd /Volumes/Development/rovenue && nice -n 19 npx tsc -p apps/api --noEmit
nice -n 19 npx vitest run --maxWorkers=2 apps/api/src/services/integrations
nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/integrations.test.ts
```

Expected: PASS.

- [ ] **Step 9: Falsify the bijection guard**

Temporarily delete `"revenue.REACTIVATION"` from `ROVENUE_EVENT_KEYS`, run `tsc -p apps/api --noEmit`, and confirm it fails naming that key. Restore it.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/integrations.ts packages/shared/src/integrations.test.ts \
        apps/api/src/services/integrations/types.ts \
        apps/api/src/services/integrations/event-mapping.ts \
        apps/api/src/services/integrations/event-mapping.catalog-coverage.test.ts \
        apps/api/src/services/integrations/revenue-key-bijection.ts \
        apps/dashboard/src/components/apps/integration-drawer/step-events.tsx
git commit -m "feat(integrations): publish non-renewing purchase and reactivation keys"
```

---

### Task 10: Keep existing connections receiving purchase events

**Files:**
- Create: `packages/db/drizzle/migrations/0122_integration_connections_purchase_keys.sql`
- Create: `packages/db/drizzle/migrations/meta/0122_snapshot.json`
- Test: `apps/api/tests/integration-connections-purchase-keys.integration.test.ts`

**Interfaces:**
- Consumes: the public keys from Task 9.

- [ ] **Step 1: Write the failing test**

```ts
it("widens a connection that already receives purchase events", async () => {
  // enabled_events is a stored literal array with no defaulting to the
  // catalog, so a connection written before this release CANNOT contain a
  // key that did not exist. Without this migration a coin-pack purchase
  // that ships today as revenue.INITIAL would simply stop arriving.
  await seedConnection({ enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL"] });
  await runMigration("0122");
  const [row] = await db.select().from(schema.integrationConnections);
  expect(row!.enabledEvents).toEqual(
    expect.arrayContaining([
      "revenue.INITIAL",
      "revenue.CREDIT_PURCHASE",
      "revenue.NON_RENEWING_PURCHASE",
    ]),
  );
});

it("leaves a connection that opted out of purchase events alone", async () => {
  await seedConnection({ enabledEvents: ["subscription.expired"] });
  await runMigration("0122");
  const [row] = await db.select().from(schema.integrationConnections);
  expect(row!.enabledEvents).toEqual(["subscription.expired"]);
});

it("does not enable revenue.REACTIVATION for anyone", async () => {
  // A genuinely new signal nobody has ever received. Enabling it silently
  // would be a change of behaviour rather than a preservation of one.
  await seedConnection({ enabledEvents: ["revenue.INITIAL"] });
  await runMigration("0122");
  const [row] = await db.select().from(schema.integrationConnections);
  expect(row!.enabledEvents).not.toContain("revenue.REACTIVATION");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
docker ps
cd /Volumes/Development/rovenue && nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/integration-connections-purchase-keys.integration.test.ts
```

Expected: FAIL — migration 0122 does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- Task 10: keep existing integrations receiving the purchases they
-- already asked for.
--
-- `enabled_events` is a stored text[] written from whatever the dashboard
-- submitted; there is no defaulting to the catalog. A connection created
-- before 2026-09-04 therefore holds an array that CANNOT contain
-- revenue.NON_RENEWING_PURCHASE.
--
-- Until now a consumable or one-time purchase reached those connections
-- as revenue.INITIAL. Splitting the type without this migration would
-- stop deliveries that work today — a silent regression on live customer
-- integrations.
--
-- Scoped to connections that already have revenue.INITIAL: those have
-- declared they want to hear about purchases, and this preserves that.
-- A connection WITHOUT it opted out of purchase events and must not be
-- opted back in.
--
-- revenue.REACTIVATION is deliberately NOT added: it is a genuinely new
-- signal nobody has ever received, so it ships opt-in.
UPDATE "integration_connections"
SET "enabled_events" = (
  SELECT array_agg(DISTINCT e)
  FROM unnest(
    "enabled_events" || ARRAY['revenue.CREDIT_PURCHASE', 'revenue.NON_RENEWING_PURCHASE']
  ) AS e
)
WHERE 'revenue.INITIAL' = ANY("enabled_events");
```

Hand-author `meta/0122_snapshot.json` from 0121's and append to `_journal.json`. The schema is unchanged, so the snapshot differs only in its ids.

- [ ] **Step 4: Run the tests**

```bash
cd /Volumes/Development/rovenue && psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl;'
nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/integration-connections-purchase-keys.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0122_integration_connections_purchase_keys.sql \
        packages/db/drizzle/migrations/meta/0122_snapshot.json \
        packages/db/drizzle/migrations/meta/_journal.json \
        apps/api/tests/integration-connections-purchase-keys.integration.test.ts
git commit -m "fix(integrations): keep existing connections receiving purchases"
```

---

### Task 11: Documentation and the ROADMAP entry

**Files:**
- Modify: `apps/docs/content/docs/integrations/outbound-webhooks.mdx`
- Modify: `ROADMAP.md:412-531` (§6)

- [ ] **Step 1: Document the two new keys and the producer table**

Add both keys to the event-key catalog with their meaning, and a producer table stating for each `revenue.*` key which store and which code path produces it. It must say plainly:

- `revenue.CREDIT_PURCHASE` means "a consumable IAP was bought" — Apple and Google receipt paths, and one-time Stripe funnel purchases of a consumable product.
- `revenue.NON_RENEWING_PURCHASE` — non-consumable products on all three stores.
- `revenue.REACTIVATION` — Apple only today, and its `metadata.reason: "refund_reversed"` discriminator, with the warning that an unmarked one is a win-back and a marked one is an accounting reversal.
- Rows written before this release carry `INITIAL` for one-time purchases; history is not rewritten.

Do not use bare `{{var}}` anywhere in the MDX — it breaks the prerender.

- [ ] **Step 2: Close the ROADMAP item**

Replace §6's open checkbox with a `[x]` entry recording what was actually built, in the style of the 2026-09-03 entry above it: the item named the Stripe symptom, the defect was that one-time purchases were never typed as one-time on any store, and the durable pieces are the compile-time bijection guard, the named groupings, and the ClickHouse contract test. Note the two rulings — `CREDIT_PURCHASE` means "consumable IAP", and the `ltv-prediction` cohort anchor stays subscription-only.

- [ ] **Step 3: Run the docs build**

```bash
cd /Volumes/Development/rovenue && nice -n 19 pnpm --filter @rovenue/docs build
```

Expected: the prerender completes.

- [ ] **Step 4: Full verification before claiming completion**

Sequentially, never in parallel:

```bash
cd /Volumes/Development/rovenue
nice -n 19 npx tsc -p apps/api --noEmit
nice -n 19 npx tsc -p apps/dashboard --noEmit
nice -n 19 npx vitest run --maxWorkers=2 packages/shared
nice -n 19 npx vitest run --maxWorkers=2 apps/api/src
nice -n 19 npx vitest run --maxWorkers=2 apps/dashboard
nice -n 19 pnpm build --concurrency=2
```

Record the actual counts. Three integration files on `main` share a queue name and hardcoded DB/Redis and flake under isolation — if a failure is in that set, confirm it fails on a clean checkout too before attributing it to this work.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs/integrations/outbound-webhooks.mdx ROADMAP.md
git commit -m "docs: one-time purchase revenue keys and §6 closure"
```

---

## Self-Review Notes

- Spec §3.1 → Task 2 and Task 6/7's call sites. §3.2 → Task 1. §3.3 → Task 1 Step 5. §3.4 → Task 7. §3.5 → Task 8 and Task 9. §3.6 → Task 9 Step 6. §3.7 → Task 9 Steps 1-2, 9. §3.8 → Tasks 3, 4, 5. §3.9 → Task 10. §4 → each task's tests plus Task 11 Step 4. §5 → Task 11.
- `oneTimeRevenueTypeFor` is spelled identically in Tasks 2, 6 and 7. `revenueDedupeKind` keeps its Task 1 signature where Task 7 calls it. The grouping constant names in Task 3 match every use in Tasks 4 and 5.
- Task 9 must not land before Task 8: publishing `revenue.REACTIVATION` without the `metadata.reason` discriminator would ship the ambiguity the spec exists to avoid.
- Task 10 must not land before Task 9: it references keys that do not exist until then.
