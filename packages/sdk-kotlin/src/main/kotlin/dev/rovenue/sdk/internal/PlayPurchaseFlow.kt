// PlayPurchaseFlow.kt — store-agnostic orchestration of a single purchase.
//
// The flow launches the store purchase, then (only on success) validates the
// purchase token server-side, acknowledges it with Play Billing, and returns
// the entitlements already hydrated into ReceiptResult by the core (no
// separate cache read needed). All store / network / core interactions are
// injected so this logic is unit-testable with fakes.

package dev.rovenue.sdk.internal

import android.app.Activity
import dev.rovenue.sdk.ProductNotAvailableException
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PurchaseCancelledException
import dev.rovenue.sdk.PurchasePendingException
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.generated.ReceiptResult

class PlayPurchaseFlow(
    private val store: PlayStore,
    private val validate: suspend (token: String, productId: String) -> ReceiptResult,
) {
    suspend fun run(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): PurchaseResult {
        when (val outcome = store.purchase(activity, productId, productType, obfuscatedAccountId)) {
            is StorePurchaseOutcome.UserCancelled ->
                throw PurchaseCancelledException("cancelled")
            is StorePurchaseOutcome.Pending ->
                throw PurchasePendingException("pending")
            is StorePurchaseOutcome.ProductNotFound ->
                throw ProductNotAvailableException("not found")
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
