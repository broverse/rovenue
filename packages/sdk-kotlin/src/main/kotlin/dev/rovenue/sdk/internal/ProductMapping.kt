package dev.rovenue.sdk.internal

import dev.rovenue.sdk.*

data class PerUnit(
    val week: Double?, val month: Double?, val year: Double?,
    val weekStr: String?, val monthStr: String?, val yearStr: String?,
)

data class PlayPhaseInput(
    val priceMicros: Long, val formattedPrice: String, val currencyCode: String,
    val billingPeriodIso: String, val billingCycleCount: Int, val recurrenceMode: Int,
)

data class PlayOfferInput(
    val basePlanId: String, val offerId: String?, val tags: List<String>,
    val phases: List<PlayPhaseInput>,
)

data class ProductInfo(
    val description: String?,
    val options: List<SubscriptionOption>?,
    val oneTimePrice: PlayPhaseInput?,
)

fun parseIso8601Period(iso: String): Period {
    // format P<number><unit>, unit in D/W/M/Y
    val m = Regex("""P(\d+)([DWMY])""").find(iso)
    val value = m?.groupValues?.get(1)?.toIntOrNull() ?: 1
    val unit = when (m?.groupValues?.get(2)) {
        "D" -> PeriodUnit.DAY; "W" -> PeriodUnit.WEEK; "Y" -> PeriodUnit.YEAR; else -> PeriodUnit.MONTH
    }
    return Period(value, unit, iso)
}

fun daysInPeriod(p: Period): Int {
    val per = when (p.unit) { PeriodUnit.DAY -> 1; PeriodUnit.WEEK -> 7; PeriodUnit.MONTH -> 30; PeriodUnit.YEAR -> 365 }
    return maxOf(p.value, 1) * per
}

fun perUnitPrices(price: Double?, period: Period?, format: (Double) -> String?): PerUnit {
    if (price == null || period == null) return PerUnit(null, null, null, null, null, null)
    val days = daysInPeriod(period).toDouble()
    val w = price / days * 7; val mo = price / days * 30; val y = price / days * 365
    return PerUnit(w, mo, y, format(w), format(mo), format(y))
}

private fun recurrence(mode: Int): RecurrenceMode = when (mode) {
    1 -> RecurrenceMode.INFINITE_RECURRING
    2 -> RecurrenceMode.FINITE_RECURRING
    else -> RecurrenceMode.NON_RECURRING
}

fun mapPricingPhase(p: PlayPhaseInput): PricingPhase {
    val rec = recurrence(p.recurrenceMode)
    val mode = when {
        p.priceMicros == 0L -> PaymentMode.FREE_TRIAL
        rec == RecurrenceMode.FINITE_RECURRING -> PaymentMode.PAY_AS_YOU_GO
        else -> null
    }
    return PricingPhase(
        price = if (p.priceMicros == 0L) 0.0 else p.priceMicros / 1_000_000.0,
        priceString = p.formattedPrice, currencyCode = p.currencyCode,
        billingPeriod = parseIso8601Period(p.billingPeriodIso),
        billingCycleCount = if (rec == RecurrenceMode.INFINITE_RECURRING) null else p.billingCycleCount,
        recurrenceMode = rec, paymentMode = mode,
    )
}

fun mapSubscriptionOption(o: PlayOfferInput): SubscriptionOption {
    val phases = o.phases.map { mapPricingPhase(it) }
    val free = phases.firstOrNull { it.paymentMode == PaymentMode.FREE_TRIAL }
    val full = phases.firstOrNull { it.recurrenceMode == RecurrenceMode.INFINITE_RECURRING }
    val intro = phases.firstOrNull { it.paymentMode == PaymentMode.PAY_AS_YOU_GO }
    val id = if (o.offerId != null) "${o.basePlanId}:${o.offerId}" else o.basePlanId
    return SubscriptionOption(
        id = id, basePlanId = o.basePlanId, offerId = o.offerId, tags = o.tags,
        isBasePlan = o.offerId == null, isPrepaid = false, pricingPhases = phases,
        freePhase = free, introPhase = intro, fullPricePhase = full,
    )
}

fun packageType(slot: String): PackageType = when (slot) {
    "\$rov_weekly" -> PackageType.WEEKLY
    "\$rov_monthly" -> PackageType.MONTHLY
    "\$rov_two_month" -> PackageType.TWO_MONTH
    "\$rov_three_month" -> PackageType.THREE_MONTH
    "\$rov_six_month" -> PackageType.SIX_MONTH
    "\$rov_annual" -> PackageType.ANNUAL
    "\$rov_lifetime" -> PackageType.LIFETIME
    else -> PackageType.CUSTOM
}

data class PlayOfferToken(
    val basePlanId: String,
    val offerId: String?,            // null/"" = base plan (no offer)
    val offerToken: String,
    val recurringPriceMicros: Long?, // INFINITE_RECURRING phase price; null if none
)

/**
 * Choose which Play offerToken to redeem.
 * - requestedBasePlanId != null → match basePlanId AND offerId (null/"" normalized as "base plan").
 *     No match → null (caller surfaces OfferNotFound).
 * - requestedBasePlanId == null → the base-plan offer (offerId null/"") with the lowest
 *     recurringPriceMicros (mirrors StoreProduct.defaultOption); else first base plan; else first offer.
 */
fun selectOfferToken(
    offers: List<PlayOfferToken>,
    requestedBasePlanId: String?,
    requestedOfferId: String?,
): String? {
    if (offers.isEmpty()) return null
    fun norm(s: String?): String? = if (s.isNullOrEmpty()) null else s
    if (requestedBasePlanId != null) {
        val wantOffer = norm(requestedOfferId)
        return offers.firstOrNull { it.basePlanId == requestedBasePlanId && norm(it.offerId) == wantOffer }?.offerToken
    }
    val basePlans = offers.filter { norm(it.offerId) == null }
    val chosen = basePlans.filter { it.recurringPriceMicros != null }.minByOrNull { it.recurringPriceMicros!! }
        ?: basePlans.firstOrNull()
        ?: offers.firstOrNull()
    return chosen?.offerToken
}
