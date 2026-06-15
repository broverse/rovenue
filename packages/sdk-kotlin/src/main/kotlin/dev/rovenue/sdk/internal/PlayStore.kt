// PlayStore.kt — the seam between the orchestration logic and the live Play
// Billing client. Isolating the store behind this interface lets
// PlayPurchaseFlow be unit-tested with a fake (no live Play Billing / device).

package dev.rovenue.sdk.internal

import android.app.Activity
import dev.rovenue.sdk.ProductType

/**
 * The result of launching a Play Billing purchase flow for one product.
 *
 * [Success.acknowledge] is a suspend lambda the caller invokes *after* the
 * server has validated the purchase — it consumes (consumables) or
 * acknowledges (subs / non-consumables) the purchase with Play Billing. Not
 * acknowledging within Google's window auto-refunds the purchase, so the flow
 * must call it only once validation succeeds.
 */
sealed interface StorePurchaseOutcome {
    data class Success(
        val purchaseToken: String,
        val orderId: String,
        val acknowledge: suspend () -> Unit,
    ) : StorePurchaseOutcome

    data object UserCancelled : StorePurchaseOutcome

    data object Pending : StorePurchaseOutcome

    data object ProductNotFound : StorePurchaseOutcome
}

/** Abstraction over Play Billing's purchase flow. */
interface PlayStore {
    suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): StorePurchaseOutcome
}
