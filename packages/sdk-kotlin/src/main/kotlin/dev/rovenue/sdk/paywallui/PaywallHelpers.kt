package dev.rovenue.sdk.paywallui

// =============================================================
// Pure text/variable helpers — behavioral mirrors of
// packages/shared/src/paywall/{validate,variables}.ts and the Swift
// PaywallViewModelHelpers.swift, pinned by render-fixtures.json.
// =============================================================

/** Formatted, display-ready price facts for one package. */
data class PackageView(
    val packageName: String,
    val price: String,
    val pricePerPeriod: String,
    val period: String,
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
 * `{{packageName}}` against [pkg]. Unknown variables are left verbatim;
 * a null [pkg] leaves the whole text verbatim.
 */
fun resolveVariables(text: String, pkg: PackageView?): String {
    if (pkg == null) return text
    return VARIABLE_PATTERN.replace(text) { match ->
        when (match.groupValues[1]) {
            "price" -> pkg.price
            "pricePerPeriod" -> pkg.pricePerPeriod
            "period" -> pkg.period
            "packageName" -> pkg.packageName
            else -> match.value
        }
    }
}
