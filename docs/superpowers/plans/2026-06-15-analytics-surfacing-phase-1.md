# Analytics Surfacing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface refund/net revenue on the MRR series, and add a revenue-summary endpoint exposing ARPPU + lifetime-value (avg/median/p90) — the KPIs that are computed in ClickHouse today but invisible in the dashboard.

**Architecture:** Pure surfacing. Extend the existing `/metrics/mrr` read path (service → route → shared type) with two already-computed `v_mrr_daily` columns, and add a new `/metrics/summary` read endpoint backed by a new `summary.ts` service that window-aggregates `raw_revenue_events` (paying subs + revenue) and aggregates `v_revenue_lifetime_subscriber` (LTV). The dashboard renders net/refund lines on the MRR panel and a new revenue-KPIs card. No new ingestion, no Postgres writes, no migrations.

**Tech Stack:** Hono + Zod + `@hono/zod-validator` (API), ClickHouse via `queryAnalytics<T>` (`apps/api/src/lib/clickhouse.ts`), `{ data: T }` envelope via `ok()` (`apps/api/src/lib/response.ts`), React + `@tanstack/react-query` + Hono RPC client (`rpc`/`unwrap` from `apps/dashboard/src/lib/api.ts`), Vitest (`apps/api/tests/`).

**Scope decisions (locked):**
- ARPU (net ÷ active-subscriber base) is **deferred to Phase 2** — it needs a Postgres active-base count and a definitional decision (point-in-time vs window-avg). Phase 1 ships **ARPPU** (net ÷ paying subs in window), which is pure-CH and unambiguous.
- Money math follows the existing `overview.ts` convention: parse CH decimal-strings with `Number()`, aggregate, emit with `.toFixed(4)` as decimal-strings. Never emit raw JS floats for currency fields.

---

## File Structure

**Backend (`apps/api`)**
- Modify `src/services/metrics/mrr.ts` — add `refundsUsd`/`netUsd` to `MrrPoint` + SELECT + mapping.
- Create `src/services/metrics/summary.ts` — `getRevenueSummary(input)`.
- Modify `src/routes/dashboard/metrics.ts` — extend `/mrr` response, add `.get("/summary", …)`.
- Modify `apps/api/tests/dashboard-metrics.test.ts` — assert new `/mrr` fields.
- Create `apps/api/tests/dashboard-metrics-summary.test.ts` — `/summary` route tests.

**Shared (`packages/shared`)**
- Modify `src/dashboard.ts` — add `refundsUsd`/`netUsd` to `MrrSeriesPoint`; add `RevenueSummaryResponse`.

**Frontend (`apps/dashboard`)**
- Create `src/lib/hooks/useProjectRevenueSummary.ts` — react-query hook.
- Create `src/components/charts/revenue-kpis-card.tsx` — KPI card row.
- Modify `src/components/charts/mrr-chart-panel.tsx` — plot net + refund series.

---

## Task 1: Add refund/net to the MRR series (shared type)

**Files:**
- Modify: `packages/shared/src/dashboard.ts:524-529`

- [ ] **Step 1: Extend `MrrSeriesPoint`**

In `packages/shared/src/dashboard.ts`, replace the `MrrSeriesPoint` interface:

```ts
export interface MrrSeriesPoint {
  bucket: string; // ISO timestamp at start-of-day UTC
  grossUsd: string; // decimal-as-string for precision
  refundsUsd: string; // decimal-as-string; refunds + chargebacks for the day
  netUsd: string; // decimal-as-string; grossUsd - refundsUsd
  eventCount: number;
  activeSubscribers: number;
}
```

- [ ] **Step 2: Typecheck the shared package**

Run: `pnpm --filter @rovenue/shared build`
Expected: PASS (no type errors). This intentionally breaks nothing yet — the new fields are additive.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add refundsUsd/netUsd to MrrSeriesPoint"
```

---

## Task 2: Surface refund/net in the MRR service

**Files:**
- Modify: `apps/api/src/services/metrics/mrr.ts`
- Test: `apps/api/tests/mrr-clickhouse-only.integration.test.ts` (existing integration suite — extend assertions only)

- [ ] **Step 1: Extend `MrrPoint` and `ChMrrRow`**

In `apps/api/src/services/metrics/mrr.ts`, update both interfaces:

```ts
export interface MrrPoint {
  bucket: Date;
  /** Decimal string to preserve precision across the wire. */
  grossUsd: string;
  /** Decimal string; refunds + chargebacks within the day. */
  refundsUsd: string;
  /** Decimal string; grossUsd - refundsUsd. */
  netUsd: string;
  eventCount: number;
  activeSubscribers: number;
}

interface ChMrrRow {
  bucket: string;
  gross_usd: string;
  refunds_usd: string;
  net_usd: string;
  event_count: string;
  active_subscribers: string;
}
```

- [ ] **Step 2: Add the two columns to the SELECT**

Replace the `sql` template in `listDailyMrr`:

```ts
  const sql = `
    SELECT
      toStartOfDay(day)               AS bucket,
      toString(gross_usd)             AS gross_usd,
      toString(refunds_usd)           AS refunds_usd,
      toString(net_usd)               AS net_usd,
      toUInt64(event_count)           AS event_count,
      toUInt64(active_subscribers)    AS active_subscribers
    FROM rovenue.v_mrr_daily
    WHERE projectId = {projectId:String}
      AND day >= {from:Date}
      AND day <= {to:Date}
    ORDER BY day ASC
  `;
```

- [ ] **Step 3: Map the new fields**

Replace the `rows.map(...)` return:

```ts
  return rows.map((r) => ({
    // CH serialises DateTime as 'YYYY-MM-DD HH:mm:ss' with no timezone
    // suffix; V8 would parse this as local time. Force UTC so callers
    // get the same instant regardless of host timezone.
    bucket: new Date(r.bucket.replace(" ", "T") + "Z"),
    grossUsd: r.gross_usd,
    refundsUsd: r.refunds_usd,
    netUsd: r.net_usd,
    eventCount: Number(r.event_count),
    activeSubscribers: Number(r.active_subscribers),
  }));
```

- [ ] **Step 4: Typecheck the API package**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS. (`refunds_usd`/`net_usd` are real columns in `v_mrr_daily` per migration `0012_idempotent_revenue_aggregates.sql`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/mrr.ts
git commit -m "feat(api): surface refundsUsd/netUsd in listDailyMrr"
```

---

## Task 3: Return refund/net from the `/metrics/mrr` route

**Files:**
- Modify: `apps/api/src/routes/dashboard/metrics.ts:87-92`
- Test: `apps/api/tests/dashboard-metrics.test.ts:36-44, 98-105, 149-154`

- [ ] **Step 1: Update the route's point mapping**

In `apps/api/src/routes/dashboard/metrics.ts`, replace the `points: points.map(...)` block inside the `/mrr` handler:

```ts
        points: points.map((p) => ({
          bucket: p.bucket.toISOString(),
          grossUsd: p.grossUsd,
          refundsUsd: p.refundsUsd,
          netUsd: p.netUsd,
          eventCount: p.eventCount,
          activeSubscribers: p.activeSubscribers,
        })),
```

- [ ] **Step 2: Update the service mock in the existing test**

In `apps/api/tests/dashboard-metrics.test.ts`, the `mrrMock.listDailyMrr` resolved value appears twice (the `vi.hoisted` block ~line 36 and the `beforeEach` ~line 98). Update **both** to include the new fields:

```ts
      {
        bucket: new Date("2026-04-01T00:00:00Z"),
        grossUsd: "99.90",
        refundsUsd: "9.99",
        netUsd: "89.91",
        eventCount: 10,
        activeSubscribers: 8,
      },
```

- [ ] **Step 3: Strengthen the default-window assertion**

In the `returns points for the default 30-day window` test, extend the `toMatchObject` (~line 149):

```ts
    expect(body.data.points[0]).toMatchObject({
      bucket: "2026-04-01T00:00:00.000Z",
      grossUsd: "99.90",
      refundsUsd: "9.99",
      netUsd: "89.91",
      eventCount: 10,
      activeSubscribers: 8,
    });
```

- [ ] **Step 4: Run the MRR route tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics.test.ts`
Expected: PASS (6 tests). If the `toMatchObject` fails, the route mapping (Step 1) is wrong.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/metrics.ts apps/api/tests/dashboard-metrics.test.ts
git commit -m "feat(api): return refundsUsd/netUsd from GET /metrics/mrr"
```

---

## Task 4: Revenue-summary shared type

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (add after `MrrSeriesResponse`, ~line 535)

- [ ] **Step 1: Add `RevenueSummaryResponse`**

```ts
// =============================================================
// Revenue summary — window KPIs (analytics surfacing Phase 1)
// =============================================================
//
// Pure-ClickHouse window aggregate. ARPU (net ÷ active base) is
// intentionally absent — it lands in Phase 2 with the active-base
// source decision. All monetary fields are decimal-as-string.

export interface RevenueSummaryResponse {
  from: string;
  to: string;
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  /** refundsUsd / grossUsd in [0,1]; null when grossUsd is 0. */
  refundRate: number | null;
  /** Distinct subscribers with a non-refund revenue event in the window. */
  payingSubscribers: number;
  /** netUsd / payingSubscribers; null when payingSubscribers is 0. */
  arppu: string | null;
  /** Lifetime net (purchased - refunded) per subscriber, in USD. */
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
  /** Subscribers contributing to the LTV aggregate. */
  ltvSubscribers: number;
}
```

- [ ] **Step 2: Typecheck the shared package**

Run: `pnpm --filter @rovenue/shared build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add RevenueSummaryResponse type"
```

---

## Task 5: Revenue-summary service

**Files:**
- Create: `apps/api/src/services/metrics/summary.ts`

- [ ] **Step 1: Write the service**

Create `apps/api/src/services/metrics/summary.ts`:

```ts
import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// Revenue summary read service — ClickHouse exclusive
// =============================================================
//
// Two CH reads, run in parallel:
//   1. raw_revenue_events window aggregate → gross, refunds,
//      distinct paying subscribers (for ARPPU).
//   2. v_revenue_lifetime_subscriber aggregate → avg/median/p90
//      lifetime net per subscriber (LTV distribution summary).
//
// Money is parsed from CH decimal-strings with Number(), summed,
// and re-emitted via toFixed(4) — same convention as overview.ts.

export interface GetRevenueSummaryInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface RevenueSummary {
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  refundRate: number | null;
  payingSubscribers: number;
  arppu: string | null;
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
  ltvSubscribers: number;
}

interface ChWindowRow {
  gross_usd: string;
  refunds_usd: string;
  paying_subs: string;
}

interface ChLtvRow {
  avg_usd: string;
  median_usd: string;
  p90_usd: string;
  subscribers: string;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getRevenueSummary(
  input: GetRevenueSummaryInput,
): Promise<RevenueSummary> {
  const params = {
    from: toDateOnly(input.from),
    to: toDateOnly(input.to),
  };

  const [windowRows, ltvRows] = await Promise.all([
    queryAnalytics<ChWindowRow>(
      input.projectId,
      `
        SELECT
          toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))          AS gross_usd,
          toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))              AS refunds_usd,
          toString(uniqExactIf(subscriberId, type NOT IN ('REFUND','CHARGEBACK'))) AS paying_subs
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {from:Date}
          AND toDate(eventDate) <= {to:Date}
      `,
      params,
    ),
    queryAnalytics<ChLtvRow>(
      input.projectId,
      `
        SELECT
          toString(round(avg(net_cents) / 100, 4))                 AS avg_usd,
          toString(round(quantileExact(0.5)(net_cents) / 100, 4))  AS median_usd,
          toString(round(quantileExact(0.9)(net_cents) / 100, 4))  AS p90_usd,
          toString(count())                                        AS subscribers
        FROM (
          SELECT
            toInt64(lifetime_dollars_purchased_cents)
              - toInt64(lifetime_dollars_refunded_cents)           AS net_cents
          FROM rovenue.v_revenue_lifetime_subscriber
          WHERE projectId = {projectId:String}
        )
      `,
      params,
    ),
  ]);

  const w = windowRows[0] ?? {
    gross_usd: "0",
    refunds_usd: "0",
    paying_subs: "0",
  };
  const l = ltvRows[0] ?? {
    avg_usd: "0",
    median_usd: "0",
    p90_usd: "0",
    subscribers: "0",
  };

  const gross = Number(w.gross_usd);
  const refunds = Number(w.refunds_usd);
  const net = gross - refunds;
  const payingSubscribers = Number(w.paying_subs);

  const refundRate = gross > 0 ? refunds / gross : null;
  const arppu =
    payingSubscribers > 0 ? (net / payingSubscribers).toFixed(4) : null;

  return {
    grossUsd: gross.toFixed(4),
    refundsUsd: refunds.toFixed(4),
    netUsd: net.toFixed(4),
    refundRate,
    payingSubscribers,
    arppu,
    avgLtvUsd: l.avg_usd,
    medianLtvUsd: l.median_usd,
    p90LtvUsd: l.p90_usd,
    ltvSubscribers: Number(l.subscribers),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/metrics/summary.ts
git commit -m "feat(api): add getRevenueSummary service (ARPPU + LTV)"
```

---

## Task 6: `/metrics/summary` route

**Files:**
- Modify: `apps/api/src/routes/dashboard/metrics.ts`

- [ ] **Step 1: Import the service**

At the top of `apps/api/src/routes/dashboard/metrics.ts`, add to the existing imports:

```ts
import { getRevenueSummary } from "../../services/metrics/summary";
```

- [ ] **Step 2: Add the route**

Chain a `.get("/summary", …)` after the existing `.get("/mrr", …)` handler (before the closing `;`). It reuses `mrrQuerySchema` for an identical window contract:

```ts
  // =============================================================
  // GET /dashboard/projects/:projectId/metrics/summary
  // =============================================================
  //
  // Window KPIs: gross/refunds/net revenue, refund rate, paying
  // subscribers + ARPPU, and lifetime-value (avg/median/p90).
  // Pure ClickHouse. ARPU (net ÷ active base) lands in Phase 2.
  .get("/summary", zValidator("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const { from, to } = c.req.valid("query");
    const summary = await getRevenueSummary({ projectId, from, to });

    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        ...summary,
      }),
    );
  });
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/metrics.ts
git commit -m "feat(api): add GET /metrics/summary route"
```

---

## Task 7: `/metrics/summary` route tests

**Files:**
- Create: `apps/api/tests/dashboard-metrics-summary.test.ts`

- [ ] **Step 1: Write the test file**

Mirror the auth/access mocking style of `dashboard-metrics.test.ts`, mocking the summary service. Create `apps/api/tests/dashboard-metrics-summary.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn(() => null),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

const { summaryMock } = vi.hoisted(() => ({
  summaryMock: {
    getRevenueSummary: vi.fn(async () => ({
      grossUsd: "1000.0000",
      refundsUsd: "100.0000",
      netUsd: "900.0000",
      refundRate: 0.1,
      payingSubscribers: 9,
      arppu: "100.0000",
      avgLtvUsd: "42.5000",
      medianLtvUsd: "30.0000",
      p90LtvUsd: "120.0000",
      ltvSubscribers: 50,
    })),
  },
}));

const { drizzleMock, authMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>): Promise<T> => primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { drizzleMock, authMock };
});

const { dbMock } = vi.hoisted(() => ({
  dbMock: { projectMember: { findUnique: vi.fn() } },
}));

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, default: dbMock, drizzle: drizzleMock };
});
vi.mock("../src/services/metrics/summary", () => summaryMock);
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

const authedHeaders = { cookie: "session=test" };

function signedIn(userId = "u_1"): void {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /dashboard/projects/:projectId/metrics/summary", () => {
  test("401 without a session", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/metrics/summary", {
      headers: authedHeaders,
    });
    expect(res.status).toBe(401);
  });

  test("403 when caller is not a project member", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/metrics/summary", {
      headers: authedHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("returns the summary payload for the default window", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "VIEWER" });
    const res = await app.request("/dashboard/projects/proj_1/metrics/summary", {
      headers: authedHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      grossUsd: "1000.0000",
      netUsd: "900.0000",
      refundRate: 0.1,
      payingSubscribers: 9,
      arppu: "100.0000",
      avgLtvUsd: "42.5000",
      p90LtvUsd: "120.0000",
    });
    expect(typeof body.data.from).toBe("string");
    expect(typeof body.data.to).toBe("string");
  });

  test("passes explicit from/to to the service", async () => {
    signedIn();
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "VIEWER" });
    await app.request(
      "/dashboard/projects/proj_1/metrics/summary?from=2026-03-01T00:00:00Z&to=2026-03-15T00:00:00Z",
      { headers: authedHeaders },
    );
    const call = summaryMock.getRevenueSummary.mock.calls[0]![0];
    expect(call.projectId).toBe("proj_1");
    expect(call.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(call.to.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-summary.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/dashboard-metrics-summary.test.ts
git commit -m "test(api): cover GET /metrics/summary"
```

---

## Task 8: Dashboard hook for the summary

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useProjectRevenueSummary.ts`

- [ ] **Step 1: Write the hook**

Mirror `useProjectMrr.ts` (same `rpc`/`unwrap` pattern). Create `apps/dashboard/src/lib/hooks/useProjectRevenueSummary.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { RevenueSummaryResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  /** Optional ISO-8601 window override. Defaults to last 30 days on the API. */
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectRevenueSummary({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "summary", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<RevenueSummaryResponse>(
        rpc.dashboard.projects[":projectId"].metrics.summary.$get({
          param: { projectId },
          query: {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        }),
      ),
  });
}
```

- [ ] **Step 2: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS. (If `rpc.dashboard.projects[...].metrics.summary` is not typed, the API route from Task 6 was not exported into the app type — re-check the route chains onto `metricsRoute`.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectRevenueSummary.ts
git commit -m "feat(dashboard): add useProjectRevenueSummary hook"
```

---

## Task 9: Revenue-KPIs card

**Files:**
- Create: `apps/dashboard/src/components/charts/revenue-kpis-card.tsx`

- [ ] **Step 1: Write the card**

Uses the project's existing styling tokens (`rv-c1`, `rv-divider`, `font-rv-mono`) and `formatCurrencyCompact` from `./format`. Create `apps/dashboard/src/components/charts/revenue-kpis-card.tsx`:

```tsx
import { useProjectRevenueSummary } from "../../lib/hooks/useProjectRevenueSummary";
import { formatCurrencyCompact } from "./format";

type Props = {
  projectId: string;
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-1 font-rv-mono text-[18px] font-medium tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function RevenueKpisCard({ projectId }: Props) {
  const { data, isLoading } = useProjectRevenueSummary({ projectId });

  const dash = "—";
  const money = (v?: string | null) =>
    isLoading || v == null ? dash : formatCurrencyCompact(Number(v));
  const pct = (v?: number | null) =>
    isLoading || v == null ? dash : `${(v * 100).toFixed(1)}%`;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        Revenue (last 30 days)
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Net revenue" value={money(data?.netUsd)} />
        <Kpi label="Refunds" value={money(data?.refundsUsd)} />
        <Kpi label="Refund rate" value={pct(data?.refundRate)} />
        <Kpi label="ARPPU" value={money(data?.arppu)} />
        <Kpi label="Avg LTV" value={money(data?.avgLtvUsd)} />
        <Kpi label="Median LTV" value={money(data?.medianLtvUsd)} />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Export from the charts barrel**

In `apps/dashboard/src/components/charts/index.ts`, add:

```ts
export { RevenueKpisCard } from "./revenue-kpis-card";
```

- [ ] **Step 3: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Render the card on the project page**

In `apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx`, import and render `<RevenueKpisCard projectId={projectId} />` above the existing MRR panel. (Use the `projectId` already resolved in that route; match the surrounding layout wrapper.)

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/charts/revenue-kpis-card.tsx apps/dashboard/src/components/charts/index.ts apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx
git commit -m "feat(dashboard): add revenue KPIs card (net/refunds/ARPPU/LTV)"
```

---

## Task 10: Plot net + refund on the MRR panel

The panel currently rolls only `grossUsd` into monthly totals. Extend the rollup to carry net and refunds, and draw a net line + refund line alongside gross.

**Files:**
- Modify: `apps/dashboard/src/components/charts/mrr-chart-panel.tsx`

- [ ] **Step 1: Widen the monthly bucket**

Replace the `MonthlyBucket` interface and `rollupToMonths` so each bucket carries `gross`, `net`, `refunds`:

```ts
interface MonthlyBucket {
  /** Year-month key, e.g. `2026-03`. */
  ym: string;
  /** Numeric month index 0..11 for the label. */
  month: number;
  /** Sum of grossUsd within the calendar month. */
  total: number;
  /** Sum of netUsd within the calendar month. */
  net: number;
  /** Sum of refundsUsd within the calendar month. */
  refunds: number;
}

function rollupToMonths(
  points: ReadonlyArray<{
    bucket: string;
    grossUsd: string;
    netUsd: string;
    refundsUsd: string;
  }>,
  months: number,
  now: Date,
): MonthlyBucket[] {
  const gross = new Map<string, number>();
  const net = new Map<string, number>();
  const refunds = new Map<string, number>();
  for (const p of points) {
    const key = bucketKey(new Date(p.bucket));
    gross.set(key, (gross.get(key) ?? 0) + Number(p.grossUsd));
    net.set(key, (net.get(key) ?? 0) + Number(p.netUsd));
    refunds.set(key, (refunds.get(key) ?? 0) + Number(p.refundsUsd));
  }
  const out: MonthlyBucket[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = bucketKey(d);
    out.push({
      ym,
      month: d.getUTCMonth(),
      total: gross.get(ym) ?? 0,
      net: net.get(ym) ?? 0,
      refunds: refunds.get(ym) ?? 0,
    });
  }
  return out;
}
```

- [ ] **Step 2: Derive a net series**

After the existing `currentValues` `useMemo` (~line 180), add:

```ts
  const netValues = useMemo(
    () => series.current.map((b) => b.net),
    [series.current],
  );
```

- [ ] **Step 3: Draw the net line**

In the line branch of the SVG (the `else` after `chartType === "bar"`, just before the gross `<path d={pathFor(currentValues)} …>` at ~line 427), add a secondary net path:

```tsx
            <path
              d={pathFor(netValues)}
              fill="none"
              stroke="var(--color-rv-success)"
              strokeWidth="1.75"
              strokeDasharray="5 3"
            />
```

- [ ] **Step 4: Add a legend entry for net**

In the header legend block (~line 269), add after the current-series `Legend`:

```tsx
          <Legend
            color="var(--color-rv-success)"
            label={t("charts.mrr.legendNet", "Net")}
          />
```

- [ ] **Step 5: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS. (`rollupToMonths` now reads `netUsd`/`refundsUsd`, which `useProjectMrr` returns from the extended `MrrSeriesPoint`.)

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/charts/mrr-chart-panel.tsx
git commit -m "feat(dashboard): plot net revenue line on MRR panel"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck the whole monorepo**

Run: `pnpm -r exec tsc --noEmit`
Expected: PASS across shared, api, dashboard.

- [ ] **Step 2: Run the API metrics unit tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics.test.ts tests/dashboard-metrics-summary.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 3: Run the ClickHouse integration suite (requires testcontainers/Docker)**

Run: `pnpm --filter @rovenue/api exec vitest run tests/mrr-clickhouse-only.integration.test.ts`
Expected: PASS. If `v_mrr_daily` lacks `refunds_usd`/`net_usd` at runtime, re-apply CH migrations: `pnpm --filter @rovenue/db db:clickhouse:migrate` (and on poisoned local state, DROP DATABASE + re-migrate per the CH-migrate runbook).

- [ ] **Step 4: Confirm the build**

Run: `pnpm build`
Expected: PASS (all packages).

---

## Self-Review Notes (carried from spec §6/§7)

- **In scope (Phase 1):** refund/net on `/metrics/mrr` + panel; `/metrics/summary` (refund rate, paying subs, ARPPU, avg/median/p90 LTV); revenue KPIs card.
- **Deferred to Phase 2 (do NOT implement here):** ARPU (active-base decision), churn rate (`subscriber_access` EXPIRED source), trial→paid conversion trend, LTV histogram.
- **Currency:** all monetary fields are decimal-as-string; `Number()`→`toFixed(4)` only inside services, never widening to float on the wire.
- **Backward compatibility:** `MrrSeriesPoint` change is additive; existing `/metrics/mrr` consumers keep working.
