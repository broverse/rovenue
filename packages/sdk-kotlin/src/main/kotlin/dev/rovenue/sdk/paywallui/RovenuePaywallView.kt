package dev.rovenue.sdk.paywallui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.util.AttributeSet
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.LinearLayout
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

/** Extra bottom clearance a ROOT-PINNED `stickyFooter` gets below its own
 *  content, for the system nav bar it sits flush against — mirrors the
 *  Swift renderer's trailing `.padding(.bottom)` at its pinned call site.
 *  Not applied to a nested (non-pinned) `stickyFooter` instance, which
 *  stays flush with its siblings like any other stack. */
private const val STICKY_FOOTER_BOTTOM_INSET_DP = 16.0

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
            // Scoped to a content change on purpose. isPurchasing is the
            // re-entrancy guard startPurchase() reads, and purchaseScope is
            // deliberately NOT tied to this view's lifecycle — so clearing
            // the flag on every bind() would unlock a second purchase while
            // the first is still running with Play Billing. A same-content
            // re-bind is now routine: the React Native bridge re-binds from
            // cache whenever a cosmetic prop changes.
            //
            // The Swift renderer already scopes its reset this way, inside
            // .onChange(of: paywallStateKey).
            this.isPurchasing = false
        }
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

        val currentPaywall = paywall
        val countdownPrefs = context.getSharedPreferences(COUNTDOWN_PREFS_NAME, Context.MODE_PRIVATE)

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
            appVersion = appVersionOrNull(),
            // Anchors a `durationSeconds` countdown's deadline to a
            // PERSISTED first-show instant, keyed by this paywall's
            // identifier (see countdownFirstShownAtMillis's doc) — real
            // SharedPreferences here; NodeViewFactoryTest injects a fake
            // instead so its tests never touch real device state.
            countdownAnchorMillis = {
                countdownFirstShownAtMillis(currentPaywall?.paywallIdentifier, countdownPrefs)
            },
        )

        // Same partition the web/Swift renderers perform on
        // `cfg.root.children`: a `stickyFooter` found ONLY as the root's
        // last direct child is pulled out and pinned below the scroller;
        // found anywhere else, it stays in `scrolledRoot`'s children and
        // reaches the ordinary NodeViewFactory dispatch, rendering in-flow
        // like any other stack (see NodeViewFactory.buildStickyFooter's doc).
        val footerNode = cfg.root.children.lastOrNull() as? BuilderNode.StickyFooter
        val scrolledChildren = if (footerNode != null) cfg.root.children.dropLast(1) else cfg.root.children
        val scrolledRoot = cfg.root.copy(children = scrolledChildren)

        val rootView = NodeViewFactory.build(context, scrolledRoot, ctx, cell = null) ?: return
        val footerView = footerNode?.let { NodeViewFactory.build(context, it, ctx, cell = null) }

        if (footerView == null) {
            val scroller = androidx.core.widget.NestedScrollView(context).apply {
                // isFillViewport is the Android spelling of "content still
                // fills the screen when it is shorter than the viewport".
                // Without it a stack with a flexible spacer collapses to its
                // natural height, and any paywall pushing its CTA to the
                // bottom rides up.
                isFillViewport = true
                addView(rootView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            }
            addView(scroller, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            return
        }

        // A pinned bar sitting flush against the screen edge needs its own
        // clearance from the system nav bar — mirrors the Swift renderer's
        // trailing `.padding(.bottom)` at the pinned call site only
        // (StickyFooterView/buildStickyFooter itself never adds this; a
        // nested, non-pinned instance stays flush with its siblings).
        footerView.setPadding(
            footerView.paddingLeft,
            footerView.paddingTop,
            footerView.paddingRight,
            footerView.paddingBottom + dp(context, STICKY_FOOTER_BOTTOM_INSET_DP),
        )

        // `scrollContent` wraps `rootView` so the clearance reserved for the
        // pinned footer is a SEPARATE padding layer from the root stack's
        // own authored `padding` (already applied inside `rootView` by
        // NodeViewFactory.buildStack) — mirrors the Swift renderer's
        // `.padding(.bottom, footerClearance)` modifier, layered OUTSIDE
        // `StackNodeView`'s own padding, never merged into it.
        val scrollContent = FrameLayout(context).apply {
            addView(rootView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            setPadding(0, 0, 0, dp(context, STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT_DP))
        }
        val scroller = androidx.core.widget.NestedScrollView(context).apply {
            isFillViewport = true
            addView(scrollContent, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        }

        // The scroller's bottom clearance comes from the footer's MEASURED
        // height, not the constant above (that's only the pre-measurement
        // placeholder) — a footer with a CTA plus fine print is routinely
        // taller than one with a CTA alone, and a fixed guess leaves the
        // last scrolled item unreachable, the same failure as no scrolling
        // at all. This listener replaces the placeholder with the real
        // value on every layout pass the footer goes through (mirrors the
        // web renderer's `ResizeObserver` / the Swift renderer's
        // `StickyFooterHeightKey` preference).
        footerView.viewTreeObserver.addOnGlobalLayoutListener(
            object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    val measured = footerView.height
                    if (measured > 0 && scrollContent.paddingBottom != measured) {
                        scrollContent.setPadding(0, 0, 0, measured)
                    }
                }
            },
        )

        val outer = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        outer.addView(
            scroller,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0).apply { weight = 1f },
        )
        outer.addView(
            footerView,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )
        addView(outer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    /**
     * The app version supplied to `Rovenue.configure` (`null` when
     * configure omitted it), feeding the `visibility` gate's
     * minAppVersion/maxAppVersion bounds — see NodeViewFactory.build.
     * `Rovenue.shared` throws before configure() ever runs; this view's
     * builder-config visibility gate must still fail open rather than
     * crash a render triggered ahead of (or without) configuration, so
     * that case is treated the same as "no appVersion" instead of
     * propagating the exception. Platform itself is NOT threaded through
     * the context — it's the compile-time literal NodeViewFactory.build
     * gates on.
     */
    private fun appVersionOrNull(): String? =
        try {
            Rovenue.shared.configuredAppVersion
        } catch (_: IllegalStateException) {
            null
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
