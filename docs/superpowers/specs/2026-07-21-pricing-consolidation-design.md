# Pricing Consolidation + Soft-Cap Enforcement

**Date:** 2026-07-21
**Status:** Approved

## Goal

Collapse the 6-tier public billing ladder to 4 (Free → Indie → Studio →
Enterprise), raise the free MTR threshold to $5K, reprice Indie to $49,
and turn today's warn-only usage caps into Plausible-style soft
enforcement (dashboard lock after two consecutive over-limit billing
periods; SDK/ingest never blocked).

Grounded in the 2026-07-21 competitive pricing research: competitors show
2–4 public tiers (Adapty 2, Superwall 4, RevenueCat ~3); market free
thresholds moved to $5K–$10K MTR; $49 flat undercuts the 1%-of-MTR
players across the whole $5K–$50K band.

## Non-goals

- Hybrid metered pricing (flat + % of MTR) — separate future phase with
  Stripe usage-based billing.
- Annual purchase enablement (annual rows stay seeded; checkout remains
  monthly-only).
- Removing `pro` / `scale` / `growth` from the Postgres enum or TS unions
  (enum value removal is painful; they become unused legacy values).
- Email notifications on usage lock (outbox event + audit only; the
  notifications pipeline can subscribe later).
- Dunning integration — `billing_dunning_state` is P5 payment-failure
  territory; usage locking is deliberately independent.

## New ladder

| Tier | Price (monthly / annual) | MTR band | Events | SQL | Retention / Audit |
|---|---|---|---|---|---|
| free | $0 | $0–5K | 5M | 100 | 30d / 7d |
| indie | $49 / $490 | $5K–50K | 50M | 2,500 | 180d / 90d |
| studio | $399 / $3,990 | $50K–250K | 250M | unlimited | 365d / 365d |
| enterprise | custom ($0 seed) | $250K+ | unlimited | unlimited | 1825d / 1825d |

Annual = 10× monthly (unchanged convention). MTR remains the soft cap
(never locks); `events` and `sql_queries` remain hard caps (now with
teeth via the lock rule below).

Naming rationale: audience-based tier names (indie developers, app
studios) beat generic size names for self-selection; "Indie" also keeps
the existing enum value, purchase flow, and env var untouched.

## 1. Data migration (single migration, 0084)

Schema changes (via `drizzle-kit generate`, then hand-append data DML —
per the known gotcha, trim any unrelated DDL from the generated file):

- `billing_tier_enum`: add value `studio` via the recreate-enum pattern
  (rename old type → CREATE TYPE with the new value list → retype the
  two tier columns → drop old type). Plain `ALTER TYPE … ADD VALUE`
  does not work here: the drizzle migrator runs all pending migrations
  in one transaction, and Postgres forbids using a value added by
  ADD VALUE inside the same transaction (0085 inserts studio rows).
- `projects`: add nullable `usage_locked_at timestamptz`.

Data migration in the same file:

1. `billing_tier_limits` updates:
   - free (both cycles): `mtr_max` 3000 → 5000.
   - indie: `price_usd_cents` 2900 → 4900 (monthly) / 29000 → 49000
     (annual); `mtr_min` 3000 → 5000; `mtr_max` 10000 → 50000;
     `events_limit` → 50,000,000; `sql_limit` → 2500;
     `retention_days` → 180; `audit_log_days` → 90.
   - insert studio rows (both cycles) with scale's current values
     (price 39900/399000, mtr 50000–250000, events 250M, sql NULL,
     retention 365, audit 365). `stripe_price_id` NULL.
   - enterprise: `mtr_min` 1000000 → 250000.
2. `billing_subscriptions`: migrate legacy tiers if any exist —
   `pro` → `indie`, `scale` → `studio`, `growth` → `enterprise`.
   (Pre-launch, expected 0 rows; the UPDATE is safety.)
3. Delete `billing_tier_limits` rows for `pro`, `scale`, `growth`
   (after step 2 so no subscription references a deleted limits row).

`packages/db/seed.ts` `TIER_LIMITS` is updated to the same 8 rows
(4 tiers × 2 cycles) for fresh installs; the existing
`STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` wiring in seed stays as-is.

Enum/TS updates: add `"studio"` to `billingTierEnum` and `billingTier`
in `packages/db/src/drizzle/enums.ts` and to `BillingTier` in
`packages/shared/src/billing.ts`, with a comment marking the public
ladder as free/indie/studio/enterprise and pro/scale/growth as legacy.

## 2. Purchase flow & env

No changes: `upgrade-project.ts` keeps targeting `("indie", "monthly")`;
webhook handlers unchanged; `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID`
keeps its name. **Ops (deploy checklist): create a new $49/month price
in the platform Stripe account and set it as
`STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID`** (the old $29 price object must
not be reused).

## 3. Dashboard copy

- `apps/dashboard/src/components/billing/upgrade-modal.tsx`: "Upgrade to
  Indie", "$49 / month".
- Billing settings page (`settings/billing.tsx`): tier names/limits
  reflect the new ladder wherever hardcoded.

## 4. Soft-cap enforcement

### Lock rule

A project is usage-locked when, for the **two most recent completed
calendar billing periods**, at least one hard-cap meter (`events` or
`sql_queries`) has a `usage_snapshots` row with
`current_value >= limit_value` in **both** periods. MTR never
contributes to locking. The rule embeds ≥1 month of implicit grace
(first over-limit period only warns).

Unlock: the same evaluation returning false clears the lock (upgrading
raises limits, so the next sweep clears it), and
`handle-subscription-updated` clears `usage_locked_at` immediately on a
tier change so paying customers are not stuck waiting for the sweep.

### Sweeper worker

`apps/api/src/workers/usage-cap-sweeper.ts` — BullMQ repeatable job
(daily), bootstrapped from `apps/api/src/index.ts` alongside the
scheduled-actions sweep, no-op unless `isBillingEnabled()` (cloud mode).
Per active project (has a `billing_subscriptions` row):

1. Call `buildUsageReport` (persists current-period snapshots + warn
   flags — existing behavior, now guaranteed to run at least daily
   instead of only when someone opens the usage page).
2. Evaluate the lock rule against the two most recent completed periods
   (pure function over snapshot rows — unit-testable in isolation).
3. On lock/unlock transition: update `projects.usage_locked_at`, write
   an `audit()` entry, and emit `billing.usage_lock.applied` /
   `billing.usage_lock.cleared` through the outbox in the same
   transaction. No-op when state is unchanged.

### Dashboard guard

`apps/api/src/middleware/usage-lock.ts` — mounted in
`routes/dashboard/index.ts` as `.use("/projects/:projectId/*", …)`
before the sub-routers. Behavior:

- Loads `projects.usage_locked_at` (single PK select).
- If locked: respond `403 { error: { code: "usage_limit_exceeded",
  message } }` — except for exempt paths: any sub-path under
  `/billing` (the upgrade path must stay reachable). The bare project
  detail route (`/projects/:projectId` with no trailing segment) is not
  matched by the wildcard mount, so it stays accessible for rendering
  the locked state.
- SDK `/v1/*`, webhooks, ingest: untouched by design.

Project detail response gains `usageLockedAt: string | null` so the
dashboard can render a lock banner with an upgrade CTA; locked sub-pages
surface the 403 state.

## 5. Testing

- Pure lock-rule function: unit tests (both-periods-over → lock; single
  period → no lock; MTR-only over → no lock; recovery → unlock; missing
  history → no lock).
- Guard middleware: unit tests (locked → 403 with code; billing path
  exempt; unlocked → passthrough).
- Sweeper: integration test (testcontainers PG) seeding snapshot rows
  across two periods and asserting the `projects.usage_locked_at`
  transition + outbox row; skipped where CH is required (usage report
  builder is already CH-tolerant).
- Migration: assert `db:migrate` applies cleanly and
  `billing_tier_limits` contains exactly 8 rows post-migration
  (extend an existing billing integration test or seed test).
- Webhook: extend `handle-subscription-updated` test to assert the lock
  clear on tier change.

## Deploy checklist (ops, outside code)

1. Create the $49/month Stripe price; update
   `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID`.
2. Run `pnpm db:migrate` (0084) before deploying the new API.
3. Marketing/docs pricing page (outside this repo) updated to the
   4-tier ladder.
