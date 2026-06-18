# Custom Webhook Configuration — Design Spec

**Date:** 2026-06-19
**Status:** Approved (design), pending implementation plan
**Area:** Dashboard "Apps / Integrations" page + project webhook delivery

## 1. Summary

The integrations page (`apps/dashboard/.../projects/$projectId/apps.tsx`) renders three
header buttons: **Integration docs**, **Custom webhook**, **Request integration**. Two of
them are dead (no handler). This work:

1. **Removes** the "Request integration" button.
2. **Makes "Custom webhook" functional** — it opens a modal that configures the project's
   **single, existing** outgoing webhook endpoint (`projects.webhookUrl` /
   `projects.webhookSecret`) and adds an **additive event-category filter**.

There is **one** webhook endpoint per project (the one the sdk-api `WebhookCard` already
shows). We are **not** building a multi-destination system, and we are **not** changing the
existing delivery path, secret storage, or the `WebhookCard`. The only behavioral addition
to delivery is optional per-event-category filtering.

## 2. Goals / Non-goals

**Goals**
- "Custom webhook" button opens a working configuration modal.
- Operator can set/edit the endpoint URL, choose which event categories to receive, and
  rotate the signing secret (revealed once).
- Outgoing webhook enqueue honors the selected event categories.
- "Request integration" button removed.

**Non-goals (explicitly out of scope)**
- No multiple webhook destinations / no `webhook_destinations` table.
- No change to the legacy delivery worker, retry/backoff, or HMAC signing logic.
- No encryption change for `webhookSecret` (stays plaintext, as today).
- No change to the sdk-api `WebhookCard` (settings → SDK page) or `BuildYourOwnCard`'s
  "New webhook" button.

## 3. What already exists (reuse, do not rebuild)

Verified in the codebase:

- **Schema:** `projects.webhookUrl text` and `projects.webhookSecret text`
  (`packages/db/src/drizzle/schema.ts:268-269`). Secret is plaintext.
- **Set URL:** `PATCH /dashboard/projects/:id` already accepts `webhookUrl`
  (`apps/api/src/routes/dashboard/projects.ts:207,350`).
- **Rotate secret:** `POST /dashboard/projects/:id/webhook-secret/rotate` mints
  `whsec_${base64url(32 bytes)}` and returns it once
  (`apps/api/src/routes/dashboard/projects.ts:392-418`). Dashboard hook
  `useRotateWebhookSecret` already calls it; audit-logged.
- **Read:** project read returns `webhookUrl` + `hasWebhookSecret`
  (`projects.ts:149-150`). Rendered by `WebhookCard`
  (`apps/dashboard/src/components/sdk-api/webhook-card.tsx`) on the settings → SDK page.
- **Enqueue:** `enqueueOutgoingWebhook` in
  `apps/api/src/services/webhook-processor.ts:276-312` reads the URL via
  `drizzle.projectRepo.findProjectWebhookUrl`, dedups by
  (project, subscriber, eventType, purchase), and inserts one `outgoing_webhooks` row.
- **Event string:** the enqueued `eventType` is the store-native value via
  `extractEventType` (`webhook-processor.ts:175-180`): Apple `notificationType`,
  Google `kind`/notificationType, Stripe `eventType`.
- **Capability gate:** `webhooks:write` (OWNER/ADMIN/DEVELOPER), defined in
  `apps/api/src/lib/capabilities.ts`.

## 4. Data model change

Single additive column on `projects`:

| column | type | default | notes |
|---|---|---|---|
| `webhookEventCategories` | `jsonb` (`string[]`) | `'[]'` not null | Empty array = receive **all** events (today's behavior). Non-empty = subscribe to that subset of normalized categories. |

**Migration:** `packages/db/drizzle/migrations/0075_project_webhook_event_categories.sql`
(next number after `0074_offerings_decouple_packages.sql`). Add column with default `'[]'`,
backfill is implicit via default. Update `packages/db/src/drizzle/schema.ts` accordingly.

No change to `outgoing_webhooks`.

## 5. Event categories (net-new shared abstraction)

Add to `@rovenue/shared`:

- `WEBHOOK_EVENT_CATEGORIES` — the operator-facing categories:
  `purchase`, `renewal`, `cancellation`, `refund`, `billing_issue`, `expiration`,
  `product_change`.
- `toWebhookEventCategory(eventType: string): WebhookEventCategory | null` — maps a
  store-native event string to a category, or `null` if unknown.

**Mapping table** (Apple `notificationType` / Google notificationType — confirm Stripe
values against `apps/api/src/routes/webhooks/stripe.ts` during implementation):

| category | Apple | Google |
|---|---|---|
| `purchase` | `SUBSCRIBED`, `OFFER_REDEEMED` | `SUBSCRIPTION_PURCHASED`, `SUBSCRIPTION_RESTARTED` |
| `renewal` | `DID_RENEW`, `RENEWAL_EXTENDED` | `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_RECOVERED` |
| `cancellation` | `DID_CHANGE_RENEWAL_STATUS` | `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_PAUSED` |
| `refund` | `REFUND`, `REFUND_DECLINED` | (n/a — handled via revoke) |
| `billing_issue` | `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED` | `SUBSCRIPTION_ON_HOLD`, `SUBSCRIPTION_IN_GRACE_PERIOD` |
| `expiration` | `EXPIRED`, `REVOKE` | `SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_REVOKED` |
| `product_change` | `DID_CHANGE_RENEWAL_PREF`, `PRICE_INCREASE` | `SUBSCRIPTION_PRICE_CHANGE_CONFIRMED`, `SUBSCRIPTION_DEFERRED` |

`CONSUMPTION_REQUEST` and any unlisted value map to `null`.

Stripe starter mapping (confirm against handler): `customer.subscription.created` →
`purchase`; `invoice.paid`/`invoice.payment_succeeded` → `renewal`;
`customer.subscription.deleted` → `cancellation`; `charge.refunded` → `refund`;
`invoice.payment_failed` → `billing_issue`; `customer.subscription.updated` →
`product_change`.

## 6. Delivery integration (filtering)

In `enqueueOutgoingWebhook` (`webhook-processor.ts`):

1. Replace `findProjectWebhookUrl` with a config fetch returning both `webhookUrl` and
   `webhookEventCategories` (new repo method `findProjectWebhookConfig(db, projectId)`
   returning `{ url, eventCategories } | null`, or extend the existing method).
2. If `url` is null → return (unchanged).
3. **Filter:** if `eventCategories` is non-empty:
   - `const cat = toWebhookEventCategory(args.eventType)`
   - if `cat !== null` and `!eventCategories.includes(cat)` → **skip enqueue** (return).
   - if `cat === null` (**unmapped**) → **fail open**: still enqueue, so unknown/new event
     types are never silently dropped. Log at debug for visibility.
4. Empty `eventCategories` → enqueue everything (today's behavior). Dedup and insert
   logic unchanged.

## 7. API change

Extend **`PATCH /dashboard/projects/:id`** (`apps/api/src/routes/dashboard/projects.ts`):

- Zod body: add
  `webhookEventCategories: z.array(z.enum(WEBHOOK_EVENT_CATEGORIES)).optional()`.
- Apply to update alongside existing `webhookUrl` handling
  (`...(body.webhookEventCategories !== undefined && { webhookEventCategories })`).
- Read response (`projects.ts:149`) includes `webhookEventCategories`.
- Same auth/capability as existing webhookUrl edit. Audit log entry consistent with the
  existing project-update path.

No new endpoint is required — URL set, secret rotate, and read already exist.

## 8. Dashboard UI

**`apps.tsx`** (`.../projects/$projectId/apps.tsx:132-145`):
- Remove the "Request integration" `Button` (and the now-unused `Plus` import if no longer
  referenced).
- Wire "Custom webhook" `onClick` to open the new modal (local `useState` open flag).

**New `components/apps/custom-webhook-modal/`** — centered modal, base-ui `Dialog`,
following the `grant-modal.tsx` pattern (`fixed left-1/2 top-1/2 z-50 w-[520px]`, backdrop
blur, header/body/footer):
- **Endpoint URL** — `Input`, prefilled from `project.webhookUrl`, URL validation, save
  enabled only when valid/dirty.
- **Event categories** — 7 checkboxes from `WEBHOOK_EVENT_CATEGORIES`. Helper text: "No
  selection = receive all events." Maps to `webhookEventCategories` (`[]` when none).
- **Signing secret** — shows `Configured` / `Not set` (from `hasWebhookSecret`). A
  **Rotate** button calls `useRotateWebhookSecret`; on success reveals the returned
  `whsec_…` once in a `CopyButton` row with a "you won't see this again" warning.
- **Footer** — Cancel + Save. Save issues the project PATCH
  (`webhookUrl` + `webhookEventCategories`), shows loading/error states, closes on success.

**Hook** — reuse an existing project-update mutation if one exists; otherwise add
`lib/hooks/useUpdateProjectWebhook.ts` (PATCH `/dashboard/projects/:id`) that invalidates
`["project", projectId]`. Reuse `useRotateWebhookSecret` as-is.

**i18n** — add `apps.customWebhook.*` keys (title, field labels, category labels, secret
copy, warnings). Remove/retire the `apps.actions.request` usage from the page (key may
remain in the catalog).

## 9. Testing

- **Unit — `toWebhookEventCategory`**: table-driven test over the Apple/Google/Stripe
  mapping, including unmapped → `null`.
- **Unit — `enqueueOutgoingWebhook` filtering**: empty categories → all enqueued; selected
  subset → matching enqueued / non-matching skipped; unmapped event with non-empty
  categories → enqueued (fail open). Mock the repo as existing tests do.
- **Route test — PATCH project**: accepts and validates `webhookEventCategories`
  (rejects values outside the enum); read returns the field.
- **Component tests** — modal open/close, URL validation, category selection → PATCH
  payload, rotate reveals secret once (mirroring `integration-drawer.test.tsx` style).

## 10. Migration / rollout notes

- Single forward-only migration (`0075`), additive column with safe default — no backfill,
  no lock risk on the (small) `projects` table.
- Behavior is unchanged for any project that doesn't set categories (`[]`).
- No coordination with the delivery worker deploy required (worker path untouched).

## 11. File touch list

**Backend**
- `packages/db/drizzle/migrations/0075_project_webhook_event_categories.sql` (new)
- `packages/db/src/drizzle/schema.ts` (add column)
- `packages/db/src/drizzle/repositories/projects.ts` (config fetch w/ categories)
- `packages/shared/src/...` (+ barrel) — `WEBHOOK_EVENT_CATEGORIES`, `toWebhookEventCategory`
- `apps/api/src/services/webhook-processor.ts` (filter in enqueue)
- `apps/api/src/routes/dashboard/projects.ts` (PATCH body + read field)

**Dashboard**
- `apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx` (remove button, wire modal)
- `apps/dashboard/src/components/apps/custom-webhook-modal/` (new modal + index export)
- `apps/dashboard/src/lib/hooks/useUpdateProjectWebhook.ts` (new, if no reusable mutation)
- i18n locale files (`apps.customWebhook.*`)

**Tests** as listed in §9.
