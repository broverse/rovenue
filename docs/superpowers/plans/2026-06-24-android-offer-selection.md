# Android Subscription-Offer Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Android SDK purchase a specific `SubscriptionOption` (base-plan/offer) by passing it to `purchase(...)`; the SDK resolves the live Play `offerToken` by matching the option's stable `basePlanId`+`offerId` at purchase time. When no option is given, default to the lowest-price base plan (matching `StoreProduct.defaultOption`) instead of Play's arbitrary first offer.

**Architecture:** A pure `selectOfferToken(...)` picks the right offer token from the live `subscriptionOfferDetails` by stable identity (no ephemeral token round-trip). `PlayBillingStore.purchase` (which already re-queries `ProductDetails`) builds the candidate list, selects, and `setOfferToken`s it. The selector threads up through `PlayPurchaseFlow.run` and the public Kotlin `purchase(..., option)` overloads, and across the RN bridge. Android-only; iOS and the receipt/backend path are untouched.

**Tech Stack:** Kotlin + Play Billing 6 (sdk-kotlin), TypeScript + Expo native bridge (sdk-rn), JUnit/`testDebugUnitTest`, Vitest.

## Global Constraints

- Android-only. iOS façade/bridge and the Rust core / `postGoogleReceipt` / backend are NOT changed.
- The caller passes a `SubscriptionOption` (or its `basePlanId`+`offerId`); NEVER an `offerToken` (ephemeral). The live token is resolved inside `purchase` by matching `basePlanId`+`offerId`.
- `offerId` `null` and `""` are equivalent ("base plan, no offer") on both the requested side and the Play offer side — normalize before matching.
- No option requested → lowest `recurringPriceMicros` BASE PLAN (offerId null/empty) — mirrors `StoreProduct.defaultOption`; if no base plan, first offer.
- Requested option not present in live `ProductDetails` → `StorePurchaseOutcome.OfferNotFound` → typed SDK error (NO silent fallback to a different price).
- `internal/ProductMapping.kt` stays billingclient-import-free (pure layer); the Play `SubscriptionOfferDetails`→`PlayOfferToken` extraction lives in `PlayBillingStore.kt`.
- Play `recurrenceMode`: 1 = INFINITE_RECURRING, 2 = FINITE_RECURRING, else NON_RECURRING.
- Verify sdk-kotlin with `./gradlew testDebugUnitTest`. Stay on `main`, commit per task, conventional commits.
- Spec: `docs/superpowers/specs/2026-06-24-android-offer-selection-design.md`.

---

## File Structure

- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ProductMapping.kt` — add pure `PlayOfferToken` + `selectOfferToken(...)`.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayStore.kt` — add `OfferNotFound` to `StorePurchaseOutcome`; extend the `PlayStore.purchase` interface signature.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt` — `purchase(...)` builds candidates + selects token + OfferNotFound.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayPurchaseFlow.kt` — `run(...)` threads basePlanId/offerId + maps OfferNotFound.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — `purchase(..., option)` + parts-based overload.
- `packages/sdk-rn/src/api/purchases.ts`, `src/specs/RovenueModule.types.ts`, `android/.../RovenueModule.kt`, `ios/RovenueModule.swift`.
- `apps/docs/content/docs/guides/processing-purchases.mdx`.

---

## Task 1: Kotlin — pure `selectOfferToken`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ProductMapping.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/SelectOfferTokenTest.kt` (Create)

**Interfaces:**
- Produces:
  - `data class PlayOfferToken(val basePlanId: String, val offerId: String?, val offerToken: String, val recurringPriceMicros: Long?)`
  - `fun selectOfferToken(offers: List<PlayOfferToken>, requestedBasePlanId: String?, requestedOfferId: String?): String?`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/SelectOfferTokenTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.internal.PlayOfferToken
import dev.rovenue.sdk.internal.selectOfferToken
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SelectOfferTokenTest {
    private val offers = listOf(
        PlayOfferToken("monthly", null, "tok-monthly-base", 9_990_000),
        PlayOfferToken("monthly", "trial", "tok-monthly-trial", 9_990_000),
        PlayOfferToken("annual", "", "tok-annual-base", 79_990_000),
    )

    @Test fun matchesBasePlanAndOffer() {
        assertEquals("tok-monthly-trial", selectOfferToken(offers, "monthly", "trial"))
    }

    @Test fun matchesBasePlanWhenOfferIdNullOrEmpty() {
        // requested offerId null must match the Play base-plan offer whose offerId is "" 
        assertEquals("tok-monthly-base", selectOfferToken(offers, "monthly", null))
        assertEquals("tok-annual-base", selectOfferToken(offers, "annual", null))
    }

    @Test fun noMatchReturnsNull() {
        assertNull(selectOfferToken(offers, "weekly", null))
        assertNull(selectOfferToken(offers, "monthly", "nonexistent"))
    }

    @Test fun defaultPicksLowestPriceBasePlan() {
        // no request → lowest recurringPriceMicros among base plans (monthly 9.99 < annual 79.99)
        assertEquals("tok-monthly-base", selectOfferToken(offers, null, null))
    }

    @Test fun emptyOffersReturnsNull() {
        assertNull(selectOfferToken(emptyList(), null, null))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.SelectOfferTokenTest"`
Expected: FAIL — unresolved `PlayOfferToken` / `selectOfferToken`.

- [ ] **Step 3: Implement** — append to `internal/ProductMapping.kt`:

```kotlin
data class PlayOfferToken(
    val basePlanId: String,
    val offerId: String?,            // null/"" = base plan (no offer)
    val offerToken: String,
    val recurringPriceMicros: Long?, // INFINITE_RECURRING phase price; null if none
)

/**
 * Choose which Play offerToken to redeem.
 * - requestedBasePlanId != null → match basePlanId AND offerId (null/"" normalized as "base plan").
 *     No match → null (caller surfaces OfferNotFound).
 * - requestedBasePlanId == null → the base-plan offer (offerId null/"") with the lowest
 *     recurringPriceMicros (mirrors StoreProduct.defaultOption); else first base plan; else first offer.
 */
fun selectOfferToken(
    offers: List<PlayOfferToken>,
    requestedBasePlanId: String?,
    requestedOfferId: String?,
): String? {
    if (offers.isEmpty()) return null
    fun norm(s: String?): String? = if (s.isNullOrEmpty()) null else s
    if (requestedBasePlanId != null) {
        val wantOffer = norm(requestedOfferId)
        return offers.firstOrNull { it.basePlanId == requestedBasePlanId && norm(it.offerId) == wantOffer }?.offerToken
    }
    val basePlans = offers.filter { norm(it.offerId) == null }
    val chosen = basePlans.filter { it.recurringPriceMicros != null }.minByOrNull { it.recurringPriceMicros!! }
        ?: basePlans.firstOrNull()
        ?: offers.firstOrNull()
    return chosen?.offerToken
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.SelectOfferTokenTest"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ProductMapping.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/SelectOfferTokenTest.kt
git commit -m "feat(sdk-kotlin): pure selectOfferToken for offer selection by stable identity"
```

---

## Task 2: Kotlin — thread offer selection through purchase

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayStore.kt` (add `OfferNotFound`; extend `purchase` signature)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt` (`purchase` body)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayPurchaseFlow.kt` (`run`)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (purchase overloads)
- Modify: any existing test fakes implementing `PlayStore` (update the `purchase` signature) — search `src/test` for `: PlayStore`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowOfferTest.kt` (Create)

**Interfaces:**
- Consumes: Task 1 (`PlayOfferToken`, `selectOfferToken`).
- Produces:
  - `StorePurchaseOutcome.OfferNotFound` (data object)
  - `PlayStore.purchase(activity, productId, productType, obfuscatedAccountId, basePlanId: String?, offerId: String?)`
  - `PlayPurchaseFlow.run(activity, productId, productType, obfuscatedAccountId, basePlanId: String?, offerId: String?)`
  - `Rovenue.purchase(activity, product, option: SubscriptionOption? = null)`, `purchase(activity, pkg, option: SubscriptionOption? = null)`, and `purchase(activity, product, basePlanId: String?, offerId: String?)`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowOfferTest.kt`. It uses a fake `PlayStore` capturing the basePlanId/offerId passed to `purchase`:

```kotlin
package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.internal.*
import dev.rovenue.sdk.generated.ReceiptResult
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.mockito.Mockito.mock

class PlayPurchaseFlowOfferTest {
    private val activity = mock(Activity::class.java)

    private class FakeStore(val outcome: StorePurchaseOutcome) : PlayStore {
        var capturedBasePlanId: String? = "UNSET"
        var capturedOfferId: String? = "UNSET"
        override suspend fun purchase(
            activity: Activity, productId: String, productType: ProductType,
            obfuscatedAccountId: String?, basePlanId: String?, offerId: String?,
        ): StorePurchaseOutcome {
            capturedBasePlanId = basePlanId; capturedOfferId = offerId; return outcome
        }
        override suspend fun queryProducts(inappIds: List<String>, subscriptionIds: List<String>) = emptyMap<String, ProductInfo>()
        override suspend fun queryUnacknowledgedPurchases() = emptyList<PendingPurchase>()
    }

    private fun receipt() = ReceiptResult("sub", "u", emptyMap(), emptyList())

    @Test fun threadsBasePlanAndOfferToStore() = runBlocking {
        val store = FakeStore(StorePurchaseOutcome.Success("tok", "order1", acknowledge = {}))
        val flow = PlayPurchaseFlow(store) { _, _ -> receipt() }
        flow.run(activity, "premium", ProductType.SUBSCRIPTION, null, "monthly", "trial")
        assertEquals("monthly", store.capturedBasePlanId)
        assertEquals("trial", store.capturedOfferId)
    }

    @Test fun offerNotFoundThrows() {
        val store = FakeStore(StorePurchaseOutcome.OfferNotFound)
        val flow = PlayPurchaseFlow(store) { _, _ -> receipt() }
        assertFailsWith<RovenueException> {
            runBlocking { flow.run(activity, "premium", ProductType.SUBSCRIPTION, null, "gone", null) }
        }
    }
}
```

(Match the real `ReceiptResult` constructor + `PendingPurchase`/`PlayStore` members on disk — open `PlayStore.kt` + the generated `ReceiptResult` and mirror exactly; the fake must implement every `PlayStore` member. `org.mockito.Mockito` is already a test dep if other tests mock — if Mockito isn't available, pass a lightweight `Activity` stub the same way existing purchase tests do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.PlayPurchaseFlowOfferTest"`
Expected: FAIL — `purchase` signature mismatch / `OfferNotFound` undefined.

- [ ] **Step 3: Add `OfferNotFound` + extend the `PlayStore` interface**

In `internal/PlayStore.kt`, add to the `StorePurchaseOutcome` sealed interface:

```kotlin
    /** The requested base-plan/offer is no longer present in the live ProductDetails. */
    data object OfferNotFound : StorePurchaseOutcome
```

and extend the interface method signature:

```kotlin
    suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
        basePlanId: String? = null,
        offerId: String? = null,
    ): StorePurchaseOutcome
```

- [ ] **Step 4: Implement offer selection in `PlayBillingStore.purchase`**

In `internal/PlayBillingStore.kt`, change the `purchase` signature to match the interface (add `basePlanId: String? = null, offerId: String? = null`). Replace the offer-token block (the `if (productType == ProductType.SUBSCRIPTION) { details.subscriptionOfferDetails?.firstOrNull()?.offerToken?.let { setOfferToken(it) } }`) with selection logic. Insert, after `val details = queryDetails(...) ?: ...`:

```kotlin
    var selectedOfferToken: String? = null
    if (productType == ProductType.SUBSCRIPTION) {
        val candidates = (details.subscriptionOfferDetails ?: emptyList()).map { offer ->
            PlayOfferToken(
                basePlanId = offer.basePlanId,
                offerId = offer.offerId,
                offerToken = offer.offerToken,
                recurringPriceMicros = offer.pricingPhases.pricingPhaseList
                    .firstOrNull { it.recurrenceMode == 1 }?.priceAmountMicros,
            )
        }
        selectedOfferToken = selectOfferToken(candidates, basePlanId, offerId)
        // Caller asked for a specific offer that no longer exists → fail loudly, do not pick a different price.
        if (selectedOfferToken == null && basePlanId != null) {
            inFlight.set(false); return StorePurchaseOutcome.OfferNotFound
        }
    }
```

Then in the `ProductDetailsParams` builder, replace the old `.apply { if (...) firstOrNull()... }` with:

```kotlin
        .apply { selectedOfferToken?.let { setOfferToken(it) } }
```

- [ ] **Step 5: Thread through `PlayPurchaseFlow.run`**

In `internal/PlayPurchaseFlow.kt`, add the two params to `run` and pass them to `store.purchase`, and map the new outcome:

```kotlin
    suspend fun run(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
        basePlanId: String? = null,
        offerId: String? = null,
    ): PurchaseResult {
        when (val outcome = store.purchase(activity, productId, productType, obfuscatedAccountId, basePlanId, offerId)) {
            is StorePurchaseOutcome.OfferNotFound ->
                throw RovenueException(kind = ErrorKind.PRODUCT_NOT_AVAILABLE, message = "requested subscription offer is no longer available")
            // ... all existing cases unchanged ...
        }
    }
```

(Keep every existing `when` branch; add only the `OfferNotFound` branch.)

- [ ] **Step 6: Public Kotlin API in `Rovenue.kt`**

Replace the two `purchase` overloads with option-aware versions delegating to one parts-based core (single-sourced — do NOT duplicate the body):

```kotlin
    suspend fun purchase(activity: Activity, pkg: Package, option: SubscriptionOption? = null): PurchaseResult =
        purchase(activity, pkg.product, option)

    suspend fun purchase(activity: Activity, product: StoreProduct, option: SubscriptionOption? = null): PurchaseResult =
        purchase(activity, product, option?.basePlanId, option?.offerId)

    suspend fun purchase(activity: Activity, product: StoreProduct, basePlanId: String?, offerId: String?): PurchaseResult {
        val context = appContext
            ?: throw RovenueException(kind = ErrorKind.STORE_PROBLEM, message = "Rovenue.configure(...) must be called with a Context before purchasing")
        val token = runCatching { getAppAccountToken() }.getOrNull()
        val flow = PlayPurchaseFlow(
            store = PlayBillingStore(context),
            validate = { receiptToken, pid -> dispatcher.run { core.postGoogleReceipt(receiptToken, pid, token, null) } },
        )
        try {
            return flow.run(activity, product.id, product.type, token, basePlanId, offerId)
        } catch (e: Throwable) {
            throw if (e is RovenueErrorFfi.Generic) RovenueException.from(e) else e
        }
    }
```

(The 2-arg `purchase(activity, product)` / `purchase(activity, pkg)` calls still resolve via the `option = null` default — no breaking change.)

- [ ] **Step 7: Update existing PlayStore fakes**

Run: `grep -rln ": PlayStore" packages/sdk-kotlin/src/test`
For each fake, update its `override suspend fun purchase(...)` to the new 6-param signature (add `basePlanId: String?, offerId: String?` — default values are fine on overrides via the interface). The build must compile.

- [ ] **Step 8: Run test + full suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.PlayPurchaseFlowOfferTest"` then `./gradlew testDebugUnitTest`
Expected: new test PASS; full unit-test suite green (existing fakes/tests updated).

- [ ] **Step 9: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayStore.kt packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayPurchaseFlow.kt packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowOfferTest.kt
git add packages/sdk-kotlin/src/test   # any updated fakes
git commit -m "feat(sdk-kotlin): purchase a chosen subscription offer (offerToken by stable identity)"
```

---

## Task 3: React Native — forward subscriptionOption to Android

**Files:**
- Modify: `packages/sdk-rn/src/api/purchases.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift` (accept + ignore the new args)
- Test: `packages/sdk-rn/src/__tests__/purchase-android-offer.test.ts` (Create)

**Interfaces:**
- Consumes: native `purchase` bridge; public `SubscriptionOption` TS type (has `basePlanId`/`offerId`).
- Produces: JS `purchase(target, options?: { promotionalOfferId?: string; subscriptionOption?: SubscriptionOption })`; native spec `purchase(productId, productType, promotionalOfferId?, basePlanId?, offerId?)`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/__tests__/purchase-android-offer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const purchaseSpy = vi.fn(async () => ({
  entitlements: [], virtualCurrencies: {}, productId: "premium", storeTransactionId: "t", isDeferred: false,
}));
vi.mock("../core/native", () => ({ getNative: () => ({ purchase: purchaseSpy }) }));

import { purchase } from "../api/purchases";

describe("purchase with Android subscriptionOption", () => {
  it("forwards basePlanId + offerId to native", async () => {
    const product = { id: "premium", type: "subscription" } as any;
    const option = { id: "monthly:trial", basePlanId: "monthly", offerId: "trial" } as any;
    await purchase(product, { subscriptionOption: option });
    expect(purchaseSpy).toHaveBeenCalledWith("premium", "subscription", undefined, "monthly", "trial");
  });
  it("passes undefined offer parts when no option", async () => {
    const product = { id: "premium", type: "subscription" } as any;
    await purchase(product);
    expect(purchaseSpy).toHaveBeenCalledWith("premium", "subscription", undefined, undefined, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchase-android-offer.test.ts`
Expected: FAIL — native called with too few args / no offer parts.

- [ ] **Step 3: Update JS purchase + spec type**

In `src/specs/RovenueModule.types.ts`, change the purchase method to:
```ts
purchase(productId: string, productType: ProductTypeDTO, promotionalOfferId?: string, basePlanId?: string, offerId?: string): Promise<PurchaseResultDTO>;
```
In `src/api/purchases.ts`:
```ts
export async function purchase(
  target: Package | StoreProduct,
  options?: { promotionalOfferId?: string; subscriptionOption?: SubscriptionOption },
): Promise<PurchaseResult> {
  const product = "product" in target ? target.product : target;
  const opt = options?.subscriptionOption;
  return call(() =>
    getNative().purchase(
      product.id, product.type, options?.promotionalOfferId,
      opt?.basePlanId ?? undefined, opt?.offerId ?? undefined,
    ),
  );
}
```
(Import `SubscriptionOption` from `../types` if not already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchase-android-offer.test.ts`
Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Thread through native bridges**

Android `packages/sdk-rn/android/.../RovenueModule.kt` — extend the `purchase` AsyncFunction to accept the new args and use them (drop the "offerToken out of scope" comment; keep ignoring `promotionalOfferId`):
```kotlin
AsyncFunction("purchase") Coroutine { productId: String, productType: String, promotionalOfferId: String?, basePlanId: String?, offerId: String? ->
    // promotionalOfferId is iOS-only (ignored here). basePlanId/offerId select a Play subscription offer.
    val activity = appContext.currentActivity
        ?: throw StoreProblemFallbackCodedException("No foreground Activity available for purchase")
    val product = StoreProduct(id = productId, type = productTypeFrom(productType), displayName = "")
    try {
        dtoFromPurchaseResult(Rovenue.shared.purchase(activity, product, basePlanId, offerId))
    } catch (e: Throwable) {
        throw codedError(e)
    }
}
```

iOS `packages/sdk-rn/ios/RovenueModule.swift` — accept the two new args and IGNORE them (Android-only; documented), keeping the existing promotionalOfferId behavior:
```swift
AsyncFunction("purchase") { (productId: String, productType: String, promotionalOfferId: String?, basePlanId: String?, offerId: String?) -> [String: Any?] in
    // basePlanId/offerId select a Play subscription offer on Android; ignored on iOS.
    guard #available(iOS 15.0, macOS 12.0, *) else { throw StoreProblemFallbackException("Purchases require iOS 15 / macOS 12 or newer") }
    let product = StoreProduct(id: productId, type: Self.productType(from: productType), displayName: "")
    do {
        let r: PurchaseResult
        if let offerId = promotionalOfferId {
            r = try await Rovenue.shared.purchase(product, promotionalOfferId: offerId)
        } else {
            r = try await Rovenue.shared.purchase(product)
        }
        return Self.dtoFromPurchaseResult(r)
    } catch let e as RovenueError { throw RovenueCodedError(e) }
}
```
(Keep the rest of the iOS function as it was; only the parameter list + the leading comment change. `_ = basePlanId; _ = offerId` if the compiler warns about unused — but Expo arg binding typically doesn't.)

- [ ] **Step 6: Verify**

Run: `cd packages/sdk-rn && pnpm vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all tests pass; tsc clean. (Native bridges can't build standalone — Expo/RN host; correctness is the arg-forwarding contract: JS sends 5 args, Android reads basePlanId/offerId, iOS reads promotionalOfferId.)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src/api/purchases.ts packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt packages/sdk-rn/ios/RovenueModule.swift packages/sdk-rn/src/__tests__/purchase-android-offer.test.ts
git commit -m "feat(sdk-rn): forward subscriptionOption (basePlanId/offerId) to Android purchase"
```

---

## Task 4: Docs — selecting an Android subscription offer

**Files:**
- Modify: `apps/docs/content/docs/guides/processing-purchases.mdx`

**Interfaces:** none (documentation).

- [ ] **Step 1: Document the feature**

In the purchases guide (near the existing promotional-offer / Android sections), add a "Selecting a subscription offer (Android)" subsection covering:
- Android products expose `subscriptionOptions` (base plans + offers, e.g. a monthly base plan and a monthly-with-free-trial offer). Pass the chosen `SubscriptionOption` to purchase to redeem it.
- Kotlin: `Rovenue.shared.purchase(activity, product, option)` where `option` is a `SubscriptionOption` from `product.subscriptionOptions`.
- React Native: `await purchase(product, { subscriptionOption: option })`.
- When no option is passed, the SDK purchases the default (lowest-price base plan = `product.defaultOption`).
- The SDK resolves the live Play offer at purchase time by the option's `basePlanId`/`offerId`; if that offer is no longer available, purchase fails with a "product not available" error (refresh offerings and retry).
- iOS: not applicable — iOS uses promotional offers (see the other section); the `subscriptionOption` option is ignored on iOS.

- [ ] **Step 2: Build docs**

Run: `pnpm --filter @rovenue/docs build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/docs
git commit -m "docs(sdk): selecting an Android subscription offer at purchase"
```

---

## Self-Review (completed)

**Spec coverage:** §3 architecture + §4.1 pure selector → Task 1; §4.2 PlayBillingStore + OfferNotFound + §4.3 flow + §4.4 Kotlin API → Task 2; §4.5 RN (JS + spec + Android bridge + iOS no-op) → Task 3; §5 error handling (OfferNotFound → typed error) → Task 2 (flow mapping); §6 testing → each task's tests (selectOfferToken matrix, flow threading + OfferNotFound, RN forwarding); docs → Task 4. Out-of-scope (§7: iOS, server-config, raw offerToken exposure, backend) excluded — no task touches them.

**Placeholder scan:** no TBD/TODO; every code step has literal code; tests included. Two "mirror the real signature on disk" directives (Task 2's `ReceiptResult`/`PlayStore` fake members, the existing-fake updates) are match-reality instructions, not placeholders.

**Type consistency:** `PlayOfferToken {basePlanId, offerId, offerToken, recurringPriceMicros}` + `selectOfferToken(offers, requestedBasePlanId, requestedOfferId)` defined in Task 1, consumed in Task 2; `StorePurchaseOutcome.OfferNotFound` defined + mapped in Task 2; `purchase(... basePlanId, offerId)` signature consistent across PlayStore interface, PlayBillingStore, PlayPurchaseFlow.run, Rovenue parts-based overload (Task 2) and the Android bridge call (Task 3); JS forwards `(id, type, promotionalOfferId, basePlanId, offerId)` (Task 3) matching the spec type's 5-arg signature.
