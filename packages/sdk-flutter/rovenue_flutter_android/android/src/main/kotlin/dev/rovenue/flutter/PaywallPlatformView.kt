// PaywallPlatformView.kt — hosts the Android Views paywall renderer
// (dev.rovenue.sdk.paywallui.RovenuePaywallView) inside a Flutter
// `PlatformView`. Task 7.
//
// Model: `packages/sdk-rn/android/.../RovenuePaywallExpoView.kt`. Flutter's
// platform-view contract differs from Expo's in one load-bearing way that
// simplifies this file relative to that model: creation params arrive
// ONCE, atomically, in the constructor — there is no per-prop update
// channel a Flutter host can use to change `placementIdentifier`/`locale`/
// etc. after the view exists (unlike Expo's `onViewDidUpdateProps`, which
// can fire many times over a view's life). So there is no `reload()`/
// content-key-cache dance here: the paywall is resolved exactly once, the
// job is cancelled in `dispose()` if still in flight, and the single
// `RovenuePaywallView.bind()` call happens if and when that resolve lands.

package dev.rovenue.flutter

import android.content.Context
import android.view.View
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.paywallui.PaywallViewOptions
import dev.rovenue.sdk.paywallui.RovenuePaywallView
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

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

    private val placementIdentifier: String
    private val locale: String?
    private val colorSchemeOverride: String?
    private val hasRestoreHandler: Boolean
    private val hasUrlHandler: Boolean

    init {
        @Suppress("UNCHECKED_CAST")
        val params = args as? Map<String, Any?> ?: emptyMap()
        placementIdentifier = params["placementIdentifier"] as? String ?: ""
        locale = params["locale"] as? String
        colorSchemeOverride = params["colorSchemeOverride"] as? String
        hasRestoreHandler = params["hasRestoreHandler"] as? Boolean ?: false
        hasUrlHandler = params["hasUrlHandler"] as? Boolean ?: false
        load()
    }

    override fun getView(): View = inner

    override fun dispose() {
        loadJob?.cancel()
        scope.cancel()
    }

    private fun load() {
        val placement = placementIdentifier
        if (placement.isEmpty()) return
        loadJob = scope.launch {
            // A resolution failure renders nothing — matches the RN bridge
            // and the Android renderer's own behavior for a null config.
            val paywall = runCatching { Rovenue.shared.getPaywall(placement, locale) }.getOrNull()
            if (paywall != null) {
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
