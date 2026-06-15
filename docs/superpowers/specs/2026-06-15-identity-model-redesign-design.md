# Identity Model Redesign — `rovenueId` + `appUserId`

- **Date:** 2026-06-15
- **Amendment (2026-06-15):** No production data exists, so the legacy `appUserId` dual-read / migration-window fallback (D6) was dropped during implementation — resolution is **rovenueId-only** plus the `mergedInto` redirect-follow. The migration is retained (safe no-op on empty tables). The `logOut()` + optimistic-identify client behavior (D4/D5) remains in the separate client/Rust follow-up plan.
- **Status:** Draft for review
- **Author:** brainstormed with Claude
- **Supersedes the identity half of:** spec §5.4 (identify-is-client-local, 2026-05-19)

## Problem

Today identity is keyed by a single mutable field, `subscribers.appUserId`, which holds
**either** a Rovenue-generated anonymous id **or** the customer's known user id. The transition
from anonymous to known is therefore a *destructive change of the row's identity key*, handled
by a separate secret-key `POST /v1/subscribers/transfer` call from the customer backend.

This produces four concrete pain points (verified against the current code):

1. **Two-step, uncoordinated merge.** `identify()` is purely client-local
   (`packages/sdk-rn/src/api/identity.ts:17`). A developer naturally calls it after login and
   assumes purchases now follow the user — but nothing merges; purchases stay on the anonymous
   subscriber. The required second step (backend `transfer`) is easy to forget and fails
   silently → "user paid, lost subscription after login" tickets.
2. **anonId plumbing.** `transfer` needs `fromAppUserId` (the anon id), but the anon id lives in
   native device storage. The client must ship it to the customer backend, which relays it to
   Rovenue — undocumented and the real friction.
3. **Race window.** Client `identify()` and backend `transfer` happen at unrelated times; a
   purchase made on the anon id in between can be stranded.
4. **Destructive, not idempotent-friendly, no logout model.** Second `transfer` throws
   "already transferred"; every new-device login spawns a new anon subscriber needing another
   transfer; logout / different-user-on-same-device is unmodeled.

Root tension: **DX (one call, auto-merge) vs. security (a public-key client must not be able to
merge/steal another user's purchases).** §5.4 made `identify()` client-local precisely to avoid
public-key merge.

## Key existing facts that shape the design

- `subscribers.id` (cuid2 PK) is the **stable internal key**. Every dependent table references it
  via `subscriberId` (`creditLedger`, `purchases`, `subscriberAccess`, `webhookEvents`,
  `revenueEvents`, `refundShieldResponses`, `experimentAssignments`, `outboxEvents`,
  `scheduledSubscriptionActions`). **ClickHouse analytics aggregate on `subscriberId`, never on
  `appUserId`** (`mv_mrr_daily` uses `uniqState(subscriberId)`). → Changing the device-facing
  lookup key does **not** touch FKs or analytics.
- Unique constraint today: `(projectId, appUserId)`.
- Lookup path: SDK sends `X-Rovenue-App-User-Id` → `middleware/app-user-context.ts` →
  `lib/resolve-subscriber.ts` → `findSubscriberByAppUserId` (404 if missing). Auto-create happens
  in `/v1/config` via `upsertSubscriber` (`ON CONFLICT (projectId, appUserId)`).
- Native contract `UserDTO` **already carries both** `anonId` (always set) and
  `knownUserId` (nullable) — `packages/sdk-rn/src/specs/RovenueModule.types.ts`. There is **no
  `logOut`/`reset`** method yet. There is **no `identifiedAt`/`isAnonymous`** flag in the schema.

## Decisions (made during brainstorming)

| # | Decision | Chosen |
|---|----------|--------|
| D1 | Identity becomes two fields | `rovenueId` (permanent) + `appUserId` (customer label) |
| D2 | Field naming | option **B**: permanent internal-facing = `rovenueId`; customer's id = `appUserId` (keeps RevenueCat + current-schema convention) |
| D3 | `identify(appUserId)` collision policy (appUserId already on another `rovenueId`) | **Auto-transfer** (RevenueCat default), made safer (see Security) |
| D4 | Logout / device hand-off | add explicit **`logOut()` / `reset()`** that mints a fresh `rovenueId` |
| D5 | Offline `identify()` | **optimistic local apply + background sync/reconcile** (flagged — confirm) |
| D6 | Migration of existing data | **included**; bulk backfill + lazy reconciliation, dual-read window (flagged — confirm) |
| D7 | Secret-key `POST /v1/subscribers/transfer` | **kept** as the authoritative/bulk consolidation path |

> ⚠️ **Flagged for review:** D5 and D6 are my recommended defaults, not yet explicitly confirmed.
> Also note D3 reverses the §5.4 security posture; the Security section defines the mitigations
> that make it acceptable.

## Target model

### Identity fields

- **`rovenueId`** — permanent, generated **per install** by the native layer (the value the SDK
  already holds as `anonId`), always present. The device-facing **primary lookup key**. Never
  changes for the life of an install (until `logOut()`).
- **`appUserId`** — the customer's backend user id, **nullable**, attached as a label via
  `identify()`. May be `null` (anonymous), and the same `appUserId` may, transiently across
  devices, map to several `rovenueId`s until consolidated.
- **`subscribers.id`** — unchanged internal PK; FK target; ClickHouse key. Untouched.

Schema changes to `subscribers`:

```
+ rovenueId   text NOT NULL              -- device-facing permanent key
  appUserId   text NULL                  -- was NOT NULL; now customer label only
+ identifiedAt timestamp NULL            -- set on first successful identify()
  -- keep: id, projectId, firstSeenAt, lastSeenAt, attributes,
  --       deletedAt, mergedInto, appleAppAccountToken, createdAt, updatedAt

unique (projectId, rovenueId)                      -- new primary device-facing constraint
unique (projectId, appUserId) WHERE appUserId IS NOT NULL  -- one canonical row per customer id
```

### Behaviors

**`identify(appUserId)` (SDK, public key → becomes a server call):**
1. Optimistically set `appUserId` locally and tag subsequent events (D5).
2. Background call: `POST /v1/identify { rovenueId, appUserId }` (public key).
3. Server:
   - If `appUserId` not used elsewhere in project → attach it to this `rovenueId`'s row, set
     `identifiedAt`. Done (no transfer).
   - If `appUserId` already on a different `rovenueId` (R_old) → **auto-transfer** R_old's assets
     to this row (reuse existing `transferSubscriber` logic, keyed by `subscribers.id`), soft-delete
     R_old with `mergedInto`. Subject to Security mitigations below.
   - If this `rovenueId` already has a *different* non-null `appUserId` → treat as a hand-off:
     do **not** silently relabel; require `logOut()` first (or auto-fork — see Open Questions).

**`logOut()` / `reset()` (new SDK + native method, D4):** native mints a **fresh `rovenueId`**,
drops the `appUserId` label, clears the entitlement cache. The next user on the device starts
clean and cannot inherit the previous user's entitlements.

**`currentUser()`** now returns `{ rovenueId, appUserId }` (renamed from `{ anonId, knownUserId }`)
— still an instant cache read.

**Secret-key `POST /v1/subscribers/transfer` (D7):** unchanged behavior, kept for authoritative
backend-driven consolidation and bulk/admin cases.

### New `POST /v1/identify` endpoint (public key)

- Auth: public key + `X-Rovenue-App-User-Id` is replaced/augmented by body `{ rovenueId, appUserId }`.
- Idempotent (safe to retry; reuses the existing advisory-lock + soft-delete guards in
  `subscriber-transfer.ts`).
- Returns the resolved `{ rovenueId, appUserId, transferred: boolean }`.

## Security — making auto-transfer (D3) safe

Pure identity-claim auto-transfer is an account-takeover vector (attacker calls
`identify(victimAppUserId)` and pulls the victim's purchases). Mitigations, mirroring how
RevenueCat ships auto-transfer as a default:

1. **Receipt-anchored transfer where possible.** Prefer moving entitlements that the calling
   device can demonstrably prove possession of (store `original_transaction_id` present on the
   device's restore/receipt), rather than on the `appUserId` claim alone.
2. **Strongly require opaque, unguessable `appUserId`.** Docs + SDK warning: never use email /
   username. Guessability is the whole attack surface.
3. **Documented shared-device caveat** + `logOut()` as the prescribed mitigation (D4).
4. **Authoritative path stays secret-key.** High-assurance consolidation remains the backend
   `transfer` endpoint (D7).

No per-project config toggle (the configurable option was explicitly rejected in favour of a
single default).

## Migration (D6)

Because FKs and analytics ride on the **stable `subscribers.id`**, no data needs to move; we only
introduce the new lookup key and reclassify the existing one.

1. **Schema:** add `rovenueId` (nullable first), add `identifiedAt`, make `appUserId` nullable.
2. **Backfill:** `UPDATE subscribers SET rovenueId = appUserId` for **all** rows (including
   soft-deleted, so `mergedInto` redirects keep resolving by `rovenueId`).
3. **Classification of the legacy `appUserId`:** we cannot reliably tell, from value alone,
   whether a legacy `appUserId` was anon-generated or customer-supplied. Strategy:
   - Treat `rovenueId` as the authoritative device key immediately.
   - **Dual-read window:** `resolveSubscriber` looks up by `rovenueId` **or** legacy `appUserId`
     so nothing 404s mid-migration.
   - **Lazy reconciliation:** on first post-upgrade call the SDK sends `rovenueId` (= old `anonId`)
     and, if known, `appUserId` (= old `knownUserId`); the server attaches `appUserId` +
     `identifiedAt` to the correct row. The native `UserDTO` already holds both halves.
4. **Constraints:** add `unique (projectId, rovenueId)`; replace the old unconditional
   `(projectId, appUserId)` unique with the partial `WHERE appUserId IS NOT NULL`.
5. **Finalize:** once devices have rolled over, set `rovenueId NOT NULL` and remove the dual-read
   fallback in a follow-up migration.

Repositories to update: `findSubscriberByAppUserId` → add `findSubscriberByRovenueId` (primary);
`upsertSubscriber` keyed on `(projectId, rovenueId)`; `resolveSubscriber` /
`app-user-context.ts` / `/v1/config.ts` switch the primary key to `rovenueId`.

## Components & boundaries

- **Native layer** (Swift/Kotlin/Rust core): generate/persist `rovenueId`; implement `logOut()`;
  `currentUser()` returns `{ rovenueId, appUserId }`. *What it does:* owns device-local identity.
- **SDK (`packages/sdk-rn`):** `identify()` (optimistic + background `POST /v1/identify`),
  `logOut()`, `currentUser()`. *Depends on:* native module + identify endpoint.
- **API `/v1/identify`:** bind/auto-transfer. *Depends on:* `subscriber-transfer` service,
  advisory locks, audit.
- **`subscriber-transfer` service:** unchanged core; now also invoked by `/v1/identify`.
- **DB repositories:** rovenueId-keyed lookup/upsert + migration.
- **Docs:** rewrite `guides/identifying-users.mdx` for the new single-call flow + logOut +
  shared-device caveat.

## Testing

- Unit: identify on fresh install (no transfer); identify with collision (auto-transfer);
  identify offline then sync; logOut mints new rovenueId; shared-device hand-off does not leak.
- Integration (testcontainers): migration backfill + dual-read; `/v1/identify` idempotency under
  concurrency (advisory-lock serialization); analytics continuity (subscriberId unchanged).
- Security: takeover attempt via guessed `appUserId` is bounded by receipt-anchoring / opaque-id.

## Open questions (to settle before/at plan time)

- **D5 confirm:** optimistic-local + background sync acceptable, or block identify when offline?
- **D6 confirm:** lazy reconciliation + dual-read acceptable, or a hard one-shot backfill?
- **Hand-off when a *different* `appUserId` is identified on an install that already has one:**
  require explicit `logOut()` (chosen) vs. auto-fork a fresh `rovenueId` inside `identify()`.
- **Receipt-anchoring depth:** how strictly to gate auto-transfer on store-transaction possession
  vs. accept the documented claim-based caveat (RevenueCat-parity).
```
