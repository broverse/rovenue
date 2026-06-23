package dev.rovenue.sdk

import dev.rovenue.sdk.internal.PlayOfferToken
import dev.rovenue.sdk.internal.selectOfferToken
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SelectOfferTokenTest {
    private val offers = listOf(
        PlayOfferToken("monthly", null, "tok-monthly-base", 9_990_000),
        PlayOfferToken("monthly", "trial", "tok-monthly-trial", 9_990_000),
        PlayOfferToken("annual", "", "tok-annual-base", 79_990_000),
    )

    @Test fun matchesBasePlanAndOffer() {
        assertEquals("tok-monthly-trial", selectOfferToken(offers, "monthly", "trial"))
    }

    @Test fun matchesBasePlanWhenOfferIdNullOrEmpty() {
        // requested offerId null must match the Play base-plan offer whose offerId is ""
        assertEquals("tok-monthly-base", selectOfferToken(offers, "monthly", null))
        assertEquals("tok-annual-base", selectOfferToken(offers, "annual", null))
    }

    @Test fun noMatchReturnsNull() {
        assertNull(selectOfferToken(offers, "weekly", null))
        assertNull(selectOfferToken(offers, "monthly", "nonexistent"))
    }

    @Test fun defaultPicksLowestPriceBasePlan() {
        // no request → lowest recurringPriceMicros among base plans (monthly 9.99 < annual 79.99)
        assertEquals("tok-monthly-base", selectOfferToken(offers, null, null))
    }

    @Test fun emptyOffersReturnsNull() {
        assertNull(selectOfferToken(emptyList(), null, null))
    }
}
