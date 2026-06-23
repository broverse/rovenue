package dev.rovenue.sdk

import dev.rovenue.sdk.internal.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull

class ProductMappingTest {
    @Test fun parsesIsoPeriods() {
        assertEquals(Period(1, PeriodUnit.MONTH, "P1M"), parseIso8601Period("P1M"))
        assertEquals(Period(3, PeriodUnit.DAY, "P3D"), parseIso8601Period("P3D"))
        assertEquals(Period(1, PeriodUnit.YEAR, "P1Y"), parseIso8601Period("P1Y"))
        assertEquals(Period(2, PeriodUnit.WEEK, "P2W"), parseIso8601Period("P2W"))
    }

    @Test fun freeTrialPhaseDetected() {
        val free = PlayPhaseInput(0, "Free", "USD", "P1W", 1, 2)   // recurrence FINITE
        val full = PlayPhaseInput(9_990_000, "$9.99", "USD", "P1M", 0, 1) // INFINITE
        val opt = mapSubscriptionOption(PlayOfferInput("monthly", "trial", listOf("tag"), listOf(free, full)))
        assertEquals(PaymentMode.FREE_TRIAL, opt.freePhase?.paymentMode)
        assertEquals("P1M", opt.fullPricePhase?.billingPeriod?.iso8601)
        assertEquals("monthly:trial", opt.id)
    }

    @Test fun perUnitNilWithoutPeriod() {
        val r = perUnitPrices(9.99, null) { null }
        assertNull(r.month)
    }

    @Test fun packageTypeMapping() {
        assertEquals(PackageType.ANNUAL, packageType("\$rov_annual"))
        assertEquals(PackageType.CUSTOM, packageType("weird"))
    }
}
