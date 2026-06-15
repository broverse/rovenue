# Analytics Surfacing Design Spec

> **Scope:** Expose subscription-analytics metrics that are **already computed in the ClickHouse data layer** (or trivially derivable from existing raw events) through the dashboard API and UI. This is a surfacing effort, not a new analytics pipeline. Closes most of the Adapty "advanced analytics" gap at low cost.
>
> **For agentic workers:** This is a *design spec*. The bite-sized TDD implementation plan is derived from it separately (`docs/superpowers/plans/`). Each metric below names its exact data source, formula, API contract, and UI target so the plan can be authored without re-investigating.

**Goal:** Surface refund/net revenue, ARPU/ARPPU, project-wide LTV, churn rate, trial→paid conversion, revenue movements, engagement, and credit KPIs from existing ClickHouse views — no new ingestion pipeline.

**Architecture:** New read-only endpoints under `apps/api/src/routes/dashboard/` backed by services in `apps/api/src/services/metrics/` that query existing ClickHouse views via `queryAnalytics<T>(projectId, sql, params)`. Dashboard renders new KPI cards + charts via react-query hooks. Response envelope `{ data: T }` throughout.

**Tech Stack:** Hono + Zod (API), ClickHouse (`@rovenue/db` views), React + react-query + existing chart components (dashboard), Vitest (tests).

---

## 1. Metric Inventory & Tiering

The honest spine of this spec: not every metric is equal. Three tiers by how much work the *data* needs.

### Tier A — Pure surfacing (data fully in views, only wire to API/UI)

| Metric | Source view | Formula / column | Current state |
|---|---|---|---|
| Refunds USD | `v_mrr_daily.refunds_usd` | already computed | computed, not returned by `/metrics/mrr` |
| Net revenue | `v_mrr_daily.net_usd` | `gross_usd − refunds_usd` | computed, not returned |
| Refund rate | `v_mrr_daily` | `refunds_usd / gross_usd` (window-summed) | not exposed |
| ARPU | `v_mrr_daily` + active base | `net_usd(window) / active_subscriber_base` | not exposed |
| ARPPU | `v_mrr_daily` | `net_usd(window) / uniq paying subs(window)` | not exposed |
| Avg / median / p90 LTV | `v_revenue_lifetime_subscriber` | aggregate `lifetime_dollars_purchased_cents − lifetime_dollars_refunded_cents` across subs | per-subscriber only; never aggregated |
| LTV distribution (histogram) | `v_revenue_lifetime_subscriber` | bucketed counts of net lifetime cents | not exposed |
| Credit consumption KPIs | `v_credit_consumption_daily` | `granted_credits`, `debited_credits`, `net_flow` summed over window | volume chart only; no KPI cards |
| Engagement (sessions) | `sdk_sessions_daily` | `session_ms`, `session_count` per sub/day | used only by Refund Shield; hidden from analytics |

### Tier B — Light derivation (raw events exist; needs one new aggregate/query)

| Metric | Source | Definition | Note |
|---|---|---|---|
| Trial→paid conversion rate (trend) | `raw_revenue_events` | `count(TRIAL_CONVERSION) / count(INITIAL where trial)` per period | `funnel-card` shows a single snapshot; this adds a windowed trend line |
| Logo churn rate | Postgres `subscriber_access` state transitions → EXPIRED | `churned_in_period / active_at_period_start` | event-vs-state source is an **open question** (§6) |
| Revenue movement: new vs churned | `raw_revenue_events` | new = `INITIAL + TRIAL_CONVERSION`, churned = `REFUND + CHARGEBACK + CANCELLATION` | **partial** — see Tier C for why expansion/contraction is excluded |

### Tier C — Out of scope (needs data-layer work, NOT surfacing)

These look like "analytics gaps" but cannot be surfaced because the underlying events do not exist yet. Listed so the plan does not silently promise them.

- **Expansion / contraction MRR movement** — requires plan-change (upgrade/downgrade) events; schema has no plan-change tracking. Future data-layer task.
- **CAC / payback period** — no acquisition-cost or marketing-spend ingestion.

> **Correction (post-investigation):** Reactivation/win-back IS surfaceable — `RevenueEventTypeName` already includes `REACTIVATION` (used in `services/metrics/overview.ts` `ALL_REVENUE_TYPES`). Reactivation rate moves from "out of scope" to **Tier B** (light derivation: `count(REACTIVATION) / churned_base`). Slotted after Phase 3.
- **Predictive LTV / churn** — separate effort (`docs/.../predictive-ltv-design.md`, Level 1 cohort extrapolation first).

> **Known definitional limitation (applies to all revenue metrics):** `v_mrr_daily.gross_usd` is **daily booked revenue** (sum of `amountUsd` for non-refund events that day), not a normalized recurring run-rate. `mrr-chart-panel` rolls daily→monthly. True normalized MRR is a future data-layer refinement; this spec surfaces what the view actually computes and labels it accordingly ("Net revenue", "Gross revenue") rather than overclaiming "MRR".

---

## 2. Metric Definitions (exact)

Denominator sourcing matters — call it out per metric.

- **Net revenue (window)** = `Σ net_usd` over `[from, to]` from `v_mrr_daily`. Decimal string, USD.
- **Refund rate (window)** = `Σ refunds_usd / Σ gross_usd`. Ratio in `[0,1]`; render as %. Guard `gross_usd = 0 → null`.
- **ARPPU (window)** = `Σ net_usd / uniq paying subscribers in window`. Paying-subs denominator = `uniq(subscriberId)` over `v_mrr_daily.active_subscribers`-style count; compute directly from `raw_revenue_events` `uniqIf(subscriberId, type NOT IN ('REFUND','CHARGEBACK'))` for the window to avoid double counting across days.
- **ARPU (window)** = `Σ net_usd / active_subscriber_base`. Base = current active entitlement count from Postgres `subscriber_access` (point-in-time), reusing the count already produced by `/subscriptions/kpis`. **Not** the transacting-subs count from `v_mrr_daily` (that would be ARPPU). Document this explicitly in the response field description.
- **Avg LTV** = `avg(lifetime_dollars_purchased_cents − lifetime_dollars_refunded_cents)/100` across all subscribers in `v_revenue_lifetime_subscriber` for the project.
- **Median / p90 LTV** = `quantile(0.5)` / `quantile(0.9)` of the same net-lifetime expression.
- **LTV histogram** = fixed cent buckets (e.g. `[0, 5, 10, 25, 50, 100, 250, 500, 1000, ∞)` USD) → subscriber counts.
- **Logo churn rate (period)** = `subscribers transitioning to EXPIRED in period / active subscribers at period start`. Source decision deferred to §6.
- **Trial→paid conversion (period)** = `count(TRIAL_CONVERSION) / count(INITIAL with trial flag)` per bucket. Guard divide-by-zero → null.

---

## 3. API Contracts

All routes mounted under the existing `GET /dashboard/projects/:projectId/...` group, VIEWER role, `{ data: T }` envelope, ClickHouse-unavailable → existing `ClickHouseUnavailableError` (503) path.

### 3.1 Extend `GET /metrics/mrr` (Tier A — refund/net)
Add two fields to each existing point. **Backward compatible** (additive).
```ts
points: Array<{
  bucket: string;            // unchanged
  grossUsd: string;          // unchanged
  refundsUsd: string;        // NEW — from v_mrr_daily.refunds_usd
  netUsd: string;            // NEW — from v_mrr_daily.net_usd
  eventCount: number;        // unchanged
  activeSubscribers: number; // unchanged
}>
```

### 3.2 New `GET /metrics/summary` (Tier A — KPI cards)
Query: `{ from?: ISO, to?: ISO }` (default 30d, max 800d — match `/metrics/mrr`).
```ts
{ data: {
  from: string; to: string;
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  refundRate: number | null;     // [0,1]
  arpu: string | null;           // net / active base (Postgres)
  arppu: string | null;          // net / paying subs (CH window)
  payingSubscribers: number;
  activeSubscriberBase: number;  // from subscriptions/kpis source
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
}}
```

### 3.3 New `GET /metrics/ltv` (Tier A — distribution)
Query: none (lifetime is cumulative). 
```ts
{ data: {
  avgUsd: string; medianUsd: string; p90Usd: string;
  totalSubscribers: number;
  histogram: Array<{ lowerUsd: number; upperUsd: number | null; count: number }>;
}}
```

### 3.4 New `GET /metrics/conversion` (Tier B — trial→paid trend)
Query: `{ from?, to?, granularity?: "day"|"week"|"month" = "week" }`.
```ts
{ data: { points: Array<{ bucket: string; trials: number; conversions: number; rate: number | null }> }}
```

### 3.5 New `GET /metrics/movements` (Tier B — new vs churned)
Query: `{ from?, to?, granularity? }`. Expansion/contraction intentionally absent (Tier C) — document in field notes.
```ts
{ data: { points: Array<{
  bucket: string;
  newUsd: string;        // INITIAL + TRIAL_CONVERSION
  churnedUsd: string;    // -(REFUND + CHARGEBACK + CANCELLATION)
  netUsd: string;
}>}}
```

### 3.6 Extend `GET /subscriptions/kpis` (Tier B — churn rate)
Add `churnRate: number | null` and `churnedCount` (count already exists). Source per §6.

### 3.7 New `GET /metrics/credits` (Tier A — credit KPIs)
Query: `{ from?, to? }`.
```ts
{ data: { grantedCredits: number; debitedCredits: number; netFlow: number; activeSubscribers: number; points: Array<{ bucket: string; granted: number; debited: number; netFlow: number }> }}
```

### 3.8 New `GET /metrics/engagement` (Tier A — sessions, lowest priority)
Query: `{ from?, to? }`.
```ts
{ data: { points: Array<{ bucket: string; sessionCount: number; avgSessionMs: number; activeSubscribers: number }> }}
```

---

## 4. Service Layer

New files under `apps/api/src/services/metrics/`, each following the established pattern (wire interface `Ch*Row` → parameterized SQL with `{name:Type}` placeholders → `queryAnalytics<T>` → map rows, coercing CH strings/dates):

- `summary.ts` — `getRevenueSummary(input)` (joins `v_mrr_daily` window-agg + `v_revenue_lifetime_subscriber` agg + Postgres active base)
- `ltv.ts` — `getLtvDistribution(projectId)`
- `conversion.ts` — `listConversionTrend(input)`
- `movements.ts` — `listRevenueMovements(input)`
- `engagement.ts` — `listEngagement(input)`
- `credits.ts` — promote existing credit query to a routed `getCreditMetrics(input)`
- extend `mrr.ts` — add `refundsUsd`/`netUsd` to `MrrPoint` + SELECT
- churn rate added to the existing subscriptions-kpis service (§6 source)

Decimal precision: keep monetary values as **Decimal strings** end-to-end (never `Number`), matching `mrr.ts`.

---

## 5. Dashboard / UI

New + extended components under `apps/dashboard/src/components/`, react-query hooks under `hooks/` (mirror `useProjectMrr` / `useChartChannels`).

| UI element | Component | Endpoint | Phase |
|---|---|---|---|
| KPI cards row (Net rev, Refund rate, ARPU, ARPPU, Avg LTV) | `charts/revenue-kpis-card.tsx` (new) | `/metrics/summary` | 1 |
| MRR panel: add net + refund series | `charts/mrr-chart-panel.tsx` (extend) | `/metrics/mrr` | 1 |
| LTV distribution histogram | `charts/ltv-distribution-card.tsx` (new) | `/metrics/ltv` | 2 |
| Trial→paid conversion trend line | `charts/conversion-trend-card.tsx` (new) | `/metrics/conversion` | 2 |
| Churn rate KPI | extend subscriptions KPI tiles | `/subscriptions/kpis` | 2 |
| Revenue movement stacked bar (new vs churned) | `charts/movements-card.tsx` (new) | `/metrics/movements` | 3 |
| Credit KPI cards | `charts/credit-kpis-card.tsx` (new) | `/metrics/credits` | 3 |
| Engagement panel | `charts/engagement-card.tsx` (new) | `/metrics/engagement` | 3 |

Each new card handles `isLoading`, empty-state, and the ClickHouse-unavailable 503 (degrade gracefully, matching existing chart behavior).

---

## 6. Open Questions

1. **Churn rate source (blocking for Tier B churn):** derive from `raw_revenue_events` `CANCELLATION` (cancel-time, not churn-time — cancels often run to period end) **or** from Postgres `subscriber_access` transitions to `EXPIRED` (true churn moment, but requires a state-transition query/MV). Recommendation: **`subscriber_access` EXPIRED transitions** for correctness; if no transition history is retained, add a lightweight churn-event MV. Decide before Phase 2.
2. **ARPU active-base definition:** point-in-time active count (end of window) vs. average over window. Recommendation: end-of-window for v1 (cheapest, matches `/subscriptions/kpis`); note as approximate.
3. **LTV currency normalization:** `lifetime_*_cents` assumes USD-normalized amounts. Confirm multi-currency purchases are already FX-normalized upstream, else LTV mixes currencies.
4. **MRR label:** rename user-facing "MRR" → "Revenue" given the daily-bookings limitation (§1), or keep "MRR" and add a tooltip? Product decision.

---

## 7. Phasing

- **Phase 1 — Pure surfacing, highest ROI:** §3.1 (refund/net in MRR) + §3.2 `/metrics/summary` + KPI cards + MRR panel net/refund series. All Tier A; no open questions block it. Closes the most visible gap (refunds/net/ARPU/LTV invisible today).
- **Phase 2 — Light derivation:** §3.3 LTV distribution, §3.4 conversion trend, §3.6 churn rate (resolve OQ #1 first).
- **Phase 3 — Movements + secondary:** §3.5 movements (new-vs-churned only), §3.7 credit KPIs, §3.8 engagement.
- **Future (separate specs):** expansion/contraction events, reactivation, normalized MRR, predictive LTV.

---

## 8. Testing

Follow `apps/api/tests/dashboard-metrics.test.ts`: Vitest, mock auth (`authMock.api.getSession`), mock `projectMember.findUnique` for role, mock the new metrics service functions, assert `{ data: ... }` shape + numeric/decimal correctness + null-guard branches (divide-by-zero on rate metrics). Integration coverage for the actual ClickHouse SQL goes in the `*.integration.test.ts` suites (testcontainers) seeding `raw_revenue_events` and asserting view-backed aggregates.
