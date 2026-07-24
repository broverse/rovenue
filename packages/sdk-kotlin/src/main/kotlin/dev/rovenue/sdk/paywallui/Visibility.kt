package dev.rovenue.sdk.paywallui

// =============================================================
// Node-level visibility: which platforms and app versions a node
// renders on. Evaluated CLIENT-SIDE by every renderer — the server
// ships the published snapshot whole.
//
// Kotlin port of packages/shared/src/paywall/visibility.ts (kept as a
// near-exact copy, including comments, the same way the RN port at
// packages/sdk-rn/src/paywall-ui/visibility.ts is): this module's
// decoder (BuilderConfigModel.kt) is a lenient, independently-typed
// `BuilderNode` model (not the strict `PaywallNode` union), so the
// evaluator is duplicated here rather than shared, and must agree
// EXACTLY with the shared implementation and the RN/Swift siblings
// against the same `visibility` vectors in render-fixtures.json.
//
// The [Visibility] data class itself lives in BuilderConfigModel.kt,
// alongside the rest of the decoded node model.
//
// The governing rule is FAIL OPEN. Every unknown resolves to visible:
// an unknown platform, an unknown app version, a version we cannot
// parse, an empty platform list. Hiding content because we could not
// tell would silently break paywalls on any facade that has not
// supplied these facts yet.
// =============================================================

private const val VERSION_SEPARATOR = "."
private val NUMERIC_COMPONENT = Regex("^\\d+$")

/**
 * Compare two digit components exactly, without going through an Int or
 * Double — either would silently misbehave past their range (`Int`
 * throws/overflows, `Double` loses precision past 2^53) and report two
 * different versions as equal or crash. Comparing normalised digit
 * strings by length then lexically is exact for any length. Mirrors the
 * TS `compareComponent` byte-for-byte.
 */
private fun compareComponent(a: String, b: String): Int {
    val left = a.trimStart('0').ifEmpty { "0" }
    val right = b.trimStart('0').ifEmpty { "0" }
    if (left.length != right.length) return left.length - right.length
    return left.compareTo(right)
}

/**
 * Component-wise numeric comparison. Missing components read as 0, so
 * "1.2" equals "1.2.0" and "1.10" beats "1.9". Taking the LONGER of the
 * two lengths is what makes "1.2.5" beat "1.2" — taking the shorter one
 * would never look at the extra component.
 *
 * Returns `null` — inconclusive — when either side has a component that
 * is not a run of digits (checked with a regex, NEVER `toInt()`/
 * `toIntOrNull()` — those either throw on a non-numeric component like
 * "beta", or (for `toIntOrNull()`) misreport a component that merely
 * overflows `Int` as non-numeric, which would wrongly make the
 * beyond-`Int.MAX_VALUE` render-fixtures vector inconclusive instead of
 * a definite comparison). Deliberately NOT semver: a real implementation
 * would have to be written four times over and agree exactly, and
 * pre-release ordering is not a rule anyone authoring a paywall bound is
 * thinking about. Refusing to guess is the honest answer, and an
 * inconclusive comparison fails open at the call site.
 */
fun compareVersions(a: String, b: String): Int? {
    val left = a.split(VERSION_SEPARATOR)
    val right = b.split(VERSION_SEPARATOR)
    if ((left + right).any { !NUMERIC_COMPONENT.matches(it) }) return null
    val length = maxOf(left.size, right.size)
    for (i in 0 until length) {
        val cmp = compareComponent(left.getOrElse(i) { "0" }, right.getOrElse(i) { "0" })
        if (cmp != 0) return cmp
    }
    return 0
}

/**
 * True when the node should render for [platform]/[appVersion]. Bounds
 * are inclusive. Fails open on every unknown: no [visibility] at all, an
 * empty/absent platform list, an unknown renderer [platform], no known
 * [appVersion], or an inconclusive [compareVersions] result all resolve
 * to visible.
 */
fun isNodeVisible(visibility: Visibility?, platform: String?, appVersion: String?): Boolean {
    if (visibility == null) return true

    val allowedPlatforms = visibility.platform
    // An empty list is what the builder produces the moment an author
    // unticks the last box. Reading it as "nowhere" would let a stray
    // click delete content from every device.
    // `isNullOrBlank`, not `!= null`: the TS reference guards with JS
    // falsiness, so an empty-string platform reads as UNKNOWN there and
    // fails open. Checking only for null here would hide the node instead
    // — a reference-vs-port split on the same input.
    if (!allowedPlatforms.isNullOrEmpty() && !platform.isNullOrBlank() && platform !in allowedPlatforms) {
        return false
    }

    val version = appVersion ?: return true

    // An inconclusive `compareVersions` (`null`) leaves `cmp` failing
    // both `< 0` and `> 0` below, so it never hides — belt-and-braces,
    // spelled out explicitly rather than relying on `null`'s comparison
    // behavior, since Kotlin (unlike JS) has no implicit null-to-zero
    // coercion in a relational comparison.
    visibility.minAppVersion?.let { min ->
        val cmp = compareVersions(version, min)
        if (cmp != null && cmp < 0) return false
    }
    visibility.maxAppVersion?.let { max ->
        val cmp = compareVersions(version, max)
        if (cmp != null && cmp > 0) return false
    }
    return true
}
