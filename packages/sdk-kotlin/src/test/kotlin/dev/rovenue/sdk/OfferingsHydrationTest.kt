// OfferingsHydrationTest.kt — unit tests for the getOfferings price-hydration
// path. Drives the internal hydrateOfferings(core, store) mapping with a FAKE
// PlayStore so no live Play Billing / device is needed.

package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.generated.CoreOffering
import dev.rovenue.sdk.generated.CoreOfferingProduct
import dev.rovenue.sdk.generated.CoreOfferings
import dev.rovenue.sdk.internal.PendingPurchase
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.PriceInfo
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import dev.rovenue.sdk.internal.hydrateOfferings
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OfferingsHydrationTest {

    /** A PlayStore that returns a fixed price map and records its query args. */
    private class FakePriceStore(private val prices: Map<String, PriceInfo>) : PlayStore {
        var lastInapp: List<String>? = null
        var lastSubs: List<String>? = null

        override suspend fun purchase(
            activity: Activity,
            productId: String,
            productType: ProductType,
            obfuscatedAccountId: String?,
        ): StorePurchaseOutcome = StorePurchaseOutcome.ProductNotFound

        override suspend fun queryPrices(
            productIds: List<String>,
            subscriptionIds: List<String>,
        ): Map<String, PriceInfo> {
            lastInapp = productIds
            lastSubs = subscriptionIds
            return prices
        }

        override suspend fun queryUnacknowledgedPurchases(): List<PendingPurchase> = emptyList()
    }

    private fun product(
        packageIdentifier: String,
        identifier: String,
        type: String,
        google: String?,
        display: String = identifier,
    ) = CoreOfferingProduct(
        packageIdentifier = packageIdentifier,
        identifier = identifier,
        productType = type,
        displayName = display,
        appleProductId = null,
        googleProductId = google,
    )

    @Test
    fun `hydrates prices for present ids and leaves absent ids null`() = runTest {
        val core = CoreOfferings(
            current = "default",
            offerings = listOf(
                CoreOffering(
                    identifier = "default",
                    isDefault = true,
                    packages = listOf(
                        product("\$rc_monthly", "monthly", "SUBSCRIPTION", google = "pro_monthly"),
                        product("\$rc_coins", "coins", "CONSUMABLE", google = "coins_100"),
                        product("\$rc_lifetime", "lifetime", "NON_CONSUMABLE", google = "lifetime_unlock"),
                    ),
                ),
            ),
        )
        val store = FakePriceStore(
            mapOf(
                "pro_monthly" to PriceInfo("$9.99", 9.99, "USD"),
                "coins_100" to PriceInfo("$0.99", 0.99, "USD"),
                // lifetime_unlock intentionally absent → null prices
            ),
        )

        val offerings = hydrateOfferings(core, store)

        // SUBS vs INAPP ids were split correctly for the Play Billing query.
        assertEquals(listOf("pro_monthly"), store.lastSubs)
        assertTrue(store.lastInapp!!.containsAll(listOf("coins_100", "lifetime_unlock")))

        val products = offerings.all.getValue("default").packages.associateBy { it.product.id }

        val monthly = products.getValue("pro_monthly").product
        assertEquals("$9.99", monthly.priceString)
        assertEquals(9.99, monthly.price)
        assertEquals("USD", monthly.currencyCode)

        val coins = products.getValue("coins_100").product
        assertEquals("$0.99", coins.priceString)
        assertEquals(0.99, coins.price)

        // Absent id → null price fields, product still present.
        val lifetime = products.getValue("lifetime_unlock").product
        assertNull(lifetime.priceString)
        assertNull(lifetime.price)
        assertNull(lifetime.currencyCode)

        assertEquals("default", offerings.current?.identifier)
    }

    @Test
    fun `falls back to configured identifier when googleProductId is null`() = runTest {
        val core = CoreOfferings(
            current = null,
            offerings = listOf(
                CoreOffering(
                    identifier = "o1",
                    isDefault = false,
                    packages = listOf(product("\$rc_weekly", "weekly", "SUBSCRIPTION", google = null)),
                ),
            ),
        )
        val store = FakePriceStore(mapOf("weekly" to PriceInfo("$1.99", 1.99, "USD")))

        val offerings = hydrateOfferings(core, store)

        val weekly = offerings.all.getValue("o1").packages.single().product
        assertEquals("weekly", weekly.id)
        assertEquals("$1.99", weekly.priceString)
        assertNull(offerings.current)
    }

    @Test
    fun `Package identifier is the slot id not the product catalog id`() = runTest {
        // packageIdentifier ($rc_monthly) is the package slot from the server;
        // identifier (pro_monthly_catalog) is the product catalog id — they must
        // not be confused or a swap bug silently passes.
        val core = CoreOfferings(
            current = "default",
            offerings = listOf(
                CoreOffering(
                    identifier = "default",
                    isDefault = true,
                    packages = listOf(
                        product(
                            packageIdentifier = "\$rc_monthly",
                            identifier = "pro_monthly_catalog",
                            type = "SUBSCRIPTION",
                            google = "pro_monthly_catalog",
                        ),
                    ),
                ),
            ),
        )
        val store = FakePriceStore(mapOf("pro_monthly_catalog" to PriceInfo("$9.99", 9.99, "USD")))

        val offerings = hydrateOfferings(core, store)

        val pkg = offerings.all.getValue("default").packages.single()
        // Package.identifier must be the slot id, not the product catalog id.
        assertEquals("\$rc_monthly", pkg.identifier)
        // The product's own store id is separately accessible and distinct.
        assertEquals("pro_monthly_catalog", pkg.product.id)
    }
}
