// OfferingsHydrationTest.kt — unit tests for the getOfferings price-hydration
// path. Drives the internal hydrateOfferings(core, store) mapping with a FAKE
// PlayStore so no live Play Billing / device is needed.

package dev.rovenue.sdk

import android.app.Activity
import dev.rovenue.sdk.generated.CoreOffering
import dev.rovenue.sdk.generated.CoreOfferingProduct
import dev.rovenue.sdk.generated.CoreOfferings
import dev.rovenue.sdk.PaymentMode
import dev.rovenue.sdk.internal.PendingPurchase
import dev.rovenue.sdk.internal.PlayOfferInput
import dev.rovenue.sdk.internal.PlayPhaseInput
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.ProductInfo
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import dev.rovenue.sdk.internal.hydrateOfferings
import dev.rovenue.sdk.internal.mapSubscriptionOption
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OfferingsHydrationTest {

    /** A PlayStore that returns a fixed ProductInfo map and records its query args. */
    private class FakeStore(private val products: Map<String, ProductInfo> = emptyMap()) : PlayStore {
        var lastInapp: List<String>? = null
        var lastSubs: List<String>? = null

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
        ): Map<String, ProductInfo> {
            lastInapp = inappIds
            lastSubs = subscriptionIds
            return products
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

    private fun monthlyPhase(priceMicros: Long = 9_990_000L, currency: String = "USD"): PlayPhaseInput =
        PlayPhaseInput(
            priceMicros = priceMicros,
            formattedPrice = "$%.2f".format(priceMicros / 1_000_000.0),
            currencyCode = currency,
            billingPeriodIso = "P1M",
            billingCycleCount = 1,
            recurrenceMode = 1, // INFINITE_RECURRING
        )

    private fun trialPhase(): PlayPhaseInput =
        PlayPhaseInput(
            priceMicros = 0L,
            formattedPrice = "Free",
            currencyCode = "USD",
            billingPeriodIso = "P1W",
            billingCycleCount = 1,
            recurrenceMode = 2, // FINITE_RECURRING — free-trial phase
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
                        product("\$rov_monthly", "monthly", "SUBSCRIPTION", google = "pro_monthly"),
                        product("\$rov_coins", "coins", "CONSUMABLE", google = "coins_100"),
                        product("\$rov_lifetime", "lifetime", "NON_CONSUMABLE", google = "lifetime_unlock"),
                    ),
                ),
            ),
        )

        val basePlanOffer = PlayOfferInput(
            basePlanId = "monthly",
            offerId = null,
            tags = emptyList(),
            phases = listOf(monthlyPhase(9_990_000L)),
        )
        val inappPhase = PlayPhaseInput(
            priceMicros = 990_000L,
            formattedPrice = "$0.99",
            currencyCode = "USD",
            billingPeriodIso = "P1M",
            billingCycleCount = 1,
            recurrenceMode = 3,
        )
        val store = FakeStore(
            mapOf(
                "pro_monthly" to ProductInfo(
                    description = "Premium monthly",
                    options = listOf(mapSubscriptionOption(basePlanOffer)),
                    oneTimePrice = null,
                ),
                "coins_100" to ProductInfo(
                    description = "100 coins",
                    options = null,
                    oneTimePrice = inappPhase,
                ),
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
                    packages = listOf(product("\$rov_weekly", "weekly", "SUBSCRIPTION", google = null)),
                ),
            ),
        )
        val weeklyOffer = PlayOfferInput(
            basePlanId = "weekly",
            offerId = null,
            tags = emptyList(),
            phases = listOf(
                PlayPhaseInput(1_990_000L, "$1.99", "USD", "P1W", 1, 1),
            ),
        )
        val store = FakeStore(
            mapOf("weekly" to ProductInfo(
                description = null,
                options = listOf(mapSubscriptionOption(weeklyOffer)),
                oneTimePrice = null,
            )),
        )

        val offerings = hydrateOfferings(core, store)

        val weekly = offerings.all.getValue("o1").packages.single().product
        assertEquals("weekly", weekly.id)
        assertEquals("$1.99", weekly.priceString)
        assertNull(offerings.current)
    }

    @Test
    fun `Package identifier is the slot id not the product catalog id`() = runTest {
        val core = CoreOfferings(
            current = "default",
            offerings = listOf(
                CoreOffering(
                    identifier = "default",
                    isDefault = true,
                    packages = listOf(
                        product(
                            packageIdentifier = "\$rov_monthly",
                            identifier = "pro_monthly_catalog",
                            type = "SUBSCRIPTION",
                            google = "pro_monthly_catalog",
                        ),
                    ),
                ),
            ),
        )
        val offer = PlayOfferInput(
            basePlanId = "pro_monthly_catalog",
            offerId = null,
            tags = emptyList(),
            phases = listOf(monthlyPhase()),
        )
        val store = FakeStore(
            mapOf("pro_monthly_catalog" to ProductInfo(
                description = null,
                options = listOf(mapSubscriptionOption(offer)),
                oneTimePrice = null,
            )),
        )

        val offerings = hydrateOfferings(core, store)

        val pkg = offerings.all.getValue("default").packages.single()
        // Package.identifier must be the slot id, not the product catalog id.
        assertEquals("\$rov_monthly", pkg.identifier)
        // The product's own store id is separately accessible and distinct.
        assertEquals("pro_monthly_catalog", pkg.product.id)
        // packageType is derived from slot id
        assertEquals(PackageType.MONTHLY, pkg.packageType)
    }

    @Test
    fun `hydratesSubscriptionWithTrialAndOptions`() = runTest {
        val core = CoreOfferings(
            current = "default",
            offerings = listOf(
                CoreOffering(
                    "default", true, listOf(
                        CoreOfferingProduct(
                            "\$rov_monthly", "premium", "SUBSCRIPTION", "Premium", null, "premium_monthly",
                        ),
                    ),
                ),
            ),
        )

        val trialOffer = PlayOfferInput(
            basePlanId = "monthly",
            offerId = "trial",
            tags = emptyList(),
            phases = listOf(trialPhase(), monthlyPhase()),
        )
        val opt = mapSubscriptionOption(trialOffer)
        val info = ProductInfo(
            description = "Premium subscription",
            options = listOf(opt),
            oneTimePrice = null,
        )

        val store = FakeStore(mapOf("premium_monthly" to info))
        val offerings = hydrateOfferings(core, store)

        val product = offerings.all.getValue("default").packages.single().product
        assertEquals("premium_monthly", product.id)
        assertNotNull(product.priceString)
        assertNotNull(product.pricePerYear)
        assertEquals(1, product.subscriptionOptions?.size)
        assertEquals(PaymentMode.FREE_TRIAL, product.introPrice?.paymentMode)
        assertEquals(true, product.isEligibleForIntroOffer)
        assertEquals("P1M", product.subscriptionPeriod?.iso8601)
    }

    @Test
    fun `config-only product when store returns empty map`() = runTest {
        val core = CoreOfferings(
            current = "default",
            offerings = listOf(
                CoreOffering(
                    identifier = "default",
                    isDefault = true,
                    packages = listOf(
                        product("\$rov_monthly", "premium_monthly", "SUBSCRIPTION", google = "premium_monthly"),
                    ),
                ),
            ),
        )
        val store = FakeStore(emptyMap())

        val offerings = hydrateOfferings(core, store)

        val product = offerings.all.getValue("default").packages.single().product
        assertEquals("premium_monthly", product.id)
        assertNull(product.priceString)
        assertNull(product.price)
        assertNull(product.currencyCode)
        assertNull(product.subscriptionOptions)
        assertNull(product.defaultOption)
        assertNull(product.isEligibleForIntroOffer)
        assertNotNull(offerings.current)
    }
}
