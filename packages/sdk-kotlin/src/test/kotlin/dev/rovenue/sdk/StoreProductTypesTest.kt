package dev.rovenue.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class StoreProductTypesTest {
    @Test
    fun enrichedStoreProductConstructs() {
        val period = Period(1, PeriodUnit.MONTH, "P1M")
        val intro = IntroPrice(0.0, "Free", "USD", period, 1, PaymentMode.FREE_TRIAL)
        val p = StoreProduct(
            id = "p1", type = ProductType.SUBSCRIPTION, productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Premium", description = "Pro", priceString = "$9.99", price = 9.99,
            currencyCode = "USD", subscriptionPeriod = period, subscriptionGroupIdentifier = null,
            isFamilyShareable = false, introPrice = intro, discounts = emptyList(),
            isEligibleForIntroOffer = true, subscriptionOptions = null, defaultOption = null,
            pricePerWeek = null, pricePerMonth = 9.99, pricePerYear = null,
            pricePerWeekString = null, pricePerMonthString = "$9.99", pricePerYearString = null,
            rawStoreProduct = null)
        assertEquals(PaymentMode.FREE_TRIAL, p.introPrice?.paymentMode)
        assertEquals("P1M", p.subscriptionPeriod?.iso8601)
        assertNull(p.subscriptionOptions)
    }
}
