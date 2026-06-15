// OfferingsHydration.kt — maps the UniFFI Core* offering types into the public
// purchase-surface types, hydrating each product's price fields from Play
// Billing's ProductDetails.
//
// The price query goes through the injected [PlayStore] seam so this whole
// path is unit-testable with a fake store (no live Play Billing / device).
// Resilience is the caller's job: a price-query failure must NOT fail
// getOfferings — see Rovenue.getOfferings(), which falls back to config-only
// offerings (null prices) when [hydrateOfferings] throws.

package dev.rovenue.sdk.internal

import android.app.Activity
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.CoreOffering
import dev.rovenue.sdk.generated.CoreOfferingProduct
import dev.rovenue.sdk.generated.CoreOfferings

/**
 * Map [core] offerings into public [Offerings], filling each [StoreProduct]'s
 * price fields from a live Play Billing price query via [store].
 *
 * Product ids are gathered by type (SUBS vs INAPP) so the single
 * [PlayStore.queryPrices] call can build the correct Play Billing query.
 * Products whose id is absent from the returned price map keep null prices.
 */
internal suspend fun hydrateOfferings(core: CoreOfferings, store: PlayStore): Offerings {
    // The id we query Play Billing with is the google product id when present,
    // else the configured identifier — matching mapProductId() below.
    val subscriptionIds = mutableSetOf<String>()
    val inappIds = mutableSetOf<String>()
    for (offering in core.offerings) {
        for (product in offering.packages) {
            val id = mapProductId(product)
            if (ProductType.from(product.productType) == ProductType.SUBSCRIPTION) {
                subscriptionIds.add(id)
            } else {
                inappIds.add(id)
            }
        }
    }

    val prices = store.queryPrices(
        productIds = inappIds.toList(),
        subscriptionIds = subscriptionIds.toList(),
    )

    val offerings = core.offerings.map { mapOffering(it, prices) }
    val all = offerings.associateBy { it.identifier }
    val current = core.current?.let { all[it] }
    return Offerings(current = current, all = all)
}

private fun mapProductId(p: CoreOfferingProduct): String = p.googleProductId ?: p.identifier

private fun mapProduct(p: CoreOfferingProduct, prices: Map<String, PriceInfo>): StoreProduct {
    val id = mapProductId(p)
    val price = prices[id]
    return StoreProduct(
        id = id,
        type = ProductType.from(p.productType),
        displayName = p.displayName,
        priceString = price?.priceString,
        price = price?.price,
        currencyCode = price?.currencyCode,
    )
}

private fun mapOffering(o: CoreOffering, prices: Map<String, PriceInfo>): Offering =
    Offering(
        identifier = o.identifier,
        isDefault = o.isDefault,
        packages = o.packages.map { Package(identifier = it.identifier, product = mapProduct(it, prices)) },
    )

/**
 * A [PlayStore] that yields no prices and no pending purchases. Used as the
 * fallback when Play Billing is unavailable so [hydrateOfferings] still
 * produces config-only offerings (null prices) instead of failing.
 */
internal object NoPriceStore : PlayStore {
    override suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): StorePurchaseOutcome = StorePurchaseOutcome.ProductNotFound

    override suspend fun queryPrices(
        productIds: List<String>,
        subscriptionIds: List<String>,
    ): Map<String, PriceInfo> = emptyMap()

    override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = emptyList()
}
