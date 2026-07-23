# SP2 — Chart series contract + two paywall readers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the charts page a real `chartId → series` contract, wire the two paywall charts to ClickHouse, and stop every other catalog entry from silently rendering MRR data under someone else's name.

**Architecture:** A new `GET /charts/series/:chartId` endpoint returns a chart-agnostic `ChartSeriesResponse`. Rate arithmetic lives in a pure function (`buildRatePoints`) so it is testable without ClickHouse; the SQL is tested only for shape, against the mocked module boundary this repo already uses for metrics. The dashboard replaces its unconditional `<MrrChartPanel>` with a dispatch: MRR keeps its bespoke panel, everything else renders a generic `SeriesChartPanel` that shows an honest empty state when `supported` is false.

**Tech Stack:** TypeScript (strict), Hono, Zod, ClickHouse, React (Vite), TanStack Query, Vitest.

Spec: `docs/superpowers/specs/2026-07-23-sp2-chart-series-contract-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for API input. Responses are `{ data: T }` via `ok()` or `{ error: { code, message } }`.
- ClickHouse access goes through `queryAnalytics` from `apps/api/src/lib/clickhouse`. Guard every reader with `assertClickHouseReady()` first, exactly as `readFunnel`/`readHeatmap` do.
- Barrel exports per package. Shared API types live in `packages/shared/src/dashboard.ts`.
- **No magic values.** Any literal carrying meaning — a window bound, a default, a percentage scale — gets a named constant next to its siblings. Structured data tables and fixture ids are not magic values.
- All new user-facing strings go through i18n (`apps/dashboard/src/i18n/locales/en.json`). No hardcoded copy in components.
- Conventional commits, one commit per task. **Stay on the current branch (`main`). Do NOT create branches or worktrees.** Another author commits to `main` in parallel — only `git add` the files your task names, never `git add -A`.
- Test invocation: packages have no `vitest` script — use `pnpm --filter <pkg> exec vitest run <path>`, never `pnpm --filter <pkg> vitest run <path>`.
- API route tests live in `apps/api/tests/`, a separate directory from `apps/api/src`. Service tests colocate with the source.
- **Every fix must be mutation-checked**: after the test passes, revert the production change, confirm the test goes red, then restore. A test that passes on unfixed code proves nothing.
- ClickHouse-backed metrics are tested by mocking the module boundary (`vi.mock("../../lib/clickhouse", ...)`) — this repo has no ClickHouse testcontainer harness, and host-to-ClickHouse traffic is rejected by the container's IP allow-list.

---

### Task 1: Shared types + the pure rate builder

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (append after `MrrSeriesResponse`, which ends at line 650)
- Modify: `apps/api/src/services/metrics/charts.ts` (append the pure function)
- Test: `apps/api/src/services/metrics/charts.rate-points.test.ts` (create)

**Interfaces:**
- Produces:
  - `ChartSeriesPoint { bucket: string; value: number | null; numerator?: number; denominator?: number }`
  - `ChartSeriesResponse { chartId: string; unit: "count" | "percent"; from: string; to: string; points: ChartSeriesPoint[]; supported: boolean }`
  - `buildRatePoints(numerator: DailyCountRow[], denominator: DailyCountRow[], from: Date, to: Date): ChartSeriesPoint[]`
  - `DailyCountRow { day: string; n: string }` — `day` is `YYYY-MM-DD`, `n` is a stringified integer (ClickHouse returns counts as strings).

**Background the implementer needs:**

Both paywall charts are ratios of two independently-queried daily aggregates. Because this repo cannot run ClickHouse in tests, the arithmetic is deliberately extracted into a pure function so it can be tested for real instead of through a mock.

The rule that matters: **a day whose denominator is zero has an undefined rate, not a zero rate.** Reporting `0` would draw a day with no paywall traffic as a 0% conversion day, which reads as a collapse rather than an absence. Such a day emits `value: null` while still reporting its `numerator` and `denominator`.

Every day in the window gets a point, in ascending order, so the client never has to fill gaps.

- [ ] **Step 1: Add the shared types**

Append to `packages/shared/src/dashboard.ts`, after the `MrrSeriesResponse` block:

```ts
// =============================================================
// Charts — generic per-chart daily series
// =============================================================
//
// One shape for every catalog chart, so the dashboard can render
// any id without a per-chart response type. `supported` is false
// for a catalog id that has no reader yet: the panel then shows an
// empty state instead of another chart's data.

export interface ChartSeriesPoint {
  /** ISO timestamp at start-of-day UTC. */
  bucket: string;
  /**
   * null when the metric is undefined for that day — a ratio whose
   * denominator is zero. Distinct from 0, which means "measured, and
   * it was zero".
   */
  value: number | null;
  /** Ratio inputs, exposed so a reader can show "3 of 120". */
  numerator?: number;
  denominator?: number;
}

export interface ChartSeriesResponse {
  chartId: string;
  unit: "count" | "percent";
  from: string;
  to: string;
  points: ChartSeriesPoint[];
  /** false when this catalog id has no reader wired yet. */
  supported: boolean;
}
```

Check whether `packages/shared/src/index.ts` re-exports `dashboard.ts` wholesale (`export * from "./dashboard"`). If it does, nothing further is needed; if it enumerates names, add the two new ones.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/services/metrics/charts.rate-points.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRatePoints } from "./charts";

// buildRatePoints is the whole reason the readers split their
// arithmetic out of SQL: this repo cannot run ClickHouse in tests,
// so the part that can be proven is proven here, with real data
// structures and no mocks.

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-03T23:59:59.999Z");

describe("buildRatePoints", () => {
  it("emits one point per day in the window, ascending", () => {
    const points = buildRatePoints([], [], FROM, TO);
    expect(points.map((p) => p.bucket)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
  });

  it("computes the ratio as a percentage for a day with both sides", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-02", n: "3" }],
      [{ day: "2026-07-02", n: "12" }],
      FROM,
      TO,
    );
    const day2 = points[1];
    expect(day2?.value).toBe(25);
    expect(day2?.numerator).toBe(3);
    expect(day2?.denominator).toBe(12);
  });

  it("reports null — NOT zero — when the denominator is zero", () => {
    // The distinction this whole field exists for. A day with no
    // paywall traffic has an UNDEFINED conversion rate; drawing it as
    // 0% would read as a collapse rather than an absence.
    const points = buildRatePoints(
      [],
      [{ day: "2026-07-02", n: "0" }],
      FROM,
      TO,
    );
    expect(points[1]?.value).toBeNull();
    expect(points[1]?.denominator).toBe(0);
  });

  it("reports zero — NOT null — when the numerator is zero but the denominator is not", () => {
    const points = buildRatePoints(
      [],
      [{ day: "2026-07-02", n: "40" }],
      FROM,
      TO,
    );
    expect(points[1]?.value).toBe(0);
  });

  it("treats a day missing from the denominator rows as zero-denominator", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-01", n: "5" }],
      [],
      FROM,
      TO,
    );
    expect(points[0]?.value).toBeNull();
  });

  it("rounds to one decimal place", () => {
    const points = buildRatePoints(
      [{ day: "2026-07-01", n: "1" }],
      [{ day: "2026-07-01", n: "3" }],
      FROM,
      TO,
    );
    expect(points[0]?.value).toBe(33.3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/metrics/charts.rate-points.test.ts
```

Expected: FAIL — `buildRatePoints` is not exported from `./charts`.

- [ ] **Step 4: Implement the pure function**

Append to `apps/api/src/services/metrics/charts.ts`. `DAY_MS` already exists in this file (line 32) — reuse it, do not redeclare.

```ts
// =============================================================
// Generic chart series — shared rate arithmetic
// =============================================================

/** One day's count as ClickHouse returns it: counts arrive stringified. */
export interface DailyCountRow {
  day: string; // YYYY-MM-DD
  n: string;
}

/**
 * Rounding scale for percentages: multiply, round, divide back.
 * 10 gives one decimal place.
 */
const PCT_ROUNDING_SCALE = 10;

/**
 * Align two daily aggregates into one point per day across the
 * window and divide them.
 *
 * A zero denominator yields `value: null`, never 0 — a day with no
 * traffic has an UNDEFINED rate, and drawing it as 0% would read as a
 * collapse rather than an absence. The inputs are reported either way
 * so a caller can show "3 of 120".
 *
 * Extracted from the readers deliberately: this repo cannot run
 * ClickHouse in tests, so keeping the arithmetic out of SQL is what
 * makes it provable.
 */
export function buildRatePoints(
  numerator: DailyCountRow[],
  denominator: DailyCountRow[],
  from: Date,
  to: Date,
): ChartSeriesPoint[] {
  const num = new Map(numerator.map((r) => [r.day, Number(r.n)]));
  const den = new Map(denominator.map((r) => [r.day, Number(r.n)]));

  const points: ChartSeriesPoint[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const key = toDateOnly(cursor);
    const n = num.get(key) ?? 0;
    const d = den.get(key) ?? 0;
    points.push({
      bucket: new Date(cursor).toISOString(),
      value: d > 0 ? Math.round((n / d) * 100 * PCT_ROUNDING_SCALE) / PCT_ROUNDING_SCALE : null,
      numerator: n,
      denominator: d,
    });
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return points;
}
```

Add `ChartSeriesPoint` to this file's existing `import type { ... } from "@rovenue/shared"` block at the top.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/metrics/charts.rate-points.test.ts
```

Expected: PASS, 6/6.

- [ ] **Step 6: Mutation-check the zero-denominator rule**

Change `value: d > 0 ? ... : null` to always compute the ratio with a guarded denominator (`n / (d || 1)`), so a zero-denominator day yields `0` instead of `null`. Re-run Step 5 and confirm the "reports null — NOT zero" test goes red while the others stay green. Restore and confirm 6/6.

Record both observed outcomes in the task report. Without this step there is no evidence the rule is enforced rather than incidental.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dashboard.ts \
        apps/api/src/services/metrics/charts.ts \
        apps/api/src/services/metrics/charts.rate-points.test.ts
git commit -m "feat(shared): chart series types + the pure daily-rate builder"
```

---

### Task 2: The two ClickHouse readers

**Files:**
- Modify: `apps/api/src/services/metrics/charts.ts`
- Test: `apps/api/src/services/metrics/charts.paywall.test.ts` (create)

**Interfaces:**
- Consumes: `buildRatePoints(numerator, denominator, from, to)`, `DailyCountRow`, `ChartSeriesPoint`, `ChartSeriesResponse` from Task 1.
- Produces: `readChartSeries(projectId: string, chartId: string, windowDays: number): Promise<ChartSeriesResponse>`.

**Background the implementer needs:**

Two ClickHouse sources back these charts:

- `rovenue.mv_paywall_daily_target` (`packages/db/clickhouse/migrations/0018_mv_paywall_daily.sql`) — columns `projectId`, `placementId`, `paywallId`, `variantId`, `day` (Date), `views` (UInt64), `subscribersHll` (`AggregateFunction(uniq, String)`). Unique viewers come from `uniqMerge(subscribersHll)`; the raw view count from `sum(views)`.
- `rovenue.raw_revenue_events` — carries `paywallId` since `0019_revenue_presented_context.sql`.
- `rovenue.v_sdk_sessions_daily` — `projectId`, `subscriberId`, `day`. Daily active subscribers are `uniq(subscriberId)` grouped by day. NOTE: `sdk_sessions_daily_tbl` (migration 0010) was DROPPED by `0016_sdk_sessions_idempotent.sql`, which replaced it with this view. Do not use the old table name.

`paywall_view_rate` = daily unique paywall viewers ÷ daily active subscribers.
`paywall_purchase` = daily unique paywall-attributed purchasers ÷ daily unique paywall viewers.

Attribution follows the pattern `apps/api/src/services/analytics-router.ts:155-190` already established: the numerator uses the **precise** `paywallId` column, not a viewer-overlap heuristic.

**ClickHouse alias trap.** Do not write `toString(day) AS day` in a query that
also does `GROUP BY day`: ClickHouse substitutes the alias into the GROUP BY and
fails with `NO_COMMON_TYPE`. Select the bare `day` column. (Found by hand-running
the SQL; every mocked test passed with the broken form.)

**Known horizon.** Revenue rows written before migration 0019 carry `paywallId = ''` and cannot match, so `paywall_purchase` under-reports for dates before that migration was deployed. This is a property of the data, not a defect — say so in the reader's comment so nobody reads the early flat region as a product collapse.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/metrics/charts.paywall.test.ts`. It mocks the ClickHouse module boundary, matching the convention in `apps/api/src/services/analytics-router.test.ts` and `apps/api/src/services/placement-metrics.test.ts` — read one of those first and follow its mock idiom.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

describe("readChartSeries", () => {
  beforeEach(() => {
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  it("reports supported:false and no points for an id with no reader", async () => {
    const res = await readChartSeries("proj_1", "churn", 7);
    expect(res.supported).toBe(false);
    expect(res.points).toEqual([]);
    expect(res.chartId).toBe("churn");
    // An unwired chart must never trigger a query — that is how the
    // old page ended up showing MRR data under another chart's name.
    expect(queryAnalyticsMock).not.toHaveBeenCalled();
  });

  it("paywall_view_rate divides unique viewers by daily active subscribers", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "30" }]) // viewers
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "120" }]); // actives

    const res = await readChartSeries("proj_1", "paywall_view_rate", 7);

    expect(res.supported).toBe(true);
    expect(res.unit).toBe("percent");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(25);

    const [viewersCall, activesCall] = queryAnalyticsMock.mock.calls as [
      [string, string, Record<string, unknown>],
      [string, string, Record<string, unknown>],
    ];
    expect(viewersCall[1]).toContain("mv_paywall_daily_target");
    expect(viewersCall[1]).toContain("uniqMerge(subscribersHll)");
    expect(activesCall[1]).toContain("v_sdk_sessions_daily");
    expect(viewersCall[2]).toMatchObject({ projectId: "proj_1" });
  });

  it("paywall_purchase divides paywall-attributed purchasers by viewers, filtering empty paywallId", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "6" }]) // purchasers
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "30" }]); // viewers

    const res = await readChartSeries("proj_1", "paywall_purchase", 7);

    expect(res.supported).toBe(true);
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(20);

    const purchasersSql = (
      queryAnalyticsMock.mock.calls[0] as [string, string, unknown]
    )[1];
    expect(purchasersSql).toContain("raw_revenue_events");
    // Pre-0019 rows carry '' and must not be counted as attributed.
    expect(purchasersSql).toContain("paywallId != ''");
    expect(purchasersSql).toContain("INITIAL");
    // A same-day rate must NOT count events that recur after the view.
    expect(purchasersSql).not.toContain("RENEWAL");
  });

  it("throws when ClickHouse is not configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(
      readChartSeries("proj_1", "paywall_view_rate", 7),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/metrics/charts.paywall.test.ts
```

Expected: FAIL — `readChartSeries` is not exported from `./charts`.

- [ ] **Step 3: Implement the readers**

**Superseded during implementation.** The `SUPPORTED_SERIES_IDS` set below was
replaced in a fix round by a `switch (chartId)` whose `default` returns
`supported: false`. Two mechanisms deciding support could disagree; one cannot.
The shipped code is the switch — read `charts.ts` rather than this snippet.

Append to `apps/api/src/services/metrics/charts.ts`:

```ts
// =============================================================
// Generic chart series — paywall reach and conversion
// =============================================================
//
// Two of the sixteen catalog charts are wired. Every other id
// answers `supported: false` so the dashboard renders an empty
// state rather than another chart's data.

/** Revenue event types that count as a purchase for attribution. */
// Only INITIAL. This is a SAME-DAY rate, so an event that recurs long
// after the view that earned it inflates the numerator against a
// denominator of today's viewers: on Stripe presentedContext persists for
// the subscription's life, so RENEWAL/REACTIVATION would put month-2+
// renewals here (200 renewals over 20 viewers renders 1000%).
// TRIAL_CONVERSION is excluded for the same lag reason — a trial started
// from a paywall on day 1 converts on day 8. INITIAL already covers trial
// STARTS at the paywall (an INITIAL carrying isTrial).
const ATTRIBUTED_PURCHASE_EVENT_TYPE = "INITIAL";

/** Catalog ids this service can serve today. */
const SUPPORTED_SERIES_IDS: ReadonlySet<string> = new Set([
  "paywall_view_rate",
  "paywall_purchase",
]);

/** Daily unique subscribers who saw any paywall in this project. */
async function readPaywallViewers(
  projectId: string,
  from: string,
  to: string,
): Promise<DailyCountRow[]> {
  return queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        day,
        toString(uniqMerge(subscribersHll))    AS n
      FROM rovenue.mv_paywall_daily_target
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
}

export async function readChartSeries(
  projectId: string,
  chartId: string,
  windowDays: number,
): Promise<ChartSeriesResponse> {
  const w = buildWindow(windowDays);
  const base = {
    chartId,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
  };

  if (!SUPPORTED_SERIES_IDS.has(chartId)) {
    // Not an error: most of the catalog simply has no reader yet.
    return { ...base, unit: "count", points: [], supported: false };
  }

  assertClickHouseReady();
  const from = toDateOnly(w.from);
  const to = toDateOnly(w.to);

  if (chartId === "paywall_view_rate") {
    // Reach: what share of the day's active subscribers saw a paywall.
    const viewers = await readPaywallViewers(projectId, from, to);
    const actives = await queryAnalytics<DailyCountRow>(
      projectId,
      `
        SELECT
          day,
          toString(uniq(subscriberId))   AS n
        FROM rovenue.v_sdk_sessions_daily
        WHERE projectId = {projectId:String}
          AND day >= {from:Date}
          AND day <= {to:Date}
        GROUP BY day
        ORDER BY day
      `,
      { projectId, from, to },
    );
    return {
      ...base,
      unit: "percent",
      points: buildRatePoints(viewers, actives, w.from, w.to),
      supported: true,
    };
  }

  // paywall_purchase — conversion: what share of paywall viewers bought.
  //
  // Precise attribution, mirroring analytics-router's placement_metrics:
  // raw_revenue_events carries the purchase's originating paywallId
  // (migration 0019), so no viewer-overlap heuristic is needed.
  //
  // KNOWN HORIZON: rows written before 0019 carry paywallId = '' and
  // cannot match, so this chart under-reports for dates before that
  // migration was deployed. That is the data, not a bug — do not
  // "fix" it by dropping the filter, which would attribute every
  // purchase to a paywall.
  const purchasers = await queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        toString(toDate(eventDate))       AS day,
        toString(uniq(subscriberId))      AS n
      FROM rovenue.raw_revenue_events
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND paywallId != ''
        AND type = '${ATTRIBUTED_PURCHASE_EVENT_TYPE}'
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
  const viewers = await readPaywallViewers(projectId, from, to);
  return {
    ...base,
    unit: "percent",
    points: buildRatePoints(purchasers, viewers, w.from, w.to),
    supported: true,
  };
}
```

Add `ChartSeriesResponse` to the file's `import type` block.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/metrics/charts.paywall.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Mutation-check the unsupported-id guard**

Remove the `SUPPORTED_SERIES_IDS` early return so every id falls through to a reader. Re-run Step 4 and confirm the `supported:false` test goes red. Restore and confirm 4/4. Record both outcomes.

- [ ] **Step 6: Run both queries by hand against ClickHouse**

**This step is not optional and cannot be replaced by the mocked tests.** No automated test executes this SQL, so a query that is syntactically valid but semantically wrong would pass everything above.

CLAUDE.md documents that host-to-ClickHouse traffic is rejected by the container's IP allow-list (`IP_ADDRESS_NOT_ALLOWED`, reported to clients as "password is incorrect"). Bridge into the compose network first:

```bash
docker run -d --rm --name ch-devfwd --network rovenue_default -p 8125:8125 \
  alpine/socat tcp-listen:8125,fork,reuseaddr tcp-connect:clickhouse:8123
```

Run each of the three queries (paywall viewers, daily actives, paywall purchasers) against `http://localhost:8125` as the `rovenue` user, substituting a real `projectId` and a date range. Then:

```bash
docker rm -f ch-devfwd
```

Record in your report, for each query: the exact SQL you ran, whether it executed without error, and the rows it returned (including "zero rows" — an empty dev database still proves the SQL parses and the columns exist). If a query errors, that is a real defect: fix it and re-run.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/metrics/charts.ts \
        apps/api/src/services/metrics/charts.paywall.test.ts
git commit -m "feat(api): paywall reach and conversion chart readers"
```

---

### Task 3: The series endpoint

**Files:**
- Modify: `apps/api/src/routes/dashboard/charts.ts`
- Test: `apps/api/tests/charts-series.test.ts` (create)

**Interfaces:**
- Consumes: `readChartSeries(projectId, chartId, windowDays)` from Task 2.
- Produces: `GET /dashboard/projects/:projectId/charts/series/:chartId?windowDays=N` returning `{ data: ChartSeriesResponse }`.

**Background the implementer needs:**

The route file already has three read-only chart endpoints (`/channels`, `/funnel`, `/heatmap`, around lines 345-375) that share an identical shape: pull `projectId` from the path, 400 if missing, read the user from context, `assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT)`, take the validated `windowDays`, and return `c.json(ok(await reader(...)))`. Follow that shape exactly — do not invent a new one.

`windowQuerySchema` already exists at line 50 and coerces/bounds `windowDays`. Reuse it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/charts-series.test.ts`. Read a sibling in `apps/api/tests/` first and follow its app-construction and auth-mocking idiom — that directory has an established harness, and inventing a second one is a defect.

Assertions the test must make:

```ts
  it("returns the series for a supported chart id", async () => {
    // ... issue GET .../charts/series/paywall_view_rate?windowDays=7
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.chartId).toBe("paywall_view_rate");
    expect(body.data.supported).toBe(true);
    expect(body.data.unit).toBe("percent");
    expect(Array.isArray(body.data.points)).toBe(true);
  });

  it("returns 200 with supported:false for a catalog id that has no reader", async () => {
    // ... issue GET .../charts/series/churn?windowDays=7
    // An unwired chart is a normal product state, not an error — the
    // client renders an empty state rather than a failure.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.supported).toBe(false);
    expect(body.data.points).toEqual([]);
  });

  it("returns 200 with supported:false for an id that is not in the catalog at all", async () => {
    // ... issue GET .../charts/series/not_a_chart?windowDays=7
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.supported).toBe(false);
  });

  it("rejects a caller without project access", async () => {
    // ... assertProjectAccess mock rejects
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run tests/charts-series.test.ts
```

Expected: FAIL — the route does not exist, so the supported-id case 404s.

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/dashboard/charts.ts`, add immediately after the `/heatmap` handler (which ends around line 375), before the saved-views section:

```ts
  .get(
    "/series/:chartId",
    validate("query", windowQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const chartId = c.req.param("chartId");
      if (!chartId) {
        throw new HTTPException(400, { message: "Missing chartId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { windowDays } = c.req.valid("query");
      return c.json(ok(await readChartSeries(projectId, chartId, windowDays)));
    },
  )
```

Add `readChartSeries` to the existing import from `../../services/metrics/charts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run tests/charts-series.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Confirm route ordering did not break a sibling**

`/series/:chartId` introduces a path parameter into a router whose other routes are literals. Run the whole chart route surface to prove nothing was shadowed:

```bash
pnpm --filter @rovenue/api exec vitest run tests/ --reporter=basic 2>&1 | tail -20
```

Report the result. If a pre-existing chart test fails, the cause is your change — report it rather than adjusting the test.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/charts.ts \
        apps/api/tests/charts-series.test.ts
git commit -m "feat(api): GET /charts/series/:chartId"
```

---

### Task 4: Dashboard panel dispatch

**Files:**
- Create: `apps/dashboard/src/components/charts/series-chart-panel.tsx`
- Create: `apps/dashboard/src/lib/hooks/useChartSeries.ts`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/charts.tsx:177`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Modify: `apps/dashboard/src/components/charts/index.ts` (barrel, if one exists)
- Test: `apps/dashboard/src/components/charts/series-chart-panel.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /dashboard/projects/:projectId/charts/series/:chartId?windowDays=N` → `{ data: ChartSeriesResponse }` from Task 3.
- Produces: `<SeriesChartPanel projectId chartId chartType range />`.

**Background the implementer needs:**

`charts.tsx:177` currently renders `<MrrChartPanel>` unconditionally, so selecting "Churn" from the catalog shows MRR data under a "Churn" heading. Removing that misreporting is the point of this task.

`MrrChartPanel` must be left **untouched**. It owns bespoke split-request window logic (`mrr-chart-panel.tsx:129-133`) added to fix a real "Couldn't load MRR" bug on wide ranges; folding it into the generic panel would risk regressing that for no gain.

Read a sibling panel in `apps/dashboard/src/components/charts/` before writing the new one, and follow its data-fetching, loading, and error conventions. Use the typed RPC client the other hooks in `apps/dashboard/src/lib/hooks/` use — do not reach for an untyped `api()` shim.

`RANGE_MONTHS` in `mrr-chart-panel.tsx` maps the range option to months; convert the selected range to `windowDays` for the query using the same source of truth rather than a second hardcoded table.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/charts/series-chart-panel.test.tsx`. Read a sibling component test in this directory first and follow its render harness (query client provider, i18n setup).

```tsx
  it("renders the empty state when the chart has no reader", async () => {
    // mock the hook to resolve { supported: false, points: [] }
    // The whole point of `supported`: an unwired chart must show an
    // honest empty state, never another chart's data.
    expect(await screen.findByText(/no data for this chart yet/i)).toBeTruthy();
  });

  it("renders points when the chart is supported", async () => {
    // mock the hook to resolve supported:true with two points
    expect(screen.queryByText(/no data for this chart yet/i)).toBeNull();
  });

  it("renders a gap, not a zero, for a null-valued day", async () => {
    // mock a points array containing { bucket, value: null, numerator: 0,
    // denominator: 0 }. Assert the rendered series does not plot 0 for
    // that day — a day with no traffic is undefined, not a collapse.
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/charts/series-chart-panel.test.tsx
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Add the i18n strings**

In `apps/dashboard/src/i18n/locales/en.json`, add under the existing `charts` object (the `charts.items.*` labels for both paywall charts already exist — do not duplicate them):

```json
"series": {
  "emptyTitle": "No data for this chart yet",
  "emptyBody": "This chart isn't wired to a data source. Pick another chart from the library.",
  "loadError": "Couldn't load this chart"
}
```

- [ ] **Step 4: Implement the hook and the panel**

Create `apps/dashboard/src/lib/hooks/useChartSeries.ts` following the query-key and RPC conventions of its siblings in that directory, and `apps/dashboard/src/components/charts/series-chart-panel.tsx` rendering:

- loading state matching its siblings
- error state using `charts.series.loadError`
- `supported === false` → the empty state using `charts.series.emptyTitle` / `emptyBody`
- otherwise the points, with `value: null` rendered as a gap in the line, never as `0`

Export it from the charts barrel if one exists.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/charts/series-chart-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Wire the dispatch**

In `apps/dashboard/src/routes/_authed/projects/$projectId/charts.tsx`, replace the unconditional `<MrrChartPanel .../>` at line 177 with:

```tsx
          {chartId === "mrr" ? (
            <MrrChartPanel
              projectId={projectId}
              chartType={chartType}
              compare={compare}
              range={range}
            />
          ) : (
            <SeriesChartPanel
              projectId={projectId}
              chartId={chartId}
              chartType={chartType}
              range={range}
            />
          )}
```

- [ ] **Step 7: Mutation-check the dispatch**

Change the condition to `chartId !== ""` so every id renders `MrrChartPanel` again — the old broken behaviour. Re-run the component test and the charts page test if one exists; confirm the empty-state test goes red. Restore and confirm green. Record both outcomes.

- [ ] **Step 8: Typecheck and build**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm build --filter @rovenue/dashboard
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/components/charts/series-chart-panel.tsx \
        apps/dashboard/src/components/charts/series-chart-panel.test.tsx \
        apps/dashboard/src/lib/hooks/useChartSeries.ts \
        apps/dashboard/src/routes/_authed/projects/\$projectId/charts.tsx \
        apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): render the selected chart's own series, not MRR"
```

Add the charts barrel file to the `git add` list if you modified it.

---

### Task 5: Whole-change verification

**Files:** none modified — this task produces a report.

- [ ] **Step 1: Run every changed-area suite on a quiet machine**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/metrics/ tests/charts-series.test.ts
pnpm --filter @rovenue/dashboard exec vitest run src/components/charts/
```

Record pass/fail counts per suite verbatim. Do not summarise a red run as green.

- [ ] **Step 2: Typecheck and build all three packages**

```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm build --filter @rovenue/dashboard
```

- [ ] **Step 3: Confirm the misreporting is actually gone**

The sub-project exists because selecting a non-MRR chart rendered MRR data. Verify the fix at the seam, not just in unit tests: confirm from the code that no path renders `MrrChartPanel` for a non-`mrr` `chartId`, and state how you confirmed it.

- [ ] **Step 4: Append the ledger entry**

Append a section to `.superpowers/sdd/progress.md` recording: the commits, each task's mutation-check outcome, the hand-run ClickHouse query results from Task 2 Step 6, and any residual left open. Follow the formatting of the existing sections. Re-read the file immediately before appending — another process may have written to it.

- [ ] **Step 5: Commit the ledger**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(sp2): record SP2 verification results"
```

---

## Notes for the reviewer

- Task 1's `buildRatePoints` exists specifically so the rate arithmetic is provable without ClickHouse. A reviewer should reject any implementation that moves the zero-denominator rule back into SQL, where no test can reach it.
- `value: null` and `value: 0` mean different things. Reject any code or test that conflates them.
- Task 2 Step 6 (hand-running the SQL) is the only check on query correctness in this whole plan. A task report that omits the actual query output is incomplete.
- `MrrChartPanel` must not be FUNCTIONALLY modified — its bespoke split-request window logic fixed a real "Couldn't load MRR" bug and must stay byte-identical. Amended after the fact: a later fix round added the `export` keyword to its `RANGE_MONTHS` declaration so the duplicate in `series-chart-panel.tsx` could be deleted. That is permitted; the original wording ("reject a diff that touches it") was too broad and would have forced two copies of the same mapping to drift apart.
- Every task carries a mutation-check step. A report that omits the mutation-check outcome is incomplete regardless of how many tests pass.
