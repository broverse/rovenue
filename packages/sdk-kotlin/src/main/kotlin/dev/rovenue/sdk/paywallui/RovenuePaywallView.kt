package dev.rovenue.sdk.paywallui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.util.AttributeSet
import android.view.Gravity
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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

/**
 * The scrolled content and the pinned footer a root stack splits into.
 * Mirrors the Swift renderer's `RootPartition`.
 */
internal data class RootPartition(
    val scrolledChildren: List<BuilderNode>,
    val stickyFooter: BuilderNode.StickyFooter?,
)

/**
 * Splits [root]'s direct children into the scrolled content and the pinned
 * footer.
 *
 * The rule (shared by all three renderers, stated authoritatively next to
 * the sticky-footer issue codes in packages/shared/src/paywall/validate.ts):
 * a `stickyFooter` is pinned when it is a DIRECT child of the root,
 * WHEREVER it sits among its siblings; among several direct-child footers
 * the LAST one wins and the earlier ones stay in the scrolled content,
 * reaching the ordinary [NodeViewFactory.build] dispatch which renders them
 * in-flow like a stack (see [NodeViewFactory.buildStickyFooter]'s doc).
 * Position among siblings deliberately does not matter for a single footer:
 * a pinned bar's position is the bottom of the screen either way, so an
 * author who dropped it above a text node still gets what they meant —
 * reading the rule as "the LAST child only" silently un-pinned that shape,
 * and the validator, which only warns about non-direct children, said
 * nothing.
 *
 * A footer that is not a direct root child at all is left where it is and
 * renders inline; the validator's `STICKY_FOOTER_NOT_AT_ROOT` warning is
 * what tells the author about that. This function does not warn, only
 * partitions.
 */
internal fun partitionRootChildren(root: BuilderNode.Stack): RootPartition {
    val children = root.children
    for (index in children.indices.reversed()) {
        val footer = children[index] as? BuilderNode.StickyFooter ?: continue
        return RootPartition(
            scrolledChildren = children.filterIndexed { i, _ -> i != index },
            stickyFooter = footer,
        )
    }
    return RootPartition(scrolledChildren = children, stickyFooter = null)
}

/**
 * The bottom clearance (px) the scrolled content reserves for the footer
 * OVERLAYING it, so the last scrolled item never ends up underneath it and
 * unreachable — the same class of bug as no scrolling at all, just subtler.
 *
 * Pure so the rules are actually testable (this module has no Robolectric —
 * see [RovenuePaywallView]'s class doc):
 * - no pinned footer, or one collapsed to [android.view.View.GONE] -> ZERO.
 *   A hidden or absent footer leaving a clearance band behind is a visible
 *   bug: a strip of dead space at the bottom of every such paywall.
 * - a laid-out footer -> its MEASURED height, never a fixed guess. A footer
 *   with a CTA plus fine print is routinely taller than one with a CTA
 *   alone (mirrors the web renderer's `ResizeObserver` / the Swift
 *   renderer's `StickyFooterHeightKey`).
 * - a footer that has not been measured yet (height 0 before the first
 *   layout pass) -> [placeholderPx], the pre-measurement guess.
 */
internal fun stickyFooterClearancePx(
    hasPinnedFooter: Boolean,
    footerIsGone: Boolean,
    measuredFooterHeightPx: Int,
    placeholderPx: Int,
): Int = when {
    !hasPinnedFooter || footerIsGone -> 0
    measuredFooterHeightPx > 0 -> measuredFooterHeightPx
    else -> placeholderPx
}

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

    // The current render's pinned-footer pair, or null when this paywall
    // has no pinned footer. Read by syncPinnedFooterClearance() off the ONE
    // global-layout listener below, so the listener survives render()'s
    // teardown-and-rebuild instead of being re-registered by it.
    private var pinnedScroller: androidx.core.widget.NestedScrollView? = null
    private var pinnedFooterView: android.view.View? = null

    /** Installed on attach, removed on detach — a listener added per
     *  render() would accumulate one per package tap (render() rebuilds the
     *  whole tree on every state change) and never be removed. */
    private val footerHeightListener = ViewTreeObserver.OnGlobalLayoutListener { syncPinnedFooterClearance() }

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
        viewTreeObserver.addOnGlobalLayoutListener(footerHeightListener)
        maybeLogShown()
    }

    override fun onDetachedFromWindow() {
        viewScope?.cancel()
        viewScope = null
        if (viewTreeObserver.isAlive) viewTreeObserver.removeOnGlobalLayoutListener(footerHeightListener)
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
        // Dropped with the tree they belonged to: the global-layout
        // listener outlives render(), so leaving stale views here would
        // have it padding a detached scroller off a detached footer.
        pinnedScroller = null
        pinnedFooterView = null
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
        // `cfg.root.children` (see partitionRootChildren): the LAST
        // `stickyFooter` among the root's DIRECT children is pulled out and
        // pinned OVER the scroller; found anywhere else, it stays in
        // `scrolledRoot`'s children and reaches the ordinary
        // NodeViewFactory dispatch, rendering in-flow like any other stack
        // (see NodeViewFactory.buildStickyFooter's doc).
        val partition = partitionRootChildren(cfg.root)
        val scrolledRoot = cfg.root.copy(children = partition.scrolledChildren)

        val rootView = NodeViewFactory.build(context, scrolledRoot, ctx, cell = null) ?: return
        // A footer whose `visibility` gate excludes this platform/version
        // builds to null — and then there is no footer at all: no overlay,
        // and (via stickyFooterClearancePx) ZERO clearance, not a band of
        // dead space at the bottom of the paywall.
        val footerView = partition.stickyFooter?.let { NodeViewFactory.build(context, it, ctx, cell = null) }

        // Resolved off THIS view's context, before the scroller exists —
        // inside the `apply` block below, `context` would resolve to the
        // scroller's own.
        val clearancePlaceholderPx = dp(context, STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT_DP)

        val scroller = androidx.core.widget.NestedScrollView(context).apply {
            // isFillViewport is the Android spelling of "content still
            // fills the screen when it is shorter than the viewport".
            // Without it a stack with a flexible spacer collapses to its
            // natural height, and any paywall pushing its CTA to the
            // bottom rides up.
            isFillViewport = true
            // The clearance is the SCROLLER's own bottom padding, and
            // `rootView` is its DIRECT child — no intermediate wrapper.
            // Both halves are load-bearing:
            //
            //  - Direct child: `isFillViewport` re-measures the scroller's
            //    direct child with an EXACTLY spec of the viewport height.
            //    An intermediate FrameLayout holding `rootView` at
            //    WRAP_CONTENT turns that EXACTLY back into an AT_MOST for
            //    the root stack, and a LinearLayout under AT_MOST hands its
            //    weighted children nothing — a flexible `spacer` collapses
            //    and a stack that distributed its children across the
            //    viewport hugs the top, which is precisely the failure
            //    `isFillViewport` exists to prevent.
            //  - Scroller padding: NestedScrollView subtracts its own
            //    vertical padding from that EXACTLY spec, so the footer's
            //    clearance is carved OUT of the viewport minimum rather
            //    than added on top of it (the Android spelling of the web
            //    renderer's `box-sizing: border-box`, and of the Swift
            //    renderer's padding-inside-`.frame(minHeight:)` order).
            //    Adding it would make every short footered paywall exactly
            //    one footer's height too tall — scrollable for nothing —
            //    and lay a bottom-anchored CTA out underneath the footer.
            //    It stays a SEPARATE padding layer from the root stack's
            //    own authored `padding` (applied inside `rootView` by
            //    NodeViewFactory.buildStack), never merged into it.
            //
            // `clipToPadding = false` lets the content scroll visibly
            // THROUGH the reserved strip and under the footer, as it does
            // on web; clipping it would make content vanish at the footer's
            // top edge instead.
            clipToPadding = false
            setPadding(
                0,
                0,
                0,
                stickyFooterClearancePx(
                    hasPinnedFooter = footerView != null,
                    footerIsGone = false,
                    measuredFooterHeightPx = 0,
                    placeholderPx = clearancePlaceholderPx,
                ),
            )
            addView(rootView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        }
        addView(scroller, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        if (footerView == null) return

        // The footer OVERLAYS the scroll area rather than standing beside
        // it in a weighted LinearLayout — the layout model the spec is
        // written for ("the scrolled content gets bottom padding equal to
        // the footer's height so the last item is never hidden beneath it")
        // and the one the opaque-background default exists for ("a pinned
        // bar needs an opaque background or the content scrolls visibly
        // beneath it"). A sibling would shorten the viewport by the
        // footer's height AND then pad the content by it again: the same
        // clearance counted twice. This view is itself a FrameLayout, so
        // the overlay needs no extra container — the footer is simply the
        // second child, bottom-gravity, over the full-bleed scroller.
        addView(
            footerView,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM),
        )
        pinnedScroller = scroller
        pinnedFooterView = footerView
        applyFooterBottomInset(footerView)
        syncPinnedFooterClearance()
    }

    /**
     * Keeps a pinned footer above the bottom safe area — never under the
     * gesture bar or the home indicator (the SwiftUI sibling gets this from
     * its safe area, the web one from `env(safe-area-inset-bottom)`). The
     * inset is the REAL one the window reports, not a fixed guess: it is 0
     * on a window the system already inset for a three-button nav bar, and
     * the gesture bar's height on an edge-to-edge one, and a hard-coded
     * value is wrong in both cases.
     *
     * Written as `base + inset` off the footer's OWN padding captured once
     * here, so repeated dispatches never accumulate. Applied only to a
     * PINNED footer: a nested (in-flow) `stickyFooter` stays flush with its
     * siblings like any other stack, and an absent/hidden one leaves
     * nothing behind at all.
     */
    private fun applyFooterBottomInset(footerView: android.view.View) {
        val basePaddingBottom = footerView.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(footerView) { view, insets ->
            val inset = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            ).bottom
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, basePaddingBottom + inset)
            insets
        }
        // render() runs on every state change, long after this window's
        // first inset dispatch, so a freshly built footer would otherwise
        // sit un-inset until the next unrelated dispatch. Apply what the
        // window already knows now, and ask for a fresh pass for the case
        // where it knows nothing yet.
        ViewCompat.getRootWindowInsets(this)?.let { insets ->
            val inset = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            ).bottom
            footerView.setPadding(
                footerView.paddingLeft,
                footerView.paddingTop,
                footerView.paddingRight,
                basePaddingBottom + inset,
            )
        }
        ViewCompat.requestApplyInsets(footerView)
    }

    /**
     * Replaces the pre-measurement clearance guess with the footer's real
     * height (see [stickyFooterClearancePx]). Driven by ONE
     * [ViewTreeObserver.OnGlobalLayoutListener], installed on attach and
     * removed on detach — registering it inside render(), which re-runs on
     * every package tap, accumulated a listener per tap for the life of the
     * view.
     */
    private fun syncPinnedFooterClearance() {
        val scroller = pinnedScroller ?: return
        val footer = pinnedFooterView ?: return
        val clearance = stickyFooterClearancePx(
            hasPinnedFooter = true,
            footerIsGone = footer.visibility == GONE,
            measuredFooterHeightPx = footer.height,
            placeholderPx = dp(context, STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT_DP),
        )
        if (scroller.paddingBottom != clearance) scroller.setPadding(0, 0, 0, clearance)
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
        // Preview must never charge — gated FIRST, before any purchasing
        // state (isPurchasing/selectedPackageId) is even read, so a preview
        // build never reaches Rovenue.shared.purchase. No fabricated
        // success/failure callback either: onPurchaseCompleted/
        // onPurchaseFailed are left untouched, same as if the tap never
        // happened. See purchaseGate's doc.
        if (!purchaseGate(previewMode = options.previewMode)) return
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
