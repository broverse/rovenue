# Predictive LTV — Level 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Ship `GET /metrics/ltv-prediction` (cohort cumulative-revenue curve scaling, 12-month horizon, monthly cohorts, project-blended + per-store + per-product) and a dashboard card — pure ClickHouse + a unit-tested JS extrapolation function. No ML, no migrations, no workers.

**Architecture:** A pure, ClickHouse-free function `computeLtvPrediction()` (the math — unit-tested directly) + a thin service `ltv-prediction.ts` that (1) runs two CH reads (revenue-by-cohort/segment/age, and cohort/segment sizes), (2) calls the pure function, (3) resolves productId→name via the existing Postgres product lookup. Route + hook + card mirror Phases 1–3.

**Tech Stack:** Hono + Zod, ClickHouse via `queryAnalytics`, Drizzle product lookup (as `overview.ts`), `{ data: T }` via `ok()`, React + react-query, Vitest.

**Decisions (approved):** curve-scaling method; horizon 12 months (param `horizonMonths` 1–36); monthly cohorts; segmentation by **acquisition store + acquisition product** (attributed by the join event); maturity curve `f(t)` learned **once project-wide** and applied to every segment; cold-start `warning` when `< minMatureCohorts` (default 3) cohorts reach the horizon.

---

## File Structure

- Create `apps/api/src/services/metrics/ltv-extrapolation.ts` — pure math (`computeLtvPrediction` + types).
- Create `apps/api/src/services/metrics/ltv-prediction.ts` — CH reads + product lookup + calls the pure fn.
- Create `apps/api/tests/ltv-extrapolation.test.ts` — unit tests for the math (no CH).
- Create `apps/api/tests/dashboard-metrics-ltv-prediction.test.ts` — route test (mocks the service).
- Modify `apps/api/src/routes/dashboard/metrics.ts` — add `.get("/ltv-prediction", …)`.
- Modify `packages/shared/src/dashboard.ts` — add response types.
- Create `apps/dashboard/src/lib/hooks/useProjectLtvPrediction.ts` + `src/components/charts/predicted-ltv-card.tsx`; wire into project page + charts barrel.

---

## Task 1: Shared types

**Files:** Modify `packages/shared/src/dashboard.ts` (after `LtvDistributionResponse`)

- [ ] **Step 1: Add types**

```ts
// =============================================================
// Predictive LTV — Level 1 (cohort curve scaling, Phase: predictive)
// =============================================================

export interface LtvSegment {
  /** store code, productId, or "__all__". */
  key: string;
  label: string;
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  /** thin-segment / cold-start flag. */
  warning: string | null;
}

export interface LtvPredictionCohort {
  cohortMonth: string; // ISO month start
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  maturity: number; // f(observedAge) in [0,1]
  isMature: boolean;
}

export interface LtvPredictionResponse {
  horizonMonths: number;
  blendedPredictedLtvUsd: string;
  maturityCurve: Array<{ ageMonth: number; fraction: number }>;
  cohorts: LtvPredictionCohort[];
  byStore: LtvSegment[];
  byProduct: LtvSegment[];
  warning: string | null;
}
```

- [ ] **Step 2:** `pnpm --filter @rovenue/shared build` → PASS
- [ ] **Step 3:** Commit `feat(shared): add LtvPredictionResponse types`

---

## Task 2: Pure extrapolation function (TDD)

**Files:** Create `apps/api/src/services/metrics/ltv-extrapolation.ts` + `apps/api/tests/ltv-extrapolation.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/tests/ltv-extrapolation.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { computeLtvPrediction, type LtvRawRow, type LtvSizeRow } from "../src/services/metrics/ltv-extrapolation";

// Two mature cohorts (age ≥ 2) with a clean curve: 60% by age 0, 100% by age 2.
// One young cohort observed only to age 0 → should scale 60 → ~100.
const H = 2;
const sizes: LtvSizeRow[] = [
  { cohortMonth: "2026-01-01", store: "APP_STORE", productId: "p1", size: 100 },
  { cohortMonth: "2026-02-01", store: "APP_STORE", productId: "p1", size: 100 },
  { cohortMonth: "2026-04-01", store: "APP_STORE", productId: "p1", size: 100 },
];
// per-age incremental net revenue (totals across the cohort). cum/member: age0=6, age1=9, age2=10.
const mk = (cohort: string, ages: number[]): LtvRawRow[] =>
  ages.map((rev, age) => ({ cohortMonth: cohort, store: "APP_STORE", productId: "p1", ageMonth: age, netUsd: rev }));
const rows: LtvRawRow[] = [
  ...mk("2026-01-01", [600, 300, 100]),
  ...mk("2026-02-01", [600, 300, 100]),
  ...mk("2026-04-01", [600]), // young, only age 0 observed
];

describe("computeLtvPrediction", () => {
  test("scales a young cohort up to the horizon via the shared curve", () => {
    const r = computeLtvPrediction(rows, sizes, H, 2, "2026-04-01");
    // f(0) = 6/10 = 0.6 ; young cohort observed 6/member → predicted ≈ 10
    const young = r.cohorts.find((c) => c.cohortMonth === "2026-04-01")!;
    expect(Number(young.observedLtvUsd)).toBeCloseTo(6, 4);
    expect(Number(young.predictedLtvUsd)).toBeCloseTo(10, 4);
    expect(young.isMature).toBe(false);
    expect(young.maturity).toBeCloseTo(0.6, 4);
    // mature cohort: predicted == observed == 10
    const mature = r.cohorts.find((c) => c.cohortMonth === "2026-01-01")!;
    expect(mature.isMature).toBe(true);
    expect(Number(mature.predictedLtvUsd)).toBeCloseTo(10, 4);
    // maturity curve monotonic, ends at 1
    expect(r.maturityCurve[0]!.fraction).toBeCloseTo(0.6, 4);
    expect(r.maturityCurve[H]!.fraction).toBeCloseTo(1, 4);
    // blended = (100*10 + 100*10 + 100*10)/300 = 10
    expect(Number(r.blendedPredictedLtvUsd)).toBeCloseTo(10, 4);
    expect(r.byStore[0]!.key).toBe("APP_STORE");
    expect(Number(r.byStore[0]!.predictedLtvUsd)).toBeCloseTo(10, 4);
    expect(r.warning).toBeNull();
  });

  test("sets warning when too few mature cohorts", () => {
    const r = computeLtvPrediction(mk("2026-04-01", [600]), [sizes[2]!], H, 3, "2026-04-01");
    expect(r.warning).not.toBeNull();
  });

  test("empty input → zeros, no throw", () => {
    const r = computeLtvPrediction([], [], H, 3, "2026-04-01");
    expect(Number(r.blendedPredictedLtvUsd)).toBe(0);
    expect(r.cohorts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module ltv-extrapolation`)

Run: `pnpm --filter @rovenue/api exec vitest run tests/ltv-extrapolation.test.ts` → FAIL

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/metrics/ltv-extrapolation.ts`:

```ts
// =============================================================
// Predictive LTV — Level 1 math (ClickHouse-free, unit-tested)
// =============================================================
//
// Cohort cumulative-revenue curve scaling. Learn one project-wide
// maturity curve f(t) = fraction of horizon-LTV realised by age t
// (from cohorts old enough to reach the horizon), then scale every
// cohort's partial observed cumulative-per-member up to the horizon.
// Segments (store/product) reuse the SAME f(t).

export interface LtvRawRow {
  cohortMonth: string; // "YYYY-MM-DD" month start
  store: string;
  productId: string;
  ageMonth: number;
  netUsd: number;
}

export interface LtvSizeRow {
  cohortMonth: string;
  store: string;
  productId: string;
  size: number;
}

export interface LtvSegmentResult {
  key: string;
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  warning: string | null;
}

export interface LtvPredictionData {
  horizonMonths: number;
  blendedPredictedLtvUsd: string;
  maturityCurve: Array<{ ageMonth: number; fraction: number }>;
  cohorts: Array<{
    cohortMonth: string;
    size: number;
    observedLtvUsd: string;
    predictedLtvUsd: string;
    maturity: number;
    isMature: boolean;
  }>;
  byStore: LtvSegmentResult[];
  byProduct: LtvSegmentResult[];
  warning: string | null;
}

function monthIndex(monthStart: string): number {
  const parts = monthStart.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return y * 12 + (m - 1);
}

/** cumAt(map, t) = Σ rev for ages 0..t. */
function cumAt(byAge: Map<number, number>, t: number): number {
  let acc = 0;
  for (let a = 0; a <= t; a++) acc += byAge.get(a) ?? 0;
  return acc;
}

export function computeLtvPrediction(
  rows: LtvRawRow[],
  sizes: LtvSizeRow[],
  horizonMonths: number,
  minMatureCohorts: number,
  asOfMonth: string,
): LtvPredictionData {
  const H = horizonMonths;
  const asOf = monthIndex(asOfMonth);

  // ---- sizes (cohort total + per segment/cohort) ----
  const sizeByCohort = new Map<string, number>();
  const sizeStore = new Map<string, Map<string, number>>(); // store -> cohort -> size
  const sizeProduct = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, key: string, cohort: string, n: number) => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(cohort, (inner.get(cohort) ?? 0) + n);
    m.set(key, inner);
  };
  for (const s of sizes) {
    sizeByCohort.set(s.cohortMonth, (sizeByCohort.get(s.cohortMonth) ?? 0) + s.size);
    add(sizeStore, s.store, s.cohortMonth, s.size);
    add(sizeProduct, s.productId, s.cohortMonth, s.size);
  }

  // ---- revenue by cohort/age (project) and per segment/cohort/age ----
  const revCohort = new Map<string, Map<number, number>>();
  const revStore = new Map<string, Map<string, Map<number, number>>>(); // store -> cohort -> age -> rev
  const revProduct = new Map<string, Map<string, Map<number, number>>>();
  const bump = (m: Map<string, Map<number, number>>, cohort: string, age: number, v: number) => {
    const inner = m.get(cohort) ?? new Map<number, number>();
    inner.set(age, (inner.get(age) ?? 0) + v);
    m.set(cohort, inner);
  };
  const bumpSeg = (m: Map<string, Map<string, Map<number, number>>>, key: string, cohort: string, age: number, v: number) => {
    const inner = m.get(key) ?? new Map<string, Map<number, number>>();
    bump(inner, cohort, age, v);
    m.set(key, inner);
  };
  for (const r of rows) {
    if (r.ageMonth < 0 || r.ageMonth > H) continue; // ignore pre-acquisition + beyond horizon
    bump(revCohort, r.cohortMonth, r.ageMonth, r.netUsd);
    bumpSeg(revStore, r.store, r.cohortMonth, r.ageMonth, r.netUsd);
    bumpSeg(revProduct, r.productId, r.cohortMonth, r.ageMonth, r.netUsd);
  }

  const cohortsList = [...sizeByCohort.keys()].sort();
  const observedAge = (c: string): number => Math.max(0, asOf - monthIndex(c));

  // ---- learn f(t) from mature cohorts (observedAge >= H, horizon revenue > 0) ----
  const mature = cohortsList.filter((c) => observedAge(c) >= H && cumAt(revCohort.get(c) ?? new Map(), H) > 0);
  let f: number[];
  let warning: string | null = null;
  if (mature.length === 0) {
    f = Array.from({ length: H + 1 }, (_, t) => (t >= H ? 1 : 0)); // no shape known → no scaling
    warning = `No cohort has reached the ${H}-month horizon yet; predictions equal observed and are highly uncertain.`;
  } else {
    const raw = Array.from({ length: H + 1 }, () => 0);
    let wsum = 0;
    for (const c of mature) {
      const size = sizeByCohort.get(c) ?? 0;
      const byAge = revCohort.get(c) ?? new Map();
      const denom = cumAt(byAge, H) / (size || 1);
      if (denom <= 0) continue;
      for (let t = 0; t <= H; t++) raw[t]! += size * ((cumAt(byAge, t) / (size || 1)) / denom);
      wsum += size;
    }
    f = raw.map((v) => (wsum > 0 ? v / wsum : 0));
    // enforce monotonic non-decreasing and f(H)=1
    for (let t = 1; t <= H; t++) f[t] = Math.max(f[t]!, f[t - 1]!);
    f[H] = 1;
    if (mature.length < minMatureCohorts) {
      warning = `Only ${mature.length} cohort(s) have reached the ${H}-month horizon; predictions are low-confidence.`;
    }
  }

  // ---- per-cohort observed → predicted (project) ----
  const fix = (n: number) => n.toFixed(4);
  const cohorts = cohortsList.map((c) => {
    const size = sizeByCohort.get(c) ?? 0;
    const byAge = revCohort.get(c) ?? new Map();
    const a = Math.min(observedAge(c), H);
    const observed = cumAt(byAge, a) / (size || 1);
    const isMature = observedAge(c) >= H;
    const fa = f[a] ?? 0;
    const predicted = isMature ? cumAt(byAge, H) / (size || 1) : fa > 0 ? observed / fa : observed;
    return {
      cohortMonth: c,
      size,
      observedLtvUsd: fix(observed),
      predictedLtvUsd: fix(predicted),
      maturity: isMature ? 1 : fa,
      isMature,
    };
  });

  const totalSize = cohortsList.reduce((s, c) => s + (sizeByCohort.get(c) ?? 0), 0);
  const blended =
    totalSize > 0
      ? cohorts.reduce((s, c) => s + c.size * Number(c.predictedLtvUsd), 0) / totalSize
      : 0;

  // ---- segment roll-up using the shared f ----
  const segment = (
    revMap: Map<string, Map<string, Map<number, number>>>,
    sizeMap: Map<string, Map<string, number>>,
  ): LtvSegmentResult[] =>
    [...sizeMap.entries()].map(([key, perCohort]) => {
      let wPred = 0;
      let wObs = 0;
      let segSize = 0;
      for (const [c, n] of perCohort) {
        const byAge = revMap.get(key)?.get(c) ?? new Map<number, number>();
        const a = Math.min(observedAge(c), H);
        const observed = cumAt(byAge, a) / (n || 1);
        const isMature = observedAge(c) >= H;
        const fa = f[a] ?? 0;
        const predicted = isMature ? cumAt(byAge, H) / (n || 1) : fa > 0 ? observed / fa : observed;
        wPred += n * predicted;
        wObs += n * observed;
        segSize += n;
      }
      return {
        key,
        size: segSize,
        observedLtvUsd: fix(segSize > 0 ? wObs / segSize : 0),
        predictedLtvUsd: fix(segSize > 0 ? wPred / segSize : 0),
        warning: warning ?? (segSize < 20 ? "Thin segment — low confidence." : null),
      };
    }).sort((a, b) => b.size - a.size);

  return {
    horizonMonths: H,
    blendedPredictedLtvUsd: fix(blended),
    maturityCurve: f.map((fraction, ageMonth) => ({ ageMonth, fraction })),
    cohorts,
    byStore: segment(revStore, sizeStore),
    byProduct: segment(revProduct, sizeProduct),
    warning,
  };
}
```

- [ ] **Step 4: Run → PASS**

Run: `pnpm --filter @rovenue/api exec vitest run tests/ltv-extrapolation.test.ts` → PASS (3 tests). Fix arithmetic if `predictedLtvUsd` ≠ expected.

- [ ] **Step 5:** Commit `feat(api): add LTV prediction extrapolation math + tests`

---

## Task 3: Service (CH reads + product names)

**Files:** Create `apps/api/src/services/metrics/ltv-prediction.ts`

- [ ] **Step 1: Write the service**

```ts
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { queryAnalytics } from "../../lib/clickhouse";
import {
  computeLtvPrediction,
  type LtvRawRow,
  type LtvSizeRow,
} from "./ltv-extrapolation";
import type { LtvSegment } from "@rovenue/shared";

export interface GetLtvPredictionInput {
  projectId: string;
  horizonMonths: number;
  minMatureCohorts: number;
}

const STORE_LABELS: Record<string, string> = {
  APP_STORE: "App Store",
  PLAY_STORE: "Play Store",
  STRIPE: "Stripe",
  MANUAL: "Manual",
};

interface ChRevRow {
  cohort_month: string;
  store: string;
  product_id: string;
  age_month: number;
  net_usd: string;
}
interface ChSizeRow {
  cohort_month: string;
  store: string;
  product_id: string;
  size: string;
}

export async function getLtvPrediction(input: GetLtvPredictionInput) {
  const joinsCte = `
    joins AS (
      SELECT
        subscriberId,
        toStartOfMonth(min(eventDate))       AS cohort_month,
        argMin(store, eventDate)             AS join_store,
        argMin(productId, eventDate)         AS join_product
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND type IN ('INITIAL','TRIAL_CONVERSION')
      GROUP BY subscriberId
    )`;

  const [revRows, sizeRows] = await Promise.all([
    queryAnalytics<ChRevRow>(
      input.projectId,
      `
        WITH ${joinsCte}
        SELECT
          toString(j.cohort_month)                                           AS cohort_month,
          j.join_store                                                       AS store,
          j.join_product                                                     AS product_id,
          toInt32(dateDiff('month', j.cohort_month, toStartOfMonth(e.eventDate))) AS age_month,
          toString(
            sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK'))
              - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK'))
          )                                                                  AS net_usd
        FROM rovenue.raw_revenue_events FINAL AS e
        INNER JOIN joins AS j ON e.subscriberId = j.subscriberId
        WHERE e.projectId = {projectId:String}
        GROUP BY cohort_month, store, product_id, age_month
      `,
    ),
    queryAnalytics<ChSizeRow>(
      input.projectId,
      `
        WITH ${joinsCte}
        SELECT
          toString(cohort_month)  AS cohort_month,
          join_store              AS store,
          join_product            AS product_id,
          toString(count())       AS size
        FROM joins
        GROUP BY cohort_month, store, product_id
      `,
    ),
  ]);

  const rows: LtvRawRow[] = revRows.map((r) => ({
    cohortMonth: r.cohort_month.slice(0, 10),
    store: r.store,
    productId: r.product_id,
    ageMonth: Number(r.age_month),
    netUsd: Number(r.net_usd),
  }));
  const sizes: LtvSizeRow[] = sizeRows.map((r) => ({
    cohortMonth: r.cohort_month.slice(0, 10),
    store: r.store,
    productId: r.product_id,
    size: Number(r.size),
  }));

  const now = new Date();
  const asOfMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

  const data = computeLtvPrediction(
    rows,
    sizes,
    input.horizonMonths,
    input.minMatureCohorts,
    asOfMonth,
  );

  // Resolve productId → display name for byProduct labels.
  const productIds = data.byProduct.map((s) => s.key).filter(Boolean);
  const nameById = new Map<string, string>();
  if (productIds.length > 0) {
    const prods = await drizzle.db
      .select({
        id: drizzle.schema.products.id,
        displayName: drizzle.schema.products.displayName,
      })
      .from(drizzle.schema.products)
      .where(
        and(
          eq(drizzle.schema.products.projectId, input.projectId),
          inArray(drizzle.schema.products.id, productIds),
        ),
      );
    for (const p of prods) nameById.set(p.id, p.displayName);
  }

  const byStore: LtvSegment[] = data.byStore.map((s) => ({
    ...s,
    label: STORE_LABELS[s.key] ?? s.key,
  }));
  const byProduct: LtvSegment[] = data.byProduct.map((s) => ({
    ...s,
    label: nameById.get(s.key) ?? s.key,
  }));

  return { ...data, byStore, byProduct };
}
```

- [ ] **Step 2:** `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 3:** Commit `feat(api): add getLtvPrediction service (CH + product names)`

---

## Task 4: Route

**Files:** Modify `apps/api/src/routes/dashboard/metrics.ts`

- [ ] **Step 1: Import** `import { getLtvPrediction } from "../../services/metrics/ltv-prediction";`

- [ ] **Step 2: Add a query schema + route** (chain after `/engagement`). Add near the other schemas:

```ts
export const ltvPredictionQuerySchema = z.object({
  horizonMonths: z.coerce.number().int().min(1).max(36).default(12),
  minMatureCohorts: z.coerce.number().int().min(1).max(24).default(3),
});
```

Handler:

```ts
  .get(
    "/ltv-prediction",
    zValidator("query", ltvPredictionQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { horizonMonths, minMatureCohorts } = c.req.valid("query");
      const data = await getLtvPrediction({ projectId, horizonMonths, minMatureCohorts });
      return c.json(ok(data));
    },
  );
```

- [ ] **Step 3:** `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 4:** Commit `feat(api): add GET /metrics/ltv-prediction route`

---

## Task 5: Route test

**Files:** Create `apps/api/tests/dashboard-metrics-ltv-prediction.test.ts`

- [ ] **Step 1:** Mirror `dashboard-metrics-summary.test.ts` scaffold; mock `../src/services/metrics/ltv-prediction`:

```ts
const { predMock } = vi.hoisted(() => ({
  predMock: {
    getLtvPrediction: vi.fn(async () => ({
      horizonMonths: 12,
      blendedPredictedLtvUsd: "84.0000",
      maturityCurve: [{ ageMonth: 0, fraction: 0.4 }, { ageMonth: 12, fraction: 1 }],
      cohorts: [{ cohortMonth: "2026-01-01", size: 100, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", maturity: 0.71, isMature: false }],
      byStore: [{ key: "APP_STORE", label: "App Store", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
      byProduct: [{ key: "p1", label: "Pro Monthly", size: 80, observedLtvUsd: "60.0000", predictedLtvUsd: "84.0000", warning: null }],
      warning: null,
    })),
  },
}));
// vi.mock("../src/services/metrics/ltv-prediction", () => predMock);
```

Tests at `/dashboard/projects/proj_1/metrics/ltv-prediction`:
1. 401 no session, 2. 403 non-member, 3. VIEWER → 200; `body.data` toMatchObject `{ horizonMonths: 12, blendedPredictedLtvUsd: "84.0000" }`; `body.data.byStore[0].label` === "App Store"; `body.data.cohorts` length 1.

- [ ] **Step 2:** `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-ltv-prediction.test.ts` → PASS (3)
- [ ] **Step 3:** Commit `test(api): cover /metrics/ltv-prediction`

---

## Task 6: Dashboard hook + card

**Files:** Create `apps/dashboard/src/lib/hooks/useProjectLtvPrediction.ts` + `src/components/charts/predicted-ltv-card.tsx`; modify charts barrel + project page

- [ ] **Step 1: Hook** (mirror `useProjectMrr`, optional `horizonMonths`)

```ts
import { useQuery } from "@tanstack/react-query";
import type { LtvPredictionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProjectLtvPrediction(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "ltv-prediction", projectId],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<LtvPredictionResponse>(
        rpc.dashboard.projects[":projectId"].metrics["ltv-prediction"].$get({
          param: { projectId },
          query: {},
        }),
      ),
  });
}
```

- [ ] **Step 2: Card** — headline blended pLTV + warning badge + a compact store/product breakdown + cohort table. Use project styling tokens (`rv-c1`, `rv-divider`, `font-rv-mono`) and `formatCurrencyCompact` from `./format`. Render: a big `blendedPredictedLtvUsd` (labelled "Predicted LTV (12mo)"), a yellow warning row when `data.warning` is set, then two small lists (By store / By product) each row `label … predictedLtvUsd (observed→)`, and a cohorts table (month, size, observed→predicted, maturity %). Keep it self-contained and handle `isLoading` with "—".

- [ ] **Step 3:** Export from `charts/index.ts`; render `<PredictedLtvCard projectId={projectId} />` on the project page next to the LTV distribution card (read the file; match `mt-4` layout).
- [ ] **Step 4:** `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 5:** Commit `feat(dashboard): add predicted LTV card`

---

## Task 7: Full verification

- [ ] **Step 1:** `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 2:** `pnpm --filter @rovenue/api exec vitest run tests/ltv-extrapolation.test.ts tests/dashboard-metrics-ltv-prediction.test.ts` → PASS (6)
- [ ] **Step 3:** `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard build` → PASS
- [ ] **Step 4 (Docker):** seed `raw_revenue_events` with ≥3 mature + 1 young cohort; assert young predicted > observed and blended is finite.

---

## Self-Review Notes

- **Math is the risk** → isolated into a pure, unit-tested function (`ltv-extrapolation.ts`); CH service is a thin adapter.
- **Cold-start honesty:** `warning` set when `< minMatureCohorts` reach the horizon (or none mature → no scaling). Thin segments flagged.
- **Segmentation:** shared project-wide `f(t)`, segments attributed by acquisition store/product — avoids unstable thin-segment curves.
- **No new infra:** two CH reads + one Postgres name lookup; computed on read.
- **Deferred (Level 2):** per-subscriber ML scoring, churn-prob model, predicted-LTV audiences, confidence intervals, explicit decay fit.
