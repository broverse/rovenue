package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.StoreProduct
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

// =============================================================
// PackageView derivation + selection semantics — identical formula
// to the Swift PackageViewMapping.swift and the web renderer
// (normative, see Phase-C spec §5 / Global Constraints).
// =============================================================

/**
 * packageName = displayName; price = priceString ?: ""; period = unit label
 * or "" for non-subscriptions; pricePerPeriod = price alone when period is
 * empty, else "price/period".
 *
 * Phase D3 optional fields:
 * - pricePerWeek/pricePerMonth/pricePerYear = the enriched product's own
 *   pricePerWeekString/pricePerMonthString/pricePerYearString verbatim.
 * - pricePerDay = pricePerWeek / 7, formatted with the product's own
 *   currency — ONLY when both a numeric pricePerWeek and a currencyCode
 *   exist on the product; `null` otherwise (no per-day figure to derive, or
 *   no currency to format it with).
 * - introPrice/introPeriod = product.introPrice's priceString and period
 *   unit label (same helper as the required `period` field) — both `null`
 *   when the product has no intro offer.
 * - relativeDiscount = see [relativeDiscount].
 *
 * [offering], when supplied, provides the sibling packages
 * [relativeDiscount] compares against — omit it (or pass `null`) when no
 * offering context is available; every other field is derivable from
 * [product] alone.
 */
fun packageView(product: StoreProduct?, displayName: String, offering: Offering? = null): PackageView {
    val price = product?.priceString ?: ""
    val period = periodLabel(product?.subscriptionPeriod)
    return PackageView(
        packageName = displayName,
        price = price,
        pricePerPeriod = if (period.isEmpty()) price else "$price/$period",
        period = period,
        pricePerDay = pricePerDayString(product),
        pricePerWeek = product?.pricePerWeekString,
        pricePerMonth = product?.pricePerMonthString,
        pricePerYear = product?.pricePerYearString,
        introPrice = product?.introPrice?.priceString,
        introPeriod = product?.introPrice?.let { periodLabel(it.period) },
        relativeDiscount = relativeDiscount(product, offering),
    )
}

private fun periodLabel(period: Period?): String = when (period?.unit) {
    PeriodUnit.DAY -> "day"
    PeriodUnit.WEEK -> "week"
    PeriodUnit.MONTH -> "month"
    PeriodUnit.YEAR -> "year"
    null -> ""
}

/** `pricePerWeek / 7`, formatted with the product's own currency — `null`
 *  unless both a numeric `pricePerWeek` and a `currencyCode` are present. */
private fun pricePerDayString(product: StoreProduct?): String? {
    val weekly = product?.pricePerWeek ?: return null
    val currencyCode = product.currencyCode ?: return null
    return formatCurrency(weekly / 7.0, currencyCode)
}

/** Fixed-locale (`Locale.US`) currency formatting so results are
 *  deterministic across host locales/CI — returns `null` for an
 *  unrecognized currency code rather than throwing. */
private fun formatCurrency(amount: Double, currencyCode: String): String? {
    val currency = try {
        Currency.getInstance(currencyCode)
    } catch (e: IllegalArgumentException) {
        return null
    }
    val formatter = NumberFormat.getCurrencyInstance(Locale.US)
    formatter.currency = currency
    return formatter.format(amount)
}

/**
 * `round((1 − pricePerYearEquivalent / maxPricePerYearEquivalent) × 100)%`
 * across [offering]'s packages with a numeric `pricePerYear` — `null` when
 * [product] has no numeric `pricePerYear`, [offering] is absent, or fewer
 * than 2 packages in [offering] are comparable (have a numeric
 * `pricePerYear` of their own). Mirrors the cross-platform D3 spec formula
 * — MUST match the Swift implementation's output for the same inputs.
 */
private fun relativeDiscount(product: StoreProduct?, offering: Offering?): String? {
    val ownYearPrice = product?.pricePerYear ?: return null
    if (offering == null) return null
    val comparable = offering.packages.mapNotNull { it.product.pricePerYear }
    if (comparable.size < 2) return null
    val maxYearPrice = comparable.max()
    if (maxYearPrice <= 0.0) return null
    val ratio = (1.0 - ownYearPrice / maxYearPrice) * 100.0
    val rounded = Math.round(ratio).toInt()
    return "$rounded%"
}

/** Empty `packageIds` means "every offering package" (schema semantics). */
fun effectivePackageIds(node: BuilderNode.PackageList, offering: Offering?): List<String> {
    if (node.packageIds.isNotEmpty()) return node.packageIds
    return offering?.packages?.map { it.identifier } ?: emptyList()
}

/** Depth-first over the PRIMARY tree (fallback subtrees excluded). */
private fun findFirstPackageList(node: BuilderNode): BuilderNode.PackageList? = when (node) {
    is BuilderNode.PackageList -> node
    is BuilderNode.Stack -> node.children.firstNotNullOfOrNull(::findFirstPackageList)
    else -> null
}

/**
 * Initial selection: the first packageList's `defaultSelected`, else the
 * first effective package id, else null. Mirrors the web renderer's tested
 * semantics and Swift's `initialSelection`.
 */
fun initialSelection(root: BuilderNode, offering: Offering?): String? {
    val list = findFirstPackageList(root) ?: return null
    list.defaultSelected?.takeIf { it.isNotEmpty() }?.let { return it }
    return effectivePackageIds(list, offering).firstOrNull()
}
