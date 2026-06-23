# Android Subscription-Offer Selection at Purchase

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Builds on:** the enriched StoreProduct feature (`StoreProduct.subscriptionOptions`/`defaultOption` already expose Android base plans + offers) and the iOS promotional-offer feature (the Android counterpart).

## 1. Problem

The Android SDK exposes `StoreProduct.subscriptionOptions` (base plans + offers with their pricing phases), but `purchase(...)` cannot redeem a SPECIFIC one: `PlayBillingStore.purchase` hardcodes `details.subscriptionOfferDetails.firstOrNull().offerToken` (the first offer Play returns). So an app can display "monthly with 1-week free trial" vs "annual" but always purchases Play's arbitrary first offer — and that may not even match the `defaultOption` (lowest-price base plan) the SDK advertised.

**Goal:** let the app pass a chosen `SubscriptionOption` to `purchase(...)`, and have the SDK redeem exactly that base-plan/offer; when none is passed, default to the same `defaultOption` the SDK advertised (not Play's arbitrary first).

## 2. Key facts established (from the codebase)

- `PlayBillingStore.purchase` (`internal/PlayBillingStore.kt`) RE-QUERIES `ProductDetails` inside purchase (`queryDetails(...)`), so the live `subscriptionOfferDetails` with current `offerToken`s are available at purchase time.
- The Play `offerToken` is **ephemeral** (tied to a specific `queryProductDetails` result; can differ/expire across queries) and is currently NOT retained in the public `SubscriptionOption` (dropped during mapping). Therefore we must NOT ask the caller to pass an `offerToken` from `getOfferings()` — it could be stale. Instead the caller passes a STABLE identity (`basePlanId` + `offerId`) and the SDK resolves the CURRENT `offerToken` inside purchase by matching. (This is RevenueCat's approach.)
- `SubscriptionOption` already carries `basePlanId: String?` and `offerId: String?` (the stable identity). Its `id` is `basePlanId` or `"basePlanId:offerId"`; `isBasePlan == (offerId == null)`.
- The receipt path (`postGoogleReceipt`) is offer-agnostic → **no backend / core change**.
- This is **Android-only**: iOS StoreKit has no base-plan/offer-selection concept (its discount mechanism is the promotional offer, already shipped). iOS purchase is untouched.

## 3. Architecture

```
App picks option ∈ product.subscriptionOptions
  └─ Rovenue.purchase(activity, product, option)           // Kotlin
       └─ PlayPurchaseFlow.run(activity, productId, type, token, basePlanId, offerId)
            └─ PlayBillingStore.purchase(... basePlanId, offerId)
                 ├─ queryDetails(productId)                 // live ProductDetails (existing)
                 ├─ build List<PlayOfferToken> from details.subscriptionOfferDetails
                 ├─ selectOfferToken(offers, basePlanId, offerId)   // PURE, testable
                 │     • requested → match basePlanId(+offerId) → that offer's CURRENT offerToken
                 │     • none requested → lowest-price BASE PLAN (== defaultOption), else first
                 │     • requested but no match → null → OfferNotFound outcome → SDK error
                 └─ launchBillingFlow(setOfferToken(selected))      // existing, token now selected
            └─ existing receipt validation + acknowledge (unchanged)
```

## 4. Components

### 4.1 Pure selection logic — `internal/ProductMapping.kt`
Add a minimal, billingclient-free input type and a pure selector (testable without Play SDK):

```kotlin
data class PlayOfferToken(
    val basePlanId: String,
    val offerId: String?,          // null for a base-plan (no offer)
    val offerToken: String,
    val recurringPriceMicros: Long?,  // INFINITE_RECURRING phase price; null if none
)

/**
 * Choose the offerToken to redeem.
 * - requestedBasePlanId != null → match basePlanId AND offerId (treat ""/null offerId as "base plan").
 *     no match → null (caller surfaces an error).
 * - requestedBasePlanId == null → the base-plan offer (offerId null/empty) with the lowest
 *     recurringPriceMicros (mirrors StoreProduct.defaultOption); if no base plan, the first offer.
 */
fun selectOfferToken(
    offers: List<PlayOfferToken>,
    requestedBasePlanId: String?,
    requestedOfferId: String?,
): String?
```

Normalization: treat `offerId` `null` and `""` as equivalent ("base plan, no offer") on both the requested side and the offer side, so an `isBasePlan` SubscriptionOption (offerId == null) matches Play's base-plan offer (offerId == "").

### 4.2 `internal/PlayBillingStore.kt`
- `purchase(...)` gains two params: `basePlanId: String?`, `offerId: String?` (default null).
- After `queryDetails`, map `details.subscriptionOfferDetails` → `List<PlayOfferToken>` (extract `basePlanId`, `offerId`, `offerToken`, and the INFINITE_RECURRING phase's `priceAmountMicros`), call `selectOfferToken(list, basePlanId, offerId)`.
- If the result is non-null → `setOfferToken(selected)` (replaces the `firstOrNull()` hardcode).
- If `selectOfferToken` returns null AND a `basePlanId` was requested → return a new `StorePurchaseOutcome.OfferNotFound` (maps to a clear SDK error: requested offer no longer available). If null and nothing requested (no subscriptionOfferDetails at all) → existing ProductNotFound/empty handling.
- INAPP (one-time) products: unchanged (no offer token).

### 4.3 `internal/PlayPurchaseFlow.kt`
- `run(...)` gains `basePlanId: String?`, `offerId: String?`, threaded into `store.purchase(...)`. Handle the new `OfferNotFound` outcome → throw `RovenueException(kind = STORE_PROBLEM or INELIGIBLE, "requested subscription offer is no longer available")`.

### 4.4 `Rovenue.kt` (public Kotlin API)
- `suspend fun purchase(activity, product: StoreProduct, option: SubscriptionOption? = null)` and the `Package` overload `purchase(activity, pkg, option: SubscriptionOption? = null)`.
- Extract `option?.basePlanId`, `option?.offerId`; pass to `PlayPurchaseFlow.run`.
- Add an internal/secondary id-parts entry the RN bridge calls: `purchase(activity, product, basePlanId: String?, offerId: String?)` (the option-based method delegates to it — single-sourced flow, no duplicated purchase body).

### 4.5 React Native
- JS `src/api/purchases.ts`: `purchase(target, options?: { promotionalOfferId?: string; subscriptionOption?: SubscriptionOption })`. The JS forwards `options.subscriptionOption?.basePlanId` + `.offerId` to native (alongside the existing `promotionalOfferId`).
- Native spec `src/specs/RovenueModule.types.ts`: `purchase(productId, productType, promotionalOfferId?, basePlanId?, offerId?)`.
- Android bridge (`android/.../RovenueModule.kt`): read `basePlanId`/`offerId`, build the `StoreProduct`, call `Rovenue.shared.purchase(activity, product, basePlanId, offerId)`. (It already ignores `promotionalOfferId` — keep that.)
- iOS bridge (`ios/RovenueModule.swift`): ignore `basePlanId`/`offerId` (Android-only; documented no-op), continue using `promotionalOfferId`. iOS façade unchanged.

## 5. Error handling

- Requested offer no longer present in live `ProductDetails` → `OfferNotFound` → typed SDK error (not a silent fallback to a different price — failing loudly is correct so the app can refresh offerings).
- No subscription offers at all / product not found → existing `ProductNotFound`.
- `launchBillingFlow` failure → existing STORE_PROBLEM path.

## 6. Testing

- **`selectOfferToken` (pure unit tests):**
  - requested basePlanId+offerId → that offer's token.
  - requested base plan (offerId null) → the base-plan offer's token (offerId ""/null normalized).
  - requested but no match → null.
  - no request → lowest `recurringPriceMicros` base-plan token (mirrors defaultOption); tie/no-base-plan → first.
- **Kotlin façade:** with a fake `PlayStore`/flow capturing args, `purchase(activity, product, option)` passes `option.basePlanId`/`option.offerId` through; `option == null` passes nulls.
- **RN:** JS `purchase(target, { subscriptionOption })` forwards `basePlanId`/`offerId` to the native bridge; `undefined` when absent (vitest, mocking `../core/native`).
- PlayBillingStore's `subscriptionOfferDetails → PlayOfferToken` extraction is thin glue over the un-mockable Play SDK; its correctness rests on the pure `selectOfferToken` tests + contract.

## 7. Out of scope

- iOS (no base-plan/offer selection concept; promotional offers already shipped).
- Server product-config `basePlanId`/`offerId` (server-driven default offer) — separate feature.
- Exposing the raw `offerToken` on the public `SubscriptionOption` (deliberately avoided — ephemeral; we re-resolve by stable identity).
- Backend / `postGoogleReceipt` changes (receipt path is offer-agnostic).
- Multi-quantity / multi-product billing flows.
