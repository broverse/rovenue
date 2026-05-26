# Billing & Plans — Design

**Date:** 2026-05-26
**Author:** Rovenue team
**Status:** Draft (pending implementation plan)

## Goals

1. Introduce a cloud-only billing layer for Rovenue so projects can be placed on
   paid tiers, charged via Stripe, and tracked through a generous metered free
   tier without breaking the "no revenue share — self-host, own your data"
   marketing pitch.
2. Define a six-tier ladder (Free, Indie, Pro, Scale, Growth, Enterprise) whose
   active tier is auto-derived from a project's Monthly Tracked Revenue (MTR).
   Customers never pick a price tier manually inside the paid range; they
   choose Free vs. Paid and the bracket adjusts at cycle boundaries.
3. Replace the existing mock `account/billing|usage|invoices` pages with
   project-scoped billing pages backed by real Stripe data, real usage meters,
   and real invoice records.
4. Build a soft-cap metering pipeline for three "money-burning" dimensions
   (MTR, lifecycle events, SQL Workbench queries) that warns at 80% / 100%
   but never blocks writes. Other dimensions (seats, feature flags,
   audiences, webhooks) stay unlimited and unmetered.
5. Implement an aggressive RevenueCat-level dunning policy: 21-day Stripe
   Smart Retry → final reminder at D21 → full account suspension (UI + SDK
   `/v1/*`) at D30. Data is preserved indefinitely; recovery is instantaneous
   on `invoice.payment_succeeded`.
6. Enforce a "mandatory billing" UX: there is no destructive "Cancel my
   subscription" button. Customers move between Free / Active / Past Due /
   Paused / Deleted states. Active paid projects must always carry at least
   one payment method; removing the last card auto-downgrades the project
   to Free.

## Non-goals

- Self-hosted billing. Self-hosted Rovenue has no billing layer; this spec is
  cloud-only. The feature is gated behind a `BILLING_ENABLED` env flag.
- Usage-based overage billing. Metered dimensions only soft-cap; we never
  charge per unit over quota. Customers upgrade by entering a new MTR bracket.
- Multi-project aggregation. Each project has its own subscription, its own
  card, its own invoices. A user with three projects gets three bills.
- Workspaces / organisations. The existing `projects` + `project_members`
  model is the billing boundary. A future workspace entity is out of scope.
- Tax engines (Avalara, automated VAT/GST/sales-tax calculation). For v1 we
  collect the customer's Tax ID and country in billing details and pass them
  to Stripe as customer metadata. We do not enable Stripe Tax in v1; invoices
  ship without computed tax and the customer is responsible for self-assessing.
  Stripe Tax is a P8+ effort.
- Migrating Free users into Stripe. Free-tier projects never get a Stripe
  customer record; the Stripe customer is created lazily on first upgrade.
- Annual prepayment discount tiers (e.g. 25% off for 2-year prepay). Annual
  cycle = 2 months free (≈17%) flat across all tiers.
- Per-seat charging. Seats are unmetered.

## Pricing model

Pricing is **flat tier per MTR bracket**. Tier auto-derives from a project's
MTR at cycle end; customers cannot pick "Pro vs. Scale" manually — only "Free
vs. Paid". The MTR bracket then determines the price.

| Tier | $/mo | $/yr | MTR bracket | Events/mo | SQL/mo | Retention |
|---|---|---|---|---|---|---|
| Free | $0 | — | $0 – $3K | 5M | 100 | 30d |
| Indie | $29 | $290 | $3K – $10K | 15M | 500 | 60d |
| Pro | $99 | $990 | $10K – $50K | 50M | 2,500 | 180d |
| Scale | $399 | $3,990 | $50K – $250K | 250M | ∞ | 365d |
| Growth | $1,499 | $14,990 | $250K – $1M | 1B | ∞ | 730d |
| Enterprise | custom | custom | $1M+ | custom | ∞ | custom |

Annual cycle = monthly × 10 (2 months free, ≈17% discount). Annual subscriptions
do not re-bracket mid-cycle — MTR changes apply only at renewal.

**Metered dimensions (real-time + cycle rollup):**
- `mtr` — sum of net revenue (USD-normalised, refunds negative) processed for
  the project during the billing period. Drives bracket assignment.
- `events` — count of lifecycle events written to `revenue_events` during the
  period (purchase, renewal, refund, trial_start, etc.).
- `sql_queries` — count of SQL Workbench executions during the period.

**Unmetered / unlimited:** seats, feature flags, audiences, cohorts,
leaderboards, experiments, webhooks (endpoints and deliveries), API requests,
custom dashboards, audit log writes, annotations. A global per-project abuse
rate limit (default 1K req/sec) is enforced separately and is not part of
billing.

**Soft-cap behaviour:** when a metered value crosses 80% the project receives
a dashboard banner + email. At 100% the banner stays red and a monthly
"over by X" email is sent. **Writes are never rejected for quota reasons.**
Global abuse rate limits are the only mechanism that can return 429.

**Feature gating between tiers:**

| Capability | Free | Indie | Pro | Scale | Growth | Enterprise |
|---|---|---|---|---|---|---|
| Core sub/credit mgmt | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Feature flags, audiences, cohorts, leaderboards | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Experiments | basic (1 active) | basic (3) | full | full | full | full |
| SQL Workbench | quota | quota | quota | ∞ | ∞ | ∞ |
| Webhooks (endpoint count) | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ |
| Audit log retention | 7d | 30d | 90d | 365d | 730d | ∞ |
| GDPR / KVKK export tool | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| SSO / SAML | — | — | — | ✓ | ✓ | ✓ |
| Custom subdomain | — | — | — | ✓ | ✓ | ✓ |
| Uptime SLA | community | community | community | 99.9% | 99.95% | 99.99% |
| Support | community | email | email | priority | priority | dedicated CSM |

## Architecture overview

```
SDK / Dashboard          API (Hono)                    Stripe              ClickHouse
─────────────────         ──────────                    ──────              ──────────
                          /v1/* (SDK)                                       usage_meters MV
                              │                                                  ▲
                              ▼ writes revenue_events                            │
                          outbox_events ──► Kafka ──► CH Kafka Engine ──────────┘
                                                                  │
                                                                  ▼
                                              usage_snapshots (hourly cron, PG)
                                                                  │
                                                                  ▼
                                                 banner / email / bracket eval
                                                                  │
                                                                  ▼ cycle end
                          stripe.subscriptions.update (price item swap)
                                                                  │
                                                                  ▼
                          /billing/stripe/webhook ◄── invoice.payment_succeeded
                                                  ◄── invoice.payment_failed
                                                  ◄── subscription.updated
                                                  ◄── setup_intent.succeeded
                              │
                              ▼ tx
                          billing_subscriptions / billing_invoices /
                          billing_payment_methods / billing_dunning_state
                              │
                              ▼ outbox_events
                          billing.* domain events (locked, recovered, ...)

Dashboard                 Stripe Elements (front-end)
─────────                 ──────────────────────────
billing / payment-methods / invoices / usage pages (project-scoped)
paywall middleware  ◄── dunning_state.ui_locked_at != null
```

## Data model

All new tables live in `packages/db/src/drizzle/schema.ts`. IDs are cuid2
strings, timestamps are `timestamp with time zone`. Money is stored as
`numeric(12,4)` USD.

### `billing_subscriptions`

```
id                cuid2 PK
project_id        FK → projects.id, unique WHERE state != 'deleted'
stripe_customer_id      text NULL   (NULL while Free)
stripe_subscription_id  text NULL   (NULL while Free)
state             enum('free','active','past_due','paused','deleted')
tier              enum('free','indie','pro','scale','growth','enterprise')
cycle             enum('monthly','annual')
current_period_start timestamptz
current_period_end   timestamptz
trial_end         timestamptz NULL
paused_at         timestamptz NULL
deleted_at        timestamptz NULL
pending_action    enum('downgrade_to_free','pause','delete') NULL
                  -- set when the dashboard issues a Stripe cancel; cleared
                  -- when the corresponding subscription.deleted webhook
                  -- arrives. Lets the webhook handler distinguish expected
                  -- deletions from unexpected ones.
created_at, updated_at
```

One row per project. State transitions are written transactionally with
audit log + outbox event.

### `billing_payment_methods`

```
id                       cuid2 PK
project_id               FK → projects.id
stripe_payment_method_id text NOT NULL, unique
brand                    text  ('visa', 'mastercard', ...)
last4                    text
exp_month, exp_year      int
is_default               boolean (exactly one TRUE per project enforced
                                  by partial unique index)
created_at
```

### `billing_invoices`

```
id                  cuid2 PK
project_id          FK → projects.id
stripe_invoice_id   text NOT NULL, unique
number              text NOT NULL  (Stripe-issued invoice number)
period_start, period_end  timestamptz
amount_due, amount_paid   numeric(12,4)
currency            text DEFAULT 'usd'
status              enum('draft','open','paid','uncollectible','void')
refunded_amount     numeric(12,4) DEFAULT 0  -- aggregated from Stripe refunds
hosted_invoice_url  text
pdf_url             text
attempt_count       int DEFAULT 0
next_payment_attempt timestamptz NULL
created_at
```

Mirrored from Stripe via webhook; the dashboard reads from this table, not
the Stripe API. Refunds are separate Stripe entities (`charge.refunded`
webhook); they update `refunded_amount` but do not change `status` —
Stripe keeps the invoice as `paid` after a refund, and so do we. Display
labels like "Refunded" in the UI are derived from
`refunded_amount > 0 AND refunded_amount >= amount_paid`.

### `billing_dunning_state`

```
project_id           PK + FK → projects.id
first_failure_at     timestamptz
attempt_count        int
current_phase        enum('retrying','past_due','suspended') NULL
ui_locked_at         timestamptz NULL
sdk_locked_at        timestamptz NULL
recovered_at         timestamptz NULL
last_email_sent_at   timestamptz
updated_at
```

Single row per project. Reset (deleted) on `invoice.payment_succeeded`.

### `billing_tier_limits`

Static reference table seeded from migration; consulted by the metering
banner job and the SDK middleware. One row per `(tier, cycle)`.

```
tier              enum
cycle             enum
price_usd_cents   int
stripe_price_id   text
mtr_min, mtr_max  numeric(12,4)
events_limit, sql_limit, retention_days  int
audit_log_days    int
```

### `usage_meters` (ClickHouse, `SummingMergeTree`)

Materialised view fed from existing `revenue_events` and a new
`dashboard.sql_log` Kafka topic. Verified pattern from
`clickhouse_summing_aggregatefunction.md`.

```
project_id      String
meter_key       LowCardinality(String)   -- 'mtr' | 'events' | 'sql_queries'
period          Date                     -- first day of billing cycle
value_state     AggregateFunction(sumState, Float64)
ORDER BY (project_id, meter_key, period)
```

### `usage_snapshots` (Postgres, hourly reconcile from ClickHouse)

```
project_id              FK
meter_key               text
period_start, period_end timestamptz
current_value           numeric
limit_value             numeric
soft_cap_warned_at      timestamptz NULL  -- 80% threshold email sent
hard_cap_warned_at      timestamptz NULL  -- 100% threshold email sent
updated_at
PK(project_id, meter_key, period_start)
```

This is the canonical source the dashboard reads. ClickHouse is the source
of truth for raw rollups; Postgres holds the snapshot for fast UI queries
and idempotent email gating.

## Stripe integration

The Hono API mounts a new router at `apps/api/src/routes/billing/`.

### Lazy customer creation

A `billing_subscriptions` row exists for every project from creation, but
`stripe_customer_id` is NULL while the project is Free. The first upgrade
attempt:

1. `POST /billing/projects/:id/upgrade` (dashboard-only, OWNER/ADMIN)
2. Creates Stripe customer with project metadata (`{ rovenue_project_id }`)
3. Returns a `SetupIntent` client secret for the dashboard to mount Stripe
   Elements
4. On `setup_intent.succeeded` webhook: insert `billing_payment_methods`
   row, mark default, then `stripe.subscriptions.create` with a single flat
   recurring price item — the `stripe_price_id` from `billing_tier_limits`
   for the tier that matches the project's current MTR. We do not use any
   metered Stripe price items; bracket changes happen via
   `subscriptions.update` swapping the price item at cycle end
5. `customer.subscription.created` webhook flips `billing_subscriptions.state`
   to `active`, sets period boundaries

### Cycle-end bracket evaluation

A nightly cron (`bracket-evaluator`) runs at UTC 00:30 and for every
`active` subscription whose `current_period_end` is within the next 24
hours:

1. Reads `usage_snapshots` for `meter_key='mtr'` in the current period
2. Maps MTR to the correct bracket via `billing_tier_limits`
3. If the new tier differs from the current tier:
   - Sends a "your tier will change at end of cycle" email (3 days before
     `current_period_end` if MTR change is upward; same-day for downward)
   - At `current_period_end`: `stripe.subscriptions.update` with the new
     price item, `proration_behavior: 'none'`, cycle-end effective
   - On `customer.subscription.updated` webhook: writes new tier to
     `billing_subscriptions` + audit log

The bracket evaluator never moves a project mid-cycle; this preserves the
"no surprise charges" property.

### Webhooks

A single route, `POST /billing/stripe/webhook`, handles all Stripe events.
Idempotency: each event's `id` is upserted into the existing
`webhook_events` dedupe table inside the same transaction as the state
mutation.

| Stripe event | Effect |
|---|---|
| `customer.subscription.created` | `billing_subscriptions.state='active'`, set period |
| `customer.subscription.updated` | sync tier, cycle, period; if `status='past_due'` enter dunning |
| `customer.subscription.deleted` | expected during pause / downgrade-to-Free / project delete — sync `billing_subscriptions.state` to `paused` or `free` based on the action that triggered it (stored in `billing_subscriptions.pending_action`); raise an ops alert only if no pending action was recorded |
| `invoice.created` | insert `billing_invoices` row, status `draft` or `open` |
| `charge.refunded` | update `billing_invoices.refunded_amount`; `revenue_events` is unaffected (refund event came in through the SDK flow) |
| `invoice.finalized` | update invoice row |
| `invoice.payment_succeeded` | mark paid + clear `billing_dunning_state` row + emit `billing.recovered` outbox event |
| `invoice.payment_failed` | advance `billing_dunning_state` (see Dunning) |
| `setup_intent.succeeded` | insert payment method row |
| `payment_method.detached` | remove row (manual detach via Stripe API only) |
| `customer.updated` | sync billing details (address, tax ID) |

All state mutations happen inside a Drizzle transaction with the
existing `audit()` helper so domain write + audit row + outbox event commit
or roll back together.

## Usage metering pipeline

### Sources
- `revenue_events` (existing) is the source for both `mtr` and `events`
  meters. The MV groups by `project_id`, sums `amount_usd` for MTR and
  counts rows for events.
- A new `dashboard.sql_log` topic is produced by the existing SQL workbench
  route (one Kafka message per execute). The MV counts rows per project.

### ClickHouse rollup

```sql
CREATE MATERIALIZED VIEW usage_meters
ENGINE = SummingMergeTree
ORDER BY (project_id, meter_key, period)
AS
SELECT
  project_id,
  'mtr' AS meter_key,
  toStartOfMonth(occurred_at) AS period,
  sumState(amount_usd) AS value_state
FROM revenue_events
WHERE event_type IN ('purchase','renewal','refund')
GROUP BY project_id, period
UNION ALL
SELECT project_id, 'events', toStartOfMonth(occurred_at), sumState(1)
FROM revenue_events GROUP BY project_id, period
UNION ALL
SELECT project_id, 'sql_queries', toStartOfMonth(executed_at), sumState(1)
FROM dashboard.sql_log GROUP BY project_id, period;
```

Annual cycles use a parallel MV with `toStartOfYear` and the rollup worker
picks the right MV based on `billing_subscriptions.cycle`. This is preferred
over a `period_kind` column because `SummingMergeTree` cannot mix two
period grains in the same ORDER BY without redundant aggregation passes.

### Reconcile to Postgres

`apps/api/src/workers/usage-rollup.ts` runs hourly via BullMQ and for each
active project:

1. `SELECT sumMerge(value_state) ... FROM usage_meters WHERE period = ?`
2. `UPSERT` into `usage_snapshots`
3. If `current_value / limit_value` crosses 0.8 and `soft_cap_warned_at IS NULL`:
   queue warning email, set timestamp
4. Same logic at 1.0 with `hard_cap_warned_at`

The dashboard `usage` page queries Postgres only. ClickHouse is the source
of truth but never read by the API.

## Project subscription state machine

```
                       ┌──────┐
                       │ Free │ ◄─────────────┐
                       └───┬──┘               │ downgrade (effective
                           │ upgrade + card    │  at cycle end)
                           ▼                   │
                      ┌────────┐               │
                ┌────►│ Active │───────────────┘
                │     └─┬──┬───┘
                │       │  │
       recover  │       │  │ user clicks "Pause project"
                │       │  ▼
                │       │  ┌────────┐
                │       │  │ Paused │
                │       │  └───┬────┘
                │       │      │ resume (card check)
                │       │      ▼
                │       │   (back to Active)
                │       │
                │       │ Stripe invoice.payment_failed
                │       ▼
                │   ┌─────────┐  D30 cron
                └───┤Past Due ├───────────►  (still Active row,
                    └─────────┘                dunning_state.phase
                                                = 'suspended')
                                                       │
                                              user types project name
                                                       ▼
                                                 ┌─────────┐ 30d
                                                 │ Deleted │ grace
                                                 └─────────┘
```

Notes:
- `Past due` is a logical sub-state of `Active` in `billing_subscriptions`;
  the `state` column stays `active`, the truth lives in
  `billing_dunning_state.current_phase`. This keeps the FSM simple — Stripe
  is authoritative for past-due; we just mirror.
- `Active → Free` requires the user to click "Downgrade to Free" in
  billing settings and confirm. Effective at end of current period.
  Cancels Stripe subscription with `cancel_at_period_end=true`.
- `Active → Paused` is a separate operation: immediate effect, cancels
  Stripe subscription with `cancel_at=now`, refunds unused period (none
  for monthly; pro-rated for annual). SDK 402's immediately.
- `Paused → Active`: re-create Stripe subscription from scratch; new
  period starts today.
- `Deleted` is the only state from which no recovery is possible. Hard
  delete after 30 days of grace (cron `project-purger`).

## Dunning state machine

```
event                                      side effect
───────────────────────────────────────────────────────────────────────
D0  invoice.payment_failed (Stripe retry attempt 1)
                              dunning_state.phase = 'retrying'
                              attempt_count = 1
                              email #1 "Your payment failed"

D3  payment_failed (attempt 2)
                              attempt_count = 2
                              email #2 "Still failing"  (Stripe-templated)

D7  payment_failed (attempt 3)
                              attempt_count = 3
                              email #3

D14 payment_failed (attempt 4 — last)
                              attempt_count = 4

D21 retry exhausted
                              dunning_state.phase = 'past_due'
                              email #5 "Final notice — service suspends
                                       in 9 days"
                              dashboard shows red banner

D30 dunning-suspender cron (hourly)
                              for every row where first_failure_at < now-30d
                              and phase = 'past_due':
                                phase = 'suspended'
                                ui_locked_at = now
                                sdk_locked_at = now
                              outbox: billing.suspended
                              email #6 "Account suspended"

D30+  monthly reminder cron
                              email "Still suspended — pay $X to recover"

at any point: invoice.payment_succeeded
                              clear billing_dunning_state row
                              outbox: billing.recovered
                              dashboard + SDK unlock immediately
                              email "Welcome back"
```

### Lock semantics

- **UI lock (`ui_locked_at != null`)**: a new dashboard middleware
  `paywall-redirect` checks `dunning_state` for every `_authed/projects/$projectId/*`
  route. If suspended, redirects to `/projects/$projectId/settings/billing`
  with a banner explaining the lock. The billing page itself stays
  reachable so the customer can add a card and pay.
- **SDK lock (`sdk_locked_at != null`)**: a new Hono middleware
  `billing-gate` runs before all `/v1/*` routes; if the project is
  suspended it returns `402 Payment Required` with a JSON body the SDK
  uses to fall back to the MMKV offline cache. The SDK's existing offline
  path treats this identically to a 5xx outage — last-known entitlement
  stays available to end-users.
- **Outbox dispatcher**: pauses delivery for suspended projects to avoid
  generating webhook traffic for non-paying tenants. Resumes on recovery.

## UI surfaces

### Page moves

The four existing `apps/dashboard/src/routes/_authed/account/{billing,
invoices,usage,team}.tsx` mock pages are re-scoped:

- `account/billing` → **deleted** (per-account billing has no meaning in a
  project-scoped model). The account-level "All projects overview" lives
  on the projects list landing.
- New: `routes/_authed/projects/$projectId/settings/billing.tsx`
- New: `routes/_authed/projects/$projectId/settings/payment-methods.tsx`
- New: `routes/_authed/projects/$projectId/settings/invoices.tsx`
- New: `routes/_authed/projects/$projectId/settings/usage.tsx`

The existing mock components (`PlanCard`, `PaymentMethodRow`,
`InvoiceStatusChip`, `UsageRow`) keep their visual design and move to
`components/billing/`. Their data inputs change from constants to
TanStack Query hooks against the new API.

### New endpoints (dashboard-only, behind OWNER/ADMIN role check)

```
GET    /dashboard/projects/:id/billing               summary + tier + period
GET    /dashboard/projects/:id/billing/usage         3 meters with current/limit
GET    /dashboard/projects/:id/billing/invoices      paged list
GET    /dashboard/projects/:id/billing/payment-methods
POST   /dashboard/projects/:id/billing/upgrade       returns SetupIntent client_secret
POST   /dashboard/projects/:id/billing/switch-cycle  monthly ↔ annual
POST   /dashboard/projects/:id/billing/downgrade     to Free, effective cycle end
POST   /dashboard/projects/:id/billing/pause
POST   /dashboard/projects/:id/billing/resume
DELETE /dashboard/projects/:id/billing/payment-methods/:pmId
POST   /dashboard/projects/:id/billing/payment-methods/:pmId/default
PATCH  /dashboard/projects/:id/billing/details       (legal entity, tax ID, address)
```

### Paywall component

`apps/dashboard/src/components/billing/paywall.tsx` renders a full-screen
takeover triggered by the dashboard middleware when
`billingSummary.state === 'suspended'`. Shows:

- "Account suspended" headline
- Outstanding invoice list with "Pay now" button (creates new payment
  intent via the existing default card)
- "Add a new card" CTA → Stripe Elements modal
- "Pause project instead" link (lets the customer step out of the
  recurring cycle without paying overdue invoice — Stripe write-off; ops
  approval required)

### Last-card removal flow

When the user clicks "Remove" on the only remaining payment method while
the project is Active paid:

```
┌────────────────────────────────────────────────────┐
│ This is your only payment method.                  │
│                                                    │
│ Removing it will downgrade your project to the     │
│ Free tier at the end of the current billing        │
│ period. Paid features will become read-only        │
│ within 24 hours after that date.                   │
│                                                    │
│ [ Add another card first ]                         │
│ [ Downgrade to Free & remove card ]                │
│ [ Cancel ]                                         │
└────────────────────────────────────────────────────┘
```

Choosing "Downgrade & remove" triggers `POST /billing/downgrade` and then,
once Stripe confirms `cancel_at_period_end`, detaches the payment method.

## Edge cases

1. **MTR drops to $0 mid-cycle on a paid annual subscription.** The
   bracket evaluator only looks at MTR at renewal; the customer pays the
   full annual at the next renewal date based on the new bracket.
2. **MTR drops to $0 mid-cycle on monthly.** At cycle end the customer is
   re-bracketed to Indie (the lowest paid tier). They do not auto-fall to
   Free — that requires an explicit downgrade.
3. **Customer resumes a Paused project after card expired.** Resume is
   blocked until they add a fresh card; the resume API returns
   `400 card_required`.
4. **Stripe webhook arrives out of order** (e.g. `subscription.updated`
   before `subscription.created`). The state machine treats `created` as
   idempotent: if the row exists, only update fields. `updated` is a
   no-op if the row is missing — it will be reconciled on the next
   `subscription` sync cron (hourly safety net).
5. **GDPR / KVKK delete request.** Project delete → 30d grace → user
   identifiers in `subscribers` table are anonymised; `audit_logs` and
   the chained hash trail are preserved (compliance). Billing records
   are retained for tax compliance (7 years per local rules).
6. **Self-host migration.** Out of scope for v1, but the data model
   doesn't preclude it: `BILLING_ENABLED=false` skips all billing
   middleware and the dashboard hides the settings pages. Existing
   self-host installs are unaffected.
7. **Refunds.** Issued through the dashboard via Stripe's refund API
   (operator action, OWNER role). The refund row appears in
   `billing_invoices` (negative amount). MTR meters are decremented
   automatically via the `refund` event type — already in
   `revenue_events`.
8. **Failed payment method during upgrade.** The SetupIntent flow surfaces
   Stripe's `error.message` directly; no `billing_subscriptions` row
   transition until `setup_intent.succeeded` fires.
9. **Concurrent upgrade attempts.** `billing_subscriptions.project_id`
   carries a partial unique index; the second writer gets a PG conflict
   and the API returns `409 already_upgrading`.
10. **Free project whose MTR exceeds $3K.** The project has no card, so
    the bracket evaluator cannot auto-upgrade it to Indie. Behaviour:
    - The first hour MTR crosses $3K, the dashboard locks paid-feature
      panels behind a "Add a card to keep your project running" banner
      (the soft-cap policy still applies for write paths — data keeps
      flowing).
    - A 30-day grace window starts. Banner + weekly email.
    - At grace end without a card, the project enters a special
      `state='past_due'` with `current_phase='past_due'` and a synthetic
      `billing_dunning_state` row (`first_failure_at = grace_end`). From
      there the standard D30 suspender cron applies on the same clock,
      and the project enters `suspended` 30 days later.
    - Adding a card at any point during this 60-day window upgrades
      the project to Indie (or higher per MTR) immediately and clears
      the synthetic dunning row.

## Testing strategy

### Unit (Vitest)
- Tier bracket assignment from MTR (parameterised: every boundary ±1¢)
- State machine transitions: legal vs illegal moves (table-driven)
- Soft-cap threshold detection (idempotent — re-running doesn't re-email)
- Last-card removal validator

### Integration (testcontainers, `*.integration.test.ts`)
- Stripe webhook round-trip: replay fixtures (`webhook_events` dedupe,
  state mutation, audit + outbox)
- `usage_meters` ClickHouse parity: insert 1,000 `revenue_events`, run
  rollup, assert PG `usage_snapshots.current` matches CH `sumMerge`
- Dunning cron: synthetic time travel via `vi.useFakeTimers()`,
  validate D0/D21/D30 transitions
- `billing-gate` middleware: SDK request → 402 when suspended → 200
  after recovery webhook
- Cycle-end bracket evaluator: project at $9.5K MTR moves to Pro;
  Stripe subscription update called with correct `stripe_price_id`

### E2E (Playwright, dashboard)
- New user signs up → creates project → upgrades to Indie via Stripe
  Elements test card → sees Active tier
- Last-card removal modal → "Downgrade & remove" flow
- Paywall redirect: synthetic `dunning_state.ui_locked_at` → all
  project routes redirect to billing
- Pause project → SDK request returns 402 → resume → SDK works

### Stripe-side
- Use Stripe's test-mode webhook signing secret in CI; fixtures committed
  under `apps/api/tests/fixtures/stripe-webhooks/`

## Rollout plan

Phases ship behind a `BILLING_ENABLED=false` env flag. Existing
self-hosted installs stay on Free behaviour with no Stripe customer
created.

1. **P1: Data model + lazy Stripe customer.** New tables, no charges,
   every project gets a `state='free'` row on creation. Backfill migration
   for existing projects. Webhook endpoint accepts events but only logs.
2. **P2: Upgrade flow + invoice mirror.** Dashboard "Upgrade" button,
   SetupIntent + Stripe Elements, real invoices, `billing_invoices`
   populated via webhook.
3. **P3: Usage metering pipeline.** `usage_meters` MV + hourly
   `usage_snapshots` rollup + dashboard `usage` page with banners.
4. **P4: Bracket evaluator + tier auto-derive.** Nightly cron, cycle-end
   `stripe.subscriptions.update`, 3-day-ahead email warnings.
5. **P5: Dunning + paywall.** `billing-gate` SDK middleware, paywall
   dashboard middleware, D30 suspender cron, recovery webhook handler.
6. **P6: Annual cycle, downgrade-to-Free, pause/resume.** Cycle switch
   endpoint, `cancel_at_period_end` flow, pause endpoint with
   `cancel_at=now`, resume re-create.
7. **P7: Delete + GDPR + tax details.** Project delete with 30d grace,
   anonymisation of subscribers, billing details form (tax ID, address),
   Stripe Tax manual mode.

Each phase is a separate implementation plan and a separate PR.

## Open questions (deferred, not blocking)

- Whether to expose Stripe's Customer Portal directly for some billing
  surfaces (invoices PDF, tax ID edit) vs. native Hono routes. v1 ships
  native; revisit if maintenance cost is high.
- Currency support beyond USD. v1 is USD-only; multi-currency requires
  per-currency `stripe_price_id` per tier and is a P8+ effort.
- Volume / negotiated discounts on Enterprise. Custom contracts will
  bypass Stripe price items for now (handled manually).
