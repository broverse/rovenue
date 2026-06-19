# Surface configured webhook on Apps & integrations + custom webhook detail

**Date:** 2026-06-19
**Status:** Approved (design)
**Area:** apps/dashboard, apps/api, packages/db, packages/shared

## Problem

A project's outgoing webhook is configured via the **"New webhook"** button on the
Apps & integrations page (`apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx`),
which opens `CustomWebhookModal` and `PATCH`es the project. But once configured, the
Apps & integrations page renders **nothing** about that webhook — it only appears in
**Settings → SDK/API → `WebhookCard`**. So after creating a webhook, the user cannot
find it where they created it. There is also no detail view for inspecting the webhook
or its delivery history.

## Data model (unchanged)

The webhook stays **one endpoint per project**. There is no `webhook_endpoints` table.
Configuration lives on the `projects` table:

- `webhookUrl: text | null`
- `webhookSecret: text | null` (exposed to dashboard only as `hasWebhookSecret: boolean`)
- `webhookEventCategories: jsonb string[]` (empty = all categories)

Delivery attempts live in `outgoing_webhooks` (one row per delivery attempt, with
`status`, `httpStatus`, `attempts`, `createdAt`, `sentAt`, `lastErrorMessage`, etc.).

**No schema migration.** This is a surfacing + read-only-history feature only.

## Scope decisions

1. **Surface the single existing webhook** — no multi-webhook model.
2. **Detail view = config + delivery history** — requires one new read endpoint.
3. **Detail view = full route/page** — not a drawer.

## Design

### 1. Backend — recent deliveries endpoint

Today only DEAD deliveries are queryable (`GET /dashboard/webhooks/failed`). Add an
all-statuses, read-only list.

**Route** — `apps/api/src/routes/dashboard/webhooks.ts`

- `GET /dashboard/webhooks/deliveries?projectId=&limit=&offset=`
- Auth: same dashboard project-access guard as the existing `/failed` route.
- Validation: Zod query schema; `projectId` required, `limit` default 20 (cap e.g. 100),
  `offset` default 0 — mirror the `/failed` handler.
- Returns recent `outgoing_webhooks` rows for the project, **all statuses**, newest first
  (`createdAt DESC`), paginated.
- Response: `{ data: ListWebhookDeliveriesResponse }` per the `{ data: T }` convention.

**Repository** — `packages/db/src/drizzle/repositories/outgoing-webhooks.ts`

- `listRecentOutgoingWebhooks(db, { projectId, limit, offset }): Promise<OutgoingWebhook[]>`
- `countOutgoingWebhooks(db, projectId): Promise<number>`
- Mirror the existing `listDeadWebhooks` / `countDeadWebhooks` implementations
  (same ordering, pagination, and project scoping; drop the `status = DEAD` filter).

**Shared types** — `packages/shared/src/dashboard.ts`

- `WebhookDelivery`: `{ id, eventType, url, status, httpStatus: number | null, attempts,
  createdAt, sentAt: string | null, lastErrorMessage: string | null }`
  (project-level promotion of the existing `SubscriberOutgoingWebhook` shape; reuse/extend
  rather than duplicate where practical).
- `ListWebhookDeliveriesResponse`: `{ webhooks: WebhookDelivery[]; pagination: { total,
  limit, offset, hasMore } }` — same `pagination` shape used by the failed list.

No changes to the delivery worker, dedup logic, claim/retry flow, or schema.

### 2. Apps & integrations page — surface the configured webhook

In `apps.tsx`, add a **"Configured webhook"** card (new component under
`apps/dashboard/src/components/apps/`), rendered only when `project.webhookUrl` is set.
Data comes from the existing `useProject(projectId)` — no new fetch.

- Displays: endpoint URL, an "Active" badge, subscribed event categories
  (or "All events" when empty), and secret-configured status (`hasWebhookSecret`).
- Clicking the card navigates to the detail route (Section 3).
- When **no** webhook is configured, behavior is unchanged: the "New webhook" button and
  `BuildYourOwnCard` CTA remain. `CustomWebhookModal` remains the create/edit path.

Placement: a dedicated section near the top of the main content column (alongside / above
`ConnectedStrip`), so a created webhook is immediately visible.

### 3. Custom webhook detail route

New full page: `/_authed/projects/$projectId/apps/webhooks`
(file `apps/dashboard/src/routes/_authed/projects/$projectId/apps/webhooks.tsx`).
Single webhook per project, so no ID segment.

- **Config block:** endpoint URL, "Edit" action (reuses `CustomWebhookModal`), subscribed
  event categories.
- **Signing secret block:** configured / not-set status + rotate action (reuses
  `useRotateWebhookSecret`).
- **Delivery history table:** new hook `useWebhookDeliveries(projectId)` calling the
  Section 1 endpoint. Columns: status, event type, attempts, created, sent, last error.
  Paginated (limit/offset). Loading + empty states (reuse the shared `LoadingState` /
  `EmptyStateCard` already used across billing pages where it fits).
- If the route is reached with no webhook configured, show an empty/CTA state pointing to
  the create modal rather than erroring.

### Component / hook inventory

New:
- `apps/api/src/routes/dashboard/webhooks.ts` — `GET .../deliveries` handler
- `packages/db/.../outgoing-webhooks.ts` — `listRecentOutgoingWebhooks`, `countOutgoingWebhooks`
- `packages/shared/src/dashboard.ts` — `WebhookDelivery`, `ListWebhookDeliveriesResponse`
- `apps/dashboard/src/components/apps/configured-webhook-card.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/apps/webhooks.tsx`
- `apps/dashboard/src/lib/hooks/useWebhookDeliveries.ts`

Reused:
- `useProject`, `useUpdateProjectWebhook`, `useRotateWebhookSecret`
- `CustomWebhookModal` (create/edit)
- Shared `LoadingState` / `EmptyStateCard`

### Out of scope (default)

- Wiring real deliveries into the Settings → SDK/API `WebhookCard` (still uses mock
  `WEBHOOK_DELIVERIES`). Can be a follow-up; the new endpoint makes it trivial later.
- Multi-webhook model / `webhook_endpoints` table.
- Any change to delivery, retry, dedup, or schema.

## Testing

- **API integration test** for `GET /dashboard/webhooks/deliveries`: project scoping
  (no cross-project leakage), ordering (newest first), pagination (`limit`/`offset`/
  `hasMore`/`total`), and that all statuses (not just DEAD) are returned. Follow the
  existing `webhooks.ts` route test patterns / testcontainers suites.
- **Repository unit/integration coverage** for `listRecentOutgoingWebhooks` /
  `countOutgoingWebhooks` alongside the existing dead-webhook repo tests.
- **Dashboard:** the configured-webhook card renders only when `webhookUrl` is set;
  detail route renders config, secret status, and delivery table; empty state when no
  webhook. Match existing dashboard test conventions.

## Acceptance criteria

- After configuring a webhook via the modal, a "Configured webhook" card is visible on the
  Apps & integrations page.
- Clicking the card opens a full detail page showing endpoint URL, secret status (with
  rotate), subscribed categories, and a paginated delivery-history table backed by real
  data.
- No webhook configured → page is unchanged; detail route shows an empty/CTA state.
- No database schema changes; existing webhook config/rotate flows unchanged.
