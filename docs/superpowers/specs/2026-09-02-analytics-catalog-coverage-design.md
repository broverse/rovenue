# Analytics — Closing §5: Catalog Coverage, a Rate UI, and Two Items That Should Not Be Built

**Date:** 2026-09-02
**Roadmap area:** §5 Analytics (90 → 95) — the three remaining open items
**Scope:** small. One real feature, one small UI, and two items this spec argues should be
closed rather than implemented.

---

## 1. Context — what reconnaissance found

Recon on 2026-09-02 read the code behind each of §5's three open items rather than the
roadmap text. For the fifth section running, the roadmap does not describe what is actually
there — but this time the correction goes in a new direction. Two of the three items are not
unfinished work. One was **decided** and one is **impossible**, and both are written down as
open.

### 1.1 Item C — chart-catalog series coverage is the real work

`SYSTEM_CATALOG` (`apps/api/src/services/metrics/chart-catalog.ts`) declares **16** chart
ids: `mrr`, `arr`, `arpu`, `rev_per_install`, `gross_vs_net`, `new_subs`, `trials_started`,
`reactivations`, `churn`, `retention_curve`, `ltv`, `trial_to_paid`, `paywall_view_rate`,
`paywall_purchase`, `credit_burn`, `liability`.

`readChartSeries` (`services/metrics/charts.ts:679`) handles exactly **two** of them —
`paywall_view_rate` and `paywall_purchase`. Its `default` branch is honest about it:

```ts
default:
  // Not an error: most of the catalog simply has no reader yet.
  return { ...base, unit: "count", points: [], supported: false };
```

So the metrics export — which the previous plan shipped as "the catalog's data, for customer
BI" — covers 2 of 16 series. It does not lie (`supported: false` is returned), but it is
one eighth of what the catalog advertises.

**Most of the data exists already, but not all of it, and the split was measured rather
than assumed.** A grep of each id's concept across `services/metrics/` gives three groups:

- **Clearly backed** — `mrr`, `arr` (`mrr.ts`), `ltv` (`ltv.ts` / `-extrapolation` /
  `-prediction`), `churn` and `trial_to_paid` (`summary.ts`, `subscriptions.ts`),
  `credit_burn` and `liability` (`credits.ts`), `gross_vs_net` and `reactivations` and
  `trials_started` (`mrr-decomposition.ts`, `transactions.ts`, `overview.ts`).
- **Backed elsewhere, not by a `services/metrics` sibling** — `retention_curve`. The
  cohorts surface (`/cohorts`, `retention-heatmap.tsx`) has its own route; the delegation
  target is that, not a metrics service.
- **Thin or unclear** — `arpu` (only `summary.ts` mentions it) and `new_subs` (the catalog
  is the ONLY file naming it). Both may still be derivable from an existing service under a
  different name, but neither is confirmed.

An earlier draft of this spec asserted "thirteen of the fourteen" from file names rather
than behaviour. That is the exact failure this area keeps having, so the number is replaced
by the grouping above and **§4.6 makes per-id verification an explicit first deliverable**
rather than a spec claim. This is still a **wiring** job for most ids — the same shape as
the §4 work that just landed — but the plan must confirm each backing before wiring it.

### 1.2 Item C's one genuine exception — `rev_per_install` has no backing data at all

`grep -rni install` across `services/metrics/` and the ClickHouse migrations returns exactly
one hit that is not the word "fresh install" in a migration comment: **the catalog entry
itself**. There is no install event, no first-seen counter, and nothing in the SDK feeding
one.

So one of the sixteen ids cannot be wired without first building install tracking, which is
an SDK-and-pipeline project of its own. §4.3 explains why it nevertheless stays in the
catalog.

### 1.3 Item B — "full country coverage" is not a gap, it is two closed questions

The roadmap asks for "Stripe country for non-`charge.refunded` events, backfill before
migration 0023". Both halves are already settled, in opposite ways.

**The Stripe half was decided, not forgotten.** `services/stripe/stripe-webhook.ts:877-886`
records the reasoning at the call site: `invoice.paid` carries no per-transaction country,
and its only country-shaped field, `customer_address`, is a **billing address** — which the
analytics-country plan *explicitly forbids*, because it is not a store-supplied country.
`charge.refunded` is wired precisely because it does carry one
(`charge.billing_details.address.country`, `:1103`).

Mixing a self-declared billing address into the same column as Apple's `storefront` and
Google's `regionCode` would silently change what the column means — which is the exact
honesty failure the country work was built to prevent.

**The backfill half is impossible from data we hold.** The only `country` column anywhere in
the Postgres schema is on `projectStripeConnections` (the connected account's own country,
not per-transaction). `revenue_events` has no country. `purchases` has no country. No table
retains a raw store payload to re-derive one from: the `payload` columns that exist belong
to `outbox_events` (our own domain events, and cleaned up on a schedule),
`scheduled_subscription_actions` and `funnel_purchases`.

Backfilling would mean re-verifying every historical transaction against the App Store
Server API, the Google Play Developer API and Stripe — a re-verification campaign against
three rate-limited third parties, not a data migration.

### 1.4 Item A — the commission-rate settings UI is real and small

No dashboard component writes a commission rate. `PUT/DELETE
/dashboard/projects/:projectId/commission-rates/:store` exists and is audited;
`COMMISSION_RATE_PRESETS` (Apple 15/30, Google 15) sits in
`services/metrics/proceeds.ts:51` with sourced citations and is **read by nothing outside
its own test**. A project without an API call sees "rate not configured — proceeds unknown",
which is honest but leaves the whole proceeds feature behind a curl command.

### 1.5 The shape

§5's remainder is **one wiring job, one small form, and two items whose honest resolution is
to write down why they are closed.** The roadmap currently records a deliberate design
ruling and a physical impossibility as if they were backlog.

## 2. Goals

1. Every catalog id that can be backed by existing data returns a real series, through the
   existing metric services rather than a second query set.
2. The metrics export therefore covers the catalog it advertises.
3. An operator can set a store commission rate from the dashboard, with the sourced presets
   offered rather than hidden.
4. §5's two unbuildable items are closed in the roadmap with their actual reasons, so the
   next reader does not re-derive them.

## 3. Non-goals

- **No install tracking.** `rev_per_install` needs an SDK-side install event and a pipeline
  to carry it. That is its own project; see §4.3 for what happens to the catalog entry
  meanwhile.
- **No billing-address country.** Upholding the existing ruling is a goal, not an omission.
  If country-by-billing is ever wanted it must be a **separately named dimension**, never
  merged into the store-supplied `country` column.
- **No historical country backfill.** See §1.3.
- **No new ClickHouse queries where a service already computes the concept.** This is the
  spec's central constraint; see §4.1.
- **No change to the chart catalog's ids, categories or ordering.** Nothing is added and
  nothing is removed — see §4.3.
- **No new chart types and no change to the rendering layer.** Every wired id must fit a
  chart type the dashboard already draws. If one does not, that is a finding to report, not
  a licence to build a renderer.

---

## 4. Design

### 4.1 Wire the readers through the existing services, never around them

The export module already states the principle it was built on: it "issues zero ClickHouse
queries of its own", because "a second query set drifts from the first over time". The same
rule now binds `readChartSeries`.

For each unwired id, the reader **delegates to the service that already owns the concept**
and reshapes the result into `ChartSeriesResponse`. It does not issue its own SQL for a
number that `mrr.ts` or `ltv.ts` or `subscriptions.ts` already produces. Where a service
exposes a monthly figure and the chart wants a daily series, the fix is to widen that
service's own query, in that service's file, so both callers keep reading the same number.

This is the §4 lesson applied to analytics: the experiments area had two results
implementations that disagreed about which one shipped, and the fix was to delete one. Do
not create the analytics version of that.

**Consequence to accept:** some ids will need their service widened, and a widened service
must keep its existing caller's behaviour identical. That is a constraint on the change, not
a reason to fork the query.

### 4.2 `supported: false` must remain reachable and honest

The `default` branch stays. An id that genuinely has no reader must keep returning
`supported: false` with zero ClickHouse round-trips — it is what makes the export's coverage
claim checkable rather than aspirational. What changes is how few ids reach it.

The schema-contract harness (`schema-contract.integration.test.ts`) must cover every newly
wired reader. That harness exists because §5 previously shipped a reader querying columns
that never existed, green in CI because every test mocked the client.

### 4.3 `rev_per_install` STAYS in the catalog, documented

An earlier draft removed it. Measurement reversed that, and the reasoning is worth keeping
because it is a precedent that does **not** transfer:

- The `estimated_proceeds` defect the previous §5 batch fixed was an entry with **no i18n
  label**, which rendered as the literal string `charts.items.estimated_proceeds` and then
  dead-ended. **All sixteen ids including `rev_per_install` have labels** — checked against
  `en.json`. So it renders a proper name.
- The dashboard already distinguishes `supported: false` from "supported but every day came
  back null" (`series-chart-panel.tsx:149-150`) — a deliberate design, not an oversight. The
  unsupported state is an honest "no reader for this yet", not a broken chart.
- **`isSystemChartId` is what reserves the id.** System charts are read-only (`403`) and
  undeletable (`charts.ts:277`, `:310`). Removing `rev_per_install` from `SYSTEM_CATALOG`
  frees that name for a user-created custom chart, which is a namespace regression in
  exchange for nothing.

So it stays, with a comment at the entry naming what would have to exist first — an SDK-side
install event and a pipeline to carry it — and it keeps returning `supported: false`. It is
the one id §4.2's honest-default branch exists for.

### 4.3b Units and currency are part of being correct, not decoration

`ChartSeriesResponse` carries a `unit`, and the `default` branch hands back `"count"` for
everything it does not know. A money series returned as a count renders as a bare number
with no currency and is a display bug that looks like a data bug.

Every wired id declares its real unit, and **money series are USD**, because the pipeline
normalises to `amountUsd` — the same normalisation `summary.ts` and `proceeds.ts` already
rely on. Say so at the reader so nobody later wires a local-currency figure into the same
field. Rate-style ids (`churn`, `trial_to_paid`, `paywall_view_rate`) are fractions, not
percentages, unless the existing card already shows percentages — match the card.

### 4.3c The export gets roughly seven times the work per request

`export.ts` iterates `SYSTEM_CHART_IDS` and today does real work for two of them. Wiring
thirteen more multiplies the per-request cost on a **streaming** endpoint whose documented
behaviour is to emit `# error: <message>` and close with HTTP 200 if a reader throws
mid-stream.

That is a real change in cost, not a rounding error. The plan must measure the export's
wall-clock before and after on a project with data, and say the number. If it becomes
unreasonable, the answer is to run the readers concurrently — the `paywall_view_rate` reader
already sets that precedent with `Promise.all` — not to quietly drop ids from the export.

### 4.4 The commission-rate settings UI

A small form on the project settings surface — `apps/dashboard/src/components/projects/SettingsForm.tsx`,
which just gained `holdoutPercentage` and is the established home for per-project settings —
one row per store, offering
`COMMISSION_RATE_PRESETS` as choices with their sourced citations visible and a free entry
for anything else. It writes through the existing audited endpoints; no new API.

Two honesty requirements carried from the previous batch:

- A store with no configured rate must keep reading "not configured — proceeds unknown"
  rather than defaulting to a preset. **Offering a default is not the same as assuming
  one**, and proceeds are money.
- The preset citations exist in `proceeds.ts` and should be shown, not summarised. An
  operator choosing 15% vs 30% is making a claim about their App Store Small Business
  Program status.
- **Match the role gate the existing endpoint already enforces.** The commission-rate routes
  call `assertProjectAccess` with a role; the form must not become a wider door than the API
  it writes through. Read the route and mirror it — do not invent a gate.

### 4.5 Close §5's two unbuildable items in the roadmap

Replace both roadmap lines with what recon established: the Stripe half is a **deliberate
ruling** (billing address is not a storefront) with the call-site reference, and the backfill
is **impossible from retained data** and would require a three-party re-verification
campaign. Whoever reads §5 next should not have to re-derive either.

---

### 4.6 Per-id backing verification is the first deliverable, not a spec claim

Before any reader is written, each unwired id gets a one-line answer to: *which existing
function already computes this, and does its output match what the catalog entry promises?*
The output is a table — id, backing function, unit, and whether the concept matches or only
the name does.

This exists because §1.1's grouping came from a grep, and a grep matches names, not
behaviour. Two ids (`arpu`, `new_subs`) are already flagged as unconfirmed, and
`retention_curve`'s backing turned out to live outside `services/metrics` entirely. **An id
whose backing turns out not to exist is a finding to report, not a licence to write new
SQL** — the whole point of §4.1 is that a second query set drifts from the first.

## 5. Data changes

**None expected.** Every wired id reads data that already lands in ClickHouse. If any id
turns out to need a column that does not exist, that is a finding to report before writing a
migration — it would mean the catalog advertises something the pipeline never carried, which
is a different problem from an unwired reader.

## 6. Risks and decisions worth stating

- **Widening a shared service risks its existing caller.** Every service touched keeps a
  test proving its current caller's numbers are unchanged.
- **Sixteen ids is a large surface for one plan.** Group them by the service that backs
  them, and let each group be independently testable; do not write one reader per task.
- **`retention_curve` and `ltv` already have dashboard surfaces** (`/cohorts`,
  `PredictedLtvCard`) fed by their own routes. Wiring the catalog id must produce the SAME
  numbers as the card, or the product now disagrees with itself in two places — assert that
  equality in a test rather than eyeballing it.
- **Some ids may be genuinely ambiguous** (`gross_vs_net` and `arpu` each have more than one
  defensible definition). Pick the one the existing dashboard card already shows, and say so
  at the reader — an analytics number whose definition lives only in a reviewer's head is
  the failure this area keeps having.

## 7. Acceptance criteria

1. Every catalog id whose backing §4.6 confirms returns a real series with points over a
   window containing data. Any id §4.6 finds unbacked is reported with its reason and left
   returning `supported: false` — an honest gap, not a fabricated series.
2. No newly wired reader issues its own ClickHouse SQL for a concept an existing service
   already computes — demonstrated by the diff, which should add delegations and reshaping,
   not queries.
3. Where a service was widened, its pre-existing caller returns identical numbers, proven by
   a test that existed before the change or was added to pin it.
4. `rev_per_install` remains in `SYSTEM_CATALOG` with a comment naming what would have to
   exist to back it, and still returns `supported: false`.
5. `readChartSeries`'s `default` branch still returns `supported: false` with zero
   ClickHouse round-trips.
6. Every newly wired reader is registered in the schema-contract harness and its tests
   execute real SQL against a testcontainer ClickHouse, not a mocked client.
7. `retention_curve` and `ltv` series match the numbers their existing dashboard cards show,
   asserted in a test.
8. A commission rate can be set and cleared from the dashboard for each store; a store with
   no rate still reports proceeds as unknown rather than assuming a preset.
9. ROADMAP §5's two unbuildable items are closed with their reasons — the Stripe billing-
   address ruling and the absence of any retained country or store payload to backfill from.
10. Every wired series declares its real `unit`, money series are USD, and a test pins at
    least one money id and one rate id against the card that already displays them.
11. The export's wall-clock is measured before and after on a project with data, and the
    number is reported.
12. The commission-rate form enforces the same role gate as the endpoint it writes through.
