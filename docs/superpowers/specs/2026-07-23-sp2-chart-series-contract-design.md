# SP2 — Chart series contract + the two paywall charts

Date: 2026-07-23
Status: approved (design)
Surfaces: `apps/api`, `apps/dashboard`, `packages/shared`

## Context

The follow-up ledger recorded `paywall_purchase` as "an unconnected stub, and its
sibling `paywall_view_rate` too", needing "the dashboard chart contract".

Investigation found the stubs are not specially broken — **15 of the 16 system
charts are equally unwired**, because no chart data contract exists at all:

- `apps/api/src/routes/dashboard/charts.ts` serves `/catalog`, `/channels`,
  `/funnel`, `/heatmap`, `/saved-views` and custom-chart CRUD. There is no
  `chartId → series` endpoint.
- `apps/dashboard/src/routes/_authed/projects/$projectId/charts.tsx:177` renders
  `<MrrChartPanel>` unconditionally. The component takes no `chartId`
  (`mrr-chart-panel.tsx:125` — only `projectId`, `chartType`, `compare`,
  `range`).
- Selecting a catalog entry changes the title, chart type and range. The data
  stays MRR.

So selecting "Churn" shows MRR under a "Churn" heading. That misreporting is a
larger user-facing problem than the two missing paywall charts, and it is the
thing this sub-project's contract removes.

**Scope decision (owner):** build the contract, wire only the two paywall charts,
and let the remaining 13 report an honest empty state. Wiring all 15 is a
separate, much larger piece — each chart carries its own query, semantics and
tests.

## Item 1 — the chart series contract

### Endpoint

```
GET /dashboard/projects/:projectId/charts/series/:chartId?windowDays=N
```

Mounted in `apps/api/src/routes/dashboard/charts.ts` beside the existing
read-only chart routes, using the same `validate("query", windowQuerySchema)`
and `assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT)`
guards those routes already use.

### Response

New types in `packages/shared/src/dashboard.ts`, following the shape of the
existing `MrrSeriesResponse` (line 645):

```ts
export interface ChartSeriesPoint {
  bucket: string;        // ISO timestamp at start-of-day UTC
  value: number | null;  // null when undefined for that day (zero denominator)
  numerator?: number;    // ratio charts expose their inputs
  denominator?: number;
}

export interface ChartSeriesResponse {
  chartId: string;
  unit: "count" | "percent";
  from: string;
  to: string;
  points: ChartSeriesPoint[];
  supported: boolean;
}
```

Two fields carry the design:

**`supported`.** A catalog id with no reader returns `supported: false` and an
empty `points` array — never another chart's data. This is what stops the
dashboard misreporting MRR under a different name, and it does so for all 13
remaining charts without writing a single additional query.

**`value: number | null`.** A ratio with a zero denominator is undefined, not
zero. Reporting `0` would draw a day with no traffic as a 0% conversion day,
which reads as a collapse rather than an absence. Consumers render `null` as a
gap.

### Rejected alternatives

- *A `chartId` query parameter on one generic `/series` route.* The path
  parameter matches how the rest of this router is shaped and keeps the id in the
  cache key without special handling.
- *Returning `501` for unsupported ids.* An unwired chart is a normal state of
  the product today, not an error; a 200 with `supported: false` lets the client
  render an empty state without treating it as a failure.

## Item 2 — the two readers

Both live in `apps/api/src/services/metrics/charts.ts` beside `readFunnel` and
`readHeatmap`, and follow the ClickHouse conventions already established there
(`assertClickHouseReady()`, `buildWindow`, `queryAnalytics`, `toDateOnly`).

### `paywall_view_rate` — reach, `unit: "percent"`

The share of active subscribers who saw a paywall that day.

- Numerator: `uniqMerge(subscribersHll)` per day from
  `rovenue.mv_paywall_daily_target` (`0018_mv_paywall_daily.sql`).
- Denominator: `uniq(subscriberId)` per day from `rovenue.sdk_sessions_daily_tbl`
  (`0010_sdk_sessions_daily.sql`).

### `paywall_purchase` — conversion, `unit: "percent"`

The share of paywall viewers who purchased that day. The label is
"Paywall → purchase", matching the arrow notation `trial_to_paid` ("Trial →
paid") uses for a conversion rate.

- Numerator: `uniq(subscriberId)` per day from `rovenue.raw_revenue_events` where
  `paywallId != ''` and
  `type IN ('INITIAL','RENEWAL','TRIAL_CONVERSION','REACTIVATION')`.
- Denominator: `uniqMerge(subscribersHll)` per day from
  `mv_paywall_daily_target`.

Together the pair decomposes the funnel: reach × conversion.

### Shared query shape

Each reader joins numerator and denominator per day, emitting one point per day
in the window. A day present in neither side is omitted; a day with a zero
denominator emits `value: null` with its `numerator`/`denominator` intact.

Attribution follows the pattern `placement_metrics` already established
(`apps/api/src/services/analytics-router.ts:155-190`): the numerator uses the
**precise** `paywallId` column that `0019_revenue_presented_context.sql` added to
`raw_revenue_events`, not a viewer-overlap heuristic.

**Known horizon, not an empty state.** Revenue rows written before migration 0019
carry `paywallId = ''` and cannot match, so `paywall_purchase` under-reports for
dates before that migration was deployed. This is a property of the data, not a
bug to fix here; it is documented in the reader's comment so nobody reads the
early flat region as a product collapse.

## Item 3 — dashboard dispatch

`charts.tsx:177` stops rendering `<MrrChartPanel>` unconditionally:

- `chartId === "mrr"` keeps the existing panel untouched. It owns bespoke
  split-request window logic (`mrr-chart-panel.tsx:129-133`) added to fix a real
  bug; folding it into the generic panel would risk regressing it for no gain.
- Every other id renders a new `SeriesChartPanel`, which fetches the series
  endpoint and renders `points`.
- `supported: false` renders "No data for this chart yet" rather than an error or
  a blank canvas.

`SeriesChartPanel` is a new file under `apps/dashboard/src/components/charts/`,
following the conventions of its siblings there. New strings are added to
`apps/dashboard/src/i18n/locales/en.json`; the two chart labels already exist
(`charts.items.paywall_view_rate`, `charts.items.paywall_purchase`).

## Testing

Every behaviour below must be mutation-checked: after the test passes, revert the
production change, confirm the test goes red, restore.

**Readers** — ClickHouse integration tests (testcontainers, the pattern used by
existing `*.integration.test.ts` in this repo). Seed known paywall view and
revenue events across several days, then assert the exact daily rates. One case
per reader must cover a **zero-denominator day and assert `value === null`, not
`0`** — that distinction is the whole point of the nullable field and a test
asserting `0` would lock in the bug.

**Endpoint** — route tests covering: a supported id returns points and
`supported: true`; an unknown or unwired id returns 200 with `supported: false`
and no points; the access guard rejects a caller without project access.

**Dashboard** — component tests that `SeriesChartPanel` renders the empty state
on `supported: false` and points otherwise, and that selecting a non-MRR catalog
entry no longer renders MRR data.

## Out of scope

- Wiring the other 13 system charts. The contract makes each a self-contained
  follow-up.
- Custom charts (`custom_charts` rows) — they have their own `config` shape and
  no reader path either; unchanged here.
- Backfilling `paywallId` onto pre-0019 revenue rows.
- SP3 (custom-domain funnel serving) and SP4 (Phase 2 runner input capture).
