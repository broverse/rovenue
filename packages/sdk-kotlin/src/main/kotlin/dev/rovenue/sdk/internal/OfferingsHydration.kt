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
import com.android.billingclient.api.ProductDetails
import dev.rovenue.sdk.IntroPrice
import dev.rovenue.sdk.LogEntry
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Offerings
import dev.rovenue.sdk.PaymentMode
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.StoreProduct
import dev.rovenue.sdk.generated.CoreOffering
import dev.rovenue.sdk.generated.CoreOfferingProduct
import dev.rovenue.sdk.generated.CoreOfferings

/**
 * Map [core] offerings into public [Offerings], filling each [StoreProduct]'s
 * price fields from a live Play Billing price query via [store].
 *
 * Product ids are gathered by type (SUBS vs INAPP) so the single
 * [PlayStore.queryProducts] call can build the correct Play Billing query.
 * Products whose id is absent from the returned product map keep null prices.
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

    val products = store.queryProducts(
        inappIds = inappIds.toList(),
        subscriptionIds = subscriptionIds.toList(),
    )
    val rawMap: Map<String, ProductDetails> = store.rawDetails()

    val offerings = core.offerings.map { mapOffering(it, products, rawMap) }
    val all = offerings.associateBy { it.identifier }
    val current = core.current?.let { all[it] }
    return Offerings(current = current, all = all)
}

private fun mapProductId(p: CoreOfferingProduct): String = p.googleProductId ?: p.identifier

private fun productCategory(type: String): ProductCategory =
    if (type.uppercase() == "SUBSCRIPTION") ProductCategory.SUBSCRIPTION else ProductCategory.NON_SUBSCRIPTION

private fun mapProduct(
    p: CoreOfferingProduct,
    info: ProductInfo?,
    raw: ProductDetails?,
): StoreProduct {
    val type = ProductType.from(p.productType)
    val id = mapProductId(p)
    if (info == null) {
        return StoreProduct(
            id = id, type = type,
            productCategory = productCategory(p.productType),
            displayName = p.displayName,
            rawStoreProduct = raw,
        )
    }

    // Determine headline price from defaultOption (subscriptions) or oneTimePrice (INAPP).
    val options = info.options

    // Normalize null and empty-string offer IDs as equivalent (Play Billing uses null for no offer,
    // server config may send "" — treat both as "no specific offer").
    fun normId(s: String?): String? = if (s.isNullOrEmpty()) null else s

    val lowestPriceDefault = options
        ?.filter { it.isBasePlan }
        ?.minByOrNull { it.fullPricePhase?.price ?: Double.MAX_VALUE }
        ?: options?.firstOrNull()

    val defaultOption = if (p.androidBasePlanId != null) {
        val wantOffer = normId(p.androidOfferId)
        val matched = options?.firstOrNull {
            it.basePlanId == p.androidBasePlanId && normId(it.offerId) == wantOffer
        }
        if (matched == null) {
            Rovenue.emit(
                LogEntry(
                    level = "warn",
                    message = "Server-configured androidBasePlanId '${p.androidBasePlanId}' (offerId='${p.androidOfferId}') " +
                        "did not match any live Play Billing option for product '${p.identifier}'; " +
                        "falling back to lowest-price default.",
                    data = null,
                ),
            )
            lowestPriceDefault
        } else {
            matched
        }
    } else {
        lowestPriceDefault
    }

    val basePhase = defaultOption?.fullPricePhase
    val priceString = basePhase?.priceString ?: info.oneTimePrice?.formattedPrice
    val basePrice = basePhase?.price ?: info.oneTimePrice?.let { it.priceMicros / 1_000_000.0 }
    val currency = basePhase?.currencyCode ?: info.oneTimePrice?.currencyCode
    val period = basePhase?.billingPeriod

    val per = perUnitPrices(basePrice, period) { d ->
        // Simple two-decimal formatter — currency symbol kept from the base price string prefix.
        val prefix = priceString?.takeWhile { !it.isDigit() } ?: ""
        "$prefix%.2f".format(d)
    }

    val intro = defaultOption?.freePhase ?: defaultOption?.introPhase
    val introPrice = intro?.let {
        IntroPrice(
            price = it.price,
            priceString = it.priceString,
            currencyCode = it.currencyCode,
            period = it.billingPeriod,
            cycles = it.billingCycleCount ?: 1,
            paymentMode = it.paymentMode ?: PaymentMode.FREE_TRIAL,
        )
    }
    val eligible = if (type == ProductType.SUBSCRIPTION) (intro != null) else null

    return StoreProduct(
        id = id, type = type,
        productCategory = productCategory(p.productType),
        displayName = p.displayName,
        description = info.description,
        priceString = priceString,
        price = basePrice,
        currencyCode = currency,
        subscriptionPeriod = period,
        introPrice = introPrice,
        discounts = emptyList(),
        isEligibleForIntroOffer = eligible,
        subscriptionOptions = options,
        defaultOption = defaultOption,
        pricePerWeek = per.week,
        pricePerMonth = per.month,
        pricePerYear = per.year,
        pricePerWeekString = per.weekStr,
        pricePerMonthString = per.monthStr,
        pricePerYearString = per.yearStr,
        rawStoreProduct = raw,
    )
}

private fun mapOffering(
    o: CoreOffering,
    products: Map<String, ProductInfo>,
    rawMap: Map<String, ProductDetails>,
): Offering = Offering(
    identifier = o.identifier,
    isDefault = o.isDefault,
    packages = o.packages.map { pkg ->
        val pid = mapProductId(pkg)
        dev.rovenue.sdk.Package(
            identifier = pkg.packageIdentifier,
            packageType = packageType(pkg.packageIdentifier),
            product = mapProduct(pkg, products[pid], rawMap[pid]),
        )
    },
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
        basePlanId: String?,
        offerId: String?,
    ): StorePurchaseOutcome = StorePurchaseOutcome.ProductNotFound

    override suspend fun queryProducts(
        inappIds: List<String>,
        subscriptionIds: List<String>,
    ): Map<String, ProductInfo> = emptyMap()

    override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = emptyList()
}
