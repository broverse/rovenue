# SDK-driven `purchase()` with remote Offerings — Design

**Date:** 2026-06-15
**Status:** Approved (brainstorming → ready for implementation plan)
**Scope:** Rovenue SDK (Rust core + Swift/Kotlin/RN façades), API (`/v1/offerings`), docs

## Problem

The SDK today exposes `postAppleReceipt` / `postGoogleReceipt`: the host app must
run the StoreKit 2 / Play Billing purchase itself, obtain a JWS / purchase token,
then hand it to Rovenue for server-side validation. This is a deliberate,
documented stance ("the SDK does **not** call StoreKit or Play Billing"), repeated
across the Rust core, the Swift/Kotlin façades, and the docs (including
`migrating-from-revenuecat.mdx`).

This design **reverses that stance**. We want RevenueCat parity: a single
`purchase()` that drives the native store flow itself, validates the receipt
transparently, and resolves with the updated subscriber state. The change is
cross-cutting (Swift, Kotlin, Rust, RN, API, docs).

## Decisions (locked during brainstorming)

1. **Product model:** Remote Offerings (full RevenueCat parity). The SDK fetches
   dashboard-configured offerings from the Rovenue backend and the app buys a
   `Package`.
2. **`purchase()` resolution timing:** Resolves **after** server validation
   completes, returning the updated entitlements/credits. Validation is "in the
   background" from the user's point of view, but the awaited promise waits for it.
3. **Legacy methods:** `postAppleReceipt` / `postGoogleReceipt` are **removed**
   (breaking change accepted). `purchase()` is the only purchase path.
4. **`restorePurchases()`** is included.
5. **finish-only-after-validation** rule and a **background transaction listener**
   are both included (correctness; avoids lost purchases).

## Data model (already in place — no schema change)

- `offerings` table: `identifier`, `accessId`, `isDefault`, `products` (jsonb array
  of product refs with order/promoted flags), `metadata`.
- `products` table: `identifier`, `type` (`SUBSCRIPTION` | `CONSUMABLE` |
  `NON_CONSUMABLE`), `storeIds` (jsonb `{ apple, google }`), `displayName`,
  `accessIds[]`, `creditAmount`, `isActive`.

Offerings map ~1:1 onto Postgres. Only a public **read** endpoint is new.

## Public API surface

RN/TS (Swift and Kotlin mirror it exactly):

```ts
const offerings = await Rovenue.getOfferings();
const pkg = offerings.current?.packages[0];          // Package
const result = await Rovenue.purchase(pkg);          // drives store + validates
const customer = await Rovenue.restorePurchases();   // sync + revalidate
```

Types:

- `Offerings { current: Offering | null; all: Record<string, Offering> }`
- `Offering { identifier: string; isDefault: boolean; packages: Package[] }`
- `Package { identifier: string; product: StoreProduct }`
- `StoreProduct { id: string; type: 'subscription' | 'consumable' | 'non_consumable'; displayName: string; priceString: string; price: number; currencyCode: string }`
  - `id` / `type` / `displayName` come from the Rovenue offerings endpoint.
  - `priceString` / `price` / `currencyCode` come from a **live StoreKit / Play
    query** for the platform's `storeId`.
- `PurchaseResult` (CustomerInfo-style): `{ entitlements: Entitlement[]; creditBalance: number; productId: string; storeTransactionId: string }`.

`purchase()` accepts a `Package` (preferred) or a `StoreProduct`.

**Removed:** `postAppleReceipt`, `postGoogleReceipt` and their native/Rust-exposed
counterparts as part of the JS-facing surface.

**`appAccountToken` / `obfuscatedAccountId`** are applied **automatically** by the
SDK inside `purchase()` (it reads the stable per-subscriber token from the Rust
core and passes it to the store call). `getAppAccountToken()` remains public but is
no longer required for purchasing.

## Layering — where the work lives

The Rust core cannot touch StoreKit / Play Billing (platform-native only). So the
store flow lives in Swift / Kotlin; the Rust core keeps validation + cache refresh.

### Swift `purchase()` sequence

1. Resolve `Product` for the package's apple `storeId` (`Product.products(for:)`,
   cached from `getOfferings()`).
2. `Product.purchase(options: [.appAccountToken(uuid)])`.
   - `.userCancelled` → throw `PurchaseCancelledError`.
   - `.pending` → throw `PurchasePendingError`.
   - `.success(verification)` → extract the JWS.
3. `core.postAppleReceipt(jws, productId, appAccountToken)` — server validation +
   entitlement/credit refresh (existing Rust transport, now internal).
4. **On validation success only:** `transaction.finish()`.
5. Return `PurchaseResult` from the refreshed core cache.

### Kotlin `purchase()` sequence

1. `queryProductDetails(storeId.google)`.
2. `launchBillingFlow(activity, params.setObfuscatedAccountId(uuid))`.
3. Purchase token arrives via `PurchasesUpdatedListener`.
4. `core.postGoogleReceipt(token, productId, obfuscatedAccountId)`.
5. **On validation success only:** `consume` (CONSUMABLE) vs `acknowledge`
   (SUBSCRIPTION / NON_CONSUMABLE) — chosen from the product `type`.
6. Return `PurchaseResult`.

### Rust core

Essentially unchanged. `post_apple` / `post_google` remain the validation transport
(now internal, invoked by the native layer, not exposed to JS) and still refresh
entitlements + credits. Whether a product grants an entitlement, credits, or both
is decided **server-side** from `products.type` / `products.creditAmount`; the
product `type` is surfaced to the native layer only so it can finish the
transaction correctly (consume vs acknowledge).

### Correctness rule — finish only after validation

finish / acknowledge / consume happens **only after** server validation succeeds.
If validation fails or the app crashes mid-flow, StoreKit / Play re-delivers the
unfinished transaction, and the background listener retries. No purchase is lost.

## Background transaction listener

Started at `configure()`:

- **Swift:** a long-lived `Transaction.updates` task.
- **Kotlin:** the `PurchasesUpdatedListener` plus `queryPurchasesAsync` on billing
  reconnect / app foreground.

Catches renewals, Ask-to-Buy approvals, and interrupted purchases → validate via
the core → finish → emit `ENTITLEMENTS_CHANGED` on the observer stream. This makes
validation truly background for transactions completed outside a `purchase()` call.
The `purchase()` call itself still awaits validation (decision #2).

## Offerings: backend + data flow

New endpoint **`GET /v1/offerings`** (public API key / Bearer auth):

```json
{ "data": {
  "current": "default",
  "offerings": [
    { "identifier": "default", "isDefault": true, "packages": [
      { "identifier": "monthly",
        "storeIds": { "apple": "com.x.pro.monthly", "google": "pro_monthly" },
        "productType": "SUBSCRIPTION",
        "displayName": "Pro Monthly" }
    ]}
  ]
}}
```

Flow: `getOfferings()` → core fetches/caches this JSON (ETag, same pattern as
entitlements) → native layer queries StoreKit / Play for each platform `storeId` to
fill live price → returns merged `Offerings`. `current` = the offering with
`isDefault = true`. Offline: serve cached offering config; live price may be stale
or absent (`StoreProduct` price fields nullable in that case).

Experiment- / placement-driven offering overrides are **out of scope** (YAGNI);
Rovenue's `experiments` table can drive `current` selection in a later iteration.

## Error handling

| Condition | Error / behaviour |
|---|---|
| User dismissed the store sheet | `PurchaseCancelledError` (benign; app shows nothing) |
| Deferred / Ask-to-Buy / Play pending | `PurchasePendingError`; entitlement arrives later via the listener |
| Server validation rejected the receipt | `ReceiptInvalidError`; transaction **not** finished (will retry) |
| Network down during validation | `NetworkUnavailableError`; transaction left unfinished, retried on next foreground |
| Product not found / store unavailable | `ProductNotAvailableError` / `StoreProblemError` |

New error classes: `PurchaseCancelledError`, `PurchasePendingError`,
`ProductNotAvailableError`, `StoreProblemError`. Existing classes reused where
they fit (`ReceiptInvalidError`, `NetworkUnavailableError`, `DuplicatePurchaseError`).

## Testing

- **Rust core:** offerings fetch + ETag cache tests; existing receipt transport
  tests retained.
- **Swift:** `SKTestSession` (StoreKitTest) matrix — success, user-cancel, pending,
  validation-fail-no-finish, restore.
- **Kotlin:** Robolectric + fake `BillingClient` — same matrix, plus consume-vs-
  acknowledge selection by product type.
- **RN:** mocked native module — `getOfferings()` shape, `purchase()` forwarding +
  error mapping, removed-methods absent from the surface.
- **API:** `/v1/offerings` integration test (testcontainers Postgres).

## Docs

Rewrite `processing-purchases.mdx`, `quickstart.mdx`, `react-native.mdx`,
`index.mdx`; **flip** `migrating-from-revenuecat.mdx` to a "near drop-in"
narrative. Remove every "SDK does not call StoreKit / Play Billing" statement.

## Implementation sequencing (for the plan)

1. Backend `GET /v1/offerings` (+ integration test).
2. Rust core offerings fetch / ETag cache (keep receipt transport, mark internal).
3. Swift: product cache, `purchase()`, `restorePurchases()`, `Transaction.updates`
   listener; remove `postAppleReceipt`/`postGoogleReceipt` from the public surface.
4. Kotlin: equivalent (Play Billing 6).
5. RN: `getOfferings()` / `purchase()` / `restorePurchases()` surface + types +
   error classes; remove legacy methods from `index.ts` and the native spec.
6. Docs rewrite + RevenueCat-migration flip.

## Out of scope (YAGNI)

- Experiment / placement-driven offering selection.
- Promotional offers / win-back offers / intro-offer eligibility surfacing in the
  SDK API (server still records them).
- Paywall UI components.
