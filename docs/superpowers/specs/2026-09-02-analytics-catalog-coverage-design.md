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

**The data mostly exists already.** `services/metrics/` holds `mrr.ts`,
`mrr-decomposition.ts`, `ltv.ts`, `ltv-extrapolation.ts`, `ltv-prediction.ts`,
`subscriptions.ts`, `summary.ts`, `credits.ts`, `engagement.ts` and `overview.ts`. Thirteen
of the fourteen unwired ids name a concept one of those services already computes. This is
a **wiring** job, not new analytics — the same shape as the §4 work that just landed.

### 1.2 Item C's exception — `rev_per_install` has no backing data at all

`grep -rni install` across `services/metrics/` and the ClickHouse migrations returns exactly
one hit that is not the word "fresh install" in a migration comment: **the catalog entry
itself**. There is no install event, no first-seen counter, and nothing in the SDK feeding
one.

So one of the sixteen ids cannot be wired without first building install tracking, which is
an SDK-and-pipeline project of its own.

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
- **No change to the chart catalog's ids, categories or ordering**, beyond §4.3's single
  removal.

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

### 4.3 `rev_per_install` leaves the catalog

A rail entry that renders and leads nowhere is worse than no entry — the previous §5 batch
fixed exactly this defect for `estimated_proceeds`, which showed a raw i18n key and
dead-ended. `rev_per_install` cannot be backed without install tracking, so it comes out of
`SYSTEM_CATALOG`, with a comment saying what would have to exist first.

Removing it is not a loss of function: it has never returned a point.

### 4.4 The commission-rate settings UI

A small form on the project settings surface, one row per store, offering
`COMMISSION_RATE_PRESETS` as choices with their sourced citations visible and a free entry
for anything else. It writes through the existing audited endpoints; no new API.

Two honesty requirements carried from the previous batch:

- A store with no configured rate must keep reading "not configured — proceeds unknown"
  rather than defaulting to a preset. **Offering a default is not the same as assuming
  one**, and proceeds are money.
- The preset citations exist in `proceeds.ts` and should be shown, not summarised. An
  operator choosing 15% vs 30% is making a claim about their App Store Small Business
  Program status.

### 4.5 Close §5's two unbuildable items in the roadmap

Replace both roadmap lines with what recon established: the Stripe half is a **deliberate
ruling** (billing address is not a storefront) with the call-site reference, and the backfill
is **impossible from retained data** and would require a three-party re-verification
campaign. Whoever reads §5 next should not have to re-derive either.

---

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

1. Every catalog id except the one removed by §4.3 returns a real series with points over a
   window containing data.
2. No newly wired reader issues its own ClickHouse SQL for a concept an existing service
   already computes — demonstrated by the diff, which should add delegations and reshaping,
   not queries.
3. Where a service was widened, its pre-existing caller returns identical numbers, proven by
   a test that existed before the change or was added to pin it.
4. `rev_per_install` is gone from `SYSTEM_CATALOG`, with a comment naming what would have to
   exist to bring it back.
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
