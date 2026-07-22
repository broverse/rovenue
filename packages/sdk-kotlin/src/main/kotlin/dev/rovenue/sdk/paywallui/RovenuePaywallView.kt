package dev.rovenue.sdk.paywallui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.util.AttributeSet
import android.widget.FrameLayout
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.Rovenue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Native Android Views renderer for Phase-B builder paywalls — draws the
 * same 7-node component tree the web renderer (packages/paywall-renderer)
 * and the SwiftUI renderer (`packages/sdk-swift .../PaywallUI/
 * RovenuePaywallView.swift`, the behavioral mirror this class was ported
 * from) draw, fed by real Play Billing pricing. Rendering is 100% native
 * Views (LinearLayout/FrameLayout/TextView/ImageView/Button) — NO Compose,
 * NO Coil (Phase-C spec non-goals).
 *
 * Usage: add the view to a layout, then call [bind] with a [Paywall]
 * carrying a non-null `builderConfigJson`:
 * ```kotlin
 * val paywallView = RovenuePaywallView(context)
 * container.addView(paywallView)
 * paywallView.bind(paywall, PaywallViewOptions(onPurchaseCompleted = { ... }))
 * ```
 *
 * Semantics mirror the web renderer (the normative sibling, see the
 * Phase-C design doc): unknown node type -> its `fallback` else nothing,
 * never a crash; empty `packageIds` = every offering package; selection
 * inits to `defaultSelected ?? effectiveIds[0] ?? null`; the purchase
 * button is disabled without a selection or while a purchase is in flight;
 * restore buttons are hidden without a handler; variables are cell-scoped
 * inside package cells and selected-package-scoped elsewhere; the renderer
 * NEVER opens URLs itself ([PaywallViewOptions.onUrl] is the only path).
 *
 * Re-render strategy: any state change (selection, purchase in flight,
 * rebind) tears down and rebuilds the ENTIRE view tree rather than
 * diffing/patching it — the simplest way to keep cell-scoped vs.
 * selected-scoped variable text correct on every change, mirroring the
 * web renderer's remount-on-change behavior. Builder paywalls are shallow
 * trees (a handful of nodes), so the rebuild cost is negligible; this is a
 * deliberate simplicity-over-micro-optimization choice, documented here so
 * a future perf pass doesn't "fix" it into a stale-label bug.
 *
 * Testing note: this class's Android-view-construction path (and
 * [NodeViewFactory]'s) is manually smoked, not unit-tested — all render
 * LOGIC lives in pure, JVM-tested helpers. The unusable Robolectric
 * dependency this module once declared has been removed (the JUnit5-
 * platform test tasks could never discover its JUnit4-style tests).
 */
class RovenuePaywallView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

    private var paywall: Paywall? = null
    private var options: PaywallViewOptions = PaywallViewOptions()
    private var config: BuilderConfigModel? = null
    private var selectedPackageId: String? = null
    private var isPurchasing: Boolean = false
    private var didLogShow: Boolean = false
    private var lastBoundContentKey: String? = null

    // Cancelled on detach — backs ONLY image loads (no point fetching a
    // bitmap for a view no longer on screen).
    private var viewScope: CoroutineScope? = null

    // Deliberately NOT tied to attach/detach: a purchase is a user-initiated
    // Play Billing flow that should run to completion (and still invoke
    // onPurchaseCompleted/onPurchaseFailed) even if this view transiently
    // detaches (e.g. a host re-layout) while the billing UI is on top.
    // Tying it to viewScope would risk a stray CancellationException
    // surfacing as a spurious onPurchaseFailed mid-purchase.
    private val purchaseScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /**
     * Binds [paywall] and renders its builder-config tree. A `null`
     * [Paywall.builderConfigJson] (or one that fails to decode) clears the
     * view to empty — a shipped app must never crash or show garbage
     * because a paywall config regressed. Safe to call repeatedly (e.g.
     * re-binding after a placement refetch); each call fully re-renders.
     */
    fun bind(paywall: Paywall, options: PaywallViewOptions = PaywallViewOptions()) {
        // Canonical log-once semantics (aligned with the Swift renderer's
        // paywallStateKey): one impression per DISTINCT paywall content per
        // view instance. Re-binding the same paywall (e.g. a placement
        // refetch returning identical content) does NOT re-log.
        val contentKey = (paywall.paywallIdentifier ?: "") + "|" + (paywall.builderConfigJson ?: "")
        val contentChanged = contentKey != lastBoundContentKey
        lastBoundContentKey = contentKey

        this.paywall = paywall
        this.options = options
        this.config = paywall.builderConfigJson?.let(::decodeBuilderConfig)
        if (contentChanged) {
            this.selectedPackageId = config?.let { initialSelection(it.root, paywall.offering) }
            this.didLogShow = false
        }
        this.isPurchasing = false
        render()
        if (isAttachedToWindow) maybeLogShown()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (viewScope == null) viewScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        maybeLogShown()
    }

    override fun onDetachedFromWindow() {
        viewScope?.cancel()
        viewScope = null
        super.onDetachedFromWindow()
    }

    /** Builder paywalls auto-track (Adapty parity): [Rovenue.logPaywallShown]
     *  fires exactly once per successfully-decoded [bind] call, gated to
     *  the view's first appearance on screen (mirrors the SwiftUI
     *  renderer's `onAppear` + `didLogShow` guard). No config -> no view,
     *  no tracking call (nothing was actually shown). */
    private fun maybeLogShown() {
        if (didLogShow) return
        val current = paywall ?: return
        if (config == null) return
        didLogShow = true
        Rovenue.shared.logPaywallShown(current)
    }

    private fun render() {
        removeAllViews()
        setBackgroundColor(0x00000000)
        val cfg = config ?: return

        val isSystemNight =
            (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val dark = computeDarkMode(options.darkMode, isSystemNight)

        cfg.background?.let { pair ->
            parseHexColor(themeValue(pair, dark))?.let { setBackgroundColor(it.toColorInt()) }
        }

        val ctx = PaywallRenderContext(
            config = cfg,
            locale = options.locale,
            dark = dark,
            offering = paywall?.offering,
            selectedPackageId = selectedPackageId,
            isPurchasing = isPurchasing,
            select = { id ->
                selectedPackageId = id
                render()
            },
            purchase = ::startPurchase,
            onClose = {
                paywall?.let { Rovenue.shared.logPaywallClosed(it) }
                options.onClose?.invoke()
            },
            onRestore = options.onRestore,
            onUrl = options.onUrl,
            loadImage = { imageView, url -> loadImageInto(imageView, url, scopeForImageLoads()) },
        )

        val rootView = NodeViewFactory.build(context, cfg.root, ctx, cell = null) ?: return
        addView(rootView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    private fun scopeForImageLoads(): CoroutineScope {
        viewScope?.let { return it }
        return CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also { viewScope = it }
    }

    private fun startPurchase() {
        if (isPurchasing) return
        val id = selectedPackageId ?: return
        val pkg = paywall?.offering?.packageBy(id) ?: return
        val activity = context.findActivity()
        if (activity == null) {
            options.onPurchaseFailed?.invoke(
                IllegalStateException(
                    "RovenuePaywallView: no Activity found in this view's context chain — " +
                        "purchase() requires an Activity to launch the Play Billing flow. " +
                        "Host the view inside an Activity (directly, or via a themed " +
                        "ContextWrapper that ultimately wraps one).",
                ),
            )
            return
        }
        isPurchasing = true
        render()
        purchaseScope.launch {
            try {
                val result = Rovenue.shared.purchase(activity, pkg)
                isPurchasing = false
                render()
                options.onPurchaseCompleted?.invoke(result)
            } catch (e: Throwable) {
                isPurchasing = false
                render()
                options.onPurchaseFailed?.invoke(e)
            }
        }
    }
}

/** Walks the [ContextWrapper] chain to find the hosting [Activity] — Views
 *  are commonly handed a themed/wrapped Context (e.g. by inflation or a
 *  ContextThemeWrapper), so `context as? Activity` alone is unreliable. */
internal fun Context.findActivity(): Activity? {
    var current: Context = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return current as? Activity
}
