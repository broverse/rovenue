package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.PurchaseResult

/**
 * Host-supplied configuration for [RovenuePaywallView.bind]. Kotlin's
 * data-class defaults stand in for the SwiftUI initializer's default
 * parameters (spec §4 — `RovenuePaywallView`/`PaywallViewOptions` public API
 * is normative); every field is optional so `PaywallViewOptions()` is a
 * valid no-op configuration.
 */
data class PaywallViewOptions(
    /** BCP-47 locale for [resolveText]; `null` resolves straight to the
     *  config's `defaultLocale`. */
    val locale: String? = null,
    /** `null` follows the device's current night-mode configuration
     *  ([android.content.res.Configuration.uiMode]'s night bit) — resolved
     *  fresh on every (re)render, so a runtime theme change is picked up on
     *  the next [RovenuePaywallView.bind] or selection change. */
    val darkMode: Boolean? = null,
    val onPurchaseCompleted: ((PurchaseResult) -> Unit)? = null,
    val onPurchaseFailed: ((Throwable) -> Unit)? = null,
    val onClose: (() -> Unit)? = null,
    /** `null` hides every `restore`-action button (web-renderer parity —
     *  hosts with no restore concept, e.g. the funnel context, simply don't
     *  pass a handler). */
    val onRestore: (() -> Unit)? = null,
    /** The view NEVER opens URLs itself — [onUrl] is the only way a
     *  `url`-action button does anything; without a handler the button
     *  renders but is inert. */
    val onUrl: ((String) -> Unit)? = null,
)
