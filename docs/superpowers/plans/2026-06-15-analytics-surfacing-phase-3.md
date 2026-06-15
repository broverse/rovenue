# Analytics Surfacing — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface MRR movement decomposition (new/expansion/churned), SDK engagement, and credit consumption volume — filling the last visible "—/zero" placeholders in the dashboard.

**Architecture:** Two new ClickHouse-only read endpoints (`/metrics/mrr-decomposition`, `/metrics/engagement`) following the established `summary.ts`/`ltv.ts` pattern; refactor the existing hardcoded `Decomposition()` panel to consume real data; and a dashboard-only credit volume chart that reuses the already-shipped `/credits/rollup` endpoint (no new backend).

**Tech Stack:** Hono + Zod, ClickHouse via `queryAnalytics<T>`, `{ data: T }` via `ok()`, React + react-query, Vitest.

**Design decisions (locked, post-investigation):**
- **Credits = dashboard-only.** `/credits/rollup` already returns `volume: CreditsVolumePoint[]` (`{ day, issued, burned, net }` numbers) and a `useProjectCredits` hook already consumes it. Phase 3 only adds a chart component — no backend, no new hook.
- **MRR movement $ excludes CANCELLATION.** `CANCELLATION.amountUsd` semantics are unverified (likely zero — cancellation doesn't move recognized revenue). So the $ decomposition uses only money-moving events: **new = INITIAL+TRIAL_CONVERSION**, **expansion = REACTIVATION**, **churned = REFUND+CHARGEBACK** (actual money out). **Contraction is not computed** (no plan-change/downgrade events exist) — the UI cell shows "—". Count-based cancellation churn is already covered by Phase 2's `purchases`-sourced churn rate.
- **Engagement** reads `rovenue.sdk_sessions_daily_tbl` (SummingMergeTree keyed by projectId+subscriberId+day), aggregated to project/day with `sum()` + `uniqExact(subscriberId)`.
- **Deferred (Phase 4, if ever):** per-bucket trial-conversion *trend* (PG+CH bucket-merge), reactivation *rate* (we already surface reactivation $ here).

---

## File Structure

**Backend (`apps/api`)**
- Create `src/services/metrics/mrr-decomposition.ts` — `getMrrDecomposition(input)`.
- Create `src/services/metrics/engagement.ts` — `listEngagement(input)`.
- Modify `src/routes/dashboard/metrics.ts` — add `.get("/mrr-decomposition", …)` + `.get("/engagement", …)`.
- Create `apps/api/tests/dashboard-metrics-movements.test.ts`, `apps/api/tests/dashboard-metrics-engagement.test.ts`.

**Shared (`packages/shared`)**
- Modify `src/dashboard.ts` — add `MrrDecompositionResponse`, `EngagementResponse`.

**Frontend (`apps/dashboard`)**
- Create `src/lib/hooks/useProjectMrrDecomposition.ts`, `src/lib/hooks/useProjectEngagement.ts`.
- Modify `src/components/charts/mrr-chart-panel.tsx` — refactor `Decomposition()` to accept props + wire the hook.
- Create `src/components/charts/engagement-card.tsx`, `src/components/charts/credit-volume-card.tsx`.
- Modify `src/components/charts/index.ts` + the project / credits pages.

---

## Task 1: Shared types

**Files:** Modify `packages/shared/src/dashboard.ts`

- [ ] **Step 1: Add both interfaces** (after `LtvDistributionResponse`)

```ts
// =============================================================
// MRR movement decomposition (Phase 3)
// =============================================================
//
// Money-moving events only. Contraction is intentionally absent —
// no plan-change/downgrade events exist; the UI shows it as "—".

export interface MrrDecompositionResponse {
  from: string;
  to: string;
  /** INITIAL + TRIAL_CONVERSION, decimal-as-string USD. */
  newUsd: string;
  /** REACTIVATION, decimal-as-string USD. */
  expansionUsd: string;
  /** REFUND + CHARGEBACK (money out), positive magnitude, decimal-as-string USD. */
  churnedUsd: string;
}

// =============================================================
// SDK engagement — daily sessions (Phase 3)
// =============================================================

export interface EngagementPoint {
  bucket: string; // ISO start-of-day UTC
  sessionCount: number;
  avgSessionMs: number;
  activeSubscribers: number;
}

export interface EngagementResponse {
  from: string;
  to: string;
  points: EngagementPoint[];
}
```

- [ ] **Step 2:** Run `pnpm --filter @rovenue/shared build` → PASS
- [ ] **Step 3:** Commit

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add MrrDecomposition + Engagement response types"
```

---

## Task 2: MRR decomposition service

**Files:** Create `apps/api/src/services/metrics/mrr-decomposition.ts`

- [ ] **Step 1: Write the service**

```ts
import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// MRR movement decomposition — ClickHouse exclusive
// =============================================================
//
// Money-moving events over the window:
//   new       = INITIAL + TRIAL_CONVERSION
//   expansion = REACTIVATION
//   churned   = REFUND + CHARGEBACK (money out, positive magnitude)
//
// CANCELLATION is excluded — its amountUsd does not represent a
// revenue movement. Contraction is not computed (no downgrade
// events). RENEWAL is steady-state, not a movement.

export interface GetMrrDecompositionInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface MrrDecomposition {
  newUsd: string;
  expansionUsd: string;
  churnedUsd: string;
}

interface ChDecompRow {
  new_usd: string;
  expansion_usd: string;
  churned_usd: string;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getMrrDecomposition(
  input: GetMrrDecompositionInput,
): Promise<MrrDecomposition> {
  const rows = await queryAnalytics<ChDecompRow>(
    input.projectId,
    `
      SELECT
        toString(sumIf(amountUsd, type IN ('INITIAL','TRIAL_CONVERSION'))) AS new_usd,
        toString(sumIf(amountUsd, type = 'REACTIVATION'))                  AS expansion_usd,
        toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))        AS churned_usd
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
    `,
    { from: toDateOnly(input.from), to: toDateOnly(input.to) },
  );

  const r = rows[0] ?? { new_usd: "0", expansion_usd: "0", churned_usd: "0" };

  // Normalise to 4dp decimal strings (CH may emit "0" / scientific).
  const fix = (v: string): string => Number(v).toFixed(4);
  return {
    newUsd: fix(r.new_usd),
    expansionUsd: fix(r.expansion_usd),
    churnedUsd: fix(r.churned_usd),
  };
}
```

- [ ] **Step 2:** Run `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 3:** Commit

```bash
git add apps/api/src/services/metrics/mrr-decomposition.ts
git commit -m "feat(api): add getMrrDecomposition service"
```

---

## Task 3: Engagement service

**Files:** Create `apps/api/src/services/metrics/engagement.ts`

- [ ] **Step 1: Write the service**

```ts
import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// SDK engagement read service — ClickHouse exclusive
// =============================================================
//
// sdk_sessions_daily_tbl is a SummingMergeTree keyed by
// (projectId, subscriberId, day); aggregate to project/day with
// sum() + uniqExact(subscriberId). avgSessionMs is derived per
// bucket (session_ms / session_count).

export interface ListEngagementInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface EngagementPoint {
  bucket: Date;
  sessionCount: number;
  avgSessionMs: number;
  activeSubscribers: number;
}

interface ChEngagementRow {
  bucket: string;
  session_count: string;
  session_ms: string;
  active_subscribers: string;
}

export async function listEngagement(
  input: ListEngagementInput,
): Promise<EngagementPoint[]> {
  const rows = await queryAnalytics<ChEngagementRow>(
    input.projectId,
    `
      SELECT
        toString(day)                      AS bucket,
        toString(sum(session_count))       AS session_count,
        toString(sum(session_ms))          AS session_ms,
        toString(uniqExact(subscriberId))  AS active_subscribers
      FROM rovenue.sdk_sessions_daily_tbl
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day ASC
    `,
    {
      from: input.from.toISOString().slice(0, 10),
      to: input.to.toISOString().slice(0, 10),
    },
  );

  return rows.map((r) => {
    const count = Number(r.session_count);
    const ms = Number(r.session_ms);
    return {
      bucket: new Date(r.bucket + "T00:00:00Z"),
      sessionCount: count,
      avgSessionMs: count > 0 ? Math.round(ms / count) : 0,
      activeSubscribers: Number(r.active_subscribers),
    };
  });
}
```

- [ ] **Step 2:** Run `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 3:** Commit

```bash
git add apps/api/src/services/metrics/engagement.ts
git commit -m "feat(api): add listEngagement service"
```

---

## Task 4: Routes

**Files:** Modify `apps/api/src/routes/dashboard/metrics.ts`

- [ ] **Step 1: Imports**

```ts
import { getMrrDecomposition } from "../../services/metrics/mrr-decomposition";
import { listEngagement } from "../../services/metrics/engagement";
```

- [ ] **Step 2: Add both routes** (chain after `/ltv`, before the final `;`)

```ts
  // GET /dashboard/projects/:projectId/metrics/mrr-decomposition
  .get(
    "/mrr-decomposition",
    zValidator("query", mrrQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(
        projectId,
        user.id,
        MemberRole.CUSTOMER_SUPPORT,
      );
      const { from, to } = c.req.valid("query");
      const d = await getMrrDecomposition({ projectId, from, to });
      return c.json(
        ok({ from: from.toISOString(), to: to.toISOString(), ...d }),
      );
    },
  )
  // GET /dashboard/projects/:projectId/metrics/engagement
  .get("/engagement", zValidator("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const { from, to } = c.req.valid("query");
    const points = await listEngagement({ projectId, from, to });
    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        points: points.map((p) => ({
          bucket: p.bucket.toISOString(),
          sessionCount: p.sessionCount,
          avgSessionMs: p.avgSessionMs,
          activeSubscribers: p.activeSubscribers,
        })),
      }),
    );
  });
```

- [ ] **Step 3:** Run `pnpm --filter @rovenue/api exec tsc --noEmit` → PASS
- [ ] **Step 4:** Commit

```bash
git add apps/api/src/routes/dashboard/metrics.ts
git commit -m "feat(api): add /metrics/mrr-decomposition + /metrics/engagement routes"
```

---

## Task 5: Route tests

**Files:** Create `apps/api/tests/dashboard-metrics-movements.test.ts` and `apps/api/tests/dashboard-metrics-engagement.test.ts`

- [ ] **Step 1: movements test** — mirror `dashboard-metrics-summary.test.ts`'s full scaffold (auditMock, drizzleMock with `schema.notifications` + `notificationRepo`, authMock, dbMock, all vi.mock blocks, signedIn, authedHeaders, beforeEach). Mock `../src/services/metrics/mrr-decomposition`:

```ts
const { decompMock } = vi.hoisted(() => ({
  decompMock: {
    getMrrDecomposition: vi.fn(async () => ({
      newUsd: "500.0000",
      expansionUsd: "50.0000",
      churnedUsd: "30.0000",
    })),
  },
}));
// vi.mock("../src/services/metrics/mrr-decomposition", () => decompMock);
```

Tests against `/dashboard/projects/proj_1/metrics/mrr-decomposition`:
1. "401 without a session" → 401
2. "403 when not a member" → 403
3. "returns decomposition" — VIEWER → 200; `body.data` toMatchObject `{ newUsd: "500.0000", expansionUsd: "50.0000", churnedUsd: "30.0000" }`; `from`/`to` strings.

Run `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-movements.test.ts` → PASS (3). Commit:
```bash
git add apps/api/tests/dashboard-metrics-movements.test.ts
git commit -m "test(api): cover /metrics/mrr-decomposition"
```

- [ ] **Step 2: engagement test** — same scaffold, mock `../src/services/metrics/engagement`:

```ts
const { engagementMock } = vi.hoisted(() => ({
  engagementMock: {
    listEngagement: vi.fn(async () => [
      { bucket: new Date("2026-04-01T00:00:00Z"), sessionCount: 120, avgSessionMs: 45000, activeSubscribers: 30 },
    ]),
  },
}));
// vi.mock("../src/services/metrics/engagement", () => engagementMock);
```

Tests against `/dashboard/projects/proj_1/metrics/engagement`:
1. "401 without a session" → 401
2. "403 when not a member" → 403
3. "returns engagement points" — VIEWER → 200; `body.data.points` length 1, `points[0]` toMatchObject `{ bucket: "2026-04-01T00:00:00.000Z", sessionCount: 120, avgSessionMs: 45000, activeSubscribers: 30 }`.

Run `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics-engagement.test.ts` → PASS (3). Commit:
```bash
git add apps/api/tests/dashboard-metrics-engagement.test.ts
git commit -m "test(api): cover /metrics/engagement"
```

---

## Task 6: Decomposition hook + wire into MRR panel

**Files:**
- Create `apps/dashboard/src/lib/hooks/useProjectMrrDecomposition.ts`
- Modify `apps/dashboard/src/components/charts/mrr-chart-panel.tsx`

- [ ] **Step 1: Hook** (mirror `useProjectMrr.ts`, windowed)

```ts
import { useQuery } from "@tanstack/react-query";
import type { MrrDecompositionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectMrrDecomposition({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "mrr-decomposition", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<MrrDecompositionResponse>(
        rpc.dashboard.projects[":projectId"].metrics["mrr-decomposition"].$get({
          param: { projectId },
          query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        }),
      ),
  });
}
```

- [ ] **Step 2: Refactor `Decomposition()` to accept props**

In `mrr-chart-panel.tsx`, replace the `Decomposition` function with a props-driven version. It keeps the same 4 cells; `contraction` always renders "—" (not computed); `churned` renders with a leading minus:

```tsx
function Decomposition({
  newUsd,
  expansionUsd,
  churnedUsd,
  loading,
}: {
  newUsd?: string;
  expansionUsd?: string;
  churnedUsd?: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const fmt = (v?: string) =>
    loading || v == null ? "—" : formatCurrencyCompact(Number(v));
  const items = [
    { key: "newMrr", labelKey: "charts.decomposition.newMrr", value: fmt(newUsd) },
    { key: "expansion", labelKey: "charts.decomposition.expansion", value: fmt(expansionUsd) },
    { key: "contraction", labelKey: "charts.decomposition.contraction", value: "—" },
    {
      key: "churned",
      labelKey: "charts.decomposition.churned",
      value: loading || churnedUsd == null ? "—" : `−${formatCurrencyCompact(Number(churnedUsd))}`,
    },
  ];

  return (
    <div className="mt-3.5 grid grid-cols-2 gap-3 border-t border-rv-divider pt-3.5 md:grid-cols-4">
      {items.map((item) => (
        <div key={item.key}>
          <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t(item.labelKey)}
          </div>
          <div className="mt-1 font-rv-mono text-[16px] font-medium tabular-nums text-rv-mute-700">
            {item.value}
          </div>
          <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">—</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire the hook in `MrrChartPanel`**

Near the existing `currentQuery` (which already computes `currentFrom`/`currentTo`), add:

```tsx
  const decomposition = useProjectMrrDecomposition({
    projectId,
    from: currentFrom,
    to: currentTo,
  });
```

And replace the `<Decomposition />` render (near the end of the returned JSX) with:

```tsx
      <Decomposition
        newUsd={decomposition.data?.newUsd}
        expansionUsd={decomposition.data?.expansionUsd}
        churnedUsd={decomposition.data?.churnedUsd}
        loading={decomposition.isLoading}
      />
```

Add the import at the top:
```tsx
import { useProjectMrrDecomposition } from "../../lib/hooks/useProjectMrrDecomposition";
```

- [ ] **Step 4:** Run `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 5:** Commit

```bash
git add apps/dashboard/src/lib/hooks/useProjectMrrDecomposition.ts apps/dashboard/src/components/charts/mrr-chart-panel.tsx
git commit -m "feat(dashboard): wire real MRR decomposition into the panel"
```

---

## Task 7: Engagement hook + card

**Files:**
- Create `apps/dashboard/src/lib/hooks/useProjectEngagement.ts`
- Create `apps/dashboard/src/components/charts/engagement-card.tsx`
- Modify `apps/dashboard/src/components/charts/index.ts` + project page

- [ ] **Step 1: Hook** (mirror `useProjectMrr.ts`)

```ts
import { useQuery } from "@tanstack/react-query";
import type { EngagementResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectEngagement({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "engagement", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<EngagementResponse>(
        rpc.dashboard.projects[":projectId"].metrics.engagement.$get({
          param: { projectId },
          query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        }),
      ),
  });
}
```

- [ ] **Step 2: Card** — a compact summary card (total sessions + avg duration in the window; project styling tokens)

```tsx
import { useProjectEngagement } from "../../lib/hooks/useProjectEngagement";

type Props = { projectId: string };

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function EngagementCard({ projectId }: Props) {
  const { data, isLoading } = useProjectEngagement({ projectId });
  const points = data?.points ?? [];
  const totalSessions = points.reduce((a, p) => a + p.sessionCount, 0);
  const weightedMs = points.reduce((a, p) => a + p.avgSessionMs * p.sessionCount, 0);
  const avgMs = totalSessions > 0 ? weightedMs / totalSessions : 0;
  const peakActive = points.reduce((a, p) => Math.max(a, p.activeSubscribers), 0);

  const tile = (label: string, value: string) => (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">{label}</div>
      <div className="mt-1 font-rv-mono text-[18px] font-medium tabular-nums">{value}</div>
    </div>
  );

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        Engagement (last 30 days)
      </div>
      <div className="grid grid-cols-3 gap-4">
        {tile("Sessions", isLoading ? "—" : totalSessions.toLocaleString())}
        {tile("Avg duration", isLoading ? "—" : fmtDuration(avgMs))}
        {tile("Peak DAU", isLoading ? "—" : peakActive.toLocaleString())}
      </div>
    </section>
  );
}
```

- [ ] **Step 3:** Add `export { EngagementCard } from "./engagement-card";` to `charts/index.ts`.
- [ ] **Step 4:** Render `<EngagementCard projectId={projectId} />` on the project page near the other analytics panels (read the file; match layout).
- [ ] **Step 5:** Run `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 6:** Commit

```bash
git add apps/dashboard/src/lib/hooks/useProjectEngagement.ts apps/dashboard/src/components/charts/engagement-card.tsx apps/dashboard/src/components/charts/index.ts apps/dashboard/src/routes/_authed/projects/$projectId/index.tsx
git commit -m "feat(dashboard): add engagement card"
```

---

## Task 8: Credit volume chart (dashboard-only, reuses existing endpoint)

**Files:**
- Create `apps/dashboard/src/components/charts/credit-volume-card.tsx`
- Modify `apps/dashboard/src/components/charts/index.ts`
- Render on the credits page (where `credit-flow.tsx` is shown) or project page

- [ ] **Step 1: Find the existing credits hook** — `apps/dashboard/src/lib/hooks/useProjectCredits.ts` already returns `CreditsRollupResponse` (which has `volume: CreditsVolumePoint[]`, each `{ day, issued, burned, net }` numbers). READ it to get the exact exported hook name + params.

- [ ] **Step 2: Write the card** — a simple grouped daily bar/line of issued vs burned, reusing the existing hook (NO new fetch). Use project styling tokens. Example skeleton (adapt the hook call to its real signature):

```tsx
import { useProjectCredits } from "../../lib/hooks/useProjectCredits";

type Props = { projectId: string };

export function CreditVolumeCard({ projectId }: Props) {
  const { data, isLoading } = useProjectCredits(projectId);
  const points = data?.volume ?? [];
  const max = Math.max(1, ...points.map((p) => Math.max(p.issued, p.burned)));

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        Credit volume (28 days)
      </div>
      {isLoading ? (
        <div className="font-rv-mono text-[12px] text-rv-mute-500">—</div>
      ) : (
        <div className="flex h-32 items-end gap-1">
          {points.map((p) => (
            <div key={p.day} className="flex flex-1 flex-col justify-end gap-0.5" title={`${p.day}: +${p.issued} / −${p.burned}`}>
              <div className="w-full rounded-sm bg-rv-accent-500" style={{ height: `${(p.issued / max) * 100}%` }} />
              <div className="w-full rounded-sm bg-rv-mute-500" style={{ height: `${(p.burned / max) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

> If `useProjectCredits` requires a `windowDays` argument or returns a differently-named field, adapt the call/field access to match — verify against the real hook signature read in Step 1.

- [ ] **Step 3:** Add `export { CreditVolumeCard } from "./credit-volume-card";` to `charts/index.ts`.
- [ ] **Step 4:** Render `<CreditVolumeCard projectId={projectId} />` on the credits page alongside `credit-flow.tsx` (read the credits route page; match layout).
- [ ] **Step 5:** Run `pnpm --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 6:** Commit

```bash
git add apps/dashboard/src/components/charts/credit-volume-card.tsx apps/dashboard/src/components/charts/index.ts
git commit -m "feat(dashboard): add credit volume chart (reuses /credits/rollup)"
```

(Also `git add` the credits page file you modified in Step 4.)

---

## Task 9: Full verification

- [ ] **Step 1:** `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard exec tsc --noEmit` → PASS
- [ ] **Step 2:** `pnpm --filter @rovenue/api exec vitest run tests/dashboard-metrics.test.ts tests/dashboard-metrics-summary.test.ts tests/dashboard-metrics-ltv.test.ts tests/dashboard-metrics-movements.test.ts tests/dashboard-metrics-engagement.test.ts` → PASS (19 tests)
- [ ] **Step 3:** `pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard build` → PASS
- [ ] **Step 4 (Docker required):** integration suites for the new CH SQL (seed `raw_revenue_events` + `sdk_sessions_daily_tbl`).

---

## Self-Review Notes

- **Spec coverage:** movements new/expansion/churned (§ Phase-3, contraction honestly "—"), engagement (§3.8), credit volume (§3.7 — reuses existing `/credits/rollup`). ✅
- **Type consistency:** service `MrrDecomposition`/`EngagementPoint` map 1:1 to shared `MrrDecompositionResponse`/`EngagementPoint`. The RPC path `metrics["mrr-decomposition"]` uses bracket access because of the hyphen.
- **Honesty:** contraction never faked; CANCELLATION excluded from $ movement; credit work adds no redundant backend.
- **Deferred:** per-bucket conversion trend, reactivation rate.
