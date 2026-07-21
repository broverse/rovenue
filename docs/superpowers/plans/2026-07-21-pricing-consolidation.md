# Pricing Consolidation + Soft-Cap Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the public billing ladder to Free/Indie/Studio/Enterprise ($0 / $49 / $399 / custom), raise the free MTR threshold to $5K, and enforce hard caps Plausible-style (dashboard lock after two consecutive over-limit periods; SDK never blocked).

**Architecture:** Two migrations (DDL then DML — Postgres forbids using a new enum value in the transaction that adds it). A pure lock-rule function, a daily BullMQ sweeper that persists usage snapshots and flips `projects.usage_locked_at`, a Hono middleware guarding `/dashboard/projects/:projectId/*` (billing paths exempt), and copy updates in the dashboard. Purchase flow and `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` are untouched (Indie keeps its name).

**Tech Stack:** Drizzle migrations, BullMQ repeatable jobs, Hono middleware, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-pricing-consolidation-design.md`

## Global Constraints

- Stay on the current branch (`main`); conventional commits per task.
- Test runner: `pnpm --filter @rovenue/api exec vitest run <path>` (skip `*.integration.test.ts` unless the docker dev stack is up).
- Typecheck gates: `pnpm --filter @rovenue/api typecheck` and `pnpm --filter @rovenue/db build` and `pnpm --filter @rovenue/shared build`.
- New ladder values (exact): free $0/0 mtr 0–5000; indie 4900/49000 mtr 5000–50000, events 50,000,000, sql 2500, retention 180, audit 90; studio 39900/399000 mtr 50000–250000, events 250,000,000, sql NULL, retention 365, audit 365; enterprise 0/0 mtr 250000–NULL, events NULL, sql NULL, retention 1825, audit 1825.
- Hard-cap meters: `events`, `sql_queries` only. MTR never locks.

---

### Task 1: Enums, schema, migrations 0084+0085, seed, shared type

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts` (both `billingTierEnum` pgEnum and `billingTier` const)
- Modify: `packages/db/src/drizzle/schema.ts` (projects table)
- Modify: `packages/shared/src/billing.ts` (`BillingTier`)
- Modify: `packages/db/seed.ts` (`TIER_LIMITS`)
- Create: `packages/db/drizzle/migrations/0084_*.sql` (generated DDL) and `packages/db/drizzle/migrations/0085_pricing_consolidation.sql` (hand-written DML)

**Interfaces:**
- Produces: `"studio"` as a valid `BillingTier`; `projects.usageLockedAt: Date | null` on the Drizzle projects model (Tasks 3–4 consume).

- [ ] **Step 1: TS enum + schema edits**

In `packages/db/src/drizzle/enums.ts`, add `"studio"` after `"scale"` in BOTH the `billingTierEnum` pgEnum array and the `billingTier` const array, and add this comment above each:

```ts
// Public ladder is free/indie/studio/enterprise; pro/scale/growth are
// legacy values kept because Postgres enum removal is unsafe.
```

In `packages/db/src/drizzle/schema.ts`, inside the `projects` pgTable column list (next to the other timestamps), add:

```ts
    // Set by the usage-cap sweeper when hard caps are exceeded two
    // consecutive billing periods; dashboard guard reads it. Null = unlocked.
    usageLockedAt: timestamp("usage_locked_at", { withTimezone: true }),
```

In `packages/shared/src/billing.ts`, extend `BillingTier` with `| "studio"` (after `"scale"`) and add the same public-ladder comment.

- [ ] **Step 2: Generate the DDL migration**

Run: `pnpm db:migrate:generate`
Inspect the new `packages/db/drizzle/migrations/0084_*.sql`: it must contain ONLY `ALTER TYPE "billing_tier" ADD VALUE 'studio' …` and `ALTER TABLE "projects" ADD COLUMN "usage_locked_at" timestamp with time zone;`. Known gotcha: drizzle-kit sometimes re-emits hand-written DDL from earlier migrations — delete anything else it generated and fix the meta snapshot only if drizzle complains on apply.

- [ ] **Step 3: Hand-write the DML migration**

Create `packages/db/drizzle/migrations/0085_pricing_consolidation.sql` (separate file because Postgres cannot use a new enum value in the same transaction that added it):

```sql
-- Pricing consolidation (2026-07-21 spec): 6-tier ladder -> 4
-- (free / indie / studio / enterprise), free threshold $5K,
-- indie repriced to $49 with the merged pro band.

-- 1. Retune surviving tiers.
UPDATE "billing_tier_limits" SET "mtr_max" = 5000 WHERE "tier" = 'free';
UPDATE "billing_tier_limits" SET
  "price_usd_cents" = CASE "cycle" WHEN 'monthly' THEN 4900 ELSE 49000 END,
  "mtr_min" = 5000,
  "mtr_max" = 50000,
  "events_limit" = 50000000,
  "sql_limit" = 2500,
  "retention_days" = 180,
  "audit_log_days" = 90
WHERE "tier" = 'indie';
UPDATE "billing_tier_limits" SET "mtr_min" = 250000 WHERE "tier" = 'enterprise';

-- 2. Studio inherits scale's bracket.
INSERT INTO "billing_tier_limits"
  ("tier", "cycle", "price_usd_cents", "stripe_price_id", "mtr_min", "mtr_max",
   "events_limit", "sql_limit", "retention_days", "audit_log_days")
VALUES
  ('studio', 'monthly', 39900, NULL, 50000, 250000, 250000000, NULL, 365, 365),
  ('studio', 'annual', 399000, NULL, 50000, 250000, 250000000, NULL, 365, 365)
ON CONFLICT ("tier", "cycle") DO NOTHING;

-- 3. Migrate any legacy subscriptions before deleting their limit rows
--    (pre-launch: expected 0 rows; UPDATEs are safety).
UPDATE "billing_subscriptions" SET "tier" = 'indie' WHERE "tier" = 'pro';
UPDATE "billing_subscriptions" SET "tier" = 'studio' WHERE "tier" = 'scale';
UPDATE "billing_subscriptions" SET "tier" = 'enterprise' WHERE "tier" = 'growth';

-- 4. Retire legacy reference rows.
DELETE FROM "billing_tier_limits" WHERE "tier" IN ('pro', 'scale', 'growth');
```

Register 0085 in `packages/db/drizzle/migrations/meta/_journal.json` the same way neighbouring hand-written migrations (e.g. 0081/0082) are registered — copy the previous entry's shape, bump `idx` and `tag`.

- [ ] **Step 4: Update the seed**

Replace `TIER_LIMITS` in `packages/db/seed.ts` with:

```ts
  const TIER_LIMITS = [
    // Free
    { tier: "free",       cycle: "monthly", priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7 },
    { tier: "free",       cycle: "annual",  priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7 },
    // Indie (merged former indie+pro band)
    { tier: "indie",      cycle: "monthly", priceCents:   4900, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90 },
    { tier: "indie",      cycle: "annual",  priceCents:  49000, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90 },
    // Studio (former scale bracket)
    { tier: "studio",     cycle: "monthly", priceCents:  39900, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365 },
    { tier: "studio",     cycle: "annual",  priceCents: 399000, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365 },
    // Enterprise
    { tier: "enterprise", cycle: "monthly", priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825 },
    { tier: "enterprise", cycle: "annual",  priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825 },
  ] as const;
```

The `indieMonthlyPriceId` wiring below it stays untouched.

- [ ] **Step 5: Build + typecheck + commit**

Run: `pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/db build && pnpm --filter @rovenue/api typecheck`
Expected: clean.
If the docker dev stack is running, also: `pnpm db:migrate` → applies 0084+0085 without error.

```bash
git add packages/db packages/shared
git commit -m "feat(db): consolidate billing ladder to free/indie/studio/enterprise"
```

---

### Task 2: Pure usage-lock rule

**Files:**
- Create: `apps/api/src/services/billing/usage-lock-rule.ts`
- Test: `apps/api/src/services/billing/usage-lock-rule.test.ts`

**Interfaces:**
- Produces: `shouldLockUsage(rows: SnapshotLike[], periods: [Date, Date]): boolean` and `completedPeriodStarts(now: Date): [Date, Date]` (Task 3 consumes). `SnapshotLike = { meterKey: string; periodStart: Date; currentValue: string; limitValue: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { completedPeriodStarts, shouldLockUsage } from "./usage-lock-rule";

const P1 = new Date(Date.UTC(2026, 4, 1)); // May 2026
const P2 = new Date(Date.UTC(2026, 5, 1)); // Jun 2026

function row(meterKey: string, periodStart: Date, current: number, limit: number | null) {
  return {
    meterKey,
    periodStart,
    currentValue: String(current),
    limitValue: limit === null ? null : String(limit),
  };
}

describe("shouldLockUsage", () => {
  it("locks when a hard meter is at/over limit in both periods", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, 5_000_000), row("events", P2, 5_000_000, 5_000_000)],
        [P1, P2],
      ),
    ).toBe(true);
  });

  it("locks when different hard meters are over in each period", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, 5_000_000), row("sql_queries", P2, 101, 100)],
        [P1, P2],
      ),
    ).toBe(true);
  });

  it("does not lock on a single over-limit period", () => {
    expect(
      shouldLockUsage([row("events", P2, 6_000_000, 5_000_000)], [P1, P2]),
    ).toBe(false);
  });

  it("never locks on MTR (soft cap), even over in both periods", () => {
    expect(
      shouldLockUsage(
        [row("mtr", P1, 9000, 5000), row("mtr", P2, 9000, 5000)],
        [P1, P2],
      ),
    ).toBe(false);
  });

  it("does not lock when the limit is null (unlimited tier)", () => {
    expect(
      shouldLockUsage(
        [row("events", P1, 6_000_000, null), row("events", P2, 6_000_000, null)],
        [P1, P2],
      ),
    ).toBe(false);
  });

  it("does not lock with no history", () => {
    expect(shouldLockUsage([], [P1, P2])).toBe(false);
  });
});

describe("completedPeriodStarts", () => {
  it("returns the two most recent completed calendar months", () => {
    const [a, b] = completedPeriodStarts(new Date(Date.UTC(2026, 6, 21))); // Jul 21
    expect(a.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(b.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("handles january rollover", () => {
    const [a, b] = completedPeriodStarts(new Date(Date.UTC(2026, 0, 5)));
    expect(a.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(b.toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/billing/usage-lock-rule.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// =============================================================
// Usage-lock rule (Plausible model)
// =============================================================
// A project is locked when at least one HARD-cap meter (events,
// sql_queries) closed AT/over its limit in BOTH of the two most
// recent completed calendar billing periods. MTR is a soft cap and
// never locks. One over-limit period only warns — the rule embeds
// >=1 month of implicit grace.

const HARD_METERS = new Set(["events", "sql_queries"]);

export interface SnapshotLike {
  meterKey: string;
  periodStart: Date;
  currentValue: string;
  limitValue: string | null;
}

export function completedPeriodStarts(now: Date): [Date, Date] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return [before, prev];
}

function periodOverLimit(rows: SnapshotLike[], period: Date): boolean {
  return rows.some((r) => {
    if (!HARD_METERS.has(r.meterKey)) return false;
    if (r.periodStart.getTime() !== period.getTime()) return false;
    if (r.limitValue === null) return false;
    const current = Number(r.currentValue);
    const limit = Number(r.limitValue);
    return Number.isFinite(current) && Number.isFinite(limit) && current >= limit;
  });
}

export function shouldLockUsage(rows: SnapshotLike[], periods: [Date, Date]): boolean {
  return periodOverLimit(rows, periods[0]) && periodOverLimit(rows, periods[1]);
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/billing/usage-lock-rule.test.ts` → PASS (8 tests).

```bash
git add apps/api/src/services/billing/usage-lock-rule.ts apps/api/src/services/billing/usage-lock-rule.test.ts
git commit -m "feat(api): pure two-consecutive-periods usage-lock rule"
```

---

### Task 3: Repo additions + usage-cap sweeper worker + bootstrap

**Files:**
- Modify: `packages/db/src/drizzle/repositories/usage-snapshots.ts` (add `findSnapshotsForPeriodStarts`)
- Modify: `packages/db/src/drizzle/repositories/billing-subscriptions.ts` (add `listProjectIdsWithBillingSubscription`)
- Modify: `packages/db/src/drizzle/repositories/projects.ts` (add `setUsageLockedAt`)
- Create: `apps/api/src/workers/usage-cap-sweeper.ts`
- Modify: `apps/api/src/index.ts` (bootstrap, next to the scheduled-actions block)
- Test: `apps/api/src/workers/usage-cap-sweeper.test.ts`

**Interfaces:**
- Consumes: `shouldLockUsage` / `completedPeriodStarts` (Task 2), `buildUsageReport` (existing), `projects.usageLockedAt` (Task 1).
- Produces: `applyUsageLockState(db, projectId, now): Promise<"locked" | "unlocked" | "unchanged">` (exported for tests and reused by nothing else), `createUsageCapSweeperWorker()`, `scheduleUsageCapSweep()`.

- [ ] **Step 1: Repo additions**

`usage-snapshots.ts` (uses the existing `inArray` import pattern):

```ts
export async function findSnapshotsForPeriodStarts(
  db: Db,
  projectId: string,
  periodStarts: Date[],
): Promise<UsageSnapshot[]> {
  return db
    .select()
    .from(usageSnapshots)
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        inArray(usageSnapshots.periodStart, periodStarts),
      ),
    );
}
```

`billing-subscriptions.ts`:

```ts
export async function listProjectIdsWithBillingSubscription(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ projectId: billingSubscriptions.projectId })
    .from(billingSubscriptions);
  return rows.map((r) => r.projectId);
}
```

`projects.ts`:

```ts
export async function setUsageLockedAt(
  db: Db,
  projectId: string,
  at: Date | null,
): Promise<void> {
  await db
    .update(projects)
    .set({ usageLockedAt: at, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}
```

(Adjust `updatedAt` handling to match how `updateProject` in the same file does it; drop the `updatedAt` set entirely if the sibling doesn't touch it.)
Ensure the three functions are exported through the repositories barrel the same way their siblings are.

- [ ] **Step 2: Write the failing worker test**

`apps/api/src/workers/usage-cap-sweeper.test.ts` — mock `@rovenue/db` (hoisted factory, same pattern as `routes/webhooks/resend-events.test.ts`) and `../services/billing/usage` (stub `buildUsageReport` to resolve) and `../lib/audit` (stub `audit`). Test `applyUsageLockState` transitions:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/billing/usage", () => ({
  buildUsageReport: vi.fn().mockResolvedValue({ meters: [] }),
}));
vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: (fn: (tx: unknown) => Promise<void>) => fn({}) },
      projectRepo: {
        findProjectById: vi.fn(),
        setUsageLockedAt: vi.fn().mockResolvedValue(undefined),
      },
      usageSnapshotRepo: {
        findSnapshotsForPeriodStarts: vi.fn().mockResolvedValue([]),
      },
      outboxRepo: { insert: vi.fn().mockResolvedValue(undefined) },
    },
  };
});

import { drizzle } from "@rovenue/db";
import { applyUsageLockState } from "./usage-cap-sweeper";

const d = drizzle as unknown as {
  projectRepo: {
    findProjectById: ReturnType<typeof vi.fn>;
    setUsageLockedAt: ReturnType<typeof vi.fn>;
  };
  usageSnapshotRepo: { findSnapshotsForPeriodStarts: ReturnType<typeof vi.fn> };
  outboxRepo: { insert: ReturnType<typeof vi.fn> };
};

const NOW = new Date(Date.UTC(2026, 6, 21));
const MAY = new Date(Date.UTC(2026, 4, 1));
const JUN = new Date(Date.UTC(2026, 5, 1));

function overRow(periodStart: Date) {
  return { meterKey: "events", periodStart, currentValue: "6000000", limitValue: "5000000" };
}

beforeEach(() => vi.clearAllMocks());

describe("applyUsageLockState", () => {
  it("locks an unlocked project when both completed periods are over", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(MAY), overRow(JUN)]);
    const out = await applyUsageLockState({} as never, "p1", NOW);
    expect(out).toBe("locked");
    expect(d.projectRepo.setUsageLockedAt).toHaveBeenCalledWith(expect.anything(), "p1", expect.any(Date));
    expect(d.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "billing.usage_lock.applied" }),
    );
  });

  it("unlocks a locked project once usage recovers", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(JUN)]);
    const out = await applyUsageLockState({} as never, "p1", NOW);
    expect(out).toBe("unlocked");
    expect(d.projectRepo.setUsageLockedAt).toHaveBeenCalledWith(expect.anything(), "p1", null);
    expect(d.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "billing.usage_lock.cleared" }),
    );
  });

  it("is a no-op when state already matches", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    d.usageSnapshotRepo.findSnapshotsForPeriodStarts.mockResolvedValue([overRow(JUN)]);
    const out = await applyUsageLockState({} as never, "p1", NOW);
    expect(out).toBe("unchanged");
    expect(d.projectRepo.setUsageLockedAt).not.toHaveBeenCalled();
    expect(d.outboxRepo.insert).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/usage-cap-sweeper.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the worker**

`apps/api/src/workers/usage-cap-sweeper.ts` — mirror the repeatable-job scaffolding of `scheduled-actions.ts` (Queue + Worker + `ensure…Repeatable()` with `REPEAT_EVERY_MS`), with:

```ts
import { Queue, Worker } from "bullmq";
import { drizzle, type Db } from "@rovenue/db";
import { env } from "../lib/env";
import { isBillingEnabled } from "../lib/host-mode";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
// Redis/Bull connection: use exactly the same connection helper and
// Queue/Worker construction that scheduled-actions.ts uses (open that
// file and copy its imports verbatim — it may construct `new Redis(...)`
// directly instead of a shared helper).
import { buildUsageReport } from "../services/billing/usage";
import {
  completedPeriodStarts,
  shouldLockUsage,
} from "../services/billing/usage-lock-rule";

const log = logger.child("usage-cap-sweeper");
export const USAGE_CAP_SWEEP_QUEUE_NAME = "rovenue-usage-cap-sweep";
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000;

/** Evaluate + apply the lock state for one project. Exported for tests. */
export async function applyUsageLockState(
  db: Db,
  projectId: string,
  now: Date,
): Promise<"locked" | "unlocked" | "unchanged"> {
  const project = await drizzle.projectRepo.findProjectById(db, projectId);
  if (!project) return "unchanged";
  const periods = completedPeriodStarts(now);
  const rows = await drizzle.usageSnapshotRepo.findSnapshotsForPeriodStarts(
    db,
    projectId,
    [...periods],
  );
  const wantLock = shouldLockUsage(rows, periods);
  const isLocked = project.usageLockedAt != null;
  if (wantLock === isLocked) return "unchanged";

  const lockedAt = wantLock ? now : null;
  await drizzle.db.transaction(async (tx) => {
    await drizzle.projectRepo.setUsageLockedAt(tx, projectId, lockedAt);
    await drizzle.outboxRepo.insert(tx, {
      aggregateType: "BILLING",
      aggregateId: projectId,
      eventType: wantLock
        ? "billing.usage_lock.applied"
        : "billing.usage_lock.cleared",
      payload: { projectId, lockedAt: lockedAt?.toISOString() ?? null },
    });
    await audit(
      {
        projectId,
        userId: "system",
        action: "update",
        resource: "project",
        resourceId: projectId,
        before: { usageLockedAt: project.usageLockedAt ?? null },
        after: { usageLockedAt: lockedAt },
      },
      tx,
    );
  });
  log.info(wantLock ? "usage lock applied" : "usage lock cleared", { projectId });
  return wantLock ? "locked" : "unlocked";
}

export async function sweepUsageCaps(db: Db, now = new Date()): Promise<void> {
  if (!isBillingEnabled()) return;
  const projectIds =
    await drizzle.billingSubscriptionRepo.listProjectIdsWithBillingSubscription(db);
  for (const projectId of projectIds) {
    try {
      // Persists current-period snapshots + warn flags (existing behavior),
      // now guaranteed at least daily instead of only on usage-page views.
      await buildUsageReport(db, projectId);
      await applyUsageLockState(db, projectId, now);
    } catch (err) {
      log.warn("sweep failed for project", {
        projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

plus `createUsageCapSweeperWorker()` / `scheduleUsageCapSweep()` copied structurally from `scheduled-actions.ts` (repeatable job calling `sweepUsageCaps(drizzle.db)`). Match `drizzle.db.transaction` usage to how other services open transactions (copy an existing `db.transaction` call site); adapt the outbox `payload` typing to `NewOutboxEvent` (stringify if the column expects text — copy `event-bus.ts`).

- [ ] **Step 4: Bootstrap in `apps/api/src/index.ts`**

Next to the scheduled-actions block:

```ts
// Usage-cap sweep — daily; flips projects.usage_locked_at per the
// two-consecutive-periods rule (cloud mode only; no-op when self-hosted).
createUsageCapSweeperWorker();
scheduleUsageCapSweep().catch((err: unknown) => {
  logger.error("failed to schedule usage-cap sweep", {
    err: err instanceof Error ? err.message : String(err),
  });
});
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `pnpm --filter @rovenue/api exec vitest run src/workers/usage-cap-sweeper.test.ts src/services/billing/usage-lock-rule.test.ts` → PASS.
Run: `pnpm --filter @rovenue/db build && pnpm --filter @rovenue/api typecheck` → clean.

```bash
git add packages/db/src apps/api/src
git commit -m "feat(api): daily usage-cap sweeper locks projects after two over-limit periods"
```

---

### Task 4: Dashboard guard middleware + billing summary field + webhook unlock

**Files:**
- Create: `apps/api/src/middleware/usage-lock.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts` (mount)
- Modify: `apps/api/src/services/billing/billing-summary.ts` + `packages/shared/src/billing.ts` (`BillingSummary.usageLockedAt`)
- Modify: `apps/api/src/services/billing/webhook-handlers/handle-subscription-updated.ts` (clear lock on tier change)
- Test: `apps/api/src/middleware/usage-lock.test.ts`; extend the existing handle-subscription-updated test file if one exists (check `apps/api/src/services/billing/webhook-handlers/`)

**Interfaces:**
- Consumes: `projects.usageLockedAt` (Task 1), `projectRepo.setUsageLockedAt` (Task 3).
- Produces: `usageLockGuard: MiddlewareHandler`; `BillingSummary.usageLockedAt: string | null` (Task 5 consumes in the dashboard).

- [ ] **Step 1: Write the failing middleware test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { findProjectById: vi.fn() },
    },
  };
});

import { drizzle } from "@rovenue/db";
import { usageLockGuard } from "./usage-lock";

const d = drizzle as unknown as {
  projectRepo: { findProjectById: ReturnType<typeof vi.fn> };
};

function app() {
  return new Hono()
    .use("/projects/:projectId/*", usageLockGuard)
    .get("/projects/:projectId/charts", (c) => c.json({ ok: true }))
    .get("/projects/:projectId/billing/summary", (c) => c.json({ ok: true }));
}

beforeEach(() => vi.clearAllMocks());

describe("usageLockGuard", () => {
  it("passes through when the project is unlocked", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    const res = await app().request("/projects/p1/charts");
    expect(res.status).toBe(200);
  });

  it("returns 403 usage_limit_exceeded when locked", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    const res = await app().request("/projects/p1/charts");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("usage_limit_exceeded");
  });

  it("exempts billing paths so the upgrade flow stays reachable", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    const res = await app().request("/projects/p1/billing/summary");
    expect(res.status).toBe(200);
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement the middleware**

```ts
import type { MiddlewareHandler } from "hono";
import { drizzle } from "@rovenue/db";

// =============================================================
// Usage-lock guard (Plausible model)
// =============================================================
// Blocks dashboard feature routes for projects whose hard caps were
// exceeded two consecutive billing periods (projects.usage_locked_at
// set by the usage-cap sweeper). Billing routes stay reachable so the
// customer can upgrade; SDK /v1 and webhooks are untouched by design
// (data collection never stops).

export const usageLockGuard: MiddlewareHandler = async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) return next();
  if (c.req.path.includes(`/projects/${projectId}/billing`)) return next();

  const project = await drizzle.projectRepo.findProjectById(drizzle.db, projectId);
  if (project?.usageLockedAt) {
    return c.json(
      {
        error: {
          code: "usage_limit_exceeded",
          message:
            "Usage limits were exceeded for two consecutive billing periods. Upgrade your plan to restore dashboard access.",
        },
      },
      403,
    );
  }
  return next();
};
```

Mount in `apps/api/src/routes/dashboard/index.ts` after the two existing `.use("*", …)` lines:

```ts
  .use("/projects/:projectId/*", usageLockGuard)
```

(plus the import). The bare `/projects/:projectId` detail route is not matched by the wildcard, so the project shell keeps rendering.

- [ ] **Step 3: Billing summary field**

In `packages/shared/src/billing.ts` add to `BillingSummary`:

```ts
  /** Set when the usage-cap sweeper locked the dashboard (Plausible model). */
  usageLockedAt: string | null;
```

In `apps/api/src/services/billing/billing-summary.ts`, load the project row (`drizzle.projectRepo.findProjectById`) and add `usageLockedAt: project?.usageLockedAt?.toISOString() ?? null` to the returned object. Fix any summary tests that assert the full object shape.

- [ ] **Step 4: Clear the lock on subscription tier change**

In `handle-subscription-updated.ts`, after `updateAfterStripeUpdated(…)`:

```ts
  // Upgrading raises limits — release any usage lock immediately rather
  // than waiting for the next daily sweep.
  await drizzle.projectRepo.setUsageLockedAt(ctx.tx, ctx.projectId, null);
```

Extend the handler's existing test (if present in `webhook-handlers/`) to assert `setUsageLockedAt` was called with `null`; if no test file exists, add the assertion to whichever billing webhook test covers `subscription.updated`.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `pnpm --filter @rovenue/api exec vitest run src/middleware/usage-lock.test.ts` plus the touched billing test files → PASS.
Run: `pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/api typecheck` → clean.

```bash
git add apps/api/src packages/shared/src
git commit -m "feat(api): usage-lock dashboard guard + summary field + unlock on upgrade"
```

---

### Task 5: Dashboard copy + lock banner

**Files:**
- Modify: `apps/dashboard/src/components/billing/upgrade-modal.tsx` ("$29 / month" → "$49 / month")
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/billing.tsx` ("Upgrade to Indie ($29 / mo)" → "($49 / mo)"; lock banner)

- [ ] **Step 1: Copy updates**

In `upgrade-modal.tsx`: `$29 / month. Cancellable any time.` → `$49 / month. Cancellable any time.`
In `billing.tsx`: `Upgrade to Indie ($29 / mo)` → `Upgrade to Indie ($49 / mo)`.

- [ ] **Step 2: Lock banner**

In `billing.tsx`, where the summary (`s`) renders, add above the plan card:

```tsx
{s.usageLockedAt && (
  <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
    Dashboard access is limited: usage exceeded your plan&apos;s limits for
    two consecutive billing periods. Upgrade to restore full access —
    data collection and your SDK are unaffected.
  </div>
)}
```

Match the file's existing styling idiom (if it uses design tokens like `text-rv-mute-500`, reuse the closest alert/banner pattern found in the dashboard instead of raw amber classes).

- [ ] **Step 3: Build, commit**

Run: `pnpm --filter @rovenue/dashboard build` (or the repo's dashboard typecheck script) → clean.

```bash
git add apps/dashboard/src
git commit -m "feat(dashboard): $49 Indie copy + usage-lock banner"
```

---

## Deploy checklist (ops, not code)

1. Create the new $49/month Stripe price; set `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` to it (do not reuse the $29 price object).
2. `pnpm db:migrate` (0084 + 0085) before rolling the new API.
3. Update the marketing/docs pricing page to the 4-tier ladder.
