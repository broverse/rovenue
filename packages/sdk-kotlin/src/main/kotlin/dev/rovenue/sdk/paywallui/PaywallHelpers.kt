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
 * Candidates for [locale]: the tag itself, then each progressively shorter
 * prefix — `zh-Hans-CN` → `zh-Hans` → `zh`. Mirrors validate.ts's
 * `localeCandidates`.
 */
internal fun localeCandidates(locale: String): List<String> {
    val parts = locale.split("-")
    return (parts.size downTo 1).map { parts.take(it).joinToString("-") }
}

/**
 * The table for [locale], matched case-insensitively. BCP-47 tags are
 * case-insensitive and the two sides disagree in practice: the builder
 * lowercases what an author types, a device reports `pt-BR` / `zh-Hans`.
 * Mirrors validate.ts's `localeTable`.
 */
internal fun localeTable(config: BuilderConfigModel, locale: String): Map<String, String>? {
    config.localizations[locale]?.let { return it }
    val wanted = locale.lowercase()
    for ((code, table) in config.localizations) {
        if (code.lowercase() == wanted) return table
    }
    return null
}

/**
 * Locale → each progressively shorter prefix of it → defaultLocale → null.
 * An empty-string value is a VALID hit (it round-trips as ""), only a
 * missing key falls through.
 *
 * The prefix step is what makes the device's locale usable: a host passing
 * `pt-BR` at a paywall keyed `pt` used to fall straight through to the
 * default language, silently — a renderer has no way to report a miss, so
 * the paywall simply showed the default language and looked fine.
 * Strictly widening: an exact match is still tried first and still wins.
 */
fun resolveText(config: BuilderConfigModel, locale: String?, key: String): String? {
    if (locale != null) {
        config.localizations[locale]?.let { if (it.containsKey(key)) return it[key] }
        for (candidate in localeCandidates(locale)) {
            val table = localeTable(config, candidate) ?: continue
            if (table.containsKey(key)) return table[key]
        }
    }
    val fallback = localeTable(config, config.defaultLocale) ?: return null
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

/**
 * Which localization key a `purchaseButton` renders: [trialLabelKey] when
 * it's non-null/non-empty AND [selectedView]'s [PackageView.introPeriod] is
 * a non-empty string (a trial/intro period is active for the current
 * selection); [labelKey] otherwise — including no selection at all
 * ([selectedView] `null`), which is never a trial. An empty-string
 * [trialLabelKey] is deliberately NOT treated as present, mirroring the TS
 * truthiness check (`node.trialLabelKey && hasIntroPeriod`) where an empty
 * string is falsy. Mirrors packages/shared/src/paywall/variables.ts's
 * `resolveCtaLabelKey` and packages/sdk-swift's `ctaLabelKey`
 * (PaywallViewModelHelpers.swift).
 */
fun ctaLabelKey(labelKey: String, trialLabelKey: String?, selectedView: PackageView?): String {
    val hasIntroPeriod = !selectedView?.introPeriod.isNullOrEmpty()
    return if (!trialLabelKey.isNullOrEmpty() && hasIntroPeriod) trialLabelKey else labelKey
}
