# Analytics — Closing §5: the Last Four Catalog Ids

Date: 2026-09-04
Area: ROADMAP §5 (Analytics), final open item
Status: design approved, implementation to follow

The chart catalog has sixteen system ids. Twelve returned a real series
after the 2026-09-03 coverage plan; four still answer `supported: false`.
This spec closes all four and, with them, §5.

The four are **not one backlog item**. They failed for three unrelated
reasons, and each reason turned out to be a different kind of claim:

| id | prior ruling | what reconnaissance found |
|---|---|---|
| `rev_per_install` | "no install event exists anywhere in the product; needs SDK work first" | An install signal already exists server-side and is already historical. No SDK work. |
| `liability` | "no balance history is retained anywhere; a line would be fabricated" | `credit_ledger` is append-only and stores the post-mutation balance *and* the signed delta. History is measurable, not fabricated. |
| `retention_curve`, `ltv` | "cohort-shaped; forcing them onto a date axis fabricates dates" | Correct, and unchanged. The gap is that the **series contract cannot declare any axis but a date**. Fix the contract, not the metrics. |

Two of the three prior rulings were right about the data and wrong about
the conclusion. The third was right about everything and named its own
fix ("this is a catalog modelling gap, not a wiring gap").

---

## 1. Context — what reconnaissance found

### 1.1 `rev_per_install` — the install signal is already in Postgres

`resolveOrCreateSubscriber` (`apps/api/src/lib/resolve-or-create-subscriber.ts`)
is the **only** subscriber-creation path reachable from the SDK's public-key
`/v1` surface (`app-user-context` middleware, `sdk-sessions`, `experiments`,
`events`). It writes the SDK-reported `platform` into `attributes` **on
create only** — the conflict path never touches attributes — precisely so
it stays "immutable first-install truth" (its own doc comment).

The importer refuses to write it, in writing:

```
// 6. NEVER set `subscribers.platform`. It is SDK first-install truth and
```
— `apps/api/src/services/import/write.ts:37`

So "a subscriber row created through the SDK path" is an install, the
product has always recorded it, and `subscribers.firstSeenAt` dates it.
What was missing was a *reader*, not an event.

Two defects in reading it off `attributes` directly, which is why this
spec adds a column instead:

1. **GDPR erasure clears `attributes`** (`anonymize-subscriber.ts:19`:
   "attributes JSON is cleared"). Keying installs off the platform
   attribute would make an aggregate install count *shrink retroactively*
   every time someone exercised erasure. An install count is not personal
   data; it must not move when a person is erased.
2. The platform header is façade-supplied. A façade that omits it would
   silently under-count installs, even though the SDK path is what
   actually happened.

### 1.2 `liability` — `credit_ledger` is the history

`credit_ledger` is DB-enforced append-only, range-partitioned monthly on
`createdAt`, and each row stores **both** a signed `amount` and the
`balance` *after* that mutation ("invariant-by-construction", schema
comment). `readOutstandingBalance` sums the latest balance per
(subscriber, currency) wallet — today's authoritative figure.

Given an append-only signed delta log, the balance at any past instant is
recoverable by walking today's authoritative total backwards through the
deltas booked since. That is arithmetic on retained rows, not a
reconstruction "no service owns".

### 1.3 `retention_curve` and `ltv` — the contract has one axis

`ChartSeriesPoint.bucket` is documented as an ISO calendar date, and
`ChartSeriesResponse` has no way to say anything else. Both metrics are
cohort-shaped: `computeRetention` (`services/cohorts.ts`) yields
period-since-join points, and `ltv`'s own label is "LTV by cohort". The
catalog declares `chartType: "line"` for both — which is *right*: they
are lines. They are lines over **periods since cohort start**, and the
response type cannot say so.

---

## 2. Goals

- All sixteen system catalog ids return a real, measured series.
- The series contract can express a cohort-period x-axis without
  overloading the date field.
- Every new reader delegates to the service that owns the concept;
  `charts.ts` gains no SQL of its own (the §5 rule, unchanged).
- Install counts survive GDPR erasure; erasing a person removes the
  person, not the aggregate.
- The metrics export streams all sixteen, including the two
  period-axis ones.
- ROADMAP §5 closes.

## 3. Non-goals

- **No SDK release.** Nothing in this spec requires a new SDK build on any
  of the five platforms.
- **No install *event*.** Installs are counted from subscriber creation,
  not from a new telemetry event type. If per-device install telemetry is
  ever wanted, it is a separate feature with a separate name.
- **No historical `paidReserveUsd`.** The credits rollup's USD reserve
  needs an average credit price derived from a *window's* revenue; there
  is no such thing "as of last March". The `liability` chart is the
  outstanding credit balance, in credits.
- **No cohort-rule UI on `/charts`.** The two cohort charts use one fixed,
  documented cohort (the acquisition cohort of the selected window).
  `/cohorts` remains the place to build arbitrary cohorts.
- **No backfill of installs for already-anonymized rows.** Their
  attributes are gone; the data is not recoverable and will not be
  guessed.

---

## 4. Design

### 4.1 `subscribers.sdkInstalledAt` — one nullable timestamp

New column, `timestamptz NULL`, written **only** by
`resolveOrCreateSubscriber` on the create branch, never on conflict,
never on update, never by the importer, never by a webhook.

- `NULL` means "this subscriber row was not created by an SDK client":
  importer rows, S2S-created rows, store-webhook-created rows.
- Non-NULL is the instant the SDK first created the row — equal to
  `firstSeenAt` at create time, and kept as its own column so it survives
  `anonymize-subscriber`'s attribute clear.
- Immutable by construction, exactly like the `platform` attribute it
  generalises: `upsertSubscriber`'s conflict path leaves it alone.

**Backfill (in the migration):**

```sql
UPDATE subscribers SET "sdkInstalledAt" = "firstSeenAt"
 WHERE "sdkInstalledAt" IS NULL AND attributes ? 'platform';
```

The predicate is the pre-existing SDK-only marker from §1.1, so the
backfill is sourced, not inferred. It covers every SDK-created subscriber
whose attributes still exist. Rows anonymized before this migration stay
NULL — stated in §3, not silently papered over.

**Index:** partial, `(projectId, sdkInstalledAt) WHERE "sdkInstalledAt"
IS NOT NULL` — the reader's only access path, and the partial predicate
keeps importer-heavy projects out of the index entirely.

Why a column rather than the `attributes ? 'platform'` predicate: §1.1's
two defects. Why not reuse `platform` for the value: the platform of an
install is a separate question from whether an install happened, and the
attribute is still there for the former.

### 4.2 `rev_per_install` — a daily ratio, both inputs exposed

New service `apps/api/src/services/metrics/installs.ts` owns the concept:
`getInstallsDaily(projectId, window)` → one Postgres `COUNT` grouped by
`date_trunc('day', "sdkInstalledAt")`. It is the only place in the
codebase that defines what an install is.

The reader divides the day's **net** revenue by the day's installs:

- numerator: `listDailyMrr`'s `netUsd` (the same source `arpu` and
  `gross_vs_net` already delegate to — no second revenue query).
- denominator: `getInstallsDaily`.
- `unit: "money"`, `numerator`/`denominator` populated so the panel can
  show "$3,412 ÷ 1,204 installs".
- installs = 0 → `value: null` (the contract's documented "undefined for
  that day", distinct from a measured 0).

**This is same-day revenue over same-day installs** — a daily efficiency
ratio, *not* lifetime revenue attributed to an install cohort. The
cohort-attributed question is exactly what `ltv` now answers (§4.5), and
the two are documented as complements at both call sites. Choosing the
same-day form deliberately: it needs no attribution model, and every
input is measured on the day it is plotted.

Postgres-backed, so — like `trials_started` and `churn` — the ClickHouse
schema-contract harness cannot guard it. It gets a real-Postgres
integration test, per §5's own standing note.

### 4.3 `liability` — walk today's authoritative total backwards

`getCreditLiabilityDaily(projectId, window)` lands in `credits.ts`, the
service that already owns `readOutstandingBalance`.

```
liability(D) = outstanding_now − Σ { amount : createdAt > end_of_day(D) }
```

Two reads: the existing latest-balance-per-wallet query, plus one
`SUM(amount) GROUP BY day` over the window. Then a right-to-left running
subtraction in TypeScript.

Three properties this shape buys, all deliberate:

1. **The last point equals `/credits`'s gauge by construction**, not by
   coincidence — same query, zero drift. Pinned by test.
2. **It reads no row outside the window.** `credit_ledger` is monthly
   range-partitioned; a forward `SUM` from zero would silently lose its
   opening balance the day an old partition is detached. The backwards
   walk cannot.
3. It uses `amount` (the signed delta), while the anchor uses `balance`
   (the post-mutation running total). The two agreeing on the final point
   is the ledger's own invariant, and the integration test asserts it
   against real Postgres rather than assuming it.

`unit: "count"` — credits are a unit of account, not USD, the same ruling
`credit_burn` already carries. All currencies summed, matching the
existing gauge's default.

### 4.4 The series contract learns about axes

`packages/shared/src/dashboard.ts`:

```ts
export type ChartSeriesAxis = "date" | "period";
export type ChartSeriesPeriodGranularity = "day" | "week" | "month";

// unchanged
export interface ChartSeriesPoint { bucket: string; value: number | null;
                                    numerator?: number; denominator?: number }

export interface ChartSeriesPeriodPoint {
  /** 0-based periods SINCE COHORT START. Not a date, deliberately. */
  period: number;
  value: number | null;
  numerator?: number;
  denominator?: number;
}

export type ChartSeriesResponse =
  | (ChartSeriesBase & { axis: "date";   points: ChartSeriesPoint[] })
  | (ChartSeriesBase & { axis: "period";
                         periodGranularity: ChartSeriesPeriodGranularity;
                         points: ChartSeriesPeriodPoint[] });
```

`axis` is **required**, not optional-with-a-default. A required
discriminator makes the compiler walk every existing reader and every
consumer; an optional one would let a period-shaped reader ship claiming
to be dated, which is the exact bug the field exists to prevent. The
thirteen date readers set it once, in `readChartSeries`'s shared `base`.

`ChartSeriesPoint` keeps its name and shape — no churn on twelve working
readers.

### 4.5 `retention_curve` and `ltv` — one cohort, two curves

Both live in `cohorts.ts`, which owns period-since-join math and the rule
compiler. Both use the **same** cohort so the two charts can be read side
by side: subscribers whose first revenue event falls inside the selected
window (a `CohortRule` carrying `firstSeenAfter`/`firstSeenBefore` bounds
— the existing DSL, no new filter fields).

- **Granularity follows the window**, via named constants, so a 6M window
  does not ask for 12 daily periods: ≤ 62 days → `day`, ≤ 186 days →
  `week`, else `month`.
- **12 periods** (`CATALOG_COHORT_PERIODS`), within `MAX_PERIODS`'s 24.
- `retention_curve`: `unit: "percent"`, `value` = retained share,
  `numerator` = active, `denominator` = cohort size. Delegates to
  `computeRetention` unchanged.
- `ltv`: `unit: "money"`, `value` = cumulative net USD per cohort member
  at period N — the standard LTV curve. New
  `computeCohortLtvCurve` beside `computeRetention`, reusing its
  membership CTE and `dateDiff` bucketing; net = purchases minus
  refunds/chargebacks, the same sign convention as `mv_mrr_daily`.
- Empty cohort → `size: 0` → every point `null`, never `0`. A cohort with
  no members has an undefined retention, not a zero one.

`/cohorts` keeps the arbitrary-rule heatmap. This is the fixed-cohort
line-chart view of the same truth, and the catalog's `chartType: "line"`
is now accurate for both.

### 4.6 Consumers

- **Export** (`export.ts`): one new `period` CSV column. Series rows fill
  `bucket` or `period`, never both. The long/tidy format was chosen for
  exactly this kind of grain mismatch; this is that design being used, not
  bent. `unit` mapping unchanged.
- **Dashboard** (`series-chart-panel.tsx`): x-axis labels come from the
  period index and granularity (`D0`/`W0`/`M0` …) when `axis === "period"`;
  the date path is untouched.
- **`supported: false` stays reachable and stays tested.** Every *system*
  id is now supported, but the dispatcher's `default` — unknown ids,
  custom-chart ids — still returns `supported: false`, `axis: "date"`,
  zero ClickHouse round-trips. The panel's empty-state test is kept for
  that path.

### 4.7 The comments that currently assert the opposite

`charts.ts`'s dispatcher header and three `chart-catalog.ts` entry
comments state at length that these ids *cannot* be wired. Those comments
were correct records of earlier rulings and are now false. Each is
rewritten to say what the id does and why it is shaped the way it is —
not deleted silently, and not left contradicting the code beneath it.

---

## 5. Data changes

One migration (next free number; the working tree already holds an
unrelated `0115`):

1. `ALTER TABLE subscribers ADD COLUMN "sdkInstalledAt" timestamptz`
2. The sourced backfill from `attributes ? 'platform'` (§4.1)
3. Partial index `(projectId, sdkInstalledAt) WHERE "sdkInstalledAt" IS NOT NULL`

No ClickHouse migration. No new table. No new event type. Generated with
`db:migrate:generate` and then inspected — hand-written DDL must be kept
out of the generated file, and the enum re-export footgun re-checked
before committing.

---

## 6. Risks and decisions worth stating

- **Installs under-count before the backfill's reach.** Any SDK-created
  subscriber anonymized before this migration is invisible to the install
  series forever. Accepted and documented; the alternative is inventing
  rows.
- **Installs are subscriber-first-contact, not device installs.** A
  reinstall that clears the SDK's local cache creates a new anonymous
  subscriber and counts again; a reinstall that restores the cache does
  not. Two merged subscribers stay two installs — merging identities is
  not an un-install. This is the honest meaning of the number and belongs
  in the metric's doc comment, not in a footnote nobody reads.
- **The liability walk trusts the ledger's own invariant** that `balance`
  is the running sum of `amount`. If a future write path ever clamps one
  without the other, the series and the gauge diverge. That is why the
  final point is asserted against `readOutstandingBalance` on real
  Postgres — the test fails the day the invariant does.
- **A required `axis` is a breaking type change** for anything consuming
  `ChartSeriesResponse` outside this repo. There is nothing outside this
  repo; the wire addition is additive for older clients.
- **The two cohort charts answer a fixed question.** Users cannot slice
  them by store or country from `/charts`. That is a deliberate scope
  line, not an oversight — the rule builder lives on `/cohorts`.

---

## 7. Acceptance criteria

1. All sixteen system catalog ids return `supported: true` with measured
   points; a test enumerates `SYSTEM_CHART_IDS` and asserts it, so a
   future id cannot be added without either a reader or a deliberate
   exception.
2. An unknown chart id still returns `supported: false`, `axis: "date"`,
   and issues zero ClickHouse queries (existing test, still green).
3. `rev_per_install` reports `null`, not `0`, on a day with no installs;
   its integration test proves an importer-created subscriber is **not**
   counted and an SDK-created one **is**.
4. `liability`'s final point equals `getCreditsRollup`'s outstanding
   balance, asserted against real Postgres.
5. `retention_curve` and `ltv` return `axis: "period"` with a declared
   granularity, and no response anywhere carries a `bucket` that is not a
   calendar date.
6. The export streams all sixteen; period-axis rows carry `period` and an
   empty `bucket`.
7. `pnpm --filter @rovenue/api test`, `--filter @rovenue/dashboard test`,
   `--filter @rovenue/shared test` green; `pnpm build` green.
8. ROADMAP §5's last open item is checked off and the section marked
   closed, with the three rulings this spec overturns named as overturned
   rather than quietly dropped.
