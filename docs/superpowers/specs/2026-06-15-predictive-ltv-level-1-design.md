# Predictive LTV — Level 1 Design Spec

> **Status:** Design for review. Pure-SQL (ClickHouse) + light JS extrapolation — **no ML, no Python service, no new infra**. Stays inside the existing TS metrics stack, which matters for an AGPL self-host. Once approved, an implementation plan is derived (`docs/superpowers/plans/`).

**Goal:** Predict subscriber lifetime value (pLTV) at a horizon (default 12 months) from observed cohort revenue curves — surfacing "this cohort will be worth ~$X" before the cohort matures.

**Why this method (cohort cumulative-revenue curve scaling):** The codebase has **no reliable billing-period or recurring-price** (`purchases.priceAmount` is per-purchase; no `billingPeriod` column). So the naive `pLTV = price × (1/churn)` is fragile. Instead we use the method RevenueCat/Adapty actually use: observe **cumulative net revenue per original member as a function of cohort age**, learn the curve shape from cohorts old enough to be mature, and scale up young cohorts' partial curves to the horizon. Needs only `amountUsd` + each subscriber's join month — both already in `raw_revenue_events`. Fully explainable, no price/period inference.

---

## 1. The Model (plain arithmetic)

**Definitions**
- **Cohort** = subscribers grouped by acquisition month `c = toStartOfMonth(min(eventDate) where type ∈ {INITIAL, TRIAL_CONVERSION})`.
- **Age** `t` = whole months between cohort month and an event's month (`dateDiff('month', c, eventMonth)`).
- **`cum(c, t)`** = cumulative **net** revenue (gross − refunds) from cohort `c`'s members through age `t`, divided by cohort size `N(c)` → cumulative revenue *per original member*.

**Mature reference curve.** Take cohorts with observed age ≥ H (the horizon). Their `cum(c, t)` is complete out to H. Average them (size-weighted) into a normalized shape:
```
f(t) = avg_over_mature_cohorts[ cum(c, t) / cum(c, H) ]   for t = 0…H,  f(H) = 1
```
`f(t)` is the fraction of horizon-LTV typically realized by age `t` (monotid increasing 0→1).

**Predict a young cohort.** A cohort observed only up to age `a < H` has realized `cum(c, a)`. Scale it up by the mature shape:
```
predictedLtv(c) = cum(c, a) / f(a)        (guard f(a) > 0; if a ≥ H, predicted = observed)
maturity(c)     = f(a)                     (0…1 — how "settled" the estimate is)
```

**Blended project pLTV** = size-weighted average of `predictedLtv(c)` across all cohorts in range.

That's the whole model — no regression library required. (A later refinement could fit an explicit decay to the marginal curve; not needed for Level 1.)

---

## 2. Data Sources (all existing)

- `rovenue.raw_revenue_events` — `subscriberId`, `eventDate`, `type`, `amountUsd`, `productId`, `store`. Join-month via `min(eventDate)` per subscriber; net revenue via `sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')) - sumIf(amountUsd, type IN ('REFUND','CHARGEBACK'))`.
- No new tables, views, or migrations. Reuses the `services/metrics/*` + `routes/dashboard/metrics.ts` + `queryAnalytics` pattern from Phases 1–3.

**Acquisition definition:** join = first `INITIAL` or `TRIAL_CONVERSION` event (a trial-only subscriber who never converts has no acquisition revenue and contributes $0 — correct for revenue LTV).

---

## 3. ClickHouse Query (one read)

```sql
WITH joins AS (
  SELECT subscriberId, toStartOfMonth(min(eventDate)) AS cohort_month
  FROM rovenue.raw_revenue_events FINAL
  WHERE projectId = {projectId:String}
    AND type IN ('INITIAL','TRIAL_CONVERSION')
  GROUP BY subscriberId
)
SELECT
  toString(j.cohort_month)                                              AS cohort_month,
  toInt32(dateDiff('month', j.cohort_month, toStartOfMonth(e.eventDate))) AS age_month,
  toString(
    sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK'))
      - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK'))
  )                                                                      AS net_usd,
  toString(uniqExactIf(e.subscriberId, e.type IN ('INITIAL','TRIAL_CONVERSION'))) AS joiners
FROM rovenue.raw_revenue_events FINAL AS e
INNER JOIN joins AS j ON e.subscriberId = j.subscriberId
WHERE e.projectId = {projectId:String}
GROUP BY cohort_month, age_month
ORDER BY cohort_month ASC, age_month ASC
```

Cohort size `N(c)` = sum of `joiners` at `age_month = 0` for that cohort (or a small second query `GROUP BY cohort_month` over `joins`). The JS layer then: pivots to `cum(c, t)` per member, picks mature cohorts (max observed age ≥ H), builds `f(t)`, scales each cohort, blends.

---

## 4. API Contract

`GET /dashboard/projects/:projectId/metrics/ltv-prediction`

Query: `{ horizonMonths?: 1–36 (default 12), minMatureCohorts?: default 3 }`

```ts
{ data: {
  horizonMonths: number;
  /** Size-weighted predicted LTV across all cohorts, decimal-as-string USD. */
  blendedPredictedLtvUsd: string;
  /** The learned shape f(t): fraction of horizon-LTV realized by age t. */
  maturityCurve: Array<{ ageMonth: number; fraction: number }>;
  cohorts: Array<{
    cohortMonth: string;        // ISO month start
    size: number;
    observedLtvUsd: string;     // cum(c, a) per member so far
    predictedLtvUsd: string;    // scaled to horizon
    maturity: number;           // f(a) in [0,1]
    isMature: boolean;          // observed age ≥ horizon
  }>;
  /** Set when fewer than minMatureCohorts mature cohorts exist → predictions are low-confidence. */
  warning: string | null;
}}
```

**Cold-start honesty:** if there aren't `minMatureCohorts` cohorts old enough to reach the horizon, `f(t)` is unreliable → return predictions but set `warning` (and the UI shows a "low confidence / not enough history" badge). Never present a confident number we can't back.

---

## 5. Dashboard Surfacing

- A `PredictedLtvCard` (charts barrel): headline **blended pLTV (12mo)** + a small cohort table (month, size, observed→predicted, maturity bar) + the maturity curve sparkline. Low-confidence warning rendered prominently when present.
- Hook `useProjectLtvPrediction` mirroring the Phase-1/2 hooks.
- Placed on the project analytics page near the LTV distribution card (they pair naturally: *realized* distribution + *predicted* forward value).

---

## 6. Open Questions (decide before implementing)

1. **Horizon default** — 12 months (annual LTV, the common SaaS standard) vs 6 vs 24. Recommendation: **12**, configurable via query param.
2. **Granularity** — monthly cohorts (recommended; robust) vs weekly (more cohorts, noisier). Recommendation: **monthly** for v1.
3. **Curve method** — simple **mature-cohort average scaling** (this spec, fully arithmetic) vs an explicit decay fit. Recommendation: **average scaling** for Level 1; revisit if it under/over-shoots.
4. **Segmentation** — project-blended only for v1, or also break down by `store` / `productId`? Recommendation: **project-blended + per-cohort table** for v1; store/product segmentation is a fast follow (same query + extra GROUP BY).

---

## 7. Scope / Non-Goals

- **In:** project-blended pLTV at a horizon, per-cohort observed→predicted table, maturity curve, cold-start warning. Pure CH + JS. One endpoint + one card.
- **Out (Level 2+):** per-subscriber ML scoring, churn-probability model, predicted-LTV audience targeting, batch-scored `subscriber_predictions` table, store/product segmentation, confidence intervals.
- **No** new tables/migrations/workers; computed on read.

---

## 8. Testing

- Service unit logic: feed a synthetic pivot (mature + young cohorts) and assert `f(t)` construction, scaling, blend, and the cold-start `warning` branch — these are pure functions, test them directly (extract the extrapolation math from the CH call so it's unit-testable without ClickHouse).
- Route test: mirror `dashboard-metrics-summary.test.ts` (auth 401 / access 403 / 200 payload shape), mocking the service.
- Integration (Docker): seed `raw_revenue_events` with two mature + one young cohort, assert the young cohort's predicted > observed and blended is sane.
