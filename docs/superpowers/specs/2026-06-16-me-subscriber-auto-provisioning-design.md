# /v1/me subscriber auto-provisioning + entitlements endpoint

**Date:** 2026-06-16
**Status:** Design — pending plan
**Scope:** Server-only (`apps/api`). No SDK/Rust change required for the primary fix.

## Problem

A freshly-launched SDK with a brand-new (never-seen) `rovenueId` cannot read its
entitlements. The reactive hooks (`useCurrentUser` / `useEntitlements` /
`useCreditBalance`) fire on mount and call the native module, which hits the
public-key `/v1/me/*` endpoints. Two defects surface:

1. **`/v1/me/*` 404s for unknown subscribers.** The `app-user-context`
   middleware calls `resolveSubscriber()`, which is find-only and throws
   `404 "Subscriber <id> not found"`. The SDK surfaces this as
   `InternalError: Server returned an error`. A brand-new user reading
   entitlements should get an **empty set (200)**, not an error.
2. **`GET /v1/me/entitlements` is not a route.** The SDK core requests
   `GET /v1/me/entitlements` (expecting `{ data: { entitlements: {…} } }`), but
   the API only serves `/v1/me/access`. Even with an existing subscriber this
   path 404s.

`/v1/config` already upserts the subscriber (`upsertSubscriber`), so there is an
inconsistency: the SDK's config call materializes the subscriber, but the
entitlements/credits reads require it to pre-exist.

## Decision (chosen approach)

Adopt the **Adapty / RevenueCat model**: the subscriber is a first-class record
that exists from the SDK's first contact, and anonymous reads return empty —
never an error. Implement this server-side as **lazy idempotent upsert on the
`/v1/me/*` path** (no SDK change, no race, no extra round-trip — `configure()`
already triggers the first `/v1/me` read).

The "unknown user → clear 404" requirement applies only to the **secret-key /
explicit** `/v1/subscribers/:appUserId/*` family, where the caller addresses a
*specific* user by id and auto-creating one would be wrong.

## Architecture & changes

### 1. Auto-provision on `/v1/me/*` (Req #1)

- Add `resolveOrCreateSubscriber(projectId, key)` in `apps/api/src/lib/` (new,
  or alongside `resolve-subscriber.ts`): resolve by `rovenueId` (following
  `mergedInto` redirects, like `resolveSubscriber`); if absent, **`upsertSubscriber`**
  a minimal anonymous row (`{ projectId, rovenueId: key, createAttributes: {} }`)
  — the same repo `/v1/config` uses — and return it.
- Change **only** `app-user-context` middleware (the `/v1/me/*` family) to call
  `resolveOrCreateSubscriber` instead of `resolveSubscriber`.
- **Do NOT change `resolveSubscriber`** — it stays find-or-404 and is still used
  by `routes/v1/subscribers.ts` (the secret-key/explicit family, see §3).
- Idempotency: `upsertSubscriber` must be a no-op-on-conflict upsert keyed by
  `(projectId, rovenueId)` so concurrent first-calls don't duplicate. (It already
  is — reused from the `/v1/config` path.)
- Result: a brand-new `rovenueId` calling any `/v1/me/*` endpoint gets a freshly
  created subscriber and an **empty** access / entitlements / credit response (200).

### 2. Add `GET /v1/me/entitlements` (SDK contract reconciliation)

- Add the route to `apps/api/src/routes/v1/me.ts`, gated by the same
  `appUserContext` middleware (so it auto-provisions per §1).
- Response shape must match the SDK's deserialization in
  `packages/core-rs/src/entitlements/reader.rs` (`body.data.entitlements` →
  `map_to_rows`): `{ data: { entitlements: <map keyed by entitlement id> } }`,
  each value carrying the fields the SDK reads (`isActive`/`is_active`,
  `productIdentifier`/`product_identifier`, `expiresAt`/`expires_iso`). Exact
  field names are verified against that struct during implementation.
- Derive the data from the same source as `/v1/me/access`
  (`buildAccessResponse` / `subscriber_access`); reshape to the entitlements map.
  Empty subscriber → `{ data: { entitlements: {} } }`.

### 3. Unknown user → clear 404 on the explicit family (Req #2)

- `routes/v1/subscribers.ts` keeps using `resolveSubscriber` (find-or-404).
  Confirm its 404 envelope carries a clear message (it already returns
  `"Subscriber <id> not found"` / `"… not found and no receipts provided"`).
- No behavior change needed beyond ensuring consistency; this path must **not**
  auto-create.

## Out of scope (follow-up)

- **SDK error mapping (Rust).** The SDK currently collapses any non-2xx into
  `InternalError: "Server returned an error"`. A follow-up should map the server
  envelope (`error.code` / `error.message`) to the correct `RovenueError`
  subclass (e.g. 404 → `UserNotFoundError`) and surface the server message. Not
  required for this fix — §1 removes the 404 from the SDK's `/v1/me` path
  entirely, and §3's messages are already clear for backend consumers. Tracked
  separately because it requires a core-rs change + uniffi rebuild.
- Anonymous→identified merge semantics (already handled via secret-key
  `/v1/subscribers/transfer`).

## Error handling

- `/v1/me/*`: missing `X-Rovenue-App-User-Id` header → unchanged `400`. Unknown
  subscriber → now auto-created (200). Upsert failure → propagate as 500 (real
  server error).
- `/v1/subscribers/:appUserId/*`: unknown → `404` with clear message (unchanged).

## Testing

- **Unit/integration (`apps/api`, testcontainers Postgres):**
  - `GET /v1/me/entitlements` with a never-seen `rovenueId` → `200`,
    `{ data: { entitlements: {} } }`, and a subscriber row now exists.
  - `GET /v1/me/access` and `/v1/me/credits` with a new `rovenueId` → `200` empty,
    row created.
  - Concurrent first-calls for the same new `rovenueId` → exactly one row
    (idempotent upsert).
  - `mergedInto` redirect still resolves to the canonical row (no duplicate
    create).
  - `/v1/subscribers/:appUserId/...` with unknown id → still `404` with the clear
    message (regression guard for §3 / Req #2).
- **SDK contract:** the `GET /v1/me/entitlements` response deserializes into the
  core-rs `EntitlementsResponse` (assert shape against the struct).

## Files touched

- `apps/api/src/lib/resolve-subscriber.ts` (add `resolveOrCreateSubscriber`, or a
  new sibling file)
- `apps/api/src/middleware/app-user-context.ts` (use resolve-or-create)
- `apps/api/src/routes/v1/me.ts` (add `GET /entitlements`)
- Tests under `apps/api/` (integration)
