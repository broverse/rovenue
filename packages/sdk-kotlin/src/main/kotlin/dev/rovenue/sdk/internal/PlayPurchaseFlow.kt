// PlayPurchaseFlow.kt — store-agnostic orchestration of a single purchase.
//
// The flow launches the store purchase, then (only on success) validates the
// purchase token server-side, acknowledges it with Play Billing, and returns
// the entitlements already hydrated into ReceiptResult by the core (no
// separate cache read needed). All store / network / core interactions are
// injected so this logic is unit-testable with fakes.
//
// Error model (all failures throw RovenueException with the appropriate kind):
//   UserCancelled     → PURCHASE_CANCELED
//   ProductNotFound   → PRODUCT_NOT_AVAILABLE
//   AlreadyOwned      → ALREADY_OWNED
//   PaymentDeclined   → PAYMENT_DECLINED
//   ServiceUnavailable→ STORE_SERVICE_UNAVAILABLE
//   Ineligible        → INELIGIBLE
//   StoreProblem      → STORE_PROBLEM
//   Deferred          → NOT thrown; returned as PurchaseResult(isDeferred=true)

package dev.rovenue.sdk.internal

import android.app.Activity
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.ReceiptResult

class PlayPurchaseFlow(
    private val store: PlayStore,
    private val validate: suspend (token: String, productId: String) -> ReceiptResult,
) {
    @Throws(RovenueException::class)
    suspend fun run(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): PurchaseResult {
        when (val outcome = store.purchase(activity, productId, productType, obfuscatedAccountId)) {
            is StorePurchaseOutcome.UserCancelled ->
                throw RovenueException(kind = ErrorKind.PURCHASE_CANCELED, message = "purchase cancelled by user")
            is StorePurchaseOutcome.ProductNotFound ->
                throw RovenueException(kind = ErrorKind.PRODUCT_NOT_AVAILABLE, message = "product not found")
            is StorePurchaseOutcome.AlreadyOwned ->
                throw RovenueException(kind = ErrorKind.ALREADY_OWNED, message = "product already owned")
            is StorePurchaseOutcome.PaymentDeclined ->
                throw RovenueException(kind = ErrorKind.PAYMENT_DECLINED, message = "payment declined")
            is StorePurchaseOutcome.ServiceUnavailable ->
                throw RovenueException(kind = ErrorKind.STORE_SERVICE_UNAVAILABLE, message = "store service unavailable", isRetryable = true)
            is StorePurchaseOutcome.Ineligible ->
                throw RovenueException(kind = ErrorKind.INELIGIBLE, message = "user ineligible for this product")
            is StorePurchaseOutcome.StoreProblem ->
                throw RovenueException(kind = ErrorKind.STORE_PROBLEM, message = "store error")
            is StorePurchaseOutcome.Deferred ->
                // A deferred/pending purchase is NOT a failure. Play is processing
                // the payment externally (e.g. cash at a kiosk). Return with
                // isDeferred=true so the caller can inform the user and wait for
                // reconcilePurchases() to grant entitlements once payment completes.
                return PurchaseResult(
                    entitlements = emptyList(),
                    virtualCurrencies = emptyMap(),
                    productId = productId,
                    storeTransactionId = "",
                    isDeferred = true,
                )
            is StorePurchaseOutcome.Success -> {
                // Validate first. If the server rejects (throws), we never
                // acknowledge — Play will auto-refund the un-acknowledged
                // purchase, which is the correct fail-safe.
                val receipt = validate(outcome.purchaseToken, productId)
                outcome.acknowledge()
                return PurchaseResult(
                    entitlements = receipt.entitlements,
                    virtualCurrencies = receipt.virtualCurrencies,
                    productId = productId,
                    storeTransactionId = outcome.orderId,
                )
            }
        }
    }
}
