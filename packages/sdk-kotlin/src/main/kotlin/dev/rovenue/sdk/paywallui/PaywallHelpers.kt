package dev.rovenue.sdk.paywallui

// =============================================================
// Pure text/variable helpers — behavioral mirrors of
// packages/shared/src/paywall/{validate,variables}.ts and the Swift
// PaywallViewModelHelpers.swift, pinned by render-fixtures.json.
// =============================================================

/**
 * Formatted, display-ready price facts for one package.
 *
 * The seven trailing fields (Phase D3) are OPTIONAL because a platform may
 * not have a numeric price to derive them from — a KNOWN variable whose
 * backing field is absent is left VERBATIM (same signal as an
 * unconfigured/unknown variable), distinct from the four required fields
 * above, which always substitute.
 */
data class PackageView(
    val packageName: String,
    val price: String,
    val pricePerPeriod: String,
    val period: String,
    val pricePerDay: String? = null,
    val pricePerWeek: String? = null,
    val pricePerMonth: String? = null,
    val pricePerYear: String? = null,
    val introPrice: String? = null,
    val introPeriod: String? = null,
    val relativeDiscount: String? = null,
)

/**
 * Locale → defaultLocale → null chain. An empty-string value is a VALID hit
 * (it round-trips as ""), only a missing key falls through.
 */
fun resolveText(config: BuilderConfigModel, locale: String?, key: String): String? {
    val requested = locale?.let { config.localizations[it] }
    requested?.let { if (it.containsKey(key)) return it[key] }
    val fallback = config.localizations[config.defaultLocale] ?: return null
    return if (fallback.containsKey(key)) fallback[key] else null
}

private val VARIABLE_PATTERN = Regex("""\{\{\s*(\w+)\s*\}\}""")

/**
 * Substitutes `{{price}}` / `{{pricePerPeriod}}` / `{{period}}` /
 * `{{packageName}}` (always present) and the Phase D3 optional
 * `{{pricePerDay}}` / `{{pricePerWeek}}` / `{{pricePerMonth}}` /
 * `{{pricePerYear}}` / `{{introPrice}}` / `{{introPeriod}}` /
 * `{{relativeDiscount}}` against [pkg]. An unknown variable name and a
 * known name whose backing field is `null` both leave the placeholder
 * VERBATIM; a null [pkg] leaves the whole text verbatim.
 */
fun resolveVariables(text: String, pkg: PackageView?): String {
    if (pkg == null) return text
    return VARIABLE_PATTERN.replace(text) { match ->
        when (match.groupValues[1]) {
            "price" -> pkg.price
            "pricePerPeriod" -> pkg.pricePerPeriod
            "period" -> pkg.period
            "packageName" -> pkg.packageName
            "pricePerDay" -> pkg.pricePerDay ?: match.value
            "pricePerWeek" -> pkg.pricePerWeek ?: match.value
            "pricePerMonth" -> pkg.pricePerMonth ?: match.value
            "pricePerYear" -> pkg.pricePerYear ?: match.value
            "introPrice" -> pkg.introPrice ?: match.value
            "introPeriod" -> pkg.introPeriod ?: match.value
            "relativeDiscount" -> pkg.relativeDiscount ?: match.value
            else -> match.value
        }
    }
}
