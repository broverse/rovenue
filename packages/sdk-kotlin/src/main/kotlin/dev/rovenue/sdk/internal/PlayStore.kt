// PlayStore.kt — the seam between the orchestration logic and the live Play
// Billing client. Isolating the store behind this interface lets
// PlayPurchaseFlow be unit-tested with a fake (no live Play Billing / device).

package dev.rovenue.sdk.internal

import android.app.Activity
import com.android.billingclient.api.ProductDetails
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

/**
 * An unfinished purchase discovered by querying Play Billing — a purchase the
 * user owns that hasn't yet been acknowledged/consumed (e.g. the app died
 * mid-flow, or the purchase happened out-of-band). [acknowledge] consumes
 * (consumables) or acknowledges (subs / non-consumables) the purchase; the
 * reconciler invokes it only after server-side validation succeeds.
 */
data class PendingPurchase(
    val purchaseToken: String,
    val productId: String,
    val productType: ProductType,
    val isAcknowledged: Boolean,
    val acknowledge: suspend () -> Unit,
)

/** Abstraction over Play Billing's purchase flow. */
interface PlayStore {
    suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): StorePurchaseOutcome

    /**
     * Query Play Billing for enriched product metadata. [subscriptionIds] are
     * queried as SUBS, [inappIds] as INAPP (Play Billing requires the product
     * type up front). Returns a map keyed by product id; ids with no matching
     * ProductDetails are simply omitted.
     */
    suspend fun queryProducts(
        inappIds: List<String>,
        subscriptionIds: List<String>,
    ): Map<String, ProductInfo>

    /**
     * Return the raw [ProductDetails] objects keyed by product id, as fetched
     * during the last [queryProducts] call. Used by [hydrateOfferings] to
     * populate [dev.rovenue.sdk.StoreProduct.rawStoreProduct]. Defaults to an
     * empty map so fakes and [NoPriceStore] need not override it.
     */
    fun rawDetails(): Map<String, ProductDetails> = emptyMap()

    /**
     * Query Play Billing for purchases the user owns that may be unfinished
     * (unacknowledged / unconsumed). Used by the background reconciler to
     * validate-then-acknowledge any purchase that didn't complete its flow.
     */
    suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase>
}
