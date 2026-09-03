# Subscription State & Entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all four open ROADMAP §2 items — cross-grade entitlement transitions, `BILLING_ISSUE` as a first-class state, Apple Family Sharing + win-back handling, and a continuous `subscriber_access` drift reconciler.

**Architecture:** A single status-semantics table in `@rovenue/shared` becomes the source of truth that `packages/db`'s enum, the API's status lists and the SQL predicates all derive from, so the new enum value cannot be silently omitted anywhere. `BILLING_ISSUE` is added via the recreate-enum migration pattern. The transition guard's row read is widened to carry a before-image, which unlocks plan-change detection for all three stores at one seam. Family-sharing revenue suppression moves into the revenue repository. A new BullMQ worker re-derives every subscriber's desired entitlement set with the *same* function the writer uses and heals drift behind a circuit breaker.

**Tech Stack:** TypeScript (strict), Hono, Drizzle ORM + PostgreSQL 16, BullMQ + Redis, Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-03-subscription-state-entitlements-design.md`

## Global Constraints

- **Stay on the current branch.** Do not create, switch, or delete branches; do not create worktrees. The user manages branching.
- **No magic values.** Every threshold, window and status list is a named exported constant with a comment saying where the number comes from. Structured data tables (status semantics, mapping tables) are not magic values — they are the point.
- **Throttle test runs.** Full suites strain this machine. Use `nice -n 19 npx vitest run --maxWorkers=2` from the package directory; never run two suites concurrently. Builds: `pnpm build --concurrency=2`.
- **No self-confirming tests.** No mocked ClickHouse, no mocked transactions asserting rollback, no hand-built expectation compared against itself. Integration tests use real Postgres via testcontainers (`*.integration.test.ts`), which requires Docker running — check `docker ps` first; a hang means Docker is down.
- **New migrations require dropping the test template DB** (`rovenue_test_tpl`) before integration tests, or the new columns will be missing.
- TypeScript strict everywhere; Zod for API input; responses are `{ data: T }` or `{ error: { code, message } }`.
- Postgres access via Drizzle only; raw SQL via the `sql` template must **qualify columns** (`"purchases"."id"`) — a bare `${table.col}` renders unqualified and breaks correlated subqueries.
- Conventional commits. Commit at the end of every task.
- Refund `amountUsd` is stored POSITIVE. All IDs are cuid2. Timestamps UTC.

---

## File Structure

**Created:**
- `packages/shared/src/subscription-status.ts` — the status tuple, the semantics `Record`, and every derived status list. One responsibility: "what does each subscription status mean".
- `packages/shared/src/subscription-status.test.ts`
- `apps/api/src/services/apple/apple-supersede.ts` — Apple's `linkedPurchaseToken` equivalent: retire the superseded row on an upgrade.
- `apps/api/src/services/apple/apple-supersede.integration.test.ts`
- `apps/api/src/services/subscription-plan-change.ts` — classify a product change and emit `subscription.product_changed`.
- `apps/api/src/services/subscription-plan-change.test.ts`
- `apps/api/src/workers/access-reconciliation.ts` — the drift sweep.
- `apps/api/src/workers/access-reconciliation.integration.test.ts`
- `apps/api/scripts/billing-issue-blast-radius.ts` — pre-deploy read-only report.
- Migrations `0115` (enum + `billingIssueDetectedAt`), `0116` (pending-change columns), `0117` (offer columns), `0118` (`subscribers.lastAccessReconciledAt`).

**Modified:**
- `packages/db/src/drizzle/enums.ts:46` — `purchaseStatus` derives from the shared tuple.
- `packages/db/src/index.ts:56` — the `PurchaseStatus` const object derives from the shared tuple.
- `packages/db/src/drizzle/schema.ts:904-1002` — new purchase columns, index predicates from derived lists.
- `packages/db/src/drizzle/repositories/purchases.ts:151` — widened lock read.
- `packages/db/src/drizzle/repositories/purchases-ext.ts:356,399` — reconciliation predicates from the derived list.
- `packages/db/src/drizzle/repositories/revenue-events.ts:154` — family-shared suppression.
- `packages/db/src/drizzle/repositories/access.ts` — reconciler read helpers.
- `apps/api/src/services/subscription-state.ts` — `BILLING_ISSUE` mappings + transitions.
- `apps/api/src/services/subscription-transition-guard.ts` — `previous` before-image.
- `apps/api/src/services/access-engine.ts` — extract `computeDesiredAccess`.
- `apps/api/src/services/apple/apple-webhook.ts` — `OFFER_REDEEMED` dispatch, supersede call, offer columns.
- `apps/api/src/services/google/google-webhook.ts`, `stripe/stripe-webhook.ts` — `BILLING_ISSUE`, `product_changed`.
- `apps/api/src/workers/expiry-checker.ts` — derived sweep list + the ageing pass.
- `apps/api/src/services/metrics/subscriptions.ts:68,189` — derived live list.
- `packages/shared/src/integrations.ts`, `store-event-normalization.ts` — the new key and the recovered rows.
- `apps/api/src/index.ts:100-125` — boot the new worker.

---

### Task 1: Status semantics as the single source of truth

**Files:**
- Create: `packages/shared/src/subscription-status.ts`
- Create: `packages/shared/src/subscription-status.test.ts`
- Modify: `packages/shared/package.json` (exports map)
- Modify: `packages/db/src/drizzle/enums.ts:46-54`
- Modify: `packages/db/src/index.ts:56-65`
- Test: `packages/db/src/drizzle/enums.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUBSCRIPTION_STATUSES` (readonly tuple), `type SubscriptionStatus`, `SUBSCRIPTION_STATUS_SEMANTICS: Record<SubscriptionStatus, StatusSemantics>`, and the derived readonly arrays `ACCESS_GRANTING_STATUSES`, `LIVE_STATUSES`, `EXPIRY_SWEEP_STATUSES`, `RECONCILABLE_STATUSES`, `TERMINAL_STATUSES`. All exported from `@rovenue/shared/subscription-status`.

This task adds **no** new status. It only moves the existing seven behind one table so Task 3 can add the eighth in one place.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/subscription-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACCESS_GRANTING_STATUSES,
  EXPIRY_SWEEP_STATUSES,
  LIVE_STATUSES,
  RECONCILABLE_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
} from "./subscription-status";

describe("subscription status semantics", () => {
  it("describes every status exactly once", () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_SEMANTICS).sort()).toEqual(
      [...SUBSCRIPTION_STATUSES].sort(),
    );
  });

  it("derives the access-granting set", () => {
    expect([...ACCESS_GRANTING_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "TRIAL"],
    );
  });

  it("derives the live set", () => {
    expect([...LIVE_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the expiry sweep set", () => {
    expect([...EXPIRY_SWEEP_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the store-reconciliation set", () => {
    expect([...RECONCILABLE_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the terminal set", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["REFUNDED", "REVOKED"]);
  });

  it("never marks a terminal status as sweepable or reconcilable", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].sweepable).toBe(false);
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].reconcilable).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && nice -n 19 npx vitest run src/subscription-status.test.ts --maxWorkers=2`
Expected: FAIL — cannot resolve `./subscription-status`.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/subscription-status.ts`:

```ts
// =============================================================
// Subscription status — one table, every meaning
// =============================================================
//
// The set of statuses AND what each one means used to be spelled out
// independently in nine places: the Postgres enum (packages/db
// enums.ts), the TS const object (packages/db index.ts), the state
// machine's mirror (api subscription-state.ts), the access engine's
// granting set, the expiry sweeper's set, two metrics lists, and two
// raw-SQL IN(...) literals. None of them failed to compile when the
// enum grew, so adding a status meant remembering nine edits.
//
// This module is the source. `packages/db` derives its enum from
// SUBSCRIPTION_STATUSES; every consumer derives its list from
// SUBSCRIPTION_STATUS_SEMANTICS. Adding a status is one edit here plus
// a tsc error at this file until the new row is filled in.

/**
 * Every subscription status, in enum order. `packages/db`'s pgEnum and
 * its TS const object are both built from this tuple, so the Postgres
 * type and the TypeScript type cannot drift apart.
 */
export const SUBSCRIPTION_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "EXPIRED",
  "REFUNDED",
  "REVOKED",
  "PAUSED",
  "GRACE_PERIOD",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface StatusSemantics {
  /** Produces a `subscriber_access` row (the access engine's union). */
  grantsAccess: boolean;
  /** Counts as an active subscription in dashboard/metrics rollups. */
  isLive: boolean;
  /** Absorbing: the state machine permits no outgoing edge. */
  isTerminal: boolean;
  /** The expiry sweeper may move this row when its period lapses. */
  sweepable: boolean;
  /** Store-reconciliation sweeps should keep re-polling this row. */
  reconcilable: boolean;
  /** Signals involuntary churn (payment failure) rather than a user choice. */
  involuntary: boolean;
}

/**
 * `Record`, not `Partial<Record>`: a new member of SUBSCRIPTION_STATUSES
 * is a compile error here until its meaning is declared. The §6
 * store-lifecycle batch shipped a silently-dropped provider event
 * because a `Partial<Record>` let a missing key compile — this is the
 * same hazard with the same fix.
 */
export const SUBSCRIPTION_STATUS_SEMANTICS: Record<
  SubscriptionStatus,
  StatusSemantics
> = {
  TRIAL: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  ACTIVE: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  GRACE_PERIOD: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: true,
  },
  // Voluntary pause (Google's PAUSED, Stripe's paused). No access, but
  // the subscription is expected back, so it stays live for rollups and
  // sweepable so a lapsed pause still reaches EXPIRED.
  PAUSED: {
    grantsAccess: false,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  EXPIRED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: false,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
  REFUNDED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: true,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
  REVOKED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: true,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
};

function statusesWhere(
  predicate: (semantics: StatusSemantics) => boolean,
): readonly SubscriptionStatus[] {
  return SUBSCRIPTION_STATUSES.filter((status) =>
    predicate(SUBSCRIPTION_STATUS_SEMANTICS[status]),
  );
}

/** Statuses whose purchases produce `subscriber_access` rows. */
export const ACCESS_GRANTING_STATUSES = statusesWhere((s) => s.grantsAccess);

/** Statuses counted as active subscriptions in metrics. */
export const LIVE_STATUSES = statusesWhere((s) => s.isLive);

/** Statuses the expiry sweeper may move on lapse. */
export const EXPIRY_SWEEP_STATUSES = statusesWhere((s) => s.sweepable);

/** Statuses a store-reconciliation sweep should keep re-polling. */
export const RECONCILABLE_STATUSES = statusesWhere((s) => s.reconcilable);

/** Absorbing statuses — no outgoing transition. */
export const TERMINAL_STATUSES = statusesWhere((s) => s.isTerminal);

/**
 * A single-quoted, comma-separated list for embedding in a raw SQL
 * `IN (...)`. Status names are compile-time constants from this module —
 * never user input — so interpolation is safe here and nowhere else.
 */
export function statusSqlList(
  statuses: readonly SubscriptionStatus[],
): string {
  return statuses.map((s) => `'${s}'`).join(", ");
}
```

- [ ] **Step 4: Add the subpath export**

In `packages/shared/package.json`, inside `"exports"`, after the `"./crypto"` entry:

```json
    "./subscription-status": {
      "types": "./src/subscription-status.ts",
      "default": "./src/subscription-status.ts"
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/shared && nice -n 19 npx vitest run src/subscription-status.test.ts --maxWorkers=2`
Expected: PASS, 7 tests.

- [ ] **Step 6: Derive the Postgres enum from the tuple**

In `packages/db/src/drizzle/enums.ts`, replace the literal `purchaseStatus` definition at line 46:

```ts
import { SUBSCRIPTION_STATUSES } from "@rovenue/shared/subscription-status";

// ...

// Derived from @rovenue/shared/subscription-status so the Postgres type
// and the TypeScript union cannot drift. pgEnum wants a non-empty
// tuple; the shared tuple is `as const` and non-empty by construction.
export const purchaseStatus = pgEnum("PurchaseStatus", SUBSCRIPTION_STATUSES);
```

- [ ] **Step 7: Derive the TS const object from the tuple**

In `packages/db/src/index.ts`, replace the hand-written `PurchaseStatus` object at line 56:

```ts
import {
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@rovenue/shared/subscription-status";

/**
 * Value-and-type pair kept for ergonomics (`PurchaseStatus.ACTIVE`).
 * Built from the shared tuple rather than re-typed, so this object can
 * never list a status the Postgres enum lacks or vice versa.
 */
export const PurchaseStatus = Object.fromEntries(
  SUBSCRIPTION_STATUSES.map((s) => [s, s]),
) as { [K in SubscriptionStatus]: K };
export type PurchaseStatus = SubscriptionStatus;
```

Also re-export the derived lists from the db barrel so api consumers have one import:

```ts
export {
  ACCESS_GRANTING_STATUSES,
  EXPIRY_SWEEP_STATUSES,
  LIVE_STATUSES,
  RECONCILABLE_STATUSES,
  SUBSCRIPTION_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  statusSqlList,
} from "@rovenue/shared/subscription-status";
```

- [ ] **Step 8: Add the db-side agreement test**

Append to `packages/db/src/drizzle/enums.test.ts`:

```ts
import { SUBSCRIPTION_STATUSES } from "@rovenue/shared/subscription-status";
import { purchaseStatus } from "./enums";
import { PurchaseStatus } from "../index";

it("purchaseStatus pgEnum matches the shared tuple", () => {
  expect(purchaseStatus.enumValues).toEqual([...SUBSCRIPTION_STATUSES]);
});

it("the PurchaseStatus const object matches the shared tuple", () => {
  expect(Object.keys(PurchaseStatus).sort()).toEqual(
    [...SUBSCRIPTION_STATUSES].sort(),
  );
});
```

- [ ] **Step 9: Run the db tests**

Run: `cd packages/db && DATABASE_URL=postgres://localhost/ignored nice -n 19 npx vitest run src/drizzle/enums.test.ts --maxWorkers=2`
Expected: PASS. (`@rovenue/db` vitest requires `DATABASE_URL` to be exported even for unit tests.)

- [ ] **Step 10: Verify drizzle-kit still sees no schema change**

Run: `pnpm db:migrate:generate`
Expected: **"No schema changes, nothing to migrate"**. If it emits a `DROP TYPE`/`CREATE TYPE` pair, drizzle-kit failed to resolve the imported tuple — revert Step 6 to a literal array, keep Step 8's test as the drift guard, and note it in the commit body. Delete any generated file before committing.

- [ ] **Step 11: Typecheck both packages**

Run: `cd packages/shared && npx tsc --noEmit && cd ../db && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/subscription-status.ts packages/shared/src/subscription-status.test.ts packages/shared/package.json packages/db/src/drizzle/enums.ts packages/db/src/drizzle/enums.test.ts packages/db/src/index.ts
git commit -m "refactor(db): derive subscription statuses from one shared semantics table"
```

---

### Task 2: Rewire the API's hand-written status lists

**Files:**
- Modify: `apps/api/src/services/access-engine.ts:5-9`
- Modify: `apps/api/src/workers/expiry-checker.ts:41-53`
- Modify: `apps/api/src/services/metrics/subscriptions.ts:68-72` and `:189`
- Modify: `apps/api/src/services/subscription-state.ts:20-29`
- Test: `apps/api/src/services/subscription-status-lists.test.ts` (create)

**Interfaces:**
- Consumes: `ACCESS_GRANTING_STATUSES`, `LIVE_STATUSES`, `EXPIRY_SWEEP_STATUSES`, `TERMINAL_STATUSES` from Task 1.
- Produces: nothing new — behaviour is identical; only the source of the lists changes.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/subscription-status-lists.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACCESS_GRANTING_STATUSES,
  TERMINAL_STATUSES,
} from "@rovenue/shared/subscription-status";
import { purchaseRepoTerminalStatuses } from "@rovenue/db";
import { allowedTransitions } from "./subscription-state";

describe("status list agreement", () => {
  it("the state machine gives terminal statuses no outgoing edge but themselves", () => {
    for (const status of TERMINAL_STATUSES) {
      expect([...allowedTransitions(status)]).toEqual([status]);
    }
  });

  it("every access-granting status is reachable from ACTIVE or is ACTIVE", () => {
    const fromActive = allowedTransitions("ACTIVE");
    for (const status of ACCESS_GRANTING_STATUSES) {
      expect(fromActive.has(status)).toBe(true);
    }
  });

  // purchases.ts:24's TERMINAL_STATUSES is a DELIBERATE duplicate: a
  // data-layer guard that must keep refusing to resurrect a terminal row
  // even when the application layer is wrong, so it must not import the
  // shared list. This pins the two together without coupling them.
  it("the data-layer terminal guard matches the derived terminal set", () => {
    expect([...purchaseRepoTerminalStatuses()].sort()).toEqual(
      [...TERMINAL_STATUSES].sort(),
    );
  });
});
```

`purchaseRepoTerminalStatuses()` does not exist yet — Step 3a below adds it as a
one-line accessor over the existing private constant.

- [ ] **Step 2: Run it to verify it passes already**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-status-lists.test.ts --maxWorkers=2`
Expected: PASS. This test is a *pin* for the rewiring below — it must stay green while the lists change source.

- [ ] **Step 3a: Expose the data-layer terminal guard for the pin test**

In `packages/db/src/drizzle/repositories/purchases.ts`, below the existing
`TERMINAL_STATUSES` constant at line 24:

```ts
/**
 * Read-only accessor for the data-layer terminal guard. Exists so a test
 * can assert this deliberate duplicate still agrees with the shared
 * semantics table WITHOUT this module importing it — the duplication is
 * the point (defence in depth if the application layer is wrong).
 */
export function purchaseRepoTerminalStatuses(): readonly PurchaseStatus[] {
  return TERMINAL_STATUSES;
}
```

Re-export it from `packages/db/src/index.ts`.

- [ ] **Step 3: Rewire the access engine**

In `apps/api/src/services/access-engine.ts`, replace lines 5-9:

```ts
import { ACCESS_GRANTING_STATUSES } from "@rovenue/shared/subscription-status";

// Derived from the shared status-semantics table — see
// packages/shared/src/subscription-status.ts. A new status that grants
// access is picked up here automatically.
const ACCESS_GRANTING: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>(
  ACCESS_GRANTING_STATUSES,
);
```

and replace the single use at line 42 (`ACCESS_GRANTING_STATUSES.has(...)`) with `ACCESS_GRANTING.has(...)`.

- [ ] **Step 4: Rewire the expiry sweeper**

In `apps/api/src/workers/expiry-checker.ts`, replace the `EXPIRY_SWEEP_STATUSES` literal at lines 41-53:

```ts
import { EXPIRY_SWEEP_STATUSES as SWEEPABLE } from "@rovenue/shared/subscription-status";

// Every non-terminal status that can lapse, derived from the shared
// semantics table. Kept in sync with the partial index
// purchases_status_expiresDate_idx by the pg_indexes contract test in
// packages/db (see Task 5).
const EXPIRY_SWEEP_STATUSES: PurchaseStatus[] = [...SWEEPABLE];
```

- [ ] **Step 5: Rewire the metrics lists**

In `apps/api/src/services/metrics/subscriptions.ts`, replace the literal at line 68:

```ts
import { LIVE_STATUSES as SHARED_LIVE_STATUSES } from "@rovenue/shared/subscription-status";

const LIVE_STATUSES: ReadonlyArray<PurchaseStatus> = SHARED_LIVE_STATUSES;
```

At line 189, replace `inArray(p.status, ["GRACE_PERIOD", "PAUSED"])` with a derived expression.

**Corrected 2026-09-04.** An earlier draft of this step derived the set as
`LIVE_STATUSES minus ACCESS_GRANTING_STATUSES`. That is wrong: GRACE_PERIOD *grants*
access, so it is subtracted out and the set collapses to `["PAUSED"]`, silently dropping
grace-period subscribers from the dashboard's at-risk count. The rule that actually
reproduces the literal is "live, but either failing payment or not currently granting
access":

```ts
import { SUBSCRIPTION_STATUS_SEMANTICS } from "@rovenue/shared/subscription-status";

/**
 * "At risk" = a live subscription that is either failing payment or not
 * currently granting access. GRACE_PERIOD qualifies on the first count,
 * PAUSED on the second; TRIAL and ACTIVE on neither. Derived rather than
 * listed so a new status matching the rule — BILLING_ISSUE, added in
 * Task 3 — joins the set automatically, which is what this view wants.
 */
const AT_RISK_STATUSES = SHARED_LIVE_STATUSES.filter((s) => {
  const semantics = SUBSCRIPTION_STATUS_SEMANTICS[s];
  return semantics.involuntary || !semantics.grantsAccess;
});
// ...
      return inArray(p.status, [...AT_RISK_STATUSES]);
```

Pin it with a test asserting `[...AT_RISK_STATUSES].sort()` equals
`["GRACE_PERIOD", "PAUSED"]` today — that assertion is what catches a wrong derivation.

- [ ] **Step 6: Rewire the state machine's STATUS mirror**

In `apps/api/src/services/subscription-state.ts`, replace the hand-written `STATUS` object at lines 20-29:

```ts
import {
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@rovenue/shared/subscription-status";

// Type-safe mirror of the PurchaseStatus enum, built from the shared
// tuple. `import type` still keeps the DB package out of this module's
// runtime graph.
const STATUS = Object.fromEntries(
  SUBSCRIPTION_STATUSES.map((s) => [s, s]),
) as { [K in SubscriptionStatus]: K };
```

- [ ] **Step 7: Run the affected suites**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-state src/services/subscription-status-lists src/services/metrics src/workers/expiry-checker.integration --maxWorkers=2`
Expected: PASS, no behaviour change.

- [ ] **Step 8: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/access-engine.ts apps/api/src/workers/expiry-checker.ts apps/api/src/services/metrics/subscriptions.ts apps/api/src/services/subscription-state.ts apps/api/src/services/subscription-status-lists.test.ts
git commit -m "refactor(api): derive every status list from the shared semantics table"
```

---

### Task 3: Add `BILLING_ISSUE` — enum, migration, semantics, transitions

**Files:**
- Modify: `packages/shared/src/subscription-status.ts`
- Modify: `packages/shared/src/subscription-status.test.ts`
- Modify: `packages/db/src/drizzle/schema.ts:904-1002`
- Create: `packages/db/drizzle/migrations/0115_billing_issue_status.sql` (+ journal + snapshot)
- Modify: `apps/api/src/services/subscription-state.ts` (TRANSITIONS)
- Test: `packages/db/src/drizzle/purchase-status-indexes.integration.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `SUBSCRIPTION_STATUSES`, `SUBSCRIPTION_STATUS_SEMANTICS`, `statusSqlList`.
- Produces: `PurchaseStatus.BILLING_ISSUE`; `purchases.billingIssueDetectedAt: Date | null`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/subscription-status.test.ts`:

```ts
it("BILLING_ISSUE is involuntary, grants no access, and is not sweepable", () => {
  const s = SUBSCRIPTION_STATUS_SEMANTICS.BILLING_ISSUE;
  expect(s).toEqual({
    grantsAccess: false,
    isLive: true,
    isTerminal: false,
    sweepable: false,
    reconcilable: true,
    involuntary: true,
  });
});

it("keeps BILLING_ISSUE out of the expiry sweep but inside reconciliation", () => {
  expect(EXPIRY_SWEEP_STATUSES).not.toContain("BILLING_ISSUE");
  expect(RECONCILABLE_STATUSES).toContain("BILLING_ISSUE");
});
```

Add to `apps/api/src/services/subscription-state.test.ts` (or create if absent):

```ts
import { validateTransition } from "./subscription-state";

it("allows entry into BILLING_ISSUE from every granting status", () => {
  expect(validateTransition("ACTIVE", "BILLING_ISSUE")).toBe(true);
  expect(validateTransition("TRIAL", "BILLING_ISSUE")).toBe(true);
  expect(validateTransition("GRACE_PERIOD", "BILLING_ISSUE")).toBe(true);
});

it("allows recovery and lapse out of BILLING_ISSUE, but not a voluntary pause", () => {
  expect(validateTransition("BILLING_ISSUE", "ACTIVE")).toBe(true);
  expect(validateTransition("BILLING_ISSUE", "EXPIRED")).toBe(true);
  expect(validateTransition("BILLING_ISSUE", "REFUNDED")).toBe(true);
  expect(validateTransition("BILLING_ISSUE", "REVOKED")).toBe(true);
  expect(validateTransition("BILLING_ISSUE", "PAUSED")).toBe(false);
});

it("keeps terminal states absorbing against BILLING_ISSUE", () => {
  expect(validateTransition("REFUNDED", "BILLING_ISSUE")).toBe(false);
  expect(validateTransition("REVOKED", "BILLING_ISSUE")).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/shared && nice -n 19 npx vitest run src/subscription-status.test.ts --maxWorkers=2`
Expected: FAIL — `SUBSCRIPTION_STATUS_SEMANTICS.BILLING_ISSUE` is `undefined`.

- [ ] **Step 3: Add the status to the shared tuple and table**

In `packages/shared/src/subscription-status.ts`, append `"BILLING_ISSUE"` to `SUBSCRIPTION_STATUSES` (last, so the Postgres enum order is append-only) and add the row:

```ts
  // Involuntary suspension for a payment failure the store has stopped
  // covering: Google account hold, Apple billing retry with no grace
  // period configured, Stripe `unpaid`/`incomplete`. Distinct from
  // GRACE_PERIOD (retry WITH access) and from PAUSED (the user's own
  // choice). Not sweepable — an account-hold row's expiresDate is
  // already past, so the expiry sweeper would erase the dunning signal
  // the moment it appeared; expiry-checker.ts's separate ageing pass
  // retires it after BILLING_ISSUE_MAX_AGE_DAYS instead.
  BILLING_ISSUE: {
    grantsAccess: false,
    isLive: true,
    isTerminal: false,
    sweepable: false,
    reconcilable: true,
    involuntary: true,
  },
```

- [ ] **Step 4: Add the transitions**

In `apps/api/src/services/subscription-state.ts`, add `STATUS.BILLING_ISSUE` to the target sets of `TRIAL`, `ACTIVE` and `GRACE_PERIOD`, and add the new source row:

```ts
    [STATUS.BILLING_ISSUE]: new Set<PurchaseStatus>([
      STATUS.BILLING_ISSUE,
      STATUS.ACTIVE,
      STATUS.EXPIRED,
      STATUS.REFUNDED,
      STATUS.REVOKED,
    ]),
```

- [ ] **Step 5: Add the column and derive the index predicates**

In `packages/db/src/drizzle/schema.ts`, inside the `purchases` table definition after `lastReconciledAt`:

```ts
    // Set the first time a purchase enters BILLING_ISSUE (not refreshed
    // by a repeated signal, so dunning campaigns can age off the real
    // start), cleared on any exit to an access-granting status.
    billingIssueDetectedAt: timestamp("billingIssueDetectedAt", {
      withTimezone: true,
    }),
```

Replace the two partial-index predicates with derived lists:

```ts
import {
  EXPIRY_SWEEP_STATUSES,
  RECONCILABLE_STATUSES,
  statusSqlList,
} from "@rovenue/shared/subscription-status";

// ...
    statusExpiresDateIdx: index("purchases_status_expiresDate_idx")
      .on(t.status, t.expiresDate)
      .where(
        sql`${t.status} IN (${sql.raw(statusSqlList(EXPIRY_SWEEP_STATUSES))})`,
      ),
    googleReconciliationIdx: index("purchases_google_reconciliation_idx")
      .on(t.store, t.lastReconciledAt, t.expiresDate)
      .where(
        sql`${t.store} = 'PLAY_STORE' AND ${t.status} IN (${sql.raw(statusSqlList(RECONCILABLE_STATUSES))})`,
      ),
```

- [ ] **Step 6: Generate the migration scaffold, then replace its body**

Run: `pnpm db:migrate:generate`

drizzle-kit will emit `ALTER TYPE ... ADD VALUE` plus the index/column DDL, and will write the journal entry and snapshot. Rename the generated `.sql` to `0115_billing_issue_status.sql`, update its `tag` in `packages/db/drizzle/migrations/meta/_journal.json`, rename the snapshot to match, and **replace the SQL body entirely** with:

```sql
-- BILLING_ISSUE cannot be added with ALTER TYPE ... ADD VALUE.
-- Postgres forbids USING a value added that way inside the transaction
-- that added it, and the drizzle migrator runs ALL pending migrations
-- in one transaction (drizzle-orm/pg-core/dialect.cjs — `migrate()`
-- wraps the whole loop in `session.transaction`). Splitting across two
-- files does not help: on a fresh install both land in the same
-- transaction and the run fails with `unsafe use of new value`, while
-- passing on a developer machine where the files ran separately.
-- Same reasoning and same shape as 0084_brown_nick_fury.sql.
--
-- Both partial indexes are dropped and recreated. Only the second one's
-- predicate actually changes (it gains BILLING_ISSUE, so held Play
-- subscriptions keep being re-polled); the first is dropped because a
-- partial-index predicate embeds Const nodes of the enum type being
-- dropped and cannot be rebuilt in place.
DROP INDEX IF EXISTS "purchases_status_expiresDate_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "purchases_google_reconciliation_idx";--> statement-breakpoint
ALTER TYPE "public"."PurchaseStatus" RENAME TO "PurchaseStatus_old";--> statement-breakpoint
CREATE TYPE "public"."PurchaseStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'REFUNDED', 'REVOKED', 'PAUSED', 'GRACE_PERIOD', 'BILLING_ISSUE');--> statement-breakpoint
ALTER TABLE "purchases" ALTER COLUMN "status" TYPE "public"."PurchaseStatus" USING "status"::text::"public"."PurchaseStatus";--> statement-breakpoint
DROP TYPE "public"."PurchaseStatus_old";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "billingIssueDetectedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "purchases_status_expiresDate_idx" ON "purchases" USING btree ("status","expiresDate") WHERE "purchases"."status" IN ('TRIAL', 'ACTIVE', 'PAUSED', 'GRACE_PERIOD');--> statement-breakpoint
CREATE INDEX "purchases_google_reconciliation_idx" ON "purchases" USING btree ("store","lastReconciledAt","expiresDate") WHERE "purchases"."store" = 'PLAY_STORE' AND "purchases"."status" IN ('TRIAL', 'ACTIVE', 'PAUSED', 'GRACE_PERIOD', 'BILLING_ISSUE');
```

- [ ] **Step 7: Write the index contract test**

Create `packages/db/src/drizzle/purchase-status-indexes.integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  EXPIRY_SWEEP_STATUSES,
  RECONCILABLE_STATUSES,
} from "@rovenue/shared/subscription-status";
import { withTestDb } from "../../tests/helpers/test-db";

// Reads the LIVE predicate out of pg_indexes rather than comparing a
// hand-built string against itself: the only thing that can make this
// pass is the migration having actually created the index Postgres
// reports.
function statusesInPredicate(indexdef: string): string[] {
  const match = /status[^)]*IN \(([^)]*)\)/i.exec(indexdef);
  if (!match?.[1]) throw new Error(`no status IN(...) in: ${indexdef}`);
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'(::[\w."]+)?$/, ""));
}

describe("purchases status partial indexes", () => {
  it("the expiry sweep index lists exactly the sweepable statuses", async () => {
    await withTestDb(async (db) => {
      const rows = await db.execute(sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'purchases'
          AND indexname = 'purchases_status_expiresDate_idx'
      `);
      const def = (rows as unknown as { rows: Array<{ indexdef: string }> })
        .rows[0]?.indexdef;
      expect(def).toBeTruthy();
      expect(statusesInPredicate(def!).sort()).toEqual(
        [...EXPIRY_SWEEP_STATUSES].sort(),
      );
    });
  });

  it("the reconciliation index lists exactly the reconcilable statuses", async () => {
    await withTestDb(async (db) => {
      const rows = await db.execute(sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'purchases'
          AND indexname = 'purchases_google_reconciliation_idx'
      `);
      const def = (rows as unknown as { rows: Array<{ indexdef: string }> })
        .rows[0]?.indexdef;
      expect(def).toBeTruthy();
      expect(statusesInPredicate(def!).sort()).toEqual(
        [...RECONCILABLE_STATUSES].sort(),
      );
    });
  });
});
```

If `packages/db/tests/helpers/test-db.ts` exposes a different helper name, use the one the neighbouring `*.integration.test.ts` files in `packages/db` already use — read one first rather than inventing a helper.

- [ ] **Step 8: Drop the test template DB and run the integration test**

Run:
```bash
docker ps > /dev/null || echo "Docker is down — start it before continuing"
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd packages/db && nice -n 19 npx vitest run src/drizzle/purchase-status-indexes.integration.test.ts --maxWorkers=2
```
Expected: PASS, both indexes present with the derived predicates.

- [ ] **Step 9: Run the unit tests**

Run: `cd packages/shared && nice -n 19 npx vitest run src/subscription-status.test.ts --maxWorkers=2 && cd ../../apps/api && nice -n 19 npx vitest run src/services/subscription-state --maxWorkers=2`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/subscription-status.ts packages/shared/src/subscription-status.test.ts packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/db/src/drizzle/purchase-status-indexes.integration.test.ts apps/api/src/services/subscription-state.ts apps/api/src/services/subscription-state.test.ts
git commit -m "feat(db): add BILLING_ISSUE as a first-class subscription status"
```

---

### Task 4: Route the three stores' billing signals to `BILLING_ISSUE`

**Files:**
- Modify: `apps/api/src/services/subscription-state.ts` (`normalizeAppleStatus`, `normalizeGoogleStatus`, `normalizeStripeStatus`)
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (stamp the column)
- Modify: `apps/api/src/services/google/google-webhook.ts`, `apps/api/src/services/stripe/stripe-webhook.ts`
- Test: `apps/api/src/services/subscription-state.test.ts`

**Interfaces:**
- Consumes: `PurchaseStatus.BILLING_ISSUE` from Task 3.
- Produces: `billingIssueStamp(from: PurchaseStatus | null, to: PurchaseStatus, now: Date): { billingIssueDetectedAt?: Date | null }` exported from `subscription-state.ts` — the single helper all three upsert paths spread into their update payload.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/subscription-state.test.ts`:

```ts
import {
  billingIssueStamp,
  normalizeAppleStatus,
  normalizeGoogleStatus,
  normalizeStripeStatus,
} from "./subscription-state";

describe("billing issue mapping", () => {
  it("keeps Apple's configured grace period access-granting", () => {
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe(
      "GRACE_PERIOD",
    );
  });

  it("routes Apple billing retry without grace to BILLING_ISSUE", () => {
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", "BILLING_RETRY")).toBe(
      "BILLING_ISSUE",
    );
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", undefined)).toBe(
      "BILLING_ISSUE",
    );
  });

  it("separates Google account hold from a voluntary pause", () => {
    expect(normalizeGoogleStatus("SUBSCRIPTION_STATE_ON_HOLD")).toBe(
      "BILLING_ISSUE",
    );
    expect(normalizeGoogleStatus("SUBSCRIPTION_STATE_PAUSED")).toBe("PAUSED");
  });

  it("separates Stripe's retrying and non-paying statuses", () => {
    expect(normalizeStripeStatus("past_due")).toBe("GRACE_PERIOD");
    expect(normalizeStripeStatus("unpaid")).toBe("BILLING_ISSUE");
    expect(normalizeStripeStatus("incomplete")).toBe("BILLING_ISSUE");
  });
});

describe("billingIssueStamp", () => {
  const now = new Date("2026-09-03T00:00:00Z");

  it("stamps on entry", () => {
    expect(billingIssueStamp("ACTIVE", "BILLING_ISSUE", now)).toEqual({
      billingIssueDetectedAt: now,
    });
  });

  it("does not reset the clock on a repeated signal", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "BILLING_ISSUE", now)).toEqual({});
  });

  it("clears on recovery to a granting status", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "ACTIVE", now)).toEqual({
      billingIssueDetectedAt: null,
    });
  });

  it("leaves the stamp alone on a lapse to EXPIRED", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "EXPIRED", now)).toEqual({});
  });
});
```

Replace the literal Google state strings with whatever `GOOGLE_SUBSCRIPTION_STATE` actually spells (read `apps/api/src/services/google/google-types.ts` first — do not guess the constant's value).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-state.test.ts --maxWorkers=2`
Expected: FAIL — current mappings return `GRACE_PERIOD` / `PAUSED`.

- [ ] **Step 3: Change the three normalizers**

In `apps/api/src/services/subscription-state.ts`:

```ts
    case APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW:
      // Apple sends subtype GRACE_PERIOD only when the app has a billing
      // grace period configured — that is the case where the subscriber
      // keeps access during the retry. Without it the subscription has
      // already lapsed on Apple's side and the user has NO access, so
      // reporting GRACE_PERIOD here (the pre-2026-09-03 "OD-1" choice)
      // granted entitlement Apple itself had withdrawn.
      return subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD
        ? STATUS.GRACE_PERIOD
        : STATUS.BILLING_ISSUE;
```

```ts
    case GOOGLE_SUBSCRIPTION_STATE.ON_HOLD:
      // Account hold: Google suspended the subscription after the grace
      // window closed. Access is gone, and — unlike PAUSED — the user
      // did not choose this, so dunning applies.
      return STATUS.BILLING_ISSUE;
    case GOOGLE_SUBSCRIPTION_STATE.PAUSED:
      return STATUS.PAUSED;
```

```ts
    case STRIPE_SUBSCRIPTION_STATUS.PAST_DUE:
      // Smart retries are running and Stripe keeps the subscription
      // usable — access is retained.
      return STATUS.GRACE_PERIOD;
    case STRIPE_SUBSCRIPTION_STATUS.UNPAID:
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE:
      return STATUS.BILLING_ISSUE;
```

- [ ] **Step 4: Add the stamp helper**

Append to `apps/api/src/services/subscription-state.ts`:

```ts
import { SUBSCRIPTION_STATUS_SEMANTICS } from "@rovenue/shared/subscription-status";

/**
 * Column patch for `purchases.billingIssueDetectedAt`, spread into the
 * guarded update by every ingestion path. Stamped on ENTRY only (so a
 * repeated ON_HOLD signal doesn't reset a dunning campaign's clock) and
 * cleared only when the subscription recovers into a status that grants
 * access again. A lapse to EXPIRED keeps the stamp — that is the
 * evidence the churn was involuntary.
 */
export function billingIssueStamp(
  from: PurchaseStatus | null,
  to: PurchaseStatus,
  now: Date,
): { billingIssueDetectedAt?: Date | null } {
  if (to === STATUS.BILLING_ISSUE) {
    return from === STATUS.BILLING_ISSUE ? {} : { billingIssueDetectedAt: now };
  }
  if (
    from === STATUS.BILLING_ISSUE &&
    SUBSCRIPTION_STATUS_SEMANTICS[to].grantsAccess
  ) {
    return { billingIssueDetectedAt: null };
  }
  return {};
}
```

- [ ] **Step 5: Spread the stamp into the three upsert paths**

In `apps/api/src/services/apple/apple-webhook.ts`'s `upsertPurchase`, inside the `update` object next to the guarded status write:

```ts
        update: {
          ...(guard.apply
            ? {
                status,
                lastStoreEventAt: eventTime,
                ...billingIssueStamp(guard.from, status, eventTime),
              }
            : {}),
          autoRenewStatus,
          expiresDate: tx.expiresDate ? new Date(tx.expiresDate) : null,
          verifiedAt: new Date(),
        },
```

Apply the equivalent spread at the guarded-status update in `google-webhook.ts` and in `stripe-webhook.ts`'s `upsertPurchaseFromSubscription`. `guard.from` is already on `GuardStatusWriteResult`.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-state src/services/apple src/services/google src/services/stripe --maxWorkers=2`
Expected: PASS. Existing tests that asserted `GRACE_PERIOD` for Apple billing retry or Google `ON_HOLD` must be **updated**, not deleted — change the expectation and add a one-line comment naming this task.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(store): route Apple retry, Google account hold and Stripe unpaid to BILLING_ISSUE"
```

---

### Task 5: Bounded ageing pass + reconciliation predicate

**Files:**
- Modify: `apps/api/src/workers/expiry-checker.ts`
- Modify: `packages/db/src/drizzle/repositories/purchases-ext.ts:356,399`
- Test: `apps/api/src/workers/expiry-checker.integration.test.ts`

**Interfaces:**
- Consumes: `RECONCILABLE_STATUSES`, `statusSqlList` (Task 1); `PurchaseStatus.BILLING_ISSUE` (Task 3).
- Produces: `BILLING_ISSUE_MAX_AGE_DAYS` and `runBillingIssueAgeing(now: Date): Promise<{ checked: number; expired: number }>` from `expiry-checker.ts`.

- [ ] **Step 1: Write the failing integration test**

Add to `apps/api/src/workers/expiry-checker.integration.test.ts`:

```ts
it("retires a BILLING_ISSUE purchase only after the max-age window", async () => {
  const now = new Date("2026-09-03T00:00:00Z");
  const fresh = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const stale = new Date(
    now.getTime() - (BILLING_ISSUE_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
  );

  const freshId = await seedPurchase({
    status: "BILLING_ISSUE",
    billingIssueDetectedAt: fresh,
  });
  const staleId = await seedPurchase({
    status: "BILLING_ISSUE",
    billingIssueDetectedAt: stale,
  });

  const result = await runBillingIssueAgeing(now);

  expect(result.expired).toBe(1);
  await expect(statusOf(freshId)).resolves.toBe("BILLING_ISSUE");
  await expect(statusOf(staleId)).resolves.toBe("EXPIRED");
});

it("does not let the ordinary expiry sweep touch BILLING_ISSUE rows", async () => {
  const id = await seedPurchase({
    status: "BILLING_ISSUE",
    billingIssueDetectedAt: new Date("2026-08-01T00:00:00Z"),
    expiresDate: new Date("2026-08-01T00:00:00Z"),
  });
  await runExpiryCheck(new Date("2026-09-03T00:00:00Z"));
  await expect(statusOf(id)).resolves.toBe("BILLING_ISSUE");
});
```

Reuse the file's existing seeding helpers; if `seedPurchase` there does not accept `billingIssueDetectedAt`, extend it rather than writing a second seeder.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/workers/expiry-checker.integration.test.ts --maxWorkers=2`
Expected: FAIL — `runBillingIssueAgeing` is not exported.

- [ ] **Step 3: Implement the ageing pass**

In `apps/api/src/workers/expiry-checker.ts`:

```ts
// Apple retries a failed renewal for up to 60 days; Google's account
// hold is 30; Stripe's dunning is configurable and shorter. 60 is the
// widest real window, so a row still in BILLING_ISSUE past it is not
// "being retried" any more — no store is still trying.
export const BILLING_ISSUE_MAX_AGE_DAYS = 60;

export async function runBillingIssueAgeing(
  now: Date = new Date(),
): Promise<{ checked: number; expired: number }> {
  const cutoff = new Date(
    now.getTime() - BILLING_ISSUE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  );
  const candidates = await drizzle.purchaseExtRepo.findAgedBillingIssuePurchases(
    drizzle.db,
    { cutoff, limit: MAX_CANDIDATES_PER_RUN },
  );

  let expired = 0;
  for (const candidate of candidates) {
    const updated = await drizzle.purchaseRepo.updatePurchaseStatusIf(
      drizzle.db,
      candidate.id,
      PurchaseStatus.BILLING_ISSUE,
      PurchaseStatus.EXPIRED,
    );
    if (updated === 0) continue;
    expired += 1;
    await safeSyncAccess(candidate.subscriberId);
    await enqueueExpirationWebhook(candidate);
    await recordCancellationRevenue(candidate, now);
  }

  return { checked: candidates.length, expired };
}
```

Call it from the worker handler right after `runExpiryCheck()`:

```ts
    async (_job: Job) => {
      const expiry = await runExpiryCheck();
      const ageing = await runBillingIssueAgeing();
      return { ...expiry, billingIssueExpired: ageing.expired };
    },
```

- [ ] **Step 4: Add the repository query**

In `packages/db/src/drizzle/repositories/purchases-ext.ts`, next to `findOverduePurchases`:

```ts
/**
 * BILLING_ISSUE rows whose dunning window has fully elapsed. Columns
 * match `findOverduePurchases` so the expiry worker can feed both
 * result sets to the same processing helpers.
 */
export async function findAgedBillingIssuePurchases(
  db: Db,
  args: { cutoff: Date; limit: number },
): Promise<ExpiryCandidate[]> {
  const result = await db.execute(sql`
    SELECT p.id,
           p."projectId"        AS "projectId",
           p."subscriberId"     AS "subscriberId",
           p."productId"        AS "productId",
           p.status,
           p.store,
           p."expiresDate"      AS "expiresDate",
           p."gracePeriodExpires" AS "gracePeriodExpires",
           p."priceAmount"      AS "priceAmount",
           p."priceCurrency"    AS "priceCurrency"
    FROM ${purchases} p
    WHERE p.status = 'BILLING_ISSUE'
      AND p."billingIssueDetectedAt" IS NOT NULL
      AND p."billingIssueDetectedAt" < ${args.cutoff}
    ORDER BY p."billingIssueDetectedAt" ASC
    LIMIT ${args.limit}
  `);
  const rows =
    (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map(toExpiryCandidate);
}
```

Use whatever the file's existing row-mapping helper for expiry candidates is called; do not add a second mapper.

- [ ] **Step 5: Derive the two reconciliation predicates**

In the same file, replace the hardcoded `IN ('TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'PAUSED')` at both line 356 and line 399:

```ts
import {
  RECONCILABLE_STATUSES,
  statusSqlList,
} from "@rovenue/shared/subscription-status";

const RECONCILABLE_SQL = sql.raw(statusSqlList(RECONCILABLE_STATUSES));

// ... inside both queries:
      AND p.status IN (${RECONCILABLE_SQL})
```

- [ ] **Step 6: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/workers/expiry-checker.integration.test.ts src/workers/google-reconciliation.integration.test.ts --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/workers/expiry-checker.ts packages/db/src/drizzle/repositories/purchases-ext.ts apps/api/src/workers/expiry-checker.integration.test.ts
git commit -m "feat(api): retire aged BILLING_ISSUE rows and keep held subscriptions reconcilable"
```

---

### Task 6: Widen the transition guard with a before-image

**Files:**
- Modify: `packages/db/src/drizzle/repositories/purchases.ts:151-175`
- Modify: `apps/api/src/services/subscription-transition-guard.ts`
- Test: `apps/api/src/services/subscription-transition-guard.previous.integration.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GuardStatusWriteResult.previous: { status: PurchaseStatus; productId: string; autoRenewStatus: boolean | null } | null`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/services/subscription-transition-guard.previous.integration.test.ts` following the setup of the existing `subscription-transition-guard.stale.test.ts` neighbours (read that file for the seed helpers before writing):

```ts
it("returns the row's product and auto-renew state as a before-image", async () => {
  const { projectId, productId, storeTransactionId } = await seedActivePurchase({
    autoRenewStatus: true,
  });

  const result = await guardStatusWrite({
    db: drizzle.db,
    projectId,
    store: Store.APP_STORE,
    storeTransactionId,
    to: PurchaseStatus.ACTIVE,
    source: "test",
  });

  expect(result.previous).toEqual({
    status: PurchaseStatus.ACTIVE,
    productId,
    autoRenewStatus: true,
  });
});

it("returns a null before-image for a row that does not exist yet", async () => {
  const result = await guardStatusWrite({
    db: drizzle.db,
    projectId: "p_missing",
    store: Store.APP_STORE,
    storeTransactionId: "tx_missing",
    to: PurchaseStatus.ACTIVE,
    source: "test",
  });
  expect(result.previous).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-transition-guard.previous.integration.test.ts --maxWorkers=2`
Expected: FAIL — `previous` is undefined.

- [ ] **Step 3: Widen the locked read**

In `packages/db/src/drizzle/repositories/purchases.ts:151`:

```ts
export async function lockPurchaseStatusByStoreTransaction(
  db: DbOrTx,
  store: Store,
  storeTransactionId: string,
): Promise<{
  id: string;
  status: PurchaseStatus;
  lastStoreEventAt: Date | null;
  // The before-image every ingestion path needs to tell a plan change
  // from an ordinary renewal, and a recovery from an unrelated payment.
  // Free here: the row is already being read FOR UPDATE.
  productId: string;
  autoRenewStatus: boolean | null;
} | null> {
  const rows = await db
    .select({
      id: purchases.id,
      status: purchases.status,
      lastStoreEventAt: purchases.lastStoreEventAt,
      productId: purchases.productId,
      autoRenewStatus: purchases.autoRenewStatus,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    )
    .for("update");
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Surface it on the guard result**

In `apps/api/src/services/subscription-transition-guard.ts`, add to `GuardStatusWriteResult`:

```ts
  /**
   * The row as it stood under the FOR UPDATE lock, or null when this is
   * the first write for the transaction. Callers use it to detect a
   * product change (plan change / cross-grade) and a genuine recovery
   * (BILLING_ISSUE -> ACTIVE) without a second query.
   */
  previous: {
    status: PurchaseStatus;
    productId: string;
    autoRenewStatus: boolean | null;
  } | null;
```

and build it once near the top of `guardStatusWrite`, then include it in **all three** return statements:

```ts
  const previous = current
    ? {
        status: current.status,
        productId: current.productId,
        autoRenewStatus: current.autoRenewStatus,
      }
    : null;
```

- [ ] **Step 5: Run the guard suites**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-transition-guard --maxWorkers=2`
Expected: PASS, including the pre-existing stale-event tests.

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && npx tsc --noEmit && cd ../../packages/db && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/repositories/purchases.ts apps/api/src/services/subscription-transition-guard.ts apps/api/src/services/subscription-transition-guard.previous.integration.test.ts
git commit -m "feat(api): carry a purchase before-image out of the transition guard"
```

---

### Task 7: Retire the superseded Apple purchase on an upgrade

**Files:**
- Create: `apps/api/src/services/apple/apple-supersede.ts`
- Create: `apps/api/src/services/apple/apple-supersede.integration.test.ts`
- Modify: `apps/api/src/services/apple/apple-webhook.ts:454-483` (`applyRenewalPrefChange`)
- Modify: `packages/db/src/drizzle/repositories/purchases-ext.ts`

**Interfaces:**
- Consumes: `guardStatusWrite` (Task 6), `syncAccess`.
- Produces: `expireSupersededApplePurchases(args: { projectId: string; originalTransactionId: string; currentStoreTransactionId: string; now: Date; source: string }): Promise<{ expired: number }>`; repository `findSupersedableApplePurchases(db, { projectId, originalTransactionId, excludeStoreTransactionId, now }): Promise<Array<{ id: string; storeTransactionId: string; subscriberId: string; status: PurchaseStatus }>>`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/services/apple/apple-supersede.integration.test.ts`:

```ts
// Apple mints a NEW transactionId for every renewal and upsertPurchase
// is keyed on it, so a long-lived subscription has one row per billing
// period under a single originalTransactionId. The supersede must touch
// exactly the row the upgrade replaced — not the renewal history.
it("expires only the unexpired sibling, never past renewal periods", async () => {
  const now = new Date("2026-09-03T00:00:00Z");
  const original = "1000000000000001";

  const oldPeriods = await Promise.all([
    seedApplePurchase({
      originalTransactionId: original,
      storeTransactionId: "tx_2026_06",
      status: "ACTIVE",
      expiresDate: new Date("2026-07-01T00:00:00Z"),
    }),
    seedApplePurchase({
      originalTransactionId: original,
      storeTransactionId: "tx_2026_07",
      status: "ACTIVE",
      expiresDate: new Date("2026-08-01T00:00:00Z"),
    }),
  ]);
  const superseded = await seedApplePurchase({
    originalTransactionId: original,
    storeTransactionId: "tx_2026_08",
    status: "ACTIVE",
    expiresDate: new Date("2026-10-01T00:00:00Z"),
  });
  const upgraded = await seedApplePurchase({
    originalTransactionId: original,
    storeTransactionId: "tx_upgrade",
    status: "ACTIVE",
    expiresDate: new Date("2026-10-01T00:00:00Z"),
  });

  const result = await expireSupersededApplePurchases({
    projectId: superseded.projectId,
    originalTransactionId: original,
    currentStoreTransactionId: "tx_upgrade",
    now,
    source: "test",
  });

  expect(result.expired).toBe(1);
  await expect(statusOf(superseded.id)).resolves.toBe("EXPIRED");
  await expect(statusOf(upgraded.id)).resolves.toBe("ACTIVE");
  for (const period of oldPeriods) {
    await expect(statusOf(period.id)).resolves.toBe("ACTIVE");
  }
});

it("leaves a terminal sibling terminal", async () => {
  const now = new Date("2026-09-03T00:00:00Z");
  const refunded = await seedApplePurchase({
    originalTransactionId: "1000000000000002",
    storeTransactionId: "tx_refunded",
    status: "REFUNDED",
    expiresDate: new Date("2026-10-01T00:00:00Z"),
  });

  await expireSupersededApplePurchases({
    projectId: refunded.projectId,
    originalTransactionId: "1000000000000002",
    currentStoreTransactionId: "tx_upgrade",
    now,
    source: "test",
  });

  await expect(statusOf(refunded.id)).resolves.toBe("REFUNDED");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/apple/apple-supersede.integration.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the repository query**

In `packages/db/src/drizzle/repositories/purchases-ext.ts`:

```ts
/**
 * Rows in the same Apple subscription chain that the incoming
 * transaction replaced. Deliberately narrow: an Apple chain holds one
 * row per BILLING PERIOD (each renewal gets its own transactionId), so
 * matching on originalTransactionId alone would sweep the entire
 * renewal history. Only a row whose period has NOT yet ended can be the
 * one an upgrade cut short.
 */
export async function findSupersedableApplePurchases(
  db: Db,
  args: {
    projectId: string;
    originalTransactionId: string;
    excludeStoreTransactionId: string;
    now: Date;
  },
): Promise<
  Array<{
    id: string;
    storeTransactionId: string;
    subscriberId: string;
    status: PurchaseStatus;
  }>
> {
  const result = await db.execute(sql`
    SELECT p.id,
           p."storeTransactionId" AS "storeTransactionId",
           p."subscriberId"       AS "subscriberId",
           p.status
    FROM ${purchases} p
    WHERE p."projectId" = ${args.projectId}
      AND p.store = 'APP_STORE'
      AND p."originalTransactionId" = ${args.originalTransactionId}
      AND p."storeTransactionId" <> ${args.excludeStoreTransactionId}
      AND p.status NOT IN (${sql.raw(statusSqlList(TERMINAL_STATUSES))})  -- add TERMINAL_STATUSES to this file's @rovenue/shared/subscription-status import
      AND p."expiresDate" IS NOT NULL
      AND p."expiresDate" > ${args.now}
  `);
  const rows =
    (result as unknown as {
      rows: Array<{
        id: string;
        storeTransactionId: string;
        subscriberId: string;
        status: PurchaseStatus;
      }>;
    }).rows ?? [];
  return rows;
}
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/services/apple/apple-supersede.ts`:

```ts
import { PurchaseStatus, Store, drizzle } from "@rovenue/db";
import { guardStatusWrite } from "../subscription-transition-guard";
import { syncAccess } from "../access-engine";
import { logger } from "../../lib/logger";

const log = logger.child("apple-supersede");

// =============================================================
// Apple upgrade supersession
// =============================================================
//
// The Apple twin of google-supersede.ts. When a subscriber upgrades,
// Apple charges immediately and sends DID_CHANGE_RENEWAL_PREF/UPGRADE
// carrying the NEW transaction — and sends nothing at all for the old
// one. Its row keeps a frozen future expiresDate, and access-engine.ts
// unions granting rows across ALL of a subscriber's purchases, so the
// pre-upgrade tier stays entitled for the rest of the old period.
//
// Scope is deliberately narrow (see findSupersedableApplePurchases):
// Apple mints a new transactionId per renewal, so the chain holds one
// row per billing period. Expiring every sibling would rewrite the
// subscription's whole history and emit an audit row per period.

export async function expireSupersededApplePurchases(args: {
  projectId: string;
  originalTransactionId: string;
  /** The replacing transaction's own id — guards against self-expiry. */
  currentStoreTransactionId: string;
  now: Date;
  source: string;
}): Promise<{ expired: number }> {
  const siblings =
    await drizzle.purchaseExtRepo.findSupersedableApplePurchases(drizzle.db, {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      excludeStoreTransactionId: args.currentStoreTransactionId,
      now: args.now,
    });

  let expired = 0;
  for (const sibling of siblings) {
    await drizzle.db.transaction(async (tx) => {
      const guard = await guardStatusWrite({
        db: tx,
        projectId: args.projectId,
        store: Store.APP_STORE,
        storeTransactionId: sibling.storeTransactionId,
        to: PurchaseStatus.EXPIRED,
        source: `${args.source}:apple_upgrade_supersede`,
        eventTime: args.now,
      });
      if (!guard.apply) return;
      await drizzle.purchaseRepo.updatePurchase(tx, sibling.id, {
        status: PurchaseStatus.EXPIRED,
        lastStoreEventAt: args.now,
      });
      expired += 1;
    });
    // Access is re-derived from the whole purchase set, so this is safe
    // to run even when the guard withheld the status write.
    await syncAccess(sibling.subscriberId);
  }

  if (expired > 0) {
    log.info("expired superseded Apple purchases", {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      expired,
    });
  }
  return { expired };
}
```

If `drizzle.purchaseRepo.updatePurchase`'s signature differs, read `packages/db/src/drizzle/repositories/purchases.ts` around line 178 and use the real one.

- [ ] **Step 5: Wire it into the upgrade handler**

In `apps/api/src/services/apple/apple-webhook.ts`'s `applyRenewalPrefChange`, immediately **before** `await grantAccess(...)`:

```ts
  // Retire the tier this upgrade replaced BEFORE granting the new one:
  // syncAccess recomputes the whole desired set inside one transaction
  // under the per-subscriber advisory lock, so ordering it this way
  // means no gap and no double-grant.
  await expireSupersededApplePurchases({
    projectId: ctx.projectId,
    originalTransactionId: ctx.transaction.originalTransactionId,
    currentStoreTransactionId: ctx.transaction.transactionId,
    now: appleNotificationEventTime(ctx),
    source: `apple:${ctx.notification.notificationType}`,
  });
```

- [ ] **Step 6: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/services/apple --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/apple packages/db/src/drizzle/repositories/purchases-ext.ts
git commit -m "fix(apple): retire the superseded purchase on an upgrade so the old tier stops granting"
```

---

### Task 8: Plan-change detection, pending change, and `product_changed`

**Files:**
- Create: `apps/api/src/services/subscription-plan-change.ts`
- Create: `apps/api/src/services/subscription-plan-change.test.ts`
- Create: `packages/db/drizzle/migrations/0116_purchase_pending_plan_change.sql` (+ journal + snapshot)
- Modify: `packages/db/src/drizzle/schema.ts` (purchases columns)
- Modify: `apps/api/src/services/apple/apple-webhook.ts`, `google/google-webhook.ts`, `stripe/stripe-webhook.ts`
- Modify: `packages/shared/src/store-event-normalization.ts` (update the Stripe exclusion comment)

**Interfaces:**
- Consumes: `GuardStatusWriteResult.previous` (Task 6).
- Produces: `type PlanChangeType = "UPGRADE" | "DOWNGRADE"`; `emitProductChanged(args: { db: Db; projectId: string; subscriberId: string; purchaseId: string; previousProductId: string; productId: string; changeType: PlanChangeType | null; now: Date }): Promise<void>`; purchase columns `pendingProductId: string | null`, `pendingChangeType: PlanChangeType | null`, `pendingChangeEffectiveAt: Date | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/subscription-plan-change.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { applePlanChangeType } from "./subscription-plan-change";

describe("applePlanChangeType", () => {
  it("reads the direction straight off Apple's subtype", () => {
    expect(applePlanChangeType("UPGRADE")).toBe("UPGRADE");
    expect(applePlanChangeType("DOWNGRADE")).toBe("DOWNGRADE");
  });

  it("returns null for a subtype that carries no direction", () => {
    expect(applePlanChangeType(undefined)).toBeNull();
    expect(applePlanChangeType("BILLING_RECOVERY")).toBeNull();
  });
});
```

Plus, in `apps/api/src/services/stripe/stripe-webhook.integration.test.ts` (or the nearest existing Stripe suite), a test that a plan change emits the outbox row:

```ts
it("emits subscription.product_changed when the price maps to a different product", async () => {
  const { subscriptionId, subscriberId } = await seedStripeSubscription({
    priceId: "price_basic",
  });
  await handleStripeEvent(
    subscriptionUpdatedEvent({ subscriptionId, priceId: "price_pro" }),
  );

  const events = await outboxEventsFor(subscriberId);
  const changed = events.find((e) => e.eventType === "subscription.product_changed");
  expect(changed).toBeTruthy();
  expect(changed!.payload.changeType).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-plan-change.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/subscription-plan-change.ts`:

```ts
import type { Db } from "@rovenue/db";
import { drizzle } from "@rovenue/db";
import { APPLE_NOTIFICATION_SUBTYPE, type AppleNotificationSubtype } from "./apple/apple-types";

export type PlanChangeType = "UPGRADE" | "DOWNGRADE";

/**
 * Apple is the only store that states the direction of a plan change.
 *
 * Deriving it elsewhere was considered and rejected: `purchases.priceAmount`
 * is the amount the store CHARGED, and a prorated upgrade charges less
 * than list price, so a price comparison labels upgrades as downgrades.
 * `products` carries neither price nor period, and calling the store
 * catalog from a webhook path is not acceptable. A null direction is
 * honest; a guessed one corrupts every cohort built on it.
 */
export function applePlanChangeType(
  subtype: AppleNotificationSubtype | undefined,
): PlanChangeType | null {
  if (subtype === APPLE_NOTIFICATION_SUBTYPE.UPGRADE) return "UPGRADE";
  if (subtype === APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE) return "DOWNGRADE";
  return null;
}

/**
 * Emit the public `subscription.product_changed` key. Called by all three
 * stores from the one place each has the before-image: the guard result.
 */
export async function emitProductChanged(args: {
  db: Db;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  previousProductId: string;
  productId: string;
  changeType: PlanChangeType | null;
  now: Date;
}): Promise<void> {
  if (args.previousProductId === args.productId) return;
  await drizzle.outboxRepo.insert(args.db, {
    aggregateType: "SUBSCRIPTION",
    aggregateId: args.subscriberId,
    eventType: "subscription.product_changed",
    payload: {
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      previousProductId: args.previousProductId,
      productId: args.productId,
      changeType: args.changeType,
      timestamp: args.now.toISOString(),
    },
  });
}
```

- [ ] **Step 4: Add the pending-change columns**

In `packages/db/src/drizzle/schema.ts`, inside `purchases` after `billingIssueDetectedAt`:

```ts
    // The product this subscription will renew into, when the store has
    // told us a change is scheduled but not yet effective (Apple
    // renewalInfo.autoRenewProductId, Google SUBSCRIPTION_DEFERRED,
    // Stripe's upcoming item). A pending downgrade NEVER revokes access
    // early — the old row is expired only when the store says it was
    // actually superseded.
    pendingProductId: text("pendingProductId").references(() => products.id),
    pendingChangeType: text("pendingChangeType"),
    pendingChangeEffectiveAt: timestamp("pendingChangeEffectiveAt", {
      withTimezone: true,
    }),
```

Generate the migration with `pnpm db:migrate:generate`, rename it to `0116_purchase_pending_plan_change.sql`, update the journal `tag` and the snapshot filename, and verify the emitted SQL is only `ALTER TABLE ... ADD COLUMN` statements plus the FK — delete any unrelated DDL drizzle-kit swept in.

- [ ] **Step 5: Wire the three stores**

In each of `apple-webhook.ts` (`upsertPurchase`), `google-webhook.ts` and `stripe-webhook.ts` (`upsertPurchaseFromSubscription`), after the guarded upsert commits and inside the same transaction:

```ts
      if (guard.previous && guard.previous.productId !== product.id) {
        await emitProductChanged({
          db: dbTx,
          projectId: ctx.projectId,
          subscriberId,
          purchaseId: persisted.id,
          previousProductId: guard.previous.productId,
          productId: product.id,
          // Apple: applePlanChangeType(ctx.notification.subtype)
          // Google/Stripe: null — neither states a direction.
          changeType: null,
          now: eventTime,
        });
      }
```

Apple passes `applePlanChangeType(ctx.notification.subtype)` instead of `null`.

Write the pending change where each store exposes it: Apple from `ctx.renewalInfo?.autoRenewProductId` when it maps to a different product; Google from the `SUBSCRIPTION_DEFERRED` handler; Stripe from the subscription's upcoming item. Clear all three columns (`null`) whenever the written `productId` equals `pendingProductId`.

- [ ] **Step 6: Update the normalization exclusion comment**

In `packages/shared/src/store-event-normalization.ts`, replace the "STILL DROPPED" paragraph about Stripe with a note that the before-image now reaches the bridge via `GuardStatusWriteResult.previous`, and that `subscription.product_changed` is emitted directly by `emitProductChanged` rather than through the flat table — the flat table stays event-type-keyed and cannot express "only when the product actually changed".

- [ ] **Step 7: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/services/subscription-plan-change src/services/stripe src/services/apple src/services/google --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 8: Pin the proration revenue invariant**

Spec §4.6 rules that no new `RevenueEventType` is added because each store already
reports proration correctly. That ruling is only safe if it is checked. Add to
`apps/api/src/services/subscription-plan-change.test.ts`:

```ts
import { RevenueEventType } from "@rovenue/db";

// Spec §4.6: an upgrade must NOT invent a proration revenue type. Apple
// sends the prorated refund as its own REFUND notification, Stripe puts
// proration lines on the invoice the existing path reads, and Google's
// replacement token carries the real priceAmountMicros — so net revenue
// is already correct and a new enum value would reach ClickHouse for
// nothing. This pins the decision: adding a member here is a deliberate
// act that fails this test first.
it("records no proration-specific revenue event type", () => {
  expect(Object.keys(RevenueEventType).sort()).toEqual([
    "CANCELLATION",
    "CREDIT_PURCHASE",
    "INITIAL",
    "REACTIVATION",
    "REFUND",
    "RENEWAL",
    "TRIAL_CONVERSION",
  ]);
});
```

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-plan-change.test.ts --maxWorkers=2`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/shared/src/store-event-normalization.ts
git commit -m "feat(store): emit subscription.product_changed for all three stores and record pending plan changes"
```

---

### Task 9: Suppress family-shared revenue in the repository

**Files:**
- Modify: `packages/db/src/drizzle/repositories/revenue-events.ts:154-205`
- Test: `packages/db/src/drizzle/repositories/revenue-events.family-shared.integration.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createRevenueEvent` now returns `Promise<RevenueEvent | null>` — `null` means the event was suppressed because the linked purchase is family-shared.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/revenue-events.family-shared.integration.test.ts`:

```ts
// A family member's Apple transaction carries inAppOwnershipType
// FAMILY_SHARED. They genuinely have entitlement — the purchaser paid —
// so recording a second full-price revenue event double-counts MRR and
// LTV. Suppression lives HERE rather than at the 13 call sites, so a
// future Apple code path cannot forget it.
it("writes no revenue row and no outbox row for a family-shared purchase", async () => {
  const { projectId, subscriberId, purchaseId, productId } =
    await seedPurchase({ ownershipType: "FAMILY_SHARED" });

  const result = await createRevenueEvent(db, {
    projectId,
    subscriberId,
    purchaseId,
    productId,
    type: "RENEWAL",
    amount: "9.99",
    currency: "USD",
    amountUsd: "9.99",
    store: "APP_STORE",
    eventDate: new Date(),
  });

  expect(result).toBeNull();
  await expect(countRevenueEvents(purchaseId)).resolves.toBe(0);
  await expect(countOutboxRows(purchaseId)).resolves.toBe(0);
});

it("still writes for a purchased (non-shared) purchase", async () => {
  const seeded = await seedPurchase({ ownershipType: "PURCHASED" });
  const result = await createRevenueEvent(db, { /* same shape */ });
  expect(result).not.toBeNull();
});

it("still writes when ownershipType is null (non-Apple stores)", async () => {
  const seeded = await seedPurchase({ ownershipType: null });
  const result = await createRevenueEvent(db, { /* same shape, store: "STRIPE" */ });
  expect(result).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/revenue-events.family-shared.integration.test.ts --maxWorkers=2`
Expected: FAIL — a row is written and the return is non-null.

- [ ] **Step 3: Implement the suppression**

In `packages/db/src/drizzle/repositories/revenue-events.ts`:

```ts
import { APPLE_FAMILY_SHARED_OWNERSHIP_TYPE } from "@rovenue/shared/subscription-status";

/**
 * Apple's `inAppOwnershipType` value for a subscription a family
 * organiser shared. Spelled once, here and in the Apple types, because
 * the whole revenue suppression turns on this exact string.
 */
export async function createRevenueEvent(
  db: DbOrTx,
  input: CreateRevenueEventInput,
): Promise<RevenueEvent | null> {
  // Family Sharing: the organiser already paid for this subscription.
  // The member is entitled (access-engine grants normally) but must not
  // produce a second economic event — that double-counts MRR and LTV.
  // Checked here rather than at the 13 call sites so no future Apple
  // path can skip it, and so no downstream aggregate needs a filter:
  // the row simply never exists.
  const [linked] = await db
    .select({ ownershipType: purchases.ownershipType })
    .from(purchases)
    .where(eq(purchases.id, input.purchaseId))
    .limit(1);
  if (linked?.ownershipType === APPLE_FAMILY_SHARED_OWNERSHIP_TYPE) {
    return null;
  }

  return db.transaction(async (tx) => {
    // ... existing body unchanged
  });
}
```

Add the constant to `packages/shared/src/subscription-status.ts`:

```ts
/**
 * Apple `inAppOwnershipType` for a family-shared subscription. Lives in
 * shared because both the API (which writes it) and the db repository
 * (which suppresses revenue on it) must agree on the exact string.
 */
export const APPLE_FAMILY_SHARED_OWNERSHIP_TYPE = "FAMILY_SHARED";
```

and make `apps/api/src/services/apple/apple-types.ts`'s `APPLE_OWNERSHIP_TYPE.FAMILY_SHARED` reference it so the two cannot diverge.

- [ ] **Step 4: Fix the fallout from the nullable return**

Run: `cd packages/db && npx tsc --noEmit && cd ../../apps/api && npx tsc --noEmit`

Every consumer that used the return value now fails to compile. There are no such production call sites today (verified), so expect failures only in tests — update each to handle `null` rather than casting it away.

- [ ] **Step 5: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd packages/db && nice -n 19 npx vitest run src/drizzle/repositories/revenue-events --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/revenue-events.ts packages/db/src/drizzle/repositories/revenue-events.family-shared.integration.test.ts packages/shared/src/subscription-status.ts apps/api/src/services/apple/apple-types.ts
git commit -m "fix(revenue): never record a revenue event for a family-shared purchase"
```

---

### Task 10: Handle `OFFER_REDEEMED` (win-back, promo, offer codes)

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (dispatch + handler + offer columns)
- Create: `packages/db/drizzle/migrations/0117_purchase_offer_metadata.sql` (+ journal + snapshot)
- Modify: `packages/db/src/drizzle/schema.ts`
- Modify: `packages/shared/src/integrations.ts`
- Modify: the provider mappers under `apps/api/src/services/integrations/`
- Test: `apps/api/src/services/apple/apple-offer-redeemed.integration.test.ts` (create), `packages/shared/src/integrations.test.ts`

**Interfaces:**
- Consumes: `expireSupersededApplePurchases` (Task 7), `applePlanChangeType` (Task 8).
- Produces: purchase columns `offerType: number | null`, `offerIdentifier: string | null`; event key `"subscription.offer_redeemed"`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/apple/apple-offer-redeemed.integration.test.ts`:

```ts
// OFFER_REDEEMED was absent from the dispatch switch entirely, so a
// win-back redemption produced no state change, no revenue event and no
// lifecycle key — the subscriber came back and Rovenue never noticed.
it("reactivates an expired subscription on a win-back redemption", async () => {
  const { projectId, subscriberId, purchaseId } = await seedApplePurchase({
    status: "EXPIRED",
    storeTransactionId: "tx_old",
  });

  await handleAppleNotification(
    offerRedeemedNotification({
      originalTransactionId: "1000000000000003",
      transactionId: "tx_winback",
      offerType: 4,
      offerIdentifier: "winback_20pct",
    }),
  );

  const purchase = await findByStoreTransaction("tx_winback");
  expect(purchase.status).toBe("ACTIVE");
  expect(purchase.offerType).toBe(4);
  expect(purchase.offerIdentifier).toBe("winback_20pct");

  const revenue = await revenueEventsFor(purchase.id);
  expect(revenue.map((r) => r.type)).toContain("REACTIVATION");

  const events = await outboxEventsFor(subscriberId);
  expect(events.map((e) => e.eventType)).toContain("subscription.offer_redeemed");
});

it("records INITIAL, not REACTIVATION, when the chain was not expired", async () => {
  await seedApplePurchase({ status: "ACTIVE", storeTransactionId: "tx_live" });
  await handleAppleNotification(
    offerRedeemedNotification({
      originalTransactionId: "1000000000000004",
      transactionId: "tx_promo",
      offerType: 2,
      offerIdentifier: "promo_x",
    }),
  );
  const revenue = await revenueEventsFor(
    (await findByStoreTransaction("tx_promo")).id,
  );
  expect(revenue.map((r) => r.type)).toContain("INITIAL");
});
```

Add to `packages/shared/src/integrations.test.ts`:

```ts
it("every subscription bridge key is resolvable by every provider mapper", () => {
  for (const provider of REGISTERED_PROVIDERS) {
    for (const key of SUBSCRIPTION_BRIDGE_EVENT_KEYS) {
      expect(
        provider.mapEventKey(key),
        `${provider.id} has no mapping for ${key}`,
      ).toBeDefined();
    }
  }
});
```

Read `apps/api/src/services/integrations/types.ts` for the real registry and mapper names before writing this — the point is that a `Partial<Record>` gap becomes a test failure, not that the names above are right.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/apple/apple-offer-redeemed.integration.test.ts --maxWorkers=2`
Expected: FAIL — nothing handles the notification.

- [ ] **Step 3: Add the offer columns**

In `packages/db/src/drizzle/schema.ts`, inside `purchases`:

```ts
    // Apple offerType (1 introductory, 2 promotional, 3 offer code,
    // 4 win-back) and the offer's identifier. `isIntroOffer` stays for
    // compatibility and is derived from offerType at the write; these
    // two are what makes a win-back cohort queryable at all.
    offerType: integer("offerType"),
    offerIdentifier: text("offerIdentifier"),
```

Generate, rename to `0117_purchase_offer_metadata.sql`, fix the journal tag and snapshot name, and confirm the SQL is two `ADD COLUMN` statements.

- [ ] **Step 4: Add the event key**

In `packages/shared/src/integrations.ts`, add `"subscription.offer_redeemed"` to `ROVENUE_EVENT_KEYS` (after `subscription.revoked`) and to `SUBSCRIPTION_BRIDGE_EVENT_KEYS`, with a comment:

```ts
  // 2026-09-03: Apple OFFER_REDEEMED had no key because it had no
  // handler. A win-back redemption is not `uncancelled` (the
  // subscription had fully lapsed) and not `product_changed` (the
  // product may be identical) — it is its own meaning, and the one a
  // win-back campaign needs to stop targeting the subscriber.
  "subscription.offer_redeemed",
```

Then run `npx tsc --noEmit` in `apps/api` and fix every provider mapper the compiler flags. Where a mapper's map is a `Partial<Record>`, add the entry; the new test from Step 1 is what keeps the next one honest.

- [ ] **Step 5: Add the dispatch entry and handler**

In `apps/api/src/services/apple/apple-webhook.ts`'s `dispatch`:

```ts
    case APPLE_NOTIFICATION_TYPE.OFFER_REDEEMED:
      return applyOfferRedeemed(ctx);
```

and the handler:

```ts
/**
 * OFFER_REDEEMED: the subscriber redeemed a promotional offer, an offer
 * code, or a win-back offer. Until now this fell through `dispatch`'s
 * default branch, so a subscriber could return from a fully lapsed
 * subscription and produce no state change, no revenue and no event.
 *
 * The revenue type turns on where the chain was: a redemption against an
 * EXPIRED chain is a genuine resurrection (REACTIVATION); one against a
 * live chain is a new paid term (INITIAL).
 */
async function applyOfferRedeemed(ctx: DispatchContext): Promise<void> {
  const subscriber = await resolveSubscriber(ctx);
  const { product, purchase, statusApplied, guard } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: isTrial(ctx.transaction)
      ? PurchaseStatus.TRIAL
      : PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
  if (!statusApplied) return;

  if (ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.UPGRADE) {
    await expireSupersededApplePurchases({
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
      currentStoreTransactionId: ctx.transaction.transactionId,
      now: appleNotificationEventTime(ctx),
      source: `apple:${ctx.notification.notificationType}`,
    });
  }

  await grantAccess({ subscriber, purchase, product, ctx });
  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
    type:
      guard.previous?.status === PurchaseStatus.EXPIRED
        ? RevenueEventType.REACTIVATION
        : RevenueEventType.INITIAL,
  });
}
```

Return `guard` from `upsertPurchase` alongside `statusApplied` so the handler can read the before-image.

Persist the offer fields in `upsertPurchase`'s `create` and `update` payloads:

```ts
          offerType: tx.offerType ?? null,
          offerIdentifier: tx.offerIdentifier ?? null,
```

Add `offerIdentifier?: string` to `AppleJwsTransactionPayload` in `apple-types.ts` if it is not already declared.

- [ ] **Step 6: Bridge the public key**

In `packages/shared/src/store-event-normalization.ts`, add to `STORE_EVENT_TO_PUBLIC_KEY`:

```ts
  OFFER_REDEEMED: "subscription.offer_redeemed",
```

- [ ] **Step 7: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/services/apple src/services/integrations --maxWorkers=2
cd ../../packages/shared && nice -n 19 npx vitest run --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services packages/shared/src packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations
git commit -m "feat(apple): handle OFFER_REDEEMED and record win-back offer metadata"
```

---

### Task 11: Extract `computeDesiredAccess`

**Files:**
- Modify: `apps/api/src/services/access-engine.ts`
- Create: `apps/api/src/services/access-engine.compute.test.ts`

**Interfaces:**
- Consumes: Task 2's `ACCESS_GRANTING` set.
- Produces: `computeDesiredAccess(purchases: PurchaseWithAccessIds[], now: Date): Map<string, DesiredAccess>` where `DesiredAccess = { purchaseId: string; expiresDate: Date | null; store: Store }`. Exported so the reconciler (Task 12) uses the exact function the writer uses.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/access-engine.compute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDesiredAccess } from "./access-engine";

const now = new Date("2026-09-03T00:00:00Z");
const future = new Date("2026-10-01T00:00:00Z");
const past = new Date("2026-08-01T00:00:00Z");

describe("computeDesiredAccess", () => {
  it("grants nothing for a non-granting status", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "BILLING_ISSUE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("ignores a granting purchase whose period has ended", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "ACTIVE", expiresDate: past, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("keeps the latest expiry when two purchases grant the same access", () => {
    const desired = computeDesiredAccess(
      [
        { id: "p1", status: "ACTIVE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: new Date("2026-09-15T00:00:00Z"), store: "STRIPE", accessIds: ["pro"] },
      ],
      now,
    );
    expect(desired.get("pro")).toEqual({
      purchaseId: "p1",
      expiresDate: future,
      store: "APP_STORE",
    });
  });

  it("treats a null expiry as the longest-lived grant", () => {
    const desired = computeDesiredAccess(
      [
        { id: "p1", status: "ACTIVE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: null, store: "APP_STORE", accessIds: ["pro"] },
      ],
      now,
    );
    expect(desired.get("pro")?.purchaseId).toBe("p2");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/access-engine.compute.test.ts --maxWorkers=2`
Expected: FAIL — `computeDesiredAccess` is not exported.

- [ ] **Step 3: Extract the function**

In `apps/api/src/services/access-engine.ts`, lift the body of `syncAccess`'s desired-map loop out verbatim:

```ts
export interface DesiredAccess {
  purchaseId: string;
  expiresDate: Date | null;
  store: Store;
}

/**
 * The authoritative answer to "what access should this subscriber have
 * right now", derived purely from their purchases. Pure and exported so
 * the drift reconciler (workers/access-reconciliation.ts) checks against
 * the EXACT function syncAccess writes from — a second implementation of
 * this rule would rot against the first, which is the failure this
 * codebase has already paid for in analytics.
 */
export function computeDesiredAccess(
  purchases: PurchaseWithAccessIds[],
  now: Date,
): Map<string, DesiredAccess> {
  const desired = new Map<string, DesiredAccess>();
  for (const purchase of purchases) {
    if (!ACCESS_GRANTING.has(purchase.status as PurchaseStatus)) continue;
    if (purchase.expiresDate && purchase.expiresDate < now) continue;
    for (const accessId of purchase.accessIds) {
      const existing = desired.get(accessId);
      if (!existing || isLaterExpiry(purchase.expiresDate, existing.expiresDate)) {
        desired.set(accessId, {
          purchaseId: purchase.id,
          expiresDate: purchase.expiresDate,
          store: purchase.store,
        });
      }
    }
  }
  return desired;
}
```

and have `syncAccess` call it:

```ts
    const desired = computeDesiredAccess(purchases, new Date());
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/access-engine --maxWorkers=2`
Expected: PASS, including the existing `syncAccess` suites — behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/access-engine.ts apps/api/src/services/access-engine.compute.test.ts
git commit -m "refactor(api): extract computeDesiredAccess so the writer and the checker share one rule"
```

---

### Task 12: The `subscriber_access` drift reconciler

**Files:**
- Create: `apps/api/src/workers/access-reconciliation.ts`
- Create: `apps/api/src/workers/access-reconciliation.integration.test.ts`
- Create: `packages/db/drizzle/migrations/0118_subscriber_access_reconciliation.sql` (+ journal + snapshot)
- Modify: `packages/db/src/drizzle/schema.ts` (`subscribers.lastAccessReconciledAt` + index)
- Modify: `packages/db/src/drizzle/repositories/access.ts` (candidate query)
- Modify: `apps/api/src/index.ts:100-125`

**Interfaces:**
- Consumes: `computeDesiredAccess` (Task 11), `syncAccess`, `audit`.
- Produces: `runAccessReconciliationSweep(now?: Date, opts?: { dryRun?: boolean; backfill?: boolean }): Promise<AccessReconciliationResult>`, `MAX_DRIFT_HEAL_RATIO`, `ACCESS_RECONCILE_STALE_AFTER_MS`, `MAX_SUBSCRIBERS_PER_SWEEP`, `createAccessReconciliationWorker()`, `scheduleAccessReconciliation()`.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/src/workers/access-reconciliation.integration.test.ts`:

```ts
// Drift is injected with direct SQL — never by calling the code under
// test — so a passing run means the reconciler found real corruption.
//
// Each case must start from a clean subscriber set: the sweep selects
// candidates GLOBALLY (drift is not project-scoped), so subscribers left
// behind by an earlier case join later batches and move the circuit
// breaker's ratio. Truncate subscribers/purchases/subscriber_access in a
// beforeEach rather than relying on distinct project ids.
//
// The breaker only applies at or above MIN_BATCH_FOR_CIRCUIT_BREAKER
// candidates, which is why the single-subscriber cases below can assert
// a heal at all.
it("classifies and heals a missing grant", async () => {
  const { subscriberId, accessId } = await seedActiveSubscriberWithAccess();
  await rawSql`DELETE FROM subscriber_access WHERE "subscriberId" = ${subscriberId}`;

  const result = await runAccessReconciliationSweep(new Date());

  expect(result.drift.missing_grant).toBe(1);
  expect(result.healed).toBe(1);
  await expect(activeAccessIds(subscriberId)).resolves.toEqual([accessId]);
});

it("classifies and heals a stale grant", async () => {
  const { subscriberId, purchaseId } = await seedActiveSubscriberWithAccess();
  await rawSql`UPDATE purchases SET status = 'EXPIRED' WHERE id = ${purchaseId}`;

  const result = await runAccessReconciliationSweep(new Date());

  expect(result.drift.stale_grant).toBe(1);
  await expect(activeAccessIds(subscriberId)).resolves.toEqual([]);
});

it("classifies a wrong expiry", async () => {
  const { subscriberId } = await seedActiveSubscriberWithAccess();
  await rawSql`UPDATE subscriber_access SET "expiresDate" = '2030-01-01' WHERE "subscriberId" = ${subscriberId}`;

  const result = await runAccessReconciliationSweep(new Date());
  expect(result.drift.wrong_expiry).toBe(1);
});

it("writes an audit row for every heal", async () => {
  const { subscriberId, projectId } = await seedActiveSubscriberWithAccess();
  await rawSql`DELETE FROM subscriber_access WHERE "subscriberId" = ${subscriberId}`;

  await runAccessReconciliationSweep(new Date());

  const rows = await auditRowsFor(projectId, "access.drift_repaired");
  expect(rows).toHaveLength(1);
  expect(rows[0].resourceId).toBe(subscriberId);
});

it("dryRun reports drift and writes nothing", async () => {
  const { subscriberId } = await seedActiveSubscriberWithAccess();
  await rawSql`DELETE FROM subscriber_access WHERE "subscriberId" = ${subscriberId}`;

  const result = await runAccessReconciliationSweep(new Date(), { dryRun: true });

  expect(result.drift.missing_grant).toBe(1);
  expect(result.healed).toBe(0);
  await expect(activeAccessIds(subscriberId)).resolves.toEqual([]);
});

// The circuit breaker is the whole safety story for auto-heal: if
// computeDesiredAccess were ever wrong, this is what stops the worker
// from faithfully revoking everyone's entitlements.
it("refuses to heal when drift exceeds MAX_DRIFT_HEAL_RATIO", async () => {
  const seeded = await Promise.all(
    Array.from({ length: MIN_BATCH_FOR_CIRCUIT_BREAKER }, () =>
      seedActiveSubscriberWithAccess(),
    ),
  );
  await rawSql`DELETE FROM subscriber_access`;

  const result = await runAccessReconciliationSweep(new Date());

  expect(result.circuitBroken).toBe(true);
  expect(result.healed).toBe(0);
  for (const s of seeded) {
    await expect(activeAccessIds(s.subscriberId)).resolves.toEqual([]);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/workers/access-reconciliation.integration.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the column and the candidate query**

In `packages/db/src/drizzle/schema.ts`, inside `subscribers`:

```ts
    // Last time the entitlement drift reconciler checked this
    // subscriber, independent of whether it found drift. NULL means
    // "never checked" and must sort FIRST — a subscriber created before
    // this worker existed has no evidence their access is correct.
    lastAccessReconciledAt: timestamp("lastAccessReconciledAt", {
      withTimezone: true,
    }),
```

and an index `subscribers_access_reconciliation_idx` on `(lastAccessReconciledAt)`.

Generate the migration, rename to `0118_subscriber_access_reconciliation.sql`, fix the journal tag and snapshot, and confirm the SQL is one `ADD COLUMN` plus one `CREATE INDEX`.

In `packages/db/src/drizzle/repositories/access.ts`:

```ts
/**
 * Subscribers due an entitlement drift check: never checked (NULL sorts
 * first), or not checked within `staleBefore`. Bounded by `limit` — the
 * caller's named per-sweep constant.
 */
export async function selectAccessReconciliationCandidates(
  db: Db,
  args: { staleBefore: Date; limit: number },
): Promise<Array<{ id: string; projectId: string }>> {
  const rows = await db
    .select({ id: subscribers.id, projectId: subscribers.projectId })
    .from(subscribers)
    .where(
      or(
        isNull(subscribers.lastAccessReconciledAt),
        lt(subscribers.lastAccessReconciledAt, args.staleBefore),
      ),
    )
    .orderBy(sql`"subscribers"."lastAccessReconciledAt" ASC NULLS FIRST`)
    .limit(args.limit);
  return rows;
}

export async function stampAccessReconciled(
  db: DbOrTx,
  subscriberId: string,
  at: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ lastAccessReconciledAt: at })
    .where(eq(subscribers.id, subscriberId));
}
```

- [ ] **Step 4: Write the worker**

Create `apps/api/src/workers/access-reconciliation.ts`:

```ts
import { Queue, Worker, type Job } from "bullmq";
import { drizzle } from "@rovenue/db";
import { createBullConnection } from "../lib/redis";
import { audit, type AuditTx } from "../lib/audit";
import { logger } from "../lib/logger";
import { computeDesiredAccess, syncAccess } from "../services/access-engine";

const log = logger.child("access-reconciliation");

export const ACCESS_RECONCILIATION_QUEUE_NAME = "rovenue-access-reconciliation";

// Per-run cap. Each candidate costs two small indexed reads; 200 keeps a
// run well inside the 30-minute interval even on a large install, and
// stamped rows drop out of the candidate set so successive runs drain
// rather than re-scan.
export const MAX_SUBSCRIBERS_PER_SWEEP = 200;

// Every subscriber is re-checked at least this often. 7 days keeps a
// full pass cheap while bounding how long silent drift can persist.
export const ACCESS_RECONCILE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Auto-heal's real risk is not a missed drift, it is a mass revoke: if
// computeDesiredAccess were wrong, this worker would faithfully apply it
// to everyone. Above this share of a batch, stop and escalate — a real
// 5% entitlement drift is an incident to look at, not a batch to
// silently rewrite.
export const MAX_DRIFT_HEAL_RATIO = 0.05;

// The ratio above is only meaningful once a batch is big enough for a
// ratio to mean anything: one drifted subscriber in a batch of one is
// 100% drift and would trip the breaker every time, so small sweeps
// could never heal at all. Below this many candidates the breaker does
// not apply — mass corruption, the thing it exists to catch, cannot
// hide in a batch this small, and every heal still writes an audit row.
export const MIN_BATCH_FOR_CIRCUIT_BREAKER = 20;

const REPEAT_EVERY_MS = 30 * 60 * 1000;
const REPEATABLE_JOB_NAME = "access-reconciliation:sweep";
const REPEATABLE_JOB_ID = "access-reconciliation-repeatable";
const SWEEP_SOURCE = "access:reconciliation-sweep";

export type DriftClass =
  | "missing_grant"
  | "stale_grant"
  | "wrong_expiry"
  | "orphan_row";

export interface AccessReconciliationResult {
  candidates: number;
  drifted: number;
  healed: number;
  circuitBroken: boolean;
  drift: Record<DriftClass, number>;
  errors: number;
}

interface SubscriberDrift {
  subscriberId: string;
  projectId: string;
  classes: DriftClass[];
}

export async function runAccessReconciliationSweep(
  now: Date = new Date(),
  opts?: { dryRun?: boolean; backfill?: boolean },
): Promise<AccessReconciliationResult> {
  const dryRun = opts?.dryRun ?? false;
  const backfill = opts?.backfill ?? false;
  const staleBefore = new Date(now.getTime() - ACCESS_RECONCILE_STALE_AFTER_MS);

  const candidates =
    await drizzle.accessRepo.selectAccessReconciliationCandidates(drizzle.db, {
      staleBefore,
      limit: MAX_SUBSCRIBERS_PER_SWEEP,
    });

  const drift: Record<DriftClass, number> = {
    missing_grant: 0,
    stale_grant: 0,
    wrong_expiry: 0,
    orphan_row: 0,
  };
  const drifted: SubscriberDrift[] = [];
  let errors = 0;

  // Pass 1 — detect only. The whole batch is measured before anything is
  // written, because the circuit breaker needs the ratio first.
  for (const candidate of candidates) {
    try {
      const classes = await detectDrift(candidate.id, now);
      if (classes.length === 0) continue;
      for (const c of classes) drift[c] += 1;
      drifted.push({
        subscriberId: candidate.id,
        projectId: candidate.projectId,
        classes,
      });
    } catch (err) {
      errors += 1;
      log.warn("drift detection failed", {
        subscriberId: candidate.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ratio =
    candidates.length === 0 ? 0 : drifted.length / candidates.length;
  const circuitBroken =
    candidates.length >= MIN_BATCH_FOR_CIRCUIT_BREAKER &&
    ratio > MAX_DRIFT_HEAL_RATIO;

  if (circuitBroken) {
    log.error("drift ratio above threshold — refusing to heal", {
      candidates: candidates.length,
      drifted: drifted.length,
      ratio,
      threshold: MAX_DRIFT_HEAL_RATIO,
      drift,
    });
  }

  let healed = 0;
  if (!circuitBroken && !dryRun) {
    for (const entry of drifted) {
      try {
        const before = await drizzle.accessRepo.findAllAccessBySubscriber(
          drizzle.db,
          entry.subscriberId,
        );
        await syncAccess(entry.subscriberId);
        const after = await drizzle.accessRepo.findAllAccessBySubscriber(
          drizzle.db,
          entry.subscriberId,
        );
        healed += 1;

        await audit(
          {
            projectId: entry.projectId,
            userId: "system",
            action: "access.drift_repaired",
            resource: "subscriber",
            resourceId: entry.subscriberId,
            before: { access: summarize(before) },
            after: {
              access: summarize(after),
              classes: entry.classes,
              source: SWEEP_SOURCE,
              backfill,
            },
            ipAddress: null,
            userAgent: null,
          },
          drizzle.db as unknown as AuditTx,
        );
      } catch (err) {
        errors += 1;
        log.warn("drift heal failed", {
          subscriberId: entry.subscriberId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!dryRun) {
    for (const candidate of candidates) {
      await drizzle.accessRepo.stampAccessReconciled(
        drizzle.db,
        candidate.id,
        now,
      );
    }
  }

  return {
    candidates: candidates.length,
    drifted: drifted.length,
    healed,
    circuitBroken,
    drift,
    errors,
  };
}

async function detectDrift(
  subscriberId: string,
  now: Date,
): Promise<DriftClass[]> {
  const purchases = await drizzle.accessRepo.findPurchasesWithAccessIds(
    drizzle.db,
    subscriberId,
  );
  const desired = computeDesiredAccess(purchases, now);
  const stored = await drizzle.accessRepo.findAllAccessBySubscriber(
    drizzle.db,
    subscriberId,
  );

  const classes = new Set<DriftClass>();
  const activeStored = stored.filter((r) => r.isActive);
  const purchaseIds = new Set(purchases.map((p) => p.id));

  for (const [accessId, target] of desired) {
    const match = activeStored.find(
      (r) => r.accessId === accessId && r.purchaseId === target.purchaseId,
    );
    if (!match) {
      classes.add("missing_grant");
      continue;
    }
    if (match.expiresDate?.getTime() !== target.expiresDate?.getTime()) {
      classes.add("wrong_expiry");
    }
  }

  for (const row of activeStored) {
    if (!purchaseIds.has(row.purchaseId)) {
      classes.add("orphan_row");
      continue;
    }
    const target = desired.get(row.accessId);
    if (!target || target.purchaseId !== row.purchaseId) {
      classes.add("stale_grant");
    }
  }

  return [...classes];
}

function summarize(
  rows: Array<{ accessId: string; purchaseId: string; isActive: boolean }>,
): Array<{ accessId: string; purchaseId: string; isActive: boolean }> {
  return rows.map((r) => ({
    accessId: r.accessId,
    purchaseId: r.purchaseId,
    isActive: r.isActive,
  }));
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getAccessReconciliationQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(ACCESS_RECONCILIATION_QUEUE_NAME, {
    connection: createBullConnection("access-reconciliation"),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleAccessReconciliation(): Promise<void> {
  const queue = getAccessReconciliationQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    { jobId: REPEATABLE_JOB_ID, repeat: { every: REPEAT_EVERY_MS } },
  );
  log.info("scheduled access reconciliation", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createAccessReconciliationWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker(
    ACCESS_RECONCILIATION_QUEUE_NAME,
    async (_job: Job) => runAccessReconciliationSweep(),
    {
      connection: createBullConnection("access-reconciliation"),
      concurrency: 1,
    },
  );
  cachedWorker.on("failed", (job, err) => {
    log.error("access reconciliation job failed", {
      jobId: job?.id,
      err: err.message,
    });
  });
  log.info("access reconciliation worker started", {
    queue: ACCESS_RECONCILIATION_QUEUE_NAME,
  });
  return cachedWorker;
}
```

- [ ] **Step 5: Boot the worker**

In `apps/api/src/index.ts`, after the Google reconciliation block:

```ts
// Entitlement drift reconciler — 30-minute repeatable BullMQ job that
// re-derives every subscriber's desired access with the same function
// syncAccess writes from, and heals drift behind a circuit breaker.
createAccessReconciliationWorker();
scheduleAccessReconciliation().catch((err: unknown) => {
  logger.error("failed to schedule access reconciliation", {
    err: err instanceof Error ? err.message : String(err),
  });
});
```

with the matching import at the top of the file.

- [ ] **Step 6: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/workers/access-reconciliation.integration.test.ts --maxWorkers=2
```
Expected: PASS, all six tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/workers/access-reconciliation.ts apps/api/src/workers/access-reconciliation.integration.test.ts apps/api/src/index.ts packages/db/src/drizzle/schema.ts packages/db/src/drizzle/repositories/access.ts packages/db/drizzle/migrations
git commit -m "feat(api): continuous subscriber_access drift reconciler with a heal circuit breaker"
```

---

### Task 13: `subscription.recovered` for Apple and Stripe

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts`, `apps/api/src/services/stripe/stripe-webhook.ts`
- Modify: `packages/shared/src/store-event-normalization.ts` (the exclusion comment)
- Test: `apps/api/src/services/subscription-recovered.integration.test.ts` (create)

**Interfaces:**
- Consumes: `GuardStatusWriteResult.previous` (Task 6), `PurchaseStatus.BILLING_ISSUE` (Task 3).
- Produces: nothing new — an existing key gains two producers.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/subscription-recovered.integration.test.ts`:

```ts
// store-event-normalization.ts records that Stripe gets no `recovered`
// row because inferring one from invoice.paid would fire on unrelated
// renewals. With BILLING_ISSUE plus the guard's before-image the
// inference is exact: BILLING_ISSUE -> ACTIVE IS a recovery.
it("emits subscription.recovered when Stripe leaves BILLING_ISSUE", async () => {
  const { subscriptionId, subscriberId } = await seedStripeSubscription({
    status: "BILLING_ISSUE",
  });
  await handleStripeEvent(
    subscriptionUpdatedEvent({ subscriptionId, status: "active" }),
  );
  const events = await outboxEventsFor(subscriberId);
  expect(events.map((e) => e.eventType)).toContain("subscription.recovered");
});

it("does not emit recovered on an ordinary renewal", async () => {
  const { subscriptionId, subscriberId } = await seedStripeSubscription({
    status: "ACTIVE",
  });
  await handleStripeEvent(
    subscriptionUpdatedEvent({ subscriptionId, status: "active" }),
  );
  const events = await outboxEventsFor(subscriberId);
  expect(events.map((e) => e.eventType)).not.toContain("subscription.recovered");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && nice -n 19 npx vitest run src/services/subscription-recovered.integration.test.ts --maxWorkers=2`
Expected: FAIL — no `subscription.recovered` row.

- [ ] **Step 3: Emit on the transition**

In each of `apple-webhook.ts` and `stripe-webhook.ts`, inside the guarded upsert transaction where `emitProductChanged` is already called (Task 8):

```ts
      // BILLING_ISSUE -> a granting status is a genuine recovery: the
      // store resolved the payment failure. Unlike inferring it from an
      // invoice, this cannot fire on an unrelated renewal, because the
      // before-image says where the row actually was.
      if (
        guard.apply &&
        guard.previous?.status === PurchaseStatus.BILLING_ISSUE &&
        SUBSCRIPTION_STATUS_SEMANTICS[status].grantsAccess
      ) {
        await drizzle.outboxRepo.insert(dbTx, {
          aggregateType: "SUBSCRIPTION",
          aggregateId: subscriberId,
          eventType: "subscription.recovered",
          payload: {
            projectId: ctx.projectId,
            subscriberId,
            purchaseId: persisted.id,
            previousStatus: guard.previous.status,
            status,
            timestamp: eventTime.toISOString(),
          },
        });
      }
```

- [ ] **Step 4: Update the exclusion comment**

In `packages/shared/src/store-event-normalization.ts`, replace the paragraph beginning "Stripe gets no `paused` row and no `recovered` row" with the current truth: `recovered` is now produced directly by the Apple and Stripe webhook handlers on the `BILLING_ISSUE → granting` transition rather than by this event-type table, because the table is keyed on event type and cannot express a state transition. The `paused` exclusion stands.

- [ ] **Step 5: Run the tests**

Run:
```bash
psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl' || true
cd apps/api && nice -n 19 npx vitest run src/services/subscription-recovered.integration.test.ts src/services/stripe src/services/apple --maxWorkers=2
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services packages/shared/src/store-event-normalization.ts
git commit -m "feat(store): emit subscription.recovered for Apple and Stripe billing recoveries"
```

---

### Task 14: Pre-deploy blast-radius report

**Files:**
- Create: `apps/api/scripts/billing-issue-blast-radius.ts`
- Test: none (read-only operator script; correctness is the SQL, verified by running it)

**Interfaces:**
- Consumes: nothing.
- Produces: a CLI that prints how many live rows the Task 4 mapping change will move out of an access-granting status.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/billing-issue-blast-radius.ts`:

```ts
/**
 * Read-only pre-deploy report for the BILLING_ISSUE mapping change.
 *
 * Task 4 moves Apple billing-retry rows (no grace subtype) and Stripe
 * `unpaid`/`incomplete` rows out of GRACE_PERIOD, which GRANTS access,
 * into BILLING_ISSUE, which does not. No existing row is rewritten by
 * the migration — the change rolls in at the rate of store
 * notifications — but the operator should know the ceiling before
 * deploying. Run this, keep the number, compare after a week.
 *
 * Usage: pnpm --filter @rovenue/api exec tsx scripts/billing-issue-blast-radius.ts
 */
import { sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";

async function main(): Promise<void> {
  const result = await drizzle.db.execute(sql`
    SELECT p.store,
           count(*)                                   AS "rows",
           count(DISTINCT p."subscriberId")           AS "subscribers"
    FROM purchases p
    JOIN subscriber_access sa ON sa."purchaseId" = p.id AND sa."isActive"
    WHERE p.status = 'GRACE_PERIOD'
      AND p.store IN ('APP_STORE', 'STRIPE')
    GROUP BY p.store
    ORDER BY p.store
  `);
  const rows =
    (result as unknown as {
      rows: Array<{ store: string; rows: string; subscribers: string }>;
    }).rows ?? [];

  if (rows.length === 0) {
    console.log("No access-granting GRACE_PERIOD rows on Apple or Stripe.");
    return;
  }

  console.log("Ceiling for entitlement loss when BILLING_ISSUE ships:");
  for (const row of rows) {
    console.log(
      `  ${row.store}: ${row.rows} purchases across ${row.subscribers} subscribers`,
    );
  }
  console.log(
    "\nThis is a CEILING, not a prediction: only rows whose next store event\n" +
      "reports a non-grace billing failure actually move.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Run it against the local database**

Run: `cd apps/api && npx tsx scripts/billing-issue-blast-radius.ts`
Expected: it prints either the "no rows" line or a per-store breakdown, and exits 0.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/billing-issue-blast-radius.ts
git commit -m "chore(api): pre-deploy blast-radius report for the BILLING_ISSUE mapping change"
```

---

### Task 15: Full verification and ROADMAP update

**Files:**
- Modify: `ROADMAP.md:116-121`

- [ ] **Step 1: Run the full API suite**

Run: `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`
Expected: green except the six known isolation flakes in the three real-infra files that share a queue name and hardcoded DB/Redis. Confirm each failure is one of those before accepting it; a new failure is a regression to fix, not a flake.

- [ ] **Step 2: Run the db and shared suites**

Run: `cd packages/db && DATABASE_URL=postgres://localhost/ignored nice -n 19 npx vitest run --maxWorkers=2 && cd ../shared && nice -n 19 npx vitest run --maxWorkers=2`
Expected: green.

- [ ] **Step 3: Build**

Run: `pnpm build --concurrency=2`
Expected: green. A `node:crypto`-in-the-browser-bundle class of error only shows up here, never in vitest.

- [ ] **Step 4: Update the roadmap**

In `ROADMAP.md`, mark all four §2 items `[x]` with a one-line note each recording what was actually built and what was decided against — matching the style of §1's entries. Include: the OD-1 reversal, the recreate-enum reason, the narrow Apple supersede scope, and the null `changeType` ruling.

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: ROADMAP §2 closed -- state machine, plan change, family/win-back, drift reconciler"
```
