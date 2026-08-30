// PaywallPlatformView.kt — hosts the Android Views paywall renderer
// (dev.rovenue.sdk.paywallui.RovenuePaywallView) inside a Flutter
// `PlatformView`. Task 7.
//
// Model: `packages/sdk-rn/android/.../RovenuePaywallExpoView.kt`. Creation
// params arrive once, atomically, in the constructor — but unlike Expo's
// `onViewDidUpdateProps`, Flutter's `AndroidView`/`UiKitView` never resend
// them on a prop change. Task 8's carry-forward closes that gap with an
// explicit `updateParams` call the Dart side (`RovenuePaywallView`'s
// `didUpdateWidget`, see `packages/sdk-flutter/rovenue_flutter/lib/src/
// paywall_view.dart`) sends over this view's own per-instance channel —
// the same pattern `google_maps_flutter`/`webview_flutter` use for
// prop-diffing platform views. `onMethodCall` only re-resolves the paywall
// (cancelling any in-flight `loadJob`) when
// `placementIdentifier`/`locale`/`colorSchemeOverride` actually changed; a
// pure `hasRestoreHandler`/`hasUrlHandler` flip just re-binds the cached
// `currentPaywall` with new closures, so an unchanged prop never triggers
// a re-fetch.

package dev.rovenue.flutter

import android.content.Context
import android.view.View
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.paywallui.PaywallViewOptions
import dev.rovenue.sdk.paywallui.RovenuePaywallView
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import dev.rovenue.sdk.Paywall

internal class PaywallPlatformView(
    context: Context,
    viewId: Int,
    args: Any?,
    messenger: BinaryMessenger,
) : PlatformView {

    private val inner = RovenuePaywallView(context)
    private val channel = MethodChannel(messenger, "dev.rovenue.flutter/paywall_view_$viewId")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loadJob: Job? = null

    private var placementIdentifier: String
    private var locale: String?
    private var colorSchemeOverride: String?
    private var hasRestoreHandler: Boolean
    private var hasUrlHandler: Boolean

    /** Cached so a handler-only `updateParams` (no placement/locale/scheme
     *  change) can re-`bind` without re-resolving the paywall. */
    private var currentPaywall: Paywall? = null

    init {
        @Suppress("UNCHECKED_CAST")
        val params = args as? Map<String, Any?> ?: emptyMap()
        placementIdentifier = params["placementIdentifier"] as? String ?: ""
        locale = params["locale"] as? String
        colorSchemeOverride = params["colorSchemeOverride"] as? String
        hasRestoreHandler = params["hasRestoreHandler"] as? Boolean ?: false
        hasUrlHandler = params["hasUrlHandler"] as? Boolean ?: false
        channel.setMethodCallHandler(::onMethodCall)
        load()
    }

    override fun getView(): View = inner

    override fun dispose() {
        loadJob?.cancel()
        scope.cancel()
    }

    /** Handles Dart's `updateParams` call (see this file's header). Any
     *  other method name is answered "not implemented" — this channel is
     *  also used the other way (native -> Dart `invokeMethod` calls in
     *  [options]), so an unrecognized method here isn't necessarily a bug.
     */
    private fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "updateParams") {
            result.notImplemented()
            return
        }
        @Suppress("UNCHECKED_CAST")
        val params = call.arguments as? Map<String, Any?> ?: emptyMap()
        val newPlacement = params["placementIdentifier"] as? String ?: ""
        val newLocale = params["locale"] as? String
        val newColorScheme = params["colorSchemeOverride"] as? String
        val newHasRestore = params["hasRestoreHandler"] as? Boolean ?: false
        val newHasUrl = params["hasUrlHandler"] as? Boolean ?: false

        val needsReload = newPlacement != placementIdentifier ||
            newLocale != locale ||
            newColorScheme != colorSchemeOverride
        val handlersChanged = newHasRestore != hasRestoreHandler || newHasUrl != hasUrlHandler

        placementIdentifier = newPlacement
        locale = newLocale
        colorSchemeOverride = newColorScheme
        hasRestoreHandler = newHasRestore
        hasUrlHandler = newHasUrl

        if (needsReload) {
            loadJob?.cancel()
            load()
        } else if (handlersChanged) {
            currentPaywall?.let { inner.bind(it, options()) }
        }
        result.success(null)
    }

    private fun load() {
        val placement = placementIdentifier
        if (placement.isEmpty()) return
        loadJob = scope.launch {
            // A resolution failure renders nothing — matches the RN bridge
            // and the Android renderer's own behavior for a null config.
            val paywall = runCatching { Rovenue.shared.getPaywall(placement, locale) }.getOrNull()
            if (paywall != null) {
                currentPaywall = paywall
                inner.bind(paywall, options())
            }
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
            channel.invokeMethod("onPurchaseCompleted", mapOf("result" to dtoFromPurchaseResult(result)))
        },
        onPurchaseFailed = { error ->
            channel.invokeMethod("onPurchaseFailed", errorArgs(error))
        },
        onClose = { channel.invokeMethod("onCloseRequested", null) },
        // A null handler is what makes the native view HIDE restore
        // affordances / leave url buttons inert — so absence must survive
        // to `PaywallViewOptions`, not become a no-op lambda.
        onRestore = if (hasRestoreHandler) ({ channel.invokeMethod("onRestoreRequested", null) }) else null,
        onUrl = if (hasUrlHandler) ({ url -> channel.invokeMethod("onUrlRequested", mapOf("url" to url)) }) else null,
    )
}
