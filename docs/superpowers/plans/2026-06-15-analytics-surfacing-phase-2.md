# Analytics Surfacing — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add ARPU, windowed churn rate, trial→paid conversion rate, and an LTV distribution histogram to the surfaced analytics — building on Phase 1's `/metrics/summary` + revenue KPIs card.

**Architecture:** Extend the existing `/metrics/summary` service (`summary.ts`) to fan out into Postgres (`purchases`) reads alongside its ClickHouse reads — mirroring `overview.ts`, which already mixes CH + PG. Add a new `/metrics/ltv` endpoint for the histogram. Dashboard gets new KPI tiles + an LTV distribution card.

**Tech Stack:** Hono + Zod (API), Drizzle (`drizzle.db.select().from(drizzle.schema.purchases)`), ClickHouse via `queryAnalytics<T>`, `{ data: T }` via `ok()`, React + react-query, Vitest.

**Design decisions (locked, post-investigation):**
- **Churn source = Postgres `purchases`, NOT `subscriber_access`.** `subscriber_access` is current-state-only (no transition history, no `projectId` column). `purchases` has `projectId`, terminal `status` (`EXPIRED`/`REFUNDED`/`REVOKED`), `cancellationDate`, `expiresDate` — so windowed churn is derivable and authoritative. This overrides the spec §6 OQ#1 recommendation, which assumed transition history that does not exist.
- **Churn + ARPU live in `/metrics/summary` (windowed), not `/subscriptions/kpis`** (which is all-time and window-less — extending it would break its contract).
- **Active base (ARPU denominator) = distinct subscribers with an `ACTIVE` purchase, point-in-time `now`.** Documented as approximate (no historical snapshot).
- **Churn rate = `churnedInWindow / (activeBase + churnedInWindow)`** — approximate; there is no point-in-time active-at-period-start snapshot.
- **Trial starts** from Postgres `purchases.isTrial = true` in window; **trial conversions** from CH `TRIAL_CONVERSION` events in window (added to the existing summary CH query). Period ratio, not cohort-accurate (matches the existing funnel semantics).
- **Deferred to Phase 3:** per-bucket conversion *trend* chart, MRR movement stacked-bar (both need PG+CH bucket-merge).

---

## File Structure

**Backend (`apps/api`)**
- Modify `src/services/metrics/summary.ts` — add 3 Postgres reads + 1 CH column; extend `RevenueSummary`.
- Create `src/services/metrics/ltv.ts` — `getLtvDistribution(projectId)`.
- Modify `src/routes/dashboard/metrics.ts` — add `.get("/ltv", …)`.
- Modify `apps/api/tests/dashboard-metrics-summary.test.ts` — extend mock + assertions.
- Create `apps/api/tests/dashboard-metrics-ltv.test.ts` — `/ltv` route tests.

**Shared (`packages/shared`)**
- Modify `src/dashboard.ts` — extend `RevenueSummaryResponse`; add `LtvDistributionResponse`.

**Frontend (`apps/dashboard`)**
- Create `src/lib/hooks/useProjectLtv.ts`.
- Modify `src/components/charts/revenue-kpis-card.tsx` — add ARPU, Churn rate, Trial→paid tiles.
- Create `src/components/charts/ltv-distribution-card.tsx`.
- Modify `src/components/charts/index.ts` + the project page to render the LTV card.

---

## Task 1: Extend `RevenueSummaryResponse` (shared)

**Files:** Modify `packages/shared/src/dashboard.ts` (the `RevenueSummaryResponse` interface from Phase 1)

- [ ] **Step 1: Add the new fields**

Append these fields inside `RevenueSummaryResponse` (after `ltvSubscribers`):

```ts
  /** Distinct subscribers with an ACTIVE purchase right now (ARPU denominator). */
  activeSubscriberBase: number;
  /** netUsd / activeSubscriberBase; null when base is 0. */
  arpu: string | null;
  /** Distinct subscribers whose subscription went terminal within the window. */
  churnedInWindow: number;
  /** churnedInWindow / (activeSubscriberBase + churnedInWindow); null when both 0. */
  churnRate: number | null;
  /** Distinct subscribers who started a trial within the window. */
  trialStarts: number;
  /** Distinct subscribers who converted a trial to paid within the window. */
  trialConversions: number;
  /** trialConversions / trialStarts; null when trialStarts is 0. */
  trialConversionRate: number | null;
```

- [ ] **Step 2: Build** — Run: `pnpm --filter @rovenue/shared build` → PASS
- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add ARPU/churn/trial fields to RevenueSummaryResponse"
```

---

## Task 2: Add Postgres + trial-conversion reads to `summary.ts`

**Files:** Modify `apps/api/src/services/metrics/summary.ts`

- [ ] **Step 1: Add imports**

At the top, add:

```ts
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, countDistinct } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
```

- [ ] **Step 2: Extend the `RevenueSummary` interface**

Add the same seven fields as Task 1 (matching names/types: `activeSubscriberBase: number; arpu: string | null; churnedInWindow: number; churnRate: number | null; trialStarts: number; trialConversions: number; trialConversionRate: number | null;`) after `ltvSubscribers`.

- [ ] **Step 3: Add `trial_conversions` to the CH window query**

In the `ChWindowRow` interface add `trial_conversions: string;`. In the first `queryAnalytics` SQL (the `raw_revenue_events` window aggregate), add this line to the SELECT (after `paying_subs`):

```sql
          toString(uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION'))           AS trial_conversions
```

(Insert a comma after the `paying_subs` line.) Update the `w` fallback object to include `trial_conversions: "0"`.

- [ ] **Step 4: Add three Postgres reads inside `getRevenueSummary`**

After the existing `const [windowRows, ltvRows] = await Promise.all([...])` block, add a parallel Postgres fan-out:

```ts
  const p = drizzle.schema.purchases;
  const [activeRow, churnedRow, trialStartRow] = await Promise.all([
    // Active base: distinct subscribers with a currently-ACTIVE purchase.
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(and(eq(p.projectId, input.projectId), eq(p.status, "ACTIVE"))),
    // Churned in window: terminal status, dated by cancellation (or expiry
    // when no explicit cancellation date) falling inside [from, to].
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(
        and(
          eq(p.projectId, input.projectId),
          inArray(p.status, ["EXPIRED", "REFUNDED", "REVOKED"]),
          or(
            and(
              isNotNull(p.cancellationDate),
              gte(p.cancellationDate, input.from),
              lte(p.cancellationDate, input.to),
            ),
            and(
              isNull(p.cancellationDate),
              isNotNull(p.expiresDate),
              gte(p.expiresDate, input.from),
              lte(p.expiresDate, input.to),
            ),
          ),
        ),
      ),
    // Trial starts: distinct subscribers who began a trial in the window.
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(
        and(
          eq(p.projectId, input.projectId),
          eq(p.isTrial, true),
          gte(p.purchaseDate, input.from),
          lte(p.purchaseDate, input.to),
        ),
      ),
  ]);
```

- [ ] **Step 5: Compute and return the new fields**

In the existing computation block, add after `const arppu = ...`:

```ts
  const trialConversions = Number(w.trial_conversions);
  const activeSubscriberBase = Number(activeRow[0]?.c ?? 0);
  const churnedInWindow = Number(churnedRow[0]?.c ?? 0);
  const trialStarts = Number(trialStartRow[0]?.c ?? 0);

  const arpu =
    activeSubscriberBase > 0 ? (net / activeSubscriberBase).toFixed(4) : null;
  const churnDenom = activeSubscriberBase + churnedInWindow;
  const churnRate = churnDenom > 0 ? churnedInWindow / churnDenom : null;
  const trialConversionRate =
    trialStarts > 0 ? trialConversions / trialStarts : null;
```

Then add to the returned object (after `ltvSubscribers: Number(l.subscribers),`):

```ts
    activeSubscriberBase,
    arpu,
    churnedInWindow,
    churnRate,
    trialStarts,
    trialConversions,
    trialConversionRate,
```

- [ ] **Step 6: Typecheck** — Run: `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/metrics/summary.ts
git commit -m "feat(api): add ARPU/churn/trial conversion to getRevenueSummary"
```

---

## Task 3: Update the `/metrics/summary` route test

**Files:** Modify `apps/api/tests/dashboard-metrics-summary.test.ts`

- [ ] **Step 1: Extend the service mock**

In the `summaryMock.getRevenueSummary` resolved object, add the new fields:

```ts
    activeSubscriberBase: 120,
    arpu: "7.5000",
    churnedInWindow: 8,
    churnRate: 0.0625,
    trialStarts: 40,
    trialConversions: 26,
    trialConversionRate: 0.65,
```

- [ ] **Step 2: Strengthen the payload assertion**

In the `returns the summary payload for the default window` test, extend `toMatchObject` to include:

```ts
      arpu: "7.5000",
      churnRate: 0.0625,
      trialConversionRate: 0.65,
      activeSubscriberBase: 120,
```

- [ ] **Step 3: Run** — Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-summary.test.ts` → PASS (4 tests)
- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/dashboard-metrics-summary.test.ts
git commit -m "test(api): cover ARPU/churn/trial fields in /metrics/summary"
```

---

## Task 4: LTV distribution shared type

**Files:** Modify `packages/shared/src/dashboard.ts` (after `RevenueSummaryResponse`)

- [ ] **Step 1: Add the type**

```ts
// =============================================================
// LTV distribution — lifetime-value histogram (Phase 2)
// =============================================================

export interface LtvHistogramBucket {
  /** Inclusive lower bound in USD. */
  lowerUsd: number;
  /** Exclusive upper bound in USD; null for the open-ended top bucket. */
  upperUsd: number | null;
  count: number;
}

export interface LtvDistributionResponse {
  avgUsd: string;
  medianUsd: string;
  p90Usd: string;
  totalSubscribers: number;
  histogram: LtvHistogramBucket[];
}
```

- [ ] **Step 2: Build** — Run: `pnpm --filter @rovenue/shared build` → PASS
- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add LtvDistributionResponse type"
```

---

## Task 5: LTV distribution service

**Files:** Create `apps/api/src/services/metrics/ltv.ts`

- [ ] **Step 1: Write the service**

```ts
import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// LTV distribution read service — ClickHouse exclusive
// =============================================================
//
// One CH read over v_revenue_lifetime_subscriber. Net lifetime
// per subscriber = purchased - refunded (both UInt64 cents, cast
// to Int64 so refund-heavy subscribers can go negative). Bucketed
// into fixed USD bands via countIf; avg/median/p90 alongside.

export interface LtvBucket {
  lowerUsd: number;
  upperUsd: number | null;
  count: number;
}

export interface LtvDistribution {
  avgUsd: string;
  medianUsd: string;
  p90Usd: string;
  totalSubscribers: number;
  histogram: LtvBucket[];
}

// Band upper bounds in USD; the final band is open-ended.
const BANDS: ReadonlyArray<{ lowerUsd: number; upperUsd: number | null }> = [
  { lowerUsd: 0, upperUsd: 5 },
  { lowerUsd: 5, upperUsd: 10 },
  { lowerUsd: 10, upperUsd: 25 },
  { lowerUsd: 25, upperUsd: 50 },
  { lowerUsd: 50, upperUsd: 100 },
  { lowerUsd: 100, upperUsd: 250 },
  { lowerUsd: 250, upperUsd: 500 },
  { lowerUsd: 500, upperUsd: 1000 },
  { lowerUsd: 1000, upperUsd: null },
];

interface ChLtvDistRow {
  b0: string;
  b1: string;
  b2: string;
  b3: string;
  b4: string;
  b5: string;
  b6: string;
  b7: string;
  b8: string;
  avg_usd: string;
  median_usd: string;
  p90_usd: string;
  subscribers: string;
}

export async function getLtvDistribution(
  projectId: string,
): Promise<LtvDistribution> {
  const rows = await queryAnalytics<ChLtvDistRow>(
    projectId,
    `
      SELECT
        toString(countIf(net_cents < 500))                         AS b0,
        toString(countIf(net_cents >= 500 AND net_cents < 1000))   AS b1,
        toString(countIf(net_cents >= 1000 AND net_cents < 2500))  AS b2,
        toString(countIf(net_cents >= 2500 AND net_cents < 5000))  AS b3,
        toString(countIf(net_cents >= 5000 AND net_cents < 10000)) AS b4,
        toString(countIf(net_cents >= 10000 AND net_cents < 25000))AS b5,
        toString(countIf(net_cents >= 25000 AND net_cents < 50000))AS b6,
        toString(countIf(net_cents >= 50000 AND net_cents < 100000))AS b7,
        toString(countIf(net_cents >= 100000))                     AS b8,
        toString(round(avg(net_cents) / 100, 4))                   AS avg_usd,
        toString(round(quantileExact(0.5)(net_cents) / 100, 4))    AS median_usd,
        toString(round(quantileExact(0.9)(net_cents) / 100, 4))    AS p90_usd,
        toString(count())                                          AS subscribers
      FROM (
        SELECT
          toInt64(lifetime_dollars_purchased_cents)
            - toInt64(lifetime_dollars_refunded_cents)             AS net_cents
        FROM rovenue.v_revenue_lifetime_subscriber
        WHERE projectId = {projectId:String}
      )
    `,
  );

  const r = rows[0] ?? {
    b0: "0", b1: "0", b2: "0", b3: "0", b4: "0",
    b5: "0", b6: "0", b7: "0", b8: "0",
    avg_usd: "0", median_usd: "0", p90_usd: "0", subscribers: "0",
  };

  const counts = [r.b0, r.b1, r.b2, r.b3, r.b4, r.b5, r.b6, r.b7, r.b8];

  return {
    avgUsd: r.avg_usd,
    medianUsd: r.median_usd,
    p90Usd: r.p90_usd,
    totalSubscribers: Number(r.subscribers),
    histogram: BANDS.map((band, i) => ({
      lowerUsd: band.lowerUsd,
      upperUsd: band.upperUsd,
      count: Number(counts[i]),
    })),
  };
}
```

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/metrics/ltv.ts
git commit -m "feat(api): add getLtvDistribution service"
```

---

## Task 6: `/metrics/ltv` route

**Files:** Modify `apps/api/src/routes/dashboard/metrics.ts`

- [ ] **Step 1: Import** — add `import { getLtvDistribution } from "../../services/metrics/ltv";`

- [ ] **Step 2: Add the route** (chain after `/summary`, before the final `;`). No query params — lifetime is cumulative:

```ts
  // =============================================================
  // GET /dashboard/projects/:projectId/metrics/ltv
  // =============================================================
  //
  // Lifetime-value distribution across all subscribers: avg/median/
  // p90 plus a fixed-band histogram. Cumulative, so no window.
  .get("/ltv", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const distribution = await getLtvDistribution(projectId);
    return c.json(ok(distribution));
  });
```

- [ ] **Step 3: Typecheck** — Run: `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/metrics.ts
git commit -m "feat(api): add GET /metrics/ltv route"
```

---

## Task 7: `/metrics/ltv` route tests

**Files:** Create `apps/api/tests/dashboard-metrics-ltv.test.ts`

- [ ] **Step 1: Write the test file**

Mirror `dashboard-metrics-summary.test.ts` exactly (same `auditMock`, `drizzleMock` with `schema.notifications` + `notificationRepo`, `authMock`, `dbMock`, `vi.mock` blocks, `signedIn`, `authedHeaders`). Mock `../src/services/metrics/ltv` with:

```ts
const { ltvMock } = vi.hoisted(() => ({
  ltvMock: {
    getLtvDistribution: vi.fn(async () => ({
      avgUsd: "42.5000",
      medianUsd: "30.0000",
      p90Usd: "120.0000",
      totalSubscribers: 50,
      histogram: [
        { lowerUsd: 0, upperUsd: 5, count: 10 },
        { lowerUsd: 1000, upperUsd: null, count: 2 },
      ],
    })),
  },
}));
// ...
vi.mock("../src/services/metrics/ltv", () => ltvMock);
```

Tests:
1. "401 without a session" → 401
2. "403 when caller is not a project member" → 403
3. "returns the distribution" — signedIn + VIEWER → 200; `body.data` toMatchObject `{ avgUsd: "42.5000", totalSubscribers: 50 }` and `body.data.histogram` has length 2 with the open-ended top bucket `upperUsd: null`.

Endpoint path: `/dashboard/projects/proj_1/metrics/ltv`.

- [ ] **Step 2: Run** — Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-ltv.test.ts` → PASS (3 tests)
- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/dashboard-metrics-ltv.test.ts
git commit -m "test(api): cover GET /metrics/ltv"
```

---

## Task 8: LTV hook + extend the KPI card

**Files:**
- Create `apps/dashboard/src/lib/hooks/useProjectLtv.ts`
- Modify `apps/dashboard/src/components/charts/revenue-kpis-card.tsx`

- [ ] **Step 1: Write the LTV hook** (mirror `useProjectMrr.ts`; no window params)

```ts
import { useQuery } from "@tanstack/react-query";
import type { LtvDistributionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProjectLtv(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "ltv", projectId],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<LtvDistributionResponse>(
        rpc.dashboard.projects[":projectId"].metrics.ltv.$get({
          param: { projectId },
        }),
      ),
  });
}
```

- [ ] **Step 2: Add three tiles to `RevenueKpisCard`**

In `revenue-kpis-card.tsx`, change the grid to allow more tiles (`lg:grid-cols-3` so 9 tiles wrap cleanly) and add after the existing tiles:

```tsx
        <Kpi label="ARPU" value={money(data?.arpu)} />
        <Kpi label="Churn rate" value={pct(data?.churnRate)} />
        <Kpi label="Trial→paid" value={pct(data?.trialConversionRate)} />
```

(Update the wrapping `<div className="grid ...">` to `className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-3"`.)

- [ ] **Step 3: Typecheck** — Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectLtv.ts apps/dashboard/src/components/charts/revenue-kpis-card.tsx
git commit -m "feat(dashboard): add useProjectLtv + ARPU/churn/trial tiles"
```

---

## Task 9: LTV distribution card

**Files:**
- Create `apps/dashboard/src/components/charts/ltv-distribution-card.tsx`
- Modify `apps/dashboard/src/components/charts/index.ts`
- Modify the project page (`apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx`)

- [ ] **Step 1: Write the card** (simple horizontal bar histogram, project styling tokens)

```tsx
import { useProjectLtv } from "../../lib/hooks/useProjectLtv";
import { formatCurrencyCompact } from "./format";

type Props = { projectId: string };

function bandLabel(lowerUsd: number, upperUsd: number | null): string {
  if (upperUsd == null) return `${formatCurrencyCompact(lowerUsd)}+`;
  return `${formatCurrencyCompact(lowerUsd)}–${formatCurrencyCompact(upperUsd)}`;
}

export function LtvDistributionCard({ projectId }: Props) {
  const { data, isLoading } = useProjectLtv(projectId);
  const buckets = data?.histogram ?? [];
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 flex items-baseline justify-between">
        <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
          Lifetime value distribution
        </div>
        <div className="font-rv-mono text-[11px] text-rv-mute-500">
          {isLoading ? "—" : `median ${formatCurrencyCompact(Number(data?.medianUsd ?? 0))}`}
        </div>
      </div>
      <div className="space-y-1.5">
        {buckets.map((b) => (
          <div key={`${b.lowerUsd}`} className="flex items-center gap-2">
            <div className="w-20 shrink-0 text-right font-rv-mono text-[10px] text-rv-mute-500">
              {bandLabel(b.lowerUsd, b.upperUsd)}
            </div>
            <div className="h-3 flex-1 rounded-sm bg-rv-c2">
              <div
                className="h-3 rounded-sm bg-rv-accent-500"
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <div className="w-8 shrink-0 font-rv-mono text-[10px] tabular-nums text-rv-mute-600">
              {b.count}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Export** — add `export { LtvDistributionCard } from "./ltv-distribution-card";` to `charts/index.ts`.

- [ ] **Step 3: Render on the project page** — import `LtvDistributionCard` and render `<LtvDistributionCard projectId={projectId} />` near the other analytics panels (read the file; place it in the existing grid row alongside the MRR/top-products panels, matching layout).

- [ ] **Step 4: Typecheck** — Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/charts/ltv-distribution-card.tsx apps/dashboard/src/components/charts/index.ts apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx
git commit -m "feat(dashboard): add LTV distribution card"
```

---

## Task 10: Full verification

- [ ] **Step 1: Monorepo typecheck** — Run: `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 2: API metrics unit tests** — Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics.test.ts tests/dashboard-metrics-summary.test.ts tests/dashboard-metrics-ltv.test.ts` → PASS (13 tests)
- [ ] **Step 3: Build** — Run: `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard build` → PASS
- [ ] **Step 4: Integration (requires Docker + applied CH migrations)** — Run: `pnpm --filter @rovenue/api exec vitest run tests/mrr-clickhouse-only.integration.test.ts` (and any summary/ltv integration suite if added). Note the new `summary.ts` PG reads need a seeded Postgres too.

---

## Self-Review Notes

- **Spec coverage:** churn rate (§3.6, source corrected to `purchases`), ARPU (§3.2 deferred item), trial→paid rate (§3.4 scalar; per-bucket trend deferred to Phase 3), LTV distribution (§3.3). ✅
- **Type consistency:** `RevenueSummary` (service) and `RevenueSummaryResponse` (shared) carry identical new field names; `LtvDistribution`/`LtvBucket` (service) map 1:1 to `LtvDistributionResponse`/`LtvHistogramBucket` (shared).
- **Money:** all monetary fields decimal-as-string via `toFixed(4)`; rates are `number | null` in `[0,1]`.
- **No `subscriber_access` dependency** — churn/active base read `purchases` (the table that actually carries `projectId` + dated terminal status).
