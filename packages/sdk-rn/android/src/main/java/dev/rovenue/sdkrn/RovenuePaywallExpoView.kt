package dev.rovenue.sdkrn

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.paywallui.PaywallViewOptions
import dev.rovenue.sdk.paywallui.RovenuePaywallView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Separates placement from locale in the resolve key. A character that
 *  cannot occur in either, so two different pairs cannot collide. */
private const val KEY_SEPARATOR = "\u0000"

/** Code sent for an [onPurchaseFailed] error that is not a
 *  [dev.rovenue.sdk.RovenueException] (so [codedError] handed back the
 *  original, un-coded, [Throwable] rather than a [CodedException]).
 *  Mirrors the iOS bridge's `UNMAPPED_ERROR_CODE`; the JS
 *  `mapNativeError()` normaliser falls back to `"Internal"` for any code
 *  it does not recognize, so the exact string only needs to be
 *  non-colliding with a real [dev.rovenue.sdk.generated.ErrorKind] name. */
private const val UNMAPPED_ERROR_CODE = "Unknown"

/**
 * Hosts the Android [RovenuePaywallView] inside a React Native view tree.
 *
 * Three things here are load-bearing and easy to lose in a refactor:
 *
 *  1. React Native does not lay out a view outside its own shadow tree.
 *     [shouldUseAndroidLayout] is ExpoView's supported answer: it makes
 *     `requestLayout` force a measure+layout pass. Do NOT hand-roll that
 *     — ExpoView.requestLayout already posts its own measureAndLayout(),
 *     and duplicating it would be dead weight that drifts.
 *  2. [ExpoView] extends `LinearLayout`, so a child added without explicit
 *     LayoutParams gets `wrap_content` and the paywall sizes to its content
 *     instead of filling. Hence MATCH_PARENT below.
 *  3. Props arrive one at a time; the reload is deferred to
 *     [onViewDidUpdateProps] so one mount triggers one paywall fetch.
 *
 * Note the asymmetry with the iOS bridge: that one has to work hard to
 * preserve the hosted view's state, because SwiftUI `@State` is scoped to
 * the UIHostingController instance. Here [RovenuePaywallView.bind] is
 * already idempotent by content key — it resets `didLogShow` and
 * `selectedPackageId` only when the content actually changes — so keeping
 * ONE long-lived [inner] instance is all that is required.
 */
class RovenuePaywallExpoView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext) {

    override val shouldUseAndroidLayout: Boolean = true

    // Native event names are deliberately NOT the JS callback names
    // (`onClose` etc.) — the JS wrapper owns those.
    // `EventDispatcher` is a View extension function with both a
    // reified-generic and a Map overload, so a bare `EventDispatcher()`
    // is ambiguous — the type argument is required.
    private val onPurchaseCompleted by EventDispatcher<Map<String, Any>>()
    private val onPurchaseFailed by EventDispatcher<Map<String, Any>>()
    private val onCloseRequested by EventDispatcher<Map<String, Any>>()
    private val onRestoreRequested by EventDispatcher<Map<String, Any>>()
    private val onUrlRequested by EventDispatcher<Map<String, Any>>()

    var placementIdentifier: String? = null
    var locale: String? = null
    var colorSchemeOverride: String? = null
    var hasRestoreHandler: Boolean = false
    var hasUrlHandler: Boolean = false

    // ONE instance for this view's lifetime. bind() is idempotent by
    // content key, so re-binding the same paywall neither re-logs the
    // impression nor drops the user's package selection.
    private val inner = RovenuePaywallView(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loadJob: Job? = null
    private var cachedPaywall: Paywall? = null
    /** The (placement, locale) pair [cachedPaywall] was fetched for. Only a
     *  change to this re-fetches; cosmetic props re-bind from cache. */
    private var resolvedKey: String? = null

    init {
        // ExpoView is a LinearLayout: without explicit params the child
        // would be wrap_content and the paywall would not fill the frame.
        addView(inner, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun onViewDidUpdateProps() {
        reload()
    }

    private fun reload() {
        val placement = placementIdentifier
        if (placement.isNullOrEmpty()) {
            loadJob?.cancel()
            cachedPaywall = null
            resolvedKey = null
            // RovenuePaywallView has no unbind(), so hiding is how we match
            // the iOS bridge's mount(nil), which removes the hosted view.
            // Without this the last paywall stays on screen after the host
            // clears the placement.
            inner.visibility = View.GONE
            return
        }
        val key = placement + KEY_SEPARATOR + (locale ?: "")
        // Toggling colorSchemeOverride or a handler flag must not cost a
        // network round-trip. Re-binding from cache is safe: bind() is
        // idempotent by content key.
        //
        // This holds only while the last resolve SUCCEEDED. A failed resolve
        // clears the key deliberately, so the next prop update — cosmetic or
        // not — retries the fetch. That is the price of not being stuck
        // blank, and it stops as soon as a resolve succeeds.
        if (key == resolvedKey) {
            cachedPaywall?.let { inner.bind(it, options()) }
            return
        }
        loadJob?.cancel()
        resolvedKey = key
        loadJob = scope.launch {
            // A resolution failure renders nothing, matching what the
            // Android view already does with a null config. Surfacing it
            // would need a new prop, which the props contract forbids.
            val paywall = runCatching { Rovenue.shared.getPaywall(placement, locale) }
                .getOrNull()
            if (resolvedKey != key) return@launch
            if (paywall == null) {
                // Same reason as the iOS bridge: a failed resolve must not
                // stay marked resolved, or the cache-hit path returns
                // nothing forever and the view is permanently blank.
                resolvedKey = null
                // It must also not leave the PREVIOUS placement's paywall on
                // screen. Switch from a placement that resolved to one that
                // fails, and without these two lines the old paywall stays
                // up indefinitely. iOS mounts nil unconditionally here; this
                // is the equivalent.
                cachedPaywall = null
                inner.visibility = View.GONE
                return@launch
            }
            cachedPaywall = paywall
            inner.visibility = View.VISIBLE
            inner.bind(paywall, options())
        }
    }

    private fun options(): PaywallViewOptions = PaywallViewOptions(
        locale = locale,
        darkMode = when (colorSchemeOverride) {
            "light" -> false
            "dark" -> true
            else -> null
        },
        onPurchaseCompleted = { result ->
            onPurchaseCompleted(mapOf("result" to dtoFromPurchaseResult(result)))
        },
        onPurchaseFailed = { error ->
            // codedError() returns Throwable (widened over its two branches),
            // so `.code` isn't statically visible here even though the
            // RovenueException branch always produces a CodedException —
            // narrow with `as?` rather than changing codedError's signature
            // (Step 3 keeps that a same-package, no-logic-edit move).
            val coded = codedError(error)
            val code = (coded as? CodedException)?.code ?: UNMAPPED_ERROR_CODE
            onPurchaseFailed(mapOf("code" to code, "message" to (coded.message ?: "")))
        },
        onClose = { onCloseRequested(emptyMap()) },
        // A null handler is what makes the native view HIDE restore
        // affordances / leave url buttons inert — so absence must survive
        // the crossing, not become a no-op lambda.
        onRestore = if (hasRestoreHandler) ({ onRestoreRequested(emptyMap()) }) else null,
        onUrl = if (hasUrlHandler) ({ url -> onUrlRequested(mapOf("url" to url)) }) else null,
    )

    // Called from `OnViewDestroys`. Deliberately NOT `onDetachedFromWindow`:
    // React Native recycles views, so a transient detach during a
    // navigation transition would cancel an in-flight fetch and leave the
    // paywall blank with nothing to retrigger it. The iOS bridge cancels
    // only in `deinit` for the same reason.
    fun onViewDestroys() {
        scope.cancel()
    }
}
