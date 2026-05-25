# Subscriptions header actions — design spec

**Date:** 2026-05-26
**Scope:** Wire the three header buttons on `/projects/:projectId/subscriptions` (`Schedule`, `Export CSV`, `New subscription`) end-to-end. Backend, schema, and dashboard UI.
**Status:** Approved (brainstorming)

## 1. Background

The subscriptions route (`apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx:347-359`) renders three header buttons that have no `onClick` handlers. None of the corresponding API endpoints exist on `apps/api/src/routes/dashboard/subscriptions.ts` (which currently exposes only read endpoints: list, kpis, composition, renewal-calendar, billing-issues).

We need to add the full slice — schema, services, endpoints, workers, hooks, modals — so the three buttons do something real.

## 2. Decisions captured during brainstorming

| Topic | Decision |
| --- | --- |
| What "Schedule" means | Schedule a subscription change (not a recurring export). v1 = **Cancel only**. Other actions (refund, pause, change-plan) are out of scope. |
| "New subscription" type | **Comp / promo grant** — manual subscription for an existing subscriber. No real billing. |
| Comp grant duration | **Presets + custom date** — 1mo / 3mo / 6mo / 1yr / lifetime, plus a custom date picker. |
| Schema for manual subs | **Add `MANUAL` to the `Store` enum.** Synthetic `storeTransactionId = comp_<cuid2>`. Worker code paths must explicitly tolerate `store='MANUAL'`. |
| Default cancel semantics for MANUAL subs | Keep access until natural `expiresDate`; offer a "revoke immediately" toggle that sets `expiresDate=now()` + `status=EXPIRED`. |
| Cancel semantics for store-backed subs | Stripe → call `subscriptions.update({ cancel_at_period_end: true })`. App Store / Play → mark intent locally + emit `subscription.cancel_requested` outgoing webhook; do **not** flip `autoRenew` (truth-of-record is the store; final state syncs via the store webhook). |

## 3. Architecture overview

```
Dashboard (subscriptions.tsx)
  ├── Schedule button       ─▶ schedule-modal.tsx ─▶ useScheduleAction ─▶ POST /v1/dashboard/projects/:id/subscriptions/:purchaseId/schedule
  ├── Export CSV button     ─▶ window.location.assign(buildExportUrl(scope, search))
  └── New subscription btn  ─▶ grant-modal.tsx    ─▶ useGrantSubscription ─▶ POST /v1/dashboard/projects/:id/subscriptions

API (Hono)
  └── /v1/dashboard/projects/:projectId/subscriptions
        ├── POST   /                                 ── grant comp subscription
        ├── GET    /export.csv                       ── stream CSV
        ├── POST   /:purchaseId/schedule             ── schedule cancel
        ├── GET    /scheduled                        ── list pending scheduled actions
        └── DELETE /scheduled/:id                    ── cancel a pending action

Services
  ├── services/subscriptions/grant.ts                ── tx: insert purchase + subscriber_access + outbox + audit
  ├── services/subscriptions/schedule.ts             ── insert scheduled_subscription_actions row + audit
  └── services/subscriptions/export-csv.ts           ── async generator streaming CSV rows via listSubscriptions cursor walk

Worker
  └── workers/scheduled-actions.ts                   ── BullMQ repeatable, every 60s: select due rows, execute per store, audit

Schema
  ├── enums.ts                                       ── add MANUAL to Store enum
  └── schema.ts                                      ── new table scheduled_subscription_actions
```

All three features write `audit_logs` entries via the existing `audit()` helper using the caller's tx so the audit row commits atomically with the domain write.

## 4. Schema changes

### 4.1 `Store` enum

Add `MANUAL` to the existing enum at `packages/db/src/drizzle/enums.ts:28`:

```ts
export const store = pgEnum("Store", [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "MANUAL",
]);
```

Postgres `ALTER TYPE … ADD VALUE 'MANUAL'` migration. Existing rows untouched. Code that switches on store must add a `MANUAL` case (lifecycle, refund sync, reconcile). Audit: grep for `case "STRIPE"` / `case "APP_STORE"` and verify each.

### 4.2 `scheduled_subscription_actions` table

```ts
export const scheduledActionType = pgEnum("ScheduledActionType", ["CANCEL"]);
export const scheduledActionStatus = pgEnum("ScheduledActionStatus", [
  "PENDING",
  "EXECUTED",
  "CANCELED",
  "FAILED",
]);

export const scheduledSubscriptionActions = pgTable(
  "scheduled_subscription_actions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId").notNull().references(() => purchases.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId").notNull().references(() => subscribers.id, { onDelete: "cascade" }),
    action: scheduledActionType("action").notNull(),
    dueAt: timestamp("dueAt", { withTimezone: true }).notNull(),
    status: scheduledActionStatus("status").notNull().default("PENDING"),
    payload: jsonb("payload").$type<{ revokeImmediately?: boolean }>().notNull().default({}),
    createdBy: text("createdBy").notNull(),  // user.id
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executedAt", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    projectIdStatusIdx: index("scheduled_actions_projectId_status_idx").on(t.projectId, t.status),
    statusDueAtIdx: index("scheduled_actions_status_dueAt_idx").on(t.status, t.dueAt),
  }),
);
```

Not partitioned — expected volume is low (manual scheduling only).

## 5. Feature: New subscription (comp grant)

### 5.1 Request

`POST /v1/dashboard/projects/:projectId/subscriptions` — role ≥ `EDITOR`.

```ts
const grantBody = z.object({
  subscriberId: z.string().min(1),
  productId: z.string().min(1),
  duration: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: z.enum(["1mo", "3mo", "6mo", "1yr", "lifetime"]) }),
    z.object({ kind: z.literal("custom"), expiresAt: z.string().datetime() }),
  ]),
  note: z.string().trim().max(200).optional(),
});
```

### 5.2 Service (`services/subscriptions/grant.ts`)

Single transaction:

1. Verify `subscriber.projectId === projectId` and `product.projectId === projectId` — throw 404 otherwise.
2. Compute `expiresDate`:
   - `lifetime` → `null`
   - `1mo / 3mo / 6mo / 1yr` → `now() + n months` (use date-fns `addMonths`)
   - `custom` → parsed `expiresAt`; reject if `<= now()`.
3. Insert `purchases` row:
   - `store: "MANUAL"`
   - `storeTransactionId: "comp_" + createId()`
   - `originalTransactionId` = same
   - `status: "ACTIVE"`
   - `isTrial: false`, `isIntroOffer: false`, `isSandbox: false`
   - `environment: "PRODUCTION"`
   - `purchaseDate: now()`, `originalPurchaseDate: now()`
   - `priceAmount: "0"`, `priceCurrency: "USD"` (the `projects` table has no per-project default currency today; if one is added later, swap here)
   - `autoRenewStatus: false`
4. Resolve entitlements: call the **existing** access resolver (the one webhook handlers use) so `null expiresDate` semantics stay consistent. Insert `subscriber_access` rows.
5. Write `outbox_events` row of type `revenue_event` payload `{ type: "INITIAL", priceAmount: 0, … }` so ClickHouse mirrors stay correct (MRR-neutral, but event-count consistent).
6. `audit({ action: "subscription.granted", resource: "purchase", resourceId: purchaseId, after: { … }, metadata: { note, duration } }, tx)`.
7. Return the created purchase row.

The existing `workers/expiry-checker.ts` already sweeps any purchase past its `expiresDate` — comp grants with non-null `expiresDate` will expire naturally there. Verify during implementation that `expiry-checker` tolerates `store='MANUAL'` (it likely does, since it operates on `expiresDate` alone, but the audit step in §4.1 covers this).

### 5.3 UI (`components/subscriptions/grant-modal.tsx`)

Modal opened from the header button. Form:

- **Subscriber:** combobox driven by an existing subscribers search hook (re-use `useProjectSubscribers` with `search` param; debounce 200ms).
- **Product:** select from `useProjectProducts(projectId)`.
- **Duration:** segmented control `[1mo | 3mo | 6mo | 1yr | Lifetime | Custom]`. When `Custom` → date input (today + 1 day minimum).
- **Note:** optional textarea, 200 char counter.
- **Submit** → `useGrantSubscription` mutation; on success: toast, invalidate `subscriptions list / kpis / composition` queries, close modal.

## 6. Feature: Schedule (cancel)

### 6.1 Request

`POST /v1/dashboard/projects/:projectId/subscriptions/:purchaseId/schedule` — role ≥ `EDITOR`.

```ts
const scheduleBody = z.object({
  action: z.literal("CANCEL"),
  dueAt: z.string().datetime(),
  revokeImmediately: z.boolean().optional().default(false),  // MANUAL store only
});
```

Validation:
- `dueAt` must be in the future (`> now() + 60s` to leave room for clock skew + sweeper interval).
- Purchase must belong to project; reject if `status` is already terminal (`EXPIRED`, `REFUNDED`, `REVOKED`).
- Reject duplicates: if there is an existing `PENDING` row for the same `purchaseId`, return 409.

### 6.2 Execution worker (`workers/scheduled-actions.ts`)

Mirrors the shape of `workers/expiry-checker.ts`:

- BullMQ queue `rovenue-scheduled-actions`.
- Repeatable job `scheduled-actions:sweep`, every 60s.
- Each tick: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 200 WHERE status='PENDING' AND dueAt <= now()`.
- Per row, branch on `purchase.store`:

| Store | Behavior |
| --- | --- |
| `MANUAL` | If `revokeImmediately`: set `expiresDate=now()`, `status='EXPIRED'`, deactivate `subscriber_access`, emit `revenue_event` of type `CANCELLATION`. Else: set `autoRenewStatus=false`, `cancellationDate=now()`. |
| `STRIPE` | Call `stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true })` where `stripeSubId = purchase.originalTransactionId` (Stripe webhook ingest already stores the `sub_…` id there — verify during implementation). Local: set `cancellationDate=now()`, `autoRenewStatus=false`. The real state-change arrives via the Stripe webhook. |
| `APP_STORE` / `PLAY_STORE` | Set `cancellationDate=now()` locally as an intent marker. Enqueue an outgoing webhook `subscription.cancel_requested` to the project. Do **not** flip `autoRenewStatus`. UI message: "Cancellation requested — final state will sync via store webhook." |

On success: `status='EXECUTED'`, `executedAt=now()`. On failure: `status='FAILED'`, `error=err.message`. Audit every outcome via `audit({ action: "subscription.cancel_executed" | "subscription.cancel_failed", … })`.

Worker registration in `apps/api/src/index.ts` next to the existing expiry-checker setup.

### 6.3 Endpoints

- `GET /scheduled` — list pending scheduled actions for the project, join `purchases` for display. Cursor pagination (reuse `decodeCursor` helper pattern).
- `DELETE /scheduled/:id` — mark `CANCELED` if still `PENDING`; 409 if not. Audit `subscription.schedule_canceled`.

### 6.4 UI (`components/subscriptions/schedule-modal.tsx`)

Triggered by the header button. Disabled with tooltip when `selectedIds.size === 0`. Behavior:

- If exactly one selected row: scheduling for that purchase.
- If multiple: fire one POST per row in parallel (page-level mutation orchestrator handles aggregate toast).
- Fields: date picker (defaults to "end of current period" if visible from row), `revokeImmediately` checkbox **only** shown when at least one selected purchase has `store === "MANUAL"`.
- Sub-section "Pending scheduled actions" in the expanded row footer (re-uses `expanded-row.tsx`) showing existing schedules + a delete button each.

## 7. Feature: Export CSV

### 7.1 Endpoint

`GET /v1/dashboard/projects/:projectId/subscriptions/export.csv?scope=…&search=…` — role ≥ `VIEWER`. Streaming Hono response:

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="subscriptions-<projectId>-<YYYYMMDD>.csv"
```

### 7.2 Implementation

Re-use `listSubscriptions` with a server-side cursor loop (`limit: 1000` per page). Stream rows as they come — write to the response body via Hono's stream helper. No new dependency; minimal CSV writer (~20 LOC) handles `"` escaping. Columns:

```
id, subscriber_id, product, status, store, price_amount, price_currency,
purchase_date, expires_date, auto_renew, is_trial, cancellation_date
```

After the stream completes: `audit({ action: "subscriptions.exported", metadata: { scope, search, row_count } })`. Hard cap: 1,000,000 rows (defensive; far above any expected dataset). If hit, write a final CSV comment line `# truncated at N rows` and audit `truncated: true`.

### 7.3 UI

`Export CSV` button → builds URL with current `scope` and `search`, then `window.location.assign(url)`. No spinner needed (browser shows download). If a project has zero subscriptions, the button shows a tooltip "Nothing to export" and is disabled.

## 8. Shared types (`packages/shared/src/dashboard.ts`)

Add Zod schemas and TS types for all new request/response shapes (`GrantSubscriptionRequest`, `ScheduleActionRequest`, `ScheduledActionRow`, `ListScheduledActionsResponse`). Mirror the existing pattern in this file.

## 9. Tests

- `services/subscriptions/grant.test.ts` — integration (real Postgres via testcontainers): all 5 duration variants, subscriber-from-another-project rejection, audit row written, subscriber_access populated, outbox row written.
- `services/subscriptions/schedule.test.ts` — integration: future-date validation, duplicate-pending rejection, terminal-status rejection.
- `workers/scheduled-actions.test.ts` — integration: MANUAL revoke-immediately path, MANUAL keep-until-natural-end path, Stripe path with stubbed SDK, Apple/Google intent-marker + webhook enqueue path.
- `services/subscriptions/export-csv.test.ts` — unit: CSV escaping (quotes, commas, newlines), pagination boundary, audit on completion.
- `routes/dashboard/subscriptions.test.ts` — route-level: auth + RBAC for the new endpoints, 409 conditions.

## 10. Roll-out

Single PR. Migration first (enum add + new table), then services + worker + routes, then dashboard. No feature flag — the buttons already exist but are inert; this PR makes them work. No backward-compatibility shim needed.

## 11. Out of scope (v1)

- Pause / Resume / Refund / Change-plan scheduled actions (only Cancel).
- Recurring scheduled exports / email delivery.
- Bulk grants (single-subscriber-at-a-time only).
- Editing or transferring an existing manual subscription (create + cancel only).
- Comp grant of a trial product (treat as plain comp; trial nuance deferred).

## 12. Open questions

None at this time. All blocking decisions are captured in §2.
