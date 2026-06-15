# SDK Purchase Freshness & Round-Trip Reduction — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Scope:** `packages/core-rs` (Rust core), native façades (`sdk-swift`, `sdk-kotlin`, `sdk-rn`)

## Background

Investigation of the SDK purchase path surfaced three findings. Two earlier-suspected
problems turned out **not** to be bugs and are explicitly out of scope:

- **Not a bug — double credit on reconcile.** The reconciler re-POSTs an owned purchase
  with a fresh idempotency key on every launch, but the server dedupes at the data layer:
  `purchases` has a unique constraint on `(store, storeTransactionId)`
  (`packages/db/src/drizzle/schema.ts:703`, upsert at `repositories/purchases.ts:65`), and
  `addCredits(..., dedupeOnReference: true)` skips an existing ledger row keyed by
  `referenceId = purchase.id` (`apps/api/src/services/credit-engine.ts:74`,
  `repositories/credit-ledger.ts:18`). Re-POST is correct but wasteful.
- **Out of scope — durable receipt outbox / startup reconcile race (1b/1c).** Platform
  re-delivery already provides transaction durability: iOS `Transaction.updates` listener
  (`sdk-swift/.../Rovenue.swift:553`) and Android `queryUnacknowledgedPurchases` +
  `PurchaseReconciler` (`sdk-kotlin/.../Rovenue.kt:124`). The residual gap (POST fails after
  3 transport retries *and* app exits, for already-consumed Android consumables) is narrow
  and deferred.

This design covers the three accepted improvements: **B** (deterministic idempotency key),
**C** (entitlement/credit freshness), **D** (return entitlements + credits from the purchase
response instead of two extra GETs).

## Goals

- Cut the purchase path from 3 network round-trips (1 POST + 2 GETs) to 1 POST.
- Eliminate the cold-resume / cold-start staleness window for entitlement & credit reads,
  without ever blocking a read on the network.
- Stop redundant receipt re-verification when the reconciler / StoreKit re-posts the same
  transaction within the server's idempotency window.

## Non-Goals

- No durable SQLite receipt outbox; no startup reconcile in the Rust core (1b/1c deferred).
- No change to the public façade `PurchaseResult` shape
  (`entitlements`, `creditBalance`, `productId`, `storeTransactionId` unchanged).
- No change to the server API (`/v1/receipts/*` already returns `access` + `credits.balance`).

---

## B — Deterministic idempotency key for receipt POSTs

### Problem
`post_apple_receipt` / `post_google_receipt` mint `IdempotencyKey::new()` (random) per call
(`packages/core-rs/src/api.rs:288, 310`). When the same store transaction is re-posted across
launches (Android `PurchaseReconciler`, iOS `Transaction.updates` re-delivery), each post
carries a new key, so the server's 24h Redis response cache
(`apps/api/src/middleware/idempotency.ts`) misses and the handler re-verifies the receipt
against Apple/Google every time.

### Design
Derive the idempotency key deterministically from the store + store transaction id so every
post for the same logical transaction shares one key:

```
idempotency_key = "rcpt:" + sha256_hex(store + ":" + store_transaction_id)
```

- Implemented in the Rust core at the receipt-post boundary so it covers **both** platforms
  and both the first post and all re-posts.
- The store transaction id is the value already used as the server-side dedup key
  (Apple `transactionId`, Google purchase token / order id as currently passed).
- Effect: a re-post within 24h replays the cached response (no Apple/Google re-verify);
  after 24h the key expires and the handler re-runs, but DB-level dedup still guarantees
  correctness. **No correctness change — pure cost reduction.**

### Notes / edge cases
- The existing in-call transport retries (3 attempts, `transport/retry.rs`) already reuse one
  key within a single call; this change extends that reuse across calls.
- A `409` from the idempotency middleware (same key, different body) is already treated as
  success by the transport classifier (`retry.rs`), which is the correct outcome here.

---

## C — Entitlement & credit freshness (TTL)

Reads currently return SQLite cache with no freshness check; `updated_at_ms` is stored but
never compared (`cache/schema.rs`). Foreground polling runs every 30s entitlements / 60s
credits but is **paused** in background and only fires after the first interval elapses, so a
read immediately after foreground / cold start can serve arbitrarily stale data.

Two complementary mechanisms:

### C1 — Immediate refresh on foreground transition
`set_foreground(true)` triggers an immediate entitlements + credits refresh instead of
waiting for the first poll interval (`packages/core-rs/src/polling/scheduler.rs`,
`api.rs` foreground handling). Subsequent polling cadence is unchanged (30s / 60s).

### C2 — Read-side staleness guard (stale-while-revalidate)
The cache read APIs (`entitlements_all()` / `entitlement(id)` / `credit_balance()` in
`packages/core-rs/src/api.rs`, backed by readers in `entitlements/` and `credits/`):

1. **Always return cached data immediately and synchronously. Reads never block on the
   network.**
2. If `now_unix_ms - updated_at_ms > staleness_threshold`, kick an **async, non-blocking**
   refresh on a background thread. When it completes it writes the cache and emits the
   change observer (`EntitlementsChanged` / `CreditBalanceChanged`), so subscribed UI
   updates reactively.
3. Coalesce: a refresh already in flight is not re-triggered (a single in-flight guard /
   flag per resource) so a burst of reads produces at most one network call.

### Threshold
- `staleness_threshold = 60_000 ms` for **both** entitlements and credits (single value,
  applied per resource).
- Implemented as a core constant (`STALENESS_MS`). The FFI `Config` dictionary maps 1:1 to
  the Rust `Config` via uniffi, so exposing this as a configure option would require touching
  every façade; that exposure is a deferred follow-up, not part of this change.

---

## D — Return entitlements + credits from the purchase response

The server receipt response already contains everything needed
(`apps/api/src/routes/v1/receipts.ts:111` returns `{ subscriber, access, credits: { balance } }`),
but the Rust client drops `access` and instead fires `entitlements.refresh()` +
`credits.refresh()` — two extra GETs (`api.rs:302-303, 324-325`). The receipt `access` entry
shape is identical to the `GET /v1/me/entitlements` wire shape (`isActive`, `expiresDate`,
`store`, `productIdentifier`), so it can feed the existing cache writers.

### Design
1. **Parse `access`.** Add `access: HashMap<String, EntitlementWire>` to `ReceiptResponse`
   (`packages/core-rs/src/receipts/types.rs:30`); stop dropping it.
2. **Hydrate cache from the response, drop the GETs.** In `post_apple_receipt` /
   `post_google_receipt`, replace the two `refresh()` calls with:
   - `map_to_rows(response.access, now)` → `EntitlementsRepo::upsert_many(scope, rows)` →
     emit `EntitlementsChanged` (reuse `entitlements/api.rs:map_to_rows`,
     `cache/entitlements.rs:upsert_many`).
   - `credits` reader `store_and_emit(scope, response.credits.balance, now)`
     (`credits/reader.rs:89`).
3. **Carry entitlements inline in the FFI result.** Extend `ReceiptResult` with
   `entitlements: Vec<EntitlementDto>` so façades build `PurchaseResult` directly from the
   call result rather than a separate cache read — closing the cache-write/cache-read race.
4. **Façade enrichment.** `sdk-swift`, `sdk-kotlin`, `sdk-rn` build `PurchaseResult` from the
   returned `entitlements` + `creditBalance`. The public `PurchaseResult` shape is unchanged;
   only its data source changes. Remove the now-redundant post-purchase cache read in each
   façade.

### Result
Purchase path: **1 POST** (was 1 POST + 2 GETs). Cache + observers updated from the response;
`updated_at_ms` stamped at write time, which also feeds C2's staleness check.

---

## Data flow (after changes)

```
purchase()                          [native façade]
  └─ store purchase (StoreKit / Play Billing)
  └─ validate → core.post{Apple,Google}Receipt   [Rust core]
        └─ POST /v1/receipts/*  (deterministic idempotency key — B)
              → { subscriber, access, credits.balance }
        └─ upsert_many(access) + emit EntitlementsChanged          (D)
        └─ store_and_emit(credits.balance) + emit CreditBalanceChanged (D)
        └─ return ReceiptResult { subscriber_id, app_user_id,
                                   credit_balance, entitlements }  (D)
  └─ acknowledge / finish transaction (only on validate success — unchanged)
  └─ build PurchaseResult from ReceiptResult                       (D)

set_foreground(true) → immediate refresh, then 30s/60s polling     (C1)
entitlements_all() / credit_balance() → return cache now;
   if age > 60s kick async refresh (coalesced) → emit on completion (C2)
```

## Error handling

- **B:** key derivation is pure; no new failure modes. Server idempotency replay / `409`
  already handled by the transport classifier.
- **C2:** the async refresh is best-effort — failures are swallowed (read already returned
  cache); the in-flight guard is cleared on completion (success or error) to allow retry on
  the next stale read. A failed foreground refresh (C1) falls back to normal polling.
- **D:** if `access` is absent/malformed in a response (older server), fall back to the
  current behavior (`refresh()`), so the SDK degrades gracefully against an un-upgraded API.

## Testing

- **B:** unit test that two posts for the same `(store, txid)` produce identical keys and
  differ across transactions; integration test asserting a re-post replays the cached
  response without a second receipt verification.
- **C1:** test that `set_foreground(true)` issues a refresh immediately (not after the
  interval).
- **C2:** test that a read older than 60s returns cache synchronously and schedules exactly
  one refresh (coalescing under a read burst); a fresh read schedules none; observer fires on
  completion.
- **D:** test that `post_*_receipt` performs no GET (only the POST) and that `ReceiptResult`
  carries the entitlements parsed from `access`; fallback test for a response missing
  `access`. Façade tests assert `PurchaseResult` is populated from the result.

## Affected files (anchors)

- `packages/core-rs/src/api.rs:288,310` (B key), `:302-303,324-327` (D), foreground (C1)
- `packages/core-rs/src/receipts/types.rs:30-57` (D — `ReceiptResponse.access`, `ReceiptResult.entitlements`)
- `packages/core-rs/src/receipts/client.rs` (B — key threading)
- `packages/core-rs/src/entitlements/{api.rs,reader.rs}`, `cache/entitlements.rs:28` (C2, D)
- `packages/core-rs/src/credits/reader.rs:89`, `cache/credits.rs:41` (C2, D)
- `packages/core-rs/src/polling/scheduler.rs` (C1)
- `sdk-swift/Sources/Rovenue/Rovenue.swift`, `sdk-kotlin/.../Rovenue.kt`,
  `sdk-rn/src/purchases.ts` (D — build `PurchaseResult` from result, drop redundant read)
