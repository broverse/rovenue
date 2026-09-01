# Analytics Integrity, Proceeds & Metrics Export — Design Spec

**Date:** 2026-09-01
**Roadmap area:** §5 Analytics (70 → 95)
**Parity bar:** RevenueCat's and Adapty's analytics surfaces for the specific gaps below — not a ground-up chart set, which mostly exists already.

---

## 1. Context — the ROADMAP is stale, and the surface is broken in one place

Reconnaissance on 2026-09-01 (mine, against the live stack) found §5 is far more built than the ROADMAP claims, and simultaneously found a live defect. Both facts shape this spec.

### What already exists

- `apps/api/src/services/metrics/` holds a **16-chart catalog** (`chart-catalog.ts`) plus `charts.ts` (599 lines), `ltv.ts`, `ltv-prediction.ts`, `ltv-extrapolation.ts`, `mrr.ts`, `mrr-decomposition.ts`, `engagement.ts`, `subscriptions.ts`, `summary.ts`, `overview.ts`, `credits.ts`, `transactions.ts`.
- The catalog already covers **five of the ROADMAP's eight §5 items**: `churn`, `retention_curve`, `ltv` (with a dedicated prediction service), `trial_to_paid`, and `paywall_view_rate` + `paywall_purchase`.
- `apps/api/src/routes/dashboard/charts.ts` exposes `/catalog`, `/channels`, `/funnel`, `/heatmap`, `/saved-views` and more.
- The dashboard has 21 chart components under `apps/dashboard/src/components/charts/`, hooks `useChartSeries` / `useProjectCharts`, and a chart test convention (RTL + `QueryClientProvider`, `data-testid` points, explicit empty-state assertions) demonstrated by `series-chart-panel.test.tsx`.
- ClickHouse holds 5 Kafka-fed raw tables, 4 aggregate targets and 6 query-time views. Migration `0012`/`0014` established the **query-time idempotent view** pattern that replaced SummingMergeTree rollups, because the outbox is at-least-once; `0014` also made every refund branch `abs()`-robust after a negative refund overflowed `toUInt64` and inflated net MRR.

### The live defect

`readFilterOptions` (`apps/api/src/services/metrics/charts.ts:288-306`), served by `GET /charts/filter-options`, queries columns that **do not exist**. Verified against the running ClickHouse:

```
Code: 47. Unknown expression or function identifier 'subscriberCountry' ...
Code: 47. Unknown expression or function identifier 'productGroupId' ...
```

`raw_revenue_events` has: `eventId, revenueEventId, projectId, subscriberId, purchaseId, productId, type, store, amount, amountUsd, currency, eventDate, ingestedAt, _version, placementId, paywallId, variantId, experimentKey`. Neither `subscriberCountry`/`country` nor `productGroupId` is among them. Two of the endpoint's three filter dimensions are dead; only `store` works.

### Why it shipped, and why that is the real finding

**Every metrics test mocks ClickHouse.** `charts.paywall.test.ts` opens with `vi.mock("../../lib/clickhouse")`. The tests prove the TypeScript composes the string it intends to; nothing proves the SQL is valid against the schema. `readFilterOptions` is green in CI and broken in production, and **the other sixteen chart queries carry exactly the same risk with exactly the same green tests**.

`packages/db/scripts/verify-clickhouse.ts` checks that expected tables exist with expected engines. That is a good precedent, and it is table-level: it cannot catch a query referencing a column that was never added.

## 2. Goals

1. **A schema contract that fails loudly.** Every chart query in the catalog is executed against a real ClickHouse schema in test, so a reference to a non-existent column breaks the build instead of the customer's dashboard.
2. **Repair `readFilterOptions`** — country and product-group filters either work or are honestly removed.
3. **Proceeds after store commission**, stated as an estimate with a visible basis, never as a payout figure we cannot know.
4. **A metrics export API** for customer BI, ClickHouse-backed.
5. **Correct the ROADMAP** to describe what is actually there.

## 3. Non-goals

- **Re-building the sixteen existing charts.** They exist; this spec protects and completes them.
- **A cohort retention *grid*.** `retention_curve` exists and the overview already has a cohort heatmap path; a second presentation of the same data is a UI request, not an analytics gap. If it is wanted, it is its own small task.
- **Claiming actual store payouts.** Apple's Small Business Program rate depends on the developer's prior-year proceeds across all their apps, and both stores apply per-country tax and currency handling we do not see. We compute an *estimate* from a configured rate.
- **Predicted-LTV modelling changes.** `ltv-prediction.ts` and `ltv-extrapolation.ts` exist; this spec does not touch the model.
- Backfilling historical rows with dimensions they never carried.

---

## 4. Design

### 4.1 The schema-contract test (the centrepiece)

A test that, for **every entry in the chart catalog** plus every other query in the metrics services, executes the query against a ClickHouse instance carrying the real migrated schema, with a bound project id and an empty result set. A query that references a missing column fails with `UNKNOWN_IDENTIFIER` and the test fails.

Three requirements make this worth having rather than decorative:

- **It must be driven by the catalog, not a hand-kept list.** A chart added tomorrow is covered automatically; a hand-maintained list would drift and re-create the problem.
- **It must run the real SQL**, not a re-typed copy. The queries must be reachable for execution without going through the mocked client — the shape of that seam is the main implementation decision, and the plan must state it explicitly.
- **Empty results are a pass.** This checks schema validity, not data. Asserting on rows would need fixtures and would make the test about something else.

Where the migrated ClickHouse comes from is an implementation choice between the compose service and an ephemeral container; the plan decides, but note the standing repo constraint: `deploy/clickhouse/users.d/rovenue.xml` allow-lists loopback + `172.16/12` + `10/8`, and Docker-Desktop host traffic arrives from `192.168.65.1`, which ClickHouse rejects as `IP_ADDRESS_NOT_ALLOWED` and reports to clients as *"password is incorrect"*.

### 4.2 Repairing the filter options

Two dimensions, two different answers.

**Country.** `raw_exposures` already carries `country`, so the concept exists in the pipeline but never reached revenue events. Revenue country must come from the subscriber's known country at event time and travel on the outbox payload — the outbox is the only path to Kafka, so a new dimension is added there and picked up by the `mv_revenue_to_raw` materialised view, exactly as `placementId`/`paywallId`/`variantId`/`experimentKey` were added by migration `0019`. **Historical rows will not have it**, and the UI must not imply otherwise: a country filter over a window that predates the column shows the rows it can and says so.

**Product group.** `productGroupId` exists nowhere in the ClickHouse schema and, unlike country, has no partial presence to build on. Unless the plan finds a real product-group concept in the Postgres model that belongs on a revenue event, **this dimension is removed from the endpoint and the UI** rather than shipped as an empty control. Removing a filter nobody can use is better than a dropdown that silently returns nothing.

Either way the endpoint stops referencing columns that do not exist — which is the actual bug.

### 4.3 Proceeds after store commission

The honest framing matters more than the arithmetic.

- Commission is **configured per project per store**, with the two Apple tiers (15% Small Business, 30% standard) and a Google equivalent as presets. The rate is the customer's statement of their own situation; we do not infer it.
- Proceeds = `net revenue × (1 − rate)`, computed **at query time** from the configured rate — never written into `raw_revenue_events`, because a rate change must not require rewriting history.
- The chart and any export column are labelled **estimated**, with the applied rate visible next to the number. Apple's tier depends on the developer's prior-year proceeds across their whole account and both stores apply tax handling we cannot see; presenting an estimate as a payout would be the same class of error as fabricating a currency.
- Refunds subtract at the same rate — the store returns its commission on a refund, so netting before applying the rate is correct.

### 4.4 Metrics export API

A ClickHouse-backed export for customer BI, project-scoped and capability-gated like the rest of the dashboard API. It must reuse the existing chart readers rather than introduce a second set of queries — a divergent copy is how two paths drift apart, and the schema-contract test only protects queries it can see.

Precedent for the response shape and streaming exists in `apps/api/src/services/subscriptions/export-csv.ts` (async generator, paged, hard row cap with an explicit truncation marker). Follow it, including the truncation marker: a silently truncated export is a lying export.

### 4.5 Dead components

`HourDayHeatmap` and `SqlPreviewCard` import from `mock-data.ts`, are exported from the charts barrel, and are **imported by nothing**. The `/heatmap` endpoint, by contrast, is real and served by `readHeatmap`. So the components are dead code, not a fake-data UI. Either wire `HourDayHeatmap` to the live endpoint or delete both along with the mock module — the plan decides, but they do not stay as they are.

---

## 5. Data changes

- One ClickHouse migration adding the country dimension to `raw_revenue_events` and its materialised view, following `0019`'s additive pattern (`ADD COLUMN IF NOT EXISTS ... DEFAULT ''`).
- The revenue outbox payload gains the same field; the dispatcher and `mv_revenue_to_raw` carry it through.
- Postgres gains per-project, per-store commission-rate configuration.
- No change to existing aggregate targets, and no backfill.

## 6. Risks / decisions worth stating

- **The schema-contract test is the deliverable most likely to be watered down** into "assert the query string contains the column name". That would restore exactly the false confidence that let this defect ship. It executes, or it is not worth writing.
- **Adding a dimension to the revenue payload touches the outbox**, which is the single path to Kafka. The change is additive and defaulted, but it must not become a dual-write.
- **Estimated proceeds will be read as real proceeds** unless the labelling is unambiguous. This is a copy problem with a correctness consequence.
- **Removing the product-group filter is a visible regression** to anyone who saw the control. It never worked; saying so is better than leaving it.
- Historical rows lack country forever. Any comparison spanning the migration boundary is partly blind, and the UI must say which part.

## 7. Acceptance criteria

1. Every chart in the catalog has its real SQL executed against a real migrated ClickHouse schema in test; adding a chart with a bad column reference fails that test. Proven by introducing such a reference and observing the failure.
2. `GET /charts/filter-options` returns without a ClickHouse exception, for every dimension it still advertises.
3. Country revenue is queryable for events recorded after the migration, and the UI states that earlier events lack the dimension rather than showing them as unknown-but-equal.
4. Product group is either genuinely queryable or absent from both API and UI — no dimension that returns nothing.
5. Proceeds are computed at query time from a per-project, per-store configured rate, are labelled estimated with the rate visible, and refunds net before the rate is applied.
6. The metrics export is project-scoped, capability-gated, reuses the chart readers, and marks truncation explicitly when it caps.
7. `HourDayHeatmap` and `SqlPreviewCard` are either wired to live data or removed with `mock-data.ts`.
8. ROADMAP §5 describes reality: the five shipped items ticked, the genuinely open ones left open, and the stale claims corrected.
9. No change to the LTV model, the existing sixteen charts' semantics, or `render-fixtures.json`.
