# ROADMAP §12 — Feature breadth (85 → 95)

Date: 2026-09-04
Branch: `roadmap-12-feature-breadth`
Status: approved design, ready for planning

## Scope

The four §12 checkboxes:

1. Feature flags: percentage rollout + kill switch
2. Real-time audience segment updates
3. Leaderboards: season/reset automation
4. Subscription-renewing credit grant automation (merges with the PR3
   `product_currency_grants` work)

Investigation found item 1 already implemented end-to-end. Items 2–4 are real
gaps of three quite different sizes. Each is an independent sub-project; they
share no tables and no code, so they can be built and reviewed in any order.

## Non-goals

- No SDK-facing leaderboard score submission. Leaderboards stay derived from
  the analytics ClickHouse already ingests. The schema carries no
  `source` discriminator; adding submitted scores later is a new design.
- No materialized `subscriber_audience_memberships` table, no
  `audience.entered` / `audience.exited` webhook events, no
  audience-membership read API. §12.2 is scoped to push-on-attribute-change
  only.
- No changes to the two existing ad-hoc leaderboard endpoints
  (`top-spenders`, `top-consumers`) or the dashboard page that consumes them.
- No new SDK surface in Swift / Kotlin / RN / Flutter. Every change here is
  server-side or dashboard-side; the SDK sees §12.2 through the existing
  `/v1/config/stream` it already consumes.

## Global constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. Every threshold, window, limit and trigger-type set is a
  named exported constant. Structured data tables (cadence → duration, the
  grant-trigger matrix) are data, not magic values, and stay as tables.
- Migrations start at `0120`; `0119_subscriber_access_reconciliation` is the
  current head. Numbers are assigned in **build** order, not in the order the
  sub-projects appear in this document — see Sequencing. Filenames below are
  written as `01xx_<name>` for that reason.
- Postgres access through Drizzle repositories only. Raw `sql` only where
  genuinely necessary, and with columns qualified (`"leaderboards"."id"`),
  never bare `${table.col}` — that renders unqualified and breaks correlated
  subqueries.
- Tests that claim a concurrency, rollback or cross-service property must run
  against real infrastructure (testcontainers Postgres / ClickHouse, real
  Redis), not mocks. A test whose failure mode is "the mock was wrong" proves
  nothing.
- Throttled test runs: `nice -n 19 npx vitest run --maxWorkers=2`, builds with
  `--concurrency=2`, strictly sequential.
- Any new enum must be re-exported from `packages/db/src/drizzle/schema.ts`,
  or `drizzle-kit` emits a spurious `DROP TYPE` on the next generate.

---

## Sub-project 1 — Feature flags: verify, do not build

### Finding

Both halves of the checkbox already exist:

| Capability | Where |
|---|---|
| Kill switch | `feature_flags.isEnabled`; `evaluate()` in `apps/api/src/services/flag-engine.ts` returns `flag.defaultValue` immediately when false; `POST /dashboard/feature-flags/:id/toggle` flips it with an audit entry and a cache invalidation; `flag-toggle.tsx` and `kill-banner.tsx` in the dashboard. |
| Percentage rollout | Per-rule `rolloutPercentage` (0–1) evaluated through `isInRollout` in `packages/shared/src/experiments/bucketing.ts`, salted per rule index so two staged rules target independent cohorts; `rollout-bar.tsx` and the rule editor in `flag-form.tsx`. |

`isInRollout` is `bucket < percentage * BUCKET_COUNT` over a stable
`assignBucket(subscriberId, seed)` hash, so a rollout is monotone: raising the
percentage only ever adds subscribers, and a subscriber already inside a
cohort stays inside it. That is the sticky-bucketing property the roadmap item
wants, and it holds by construction.

### Work

One regression test file, `apps/api/tests/flag-engine.rollout-kill.test.ts`,
pinning the two properties that no existing test asserts end-to-end:

1. **Kill switch dominates rules.** A flag with `isEnabled: false` and a rule
   that would match returns `defaultValue`, not the rule value — through
   `evaluateFlag` *and* through `evaluateAllFlags` (which skips disabled flags
   entirely, a different code path).
2. **Rollout is monotone.** For a fixed population of subscriber ids, the set
   admitted at 30% is a subset of the set admitted at 60%, which is a subset
   of the set at 100%. Asserted as a real subset relation over a few hundred
   generated ids, not a spot check on one id.

Then tick the checkbox with a note that the item was already implemented.

---

## Sub-project 2 — Real-time audience segment updates

### Current behaviour

`publishConfigInvalidation(projectId)` publishes `{ projectId }` on the
`rovenue:experiments:invalidate` Redis channel. `GET /v1/config/stream`
subscribes, and on any message for its project re-runs
`evaluateSubscriberConfig` and pushes fresh `{ flags, experiments }`.

Publishers today are all *config CRUD*: flag create/update/toggle/delete,
audience CRUD, experiment transitions. Audience rules themselves are evaluated
live against subscriber attributes on every request, so a rule change
propagates immediately.

### Gap

A subscriber's **attributes** changing is what actually moves that subscriber
between segments, and it publishes nothing. A device with an open stream that
posts `{ plan: "pro" }` keeps receiving its old segment's config until the
stream reconnects or something unrelated invalidates the project.

There are exactly three attribute write paths:

| Path | File |
|---|---|
| `POST /v1/subscribers/:appUserId/attributes` | `apps/api/src/routes/v1/subscribers.ts:163` |
| `POST /v1/me/attributes` | `apps/api/src/routes/v1/me.ts:96` |
| read-then-upsert merge inside `/v1/config` | `apps/api/src/services/subscriber-config.ts:61` |

Plus `POST /v1/subscribers/transfer`, which does not write attributes but does
change which row a device's identity resolves to.

### Design

**Message shape.** Widen the channel payload to
`{ projectId: string; subscriberIds?: string[] }`. Absent `subscriberIds` means
project-wide — every existing publisher keeps its current call signature and
its current meaning, so this is backward compatible by construction. Present
means only streams for those subscribers re-evaluate.

A stream that receives a message it does not match does no work at all: no
Postgres read, no ClickHouse read, no push. This is the point of the change —
attribute writes are far more frequent than config CRUD, and waking every
stream in a project on each one would be worse than the gap it closes.

**New publisher.** `publishSubscriberInvalidation(projectId, subscriberIds)` in
`apps/api/src/lib/config-invalidation.ts`, alongside the existing
project-wide one. Best-effort like its sibling: a publish failure means the
device picks the change up on its next poll or reconnect, never an error to
the caller.

**Identity.** Streams must match on the resolved **subscriber row id**, not the
`appUserId` they were opened with — a device can address itself by rovenueId
or by external id, and a `/transfer` merge changes which row either resolves
to. So:

- `evaluateSubscriberConfig` returns the resolved `subscriberId` alongside
  `{ flags, experiments }`. The stream stores the id from its most recent
  evaluation and matches invalidations against that.
- `transferSubscriber` publishes an invalidation naming **both** the retired
  row id and the surviving one, so a device still holding the dead id is woken
  and re-resolves onto the survivor on its next evaluation.

**Loop guard.** `subscriber-config.ts` is called *by* the stream. If it
published unconditionally, every push would trigger another evaluation, which
would publish again — the same shape as the `refreshX()`-inside-the-`XCHANGED`
listener bug. It is safe today only by accident: the stream passes
`requestAttributes: {}`, so `hasNewAttributes` is false. The design makes that
explicit — the publish is guarded on `hasNewAttributes && !deadEnded`, the
same condition that already guards the write — and a test asserts that a
stream's own re-evaluation publishes nothing. That test fails if someone later
makes the stream forward attributes, which is exactly when the loop would
reappear.

**Coalescing.** A burst of attribute writes for one subscriber must not become
a burst of pushes. Each stream coalesces on a trailing edge: an invalidation
schedules a re-evaluation at most once per `CONFIG_STREAM_COALESCE_MS`, and
invalidations arriving inside that window collapse into the pending one. Note
this bounds push *rate*, not correctness — the trailing evaluation always
reads current state, so the last push in a burst is always right.

### Files

- `apps/api/src/lib/config-invalidation.ts` — message type, new publisher.
- `apps/api/src/routes/v1/config-stream.ts` — subscriber matching, coalescing.
- `apps/api/src/services/subscriber-config.ts` — return resolved id; guarded
  publish.
- `apps/api/src/routes/v1/subscribers.ts`, `apps/api/src/routes/v1/me.ts` —
  publish after a successful attribute write.
- `apps/api/src/services/subscriber-transfer.ts` — publish both ids.

### Tests

- Unit: a per-subscriber message wakes only the matching stream; a
  project-wide message wakes all streams; an unmatched message does zero work.
- Unit: the loop guard — evaluating with empty `requestAttributes` publishes
  nothing.
- Unit: coalescing — N invalidations inside the window produce one
  re-evaluation, and that evaluation observes the latest state.
- Integration (real Redis): write attributes through
  `POST /v1/subscribers/:appUserId/attributes` while a stream is open, and
  assert the stream receives a push whose flags reflect the new segment. This
  is the only test that proves the feature; the unit tests above pin the
  pieces.
- Integration (real Redis): after `/transfer`, a stream opened on the retired
  id is woken and its next evaluation resolves onto the survivor.

---

## Sub-project 3 — Leaderboard seasons

### Current behaviour

`apps/api/src/routes/dashboard/leaderboards.ts` exposes two endpoints,
`top-spenders` (sum of `amountUsd` from `raw_revenue_events`) and
`top-consumers` (sum of debited credits from `raw_credit_ledger`), each taking
an explicit `from`/`to` day range and a `limit`. There is no leaderboard
object, no Postgres table, no persistence, no season concept. The dashboard
page passes a date range picker straight through.

### Design

Three new tables (migration `01xx_leaderboard_seasons.sql`).

**`leaderboards`** — the configuration object.

| Column | Notes |
|---|---|
| `id` | cuid2 |
| `projectId` | FK → projects, cascade |
| `identifier` | unique per project; the stable key |
| `name` | display |
| `metric` | new enum `LeaderboardMetric`: `TOP_SPENDERS` \| `TOP_CONSUMERS` |
| `currencyId` | nullable FK → virtual_currencies. Only meaningful for `TOP_CONSUMERS`; null means "all currencies", matching today's query |
| `cadence` | new enum `LeaderboardCadence`: `WEEKLY` \| `MONTHLY` \| `CUSTOM` |
| `customPeriodDays` | nullable int; required and >0 when cadence is `CUSTOM`, must be null otherwise (CHECK constraint) |
| `timezone` | IANA name, default `UTC` |
| `entryLimit` | int, default `LEADERBOARD_DEFAULT_ENTRY_LIMIT` |
| `anchorAt` | when the first season starts |
| `isEnabled` | bool, default true |
| `createdAt` / `updatedAt` | |

`timezone` is not decoration: a weekly leaderboard for a Turkish app must roll
at local midnight, and a UTC-only boundary would cut Saturday evening in half.
Boundary arithmetic is done in the leaderboard's timezone and stored as UTC
instants, per the repo-wide "timestamps UTC" convention.

**`leaderboard_seasons`**

| Column | Notes |
|---|---|
| `id` | cuid2 |
| `leaderboardId` | FK → leaderboards, cascade |
| `seasonNumber` | int, 1-based; unique with `leaderboardId` |
| `startsAt` / `endsAt` | UTC instants; `endsAt` exclusive |
| `status` | new enum `LeaderboardSeasonStatus`: `ACTIVE` \| `CLOSED` |
| `closedAt` | nullable |
| `createdAt` | |

Partial unique index on `(leaderboardId) WHERE status = 'ACTIVE'`. This is the
load-bearing constraint: it makes "two API replicas both open a season" a
database error rather than a data corruption, without any application-level
locking.

**`leaderboard_standings`** — the frozen snapshot, append-only in practice.

| Column | Notes |
|---|---|
| `id` | cuid2 |
| `seasonId` | FK → leaderboard_seasons, cascade |
| `rank` | int, 1-based; unique with `seasonId` |
| `subscriberId` | text; deliberately **not** an FK — a season's standings must survive a GDPR erase of the subscriber row |
| `score` | numeric as text, to avoid float drift on USD sums and large credit totals |
| `eventCount` | int |

### Worker

`apps/api/src/workers/leaderboard-scheduler.ts`, modelled directly on
`experiment-scheduler.ts` (repeatable BullMQ job, own queue name, own
repeatable job id). Each sweep:

1. **Open missing seasons.** Every enabled leaderboard with no `ACTIVE` season
   and `anchorAt <= now` gets season 1 (or the next number) opened at the
   cadence boundary containing `anchorAt`. Insert relies on the partial unique
   index to reject a concurrent duplicate; a unique violation here is expected
   under concurrency and is logged at debug, not error.
2. **Close due seasons.** For each `ACTIVE` season with
   `endsAt + LEADERBOARD_SNAPSHOT_SETTLE_MS <= now`:
   - claim it with a conditional `UPDATE leaderboard_seasons SET status =
     'CLOSED', closedAt = now WHERE id = $1 AND status = 'ACTIVE' RETURNING *`
     — never a SELECT then an UPDATE, so two replicas cannot both close it;
   - query ClickHouse for the top-N over `[startsAt, endsAt)` using the same
     SQL the existing endpoints use, parameterised by metric;
   - insert standings with `ON CONFLICT (seasonId, rank) DO NOTHING`, so a
     crash partway through the insert re-runs cleanly;
   - `audit()` the close inside the caller's transaction;
   - open the next season starting at `endsAt`.

**Why the settle delay.** ClickHouse is fed asynchronously through Kafka from
the outbox. Snapshotting at the instant a season ends would freeze standings
before the last minutes of events have landed, and the resulting numbers would
be permanently wrong with no way to notice. The worker therefore waits
`LEADERBOARD_SNAPSHOT_SETTLE_MS` past the boundary before snapshotting — while
the *next* season still starts exactly at `endsAt`, so there is no gap in
coverage and no event falls between two seasons. The delay affects only when
the frozen numbers appear, never which events they include.

### API

Extend `apps/api/src/routes/dashboard/leaderboards.ts`:

- `GET|POST /dashboard/projects/:projectId/leaderboards` — list, create
- `GET|PATCH|DELETE /dashboard/projects/:projectId/leaderboards/:id`
- `GET .../leaderboards/:id/seasons` — season list, newest first
- `GET .../leaderboards/seasons/:seasonId/standings` — frozen snapshot
- `GET .../leaderboards/:id/current` — live standings for the `ACTIVE` season,
  computed from ClickHouse over the open season's window; reuses the same SQL
  as the snapshot so live and frozen numbers cannot diverge in shape

Writes require the existing `leaderboards:write` capability via
`assertProjectCapability`;
reads keep the existing `MemberRole.CUSTOMER_SUPPORT` floor. The existing
`top-spenders` / `top-consumers` endpoints are untouched.

The snapshot query and the `/current` query must be **one function** taking a
metric and a window, called from both the worker and the route. Two copies of
this SQL is how a live leaderboard and its own archive end up disagreeing.

### Dashboard

`apps/dashboard/src/routes/_authed/projects/$projectId/leaderboards.tsx` gains
a configured-leaderboards list alongside the existing ad-hoc range view, a
create/edit form, and a season selector (Current | past seasons) that switches
between `/current` and a frozen `standings` fetch.

### Tests

- Unit: cadence → boundary arithmetic, including a DST transition in a
  non-UTC timezone and a month boundary from a 31st anchor.
- Unit: `customPeriodDays` validation both ways (required when `CUSTOM`,
  rejected otherwise).
- Integration (testcontainers Postgres): two concurrent sweeps cannot open two
  `ACTIVE` seasons, and cannot both close one. Asserted against a real
  database, since the property being claimed *is* the database constraint.
- Integration (testcontainers Postgres + ClickHouse): seed revenue and credit
  events either side of a season boundary, run the sweep, and assert the
  frozen standings contain exactly the in-window events — this is what proves
  the settle delay does not shift the window.
- Integration: a sweep interrupted after the claim but before the standings
  insert completes leaves a re-runnable state.

---

## Sub-project 4 — Subscription-renewal credit grants

### Current behaviour

`product_currency_grants` is `(id, productId, currencyId, amount)` with a
unique `(productId, currencyId)`. `grantPurchaseCurrencies` in
`apps/api/src/services/purchase-credits.ts` reads a product's grants and calls
`addCredits` for each, deduping on
`(referenceType: "purchase", referenceId: purchaseId, currencyId)`.

Both call sites gate on `product.type === ProductType.CONSUMABLE`:
`apps/api/src/routes/v1/receipts.ts:69` and
`apps/api/src/services/webhook-processor.ts:304`.

### Gap

A subscription never grants virtual currency — not on its initial purchase and
not on any renewal. "500 coins a month with your Pro subscription" is not
expressible.

### Design

**Schema** (migration `01xx_currency_grant_trigger.sql`): add
`grantOn` to `product_currency_grants`, a new enum `CurrencyGrantTrigger` with
values `PURCHASE`, `RENEWAL`, `BOTH`, `NOT NULL DEFAULT 'PURCHASE'`. Every
existing row therefore keeps exactly today's behaviour, and the migration is
inert on existing databases.

**Service.** `grantPurchaseCurrencies` gains a required
`trigger: "PURCHASE" | "RENEWAL"` argument and filters grants to rows whose
`grantOn` includes that trigger. The mapping is a table
(`GRANT_TRIGGER_MATCHES`), not a chain of conditionals.

The `CONSUMABLE`-only gate at the two existing call sites is removed and
replaced by the honest condition — "does this product have grant rows matching
this trigger". A subscription with no grant rows does nothing; the cost is one
indexed lookup per event.

**Wiring.** There are eight `createRevenueEvent` call sites across Apple,
Google, Stripe, receipt verification, import, Google reconciliation and the
expiry checker. Adding a grant call to each is the failure mode the
store-lifecycle work already paid for once: a per-site mapping is not a
delivery guarantee, and the ninth provider added next year will silently omit
it.

Instead, a single `apps/api/src/services/record-revenue-event.ts` wrapper
becomes the only way a revenue event is written. All eight sites migrate to
it. It writes the event, then — for the granting types only — grants.

Granting types are `RENEWAL`, `TRIAL_CONVERSION` and `REACTIVATION`, hoisted
to `RENEWAL_GRANT_EVENT_TYPES`. `INITIAL` is deliberately excluded: an initial
subscription purchase is the `PURCHASE` trigger, and letting it match both
would double-grant a `BOTH` row on day one.

**Ordering and transactions.** `addCredits` opens its own transaction (it takes
an advisory xact lock and writes ledger plus outbox rows), so it cannot run
inside a caller's transaction. Several call sites are tx-bound. The wrapper
therefore grants *after* the revenue-event write, outside any caller
transaction. That is safe to retry, because `addCredits` dedupes on
`(referenceType: "renewal", referenceId: revenueEventId, currencyId)` — a
distinct `referenceType` from the purchase path, so a consumable purchase and
a renewal can never collide even if ids coincide.

**The residual hole, and the sweeper.** If the process dies between the
revenue-event write and the grant, the grant is lost with nothing to notice.
`apps/api/src/workers/renewal-grant-reconciliation.ts` closes it, in the shape
of the existing `access-reconciliation` worker: sweep revenue events of a
granting type from the last `RENEWAL_GRANT_LOOKBACK_DAYS`, whose product has
at least one `RENEWAL`/`BOTH` grant row, and for which no matching
`credit_ledger` row exists; grant those. Because the grant is idempotent, the
sweeper is safe to run continuously, and a bounded lookback keeps its query
indexed rather than growing without limit.

The sweeper is not a substitute for the wrapper — it is the audit that proves
the wrapper works. Its steady-state result should be zero, and a non-zero
count is a signal worth a metric.

### Dashboard

The product editor's currency-grants section (`routes/dashboard/products.ts`
and its dashboard counterpart) gains a per-row "grant on" selector. A grant
row on a non-subscription product cannot select `RENEWAL` or `BOTH` —
validated server-side, not only in the form.

### Files

- `packages/db/src/drizzle/enums.ts` + `schema.ts` — `CurrencyGrantTrigger`,
  re-exported from `schema.ts`.
- `packages/db/src/drizzle/repositories/product-currency-grants.ts` — trigger
  filter; the sweeper's missing-grant query.
- `apps/api/src/services/purchase-credits.ts` — trigger argument.
- `apps/api/src/services/record-revenue-event.ts` — new wrapper.
- Eight call sites migrated to the wrapper.
- `apps/api/src/workers/renewal-grant-reconciliation.ts` — new.
- `apps/api/src/routes/dashboard/products.ts` + dashboard form.

### Tests

- Unit: the trigger matrix — `PURCHASE` rows grant only on purchase, `RENEWAL`
  only on renewal, `BOTH` on both, and `INITIAL` never takes the renewal path.
- Unit: a subscription product with no grant rows performs no writes.
- Integration (testcontainers Postgres): a renewal grants once; replaying the
  same webhook grants nothing further. The replay must go through the real
  webhook path, not a hand-built duplicate call — the dedup being tested is
  the one a real Apple retry would hit.
- Integration: the sweeper finds and repairs a revenue event whose grant was
  dropped, and is a no-op on a second run.
- A guard test that fails if a `createRevenueEvent` call appears outside
  `record-revenue-event.ts` — the structural guarantee, enforced rather than
  documented. Implemented as a source scan in the same spirit as the
  `Partial<Record>` provider-coverage guard from the store-lifecycle work.

---

## Sequencing

The three sub-projects are independent. Recommended order, cheapest proof
first:

1. §12.1 regression test (small, closes a checkbox immediately)
2. §12.4 renewal grants (schema + wrapper + sweeper; highest user value)
3. §12.2 real-time audiences (subtle, but contained)
4. §12.3 leaderboard seasons (largest; three tables, a worker and UI)

## Risks

- **§12.4's eight-site migration** is the biggest blast radius in this spec.
  It touches every store integration's money path. The guard test is what
  makes it safe to do at all; without it the migration is worse than the
  problem. Each site's existing tests must stay green unmodified — if a test
  needs changing to accommodate the wrapper, that is a behaviour change and
  needs explaining, not editing.
- **§12.3's ClickHouse dependency.** The worker reads ClickHouse and writes
  Postgres. A ClickHouse outage must leave the season `ACTIVE` and retry, not
  close it with empty standings. The claim happens before the query, so this
  needs explicit handling: on query failure, roll the claim back.
- **§12.2's coalescing window** trades push latency for push volume. If it is
  set too high, "real-time" stops being true. It is a named constant so it can
  be tuned without a code change in more than one place.
