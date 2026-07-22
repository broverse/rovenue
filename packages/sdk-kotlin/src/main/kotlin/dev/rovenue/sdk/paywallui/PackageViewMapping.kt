package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.StoreProduct

// =============================================================
// PackageView derivation + selection semantics — identical formula
// to the Swift PackageViewMapping.swift and the web renderer
// (normative, see Phase-C spec §5 / Global Constraints).
// =============================================================

/**
 * packageName = displayName; price = priceString ?: ""; period = unit label
 * or "" for non-subscriptions; pricePerPeriod = price alone when period is
 * empty, else "price/period".
 */
fun packageView(product: StoreProduct?, displayName: String): PackageView {
    val price = product?.priceString ?: ""
    val period = periodLabel(product?.subscriptionPeriod)
    return PackageView(
        packageName = displayName,
        price = price,
        pricePerPeriod = if (period.isEmpty()) price else "$price/$period",
        period = period,
    )
}

private fun periodLabel(period: Period?): String = when (period?.unit) {
    PeriodUnit.DAY -> "day"
    PeriodUnit.WEEK -> "week"
    PeriodUnit.MONTH -> "month"
    PeriodUnit.YEAR -> "year"
    null -> ""
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
