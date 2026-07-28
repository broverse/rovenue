package dev.rovenue.sdk.paywallui

import android.graphics.Rect
import android.view.View
import android.view.ViewTreeObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner

// =============================================================
// ONE visibility rule for every time-driven node.
//
// Every timer, player and animation in a paywall answers the same question:
// is this node on screen RIGHT NOW? Two independent signals compose, and a
// node is only allowed to burn time when BOTH say yes:
//
//   1. the node intersects the viewport   (geometry — [isNodeOnScreen])
//   2. the app is in the foreground       (process lifecycle)
//
// Signal 2 already existed on Android (the carousel's `ProcessLifecycleOwner`
// observer); signal 1 did not. This file is where both now live, ONCE, so a
// new time-driven node type inherits the rule instead of re-deriving it.
//
// CROSS-PLATFORM CONTRACT. The web renderer uses `IntersectionObserver` +
// `visibilitychange`; the SwiftUI renderer uses a `GeometryReader` in a named
// coordinate space + scene phase. Android's equivalent of the first is
// `View.getLocalVisibleRect` sampled from a
// `ViewTreeObserver.OnScrollChangedListener` — see [NodeVisibilityDetector].
// All three FAIL OPEN when they cannot tell (see [isNodeOnScreen]).
// =============================================================

/** Seconds → millis, for the authored auto-advance interval. */
internal const val MILLIS_PER_SECOND = 1000.0

/**
 * The fewest pages a carousel needs before auto-advance means anything:
 * one page (or none) has nowhere to advance to.
 */
internal const val CAROUSEL_MIN_AUTO_ADVANCE_PAGES = 2

/**
 * The smallest authored auto-advance interval that is actually an interval.
 * At or below this, auto-advance is OFF — `postDelayed(0)` would spin the
 * pager as fast as the main looper can deliver.
 */
private const val MIN_AUTO_ADVANCE_SECONDS = 0.0

/**
 * Geometry half of the rule: does [visibleRect] — what
 * `View.getLocalVisibleRect` reported for a view of [viewWidth] x
 * [viewHeight], or `null` when it reported nothing visible at all — mean this
 * node is on screen?
 *
 * ANY intersection counts. A node one pixel into the viewport is a node the
 * user can see a timer on, and there is deliberately no "at least N percent"
 * threshold: the three renderers would have to agree on the fraction, and web
 * and iOS do not apply one either.
 *
 * FAIL OPEN, and note the ORDER — the unmeasured case is decided FIRST. Before
 * layout a view has no size and no visible rect, and reading that as
 * "off screen" would stop every timer at attach and leave a paywall full of
 * frozen countdowns. A stopped clock is worse than a running one, so an
 * unmeasured view counts as on screen (matching web, where a node with no
 * `IntersectionObserver` entry yet is treated as visible, and iOS, where a
 * `.zero` viewport counts as visible). Only once the view HAS a size does a
 * missing visible rect actually mean "scrolled away".
 *
 * NOT OBSERVABLE OFF-DEVICE: under the mockable `android.jar` every `Rect`
 * accessor is inert (fields stay `0`, `isEmpty()` returns the default
 * `false`), so the unit tests pin the unmeasured and null-rect branches only.
 * The `isEmpty()` branch — a degenerate rect from a zero-area intersection —
 * is real device behaviour that a JVM test cannot reach.
 */
internal fun isNodeOnScreen(visibleRect: Rect?, viewWidth: Int, viewHeight: Int): Boolean {
    if (viewWidth <= UNMEASURED_VIEW_DIMENSION_PX || viewHeight <= UNMEASURED_VIEW_DIMENSION_PX) return true
    val rect = visibleRect ?: return false
    return !rect.isEmpty()
}

/**
 * The whole rule: a node may run time-driven work only while it is
 * [onScreen] AND the app is [appForegrounded].
 *
 * A backgrounded app's main looper keeps delivering messages, so neither
 * signal implies the other — an on-screen carousel in a backgrounded app
 * still advances pages and CHANGES THE PAGE THE USER COMES BACK TO unless the
 * foreground half is checked too.
 */
internal fun isNodeTimerActive(onScreen: Boolean, appForegrounded: Boolean): Boolean =
    onScreen && appForegrounded

/**
 * Whether a `countdown` row's once-a-second tick should be running:
 * [active] (the composed rule) and not already collapsed by
 * `onExpiry: "hide"`.
 *
 * [hiddenOnExpiry] is a latch that never un-latches, so it survives a
 * pause/resume cycle: coming back on screen must not resurrect the tick of a
 * countdown that has nothing left to draw.
 */
internal fun countdownTickShouldRun(active: Boolean, hiddenOnExpiry: Boolean): Boolean =
    active && !hiddenOnExpiry

/**
 * How long until a `carousel` should turn its next page, or `null` when it
 * should not be scheduled at all.
 *
 * `null` covers four separate reasons, which is exactly why this is one
 * function and not four scattered guards: the node is paused ([active] is
 * false), a `loop: false` carousel already latched [stoppedAtEnd], there is
 * no positive authored interval ([autoAdvanceSeconds] absent means OFF, not
 * "use a default"), or there is nowhere to advance to.
 *
 * [stoppedAtEnd] is checked independently of [active], so the stop latch
 * SURVIVES a pause/resume: pausing is not the same as reaching the last page,
 * and a carousel that stopped at its end must stay stopped when it scrolls
 * back into view.
 */
internal fun carouselAutoAdvanceDelayMillis(
    active: Boolean,
    stoppedAtEnd: Boolean,
    autoAdvanceSeconds: Double?,
    pageCount: Int,
): Long? {
    if (!active || stoppedAtEnd) return null
    if (pageCount < CAROUSEL_MIN_AUTO_ADVANCE_PAGES) return null
    val seconds = autoAdvanceSeconds ?: return null
    if (seconds <= MIN_AUTO_ADVANCE_SECONDS) return null
    return (seconds * MILLIS_PER_SECOND).toLong()
}

/**
 * The shared plumbing that keeps [isNodeTimerActive] up to date for one
 * [view], and calls [onActiveChanged] when the answer flips.
 *
 * Built ONCE per time-driven node and owned by it: [start] from
 * `onAttachedToWindow`, [stop] from `onDetachedFromWindow`. It supplies an
 * ADDITIONAL pause signal — it does not replace the owner's own handler
 * teardown, which must still happen on detach.
 *
 * EVERY LISTENER REGISTERED IS UNREGISTERED IN [stop]. `RovenuePaywallView`
 * rebuilds its whole view tree on every state change (a package tap is a
 * rebuild), and an attached view's `getViewTreeObserver()` is the WINDOW's
 * observer, shared by the entire hierarchy and outliving any single node — a
 * listener left behind both leaks the discarded view and re-runs on every
 * future scroll, once more per tap, for the life of the window. That exact
 * defect has already shipped in this renderer once.
 *
 * FAILS SOFT ON THE LIFECYCLE HALF. `ProcessLifecycleOwner.get()` THROWS when
 * `androidx.startup`'s `ProcessLifecycleInitializer` never ran — a host app is
 * free to strip it out of the manifest (`tools:node="remove"`), and apps that
 * manage their own App Startup do exactly that. That throw would land in
 * `onAttachedToWindow`, taking the host app down as the paywall appears. A
 * paywall must never crash a host app over an OPTIONAL nicety, and pausing
 * while backgrounded is exactly that — so a missing process lifecycle is
 * treated as "always foregrounded" and only the geometry half applies.
 *
 * DEVICE-ONLY: whether `OnScrollChangedListener` fires, and whether
 * `getLocalVisibleRect` returns real rects, is not observable under the
 * mockable `android.jar` (both are stubbed). The decision this class feeds is
 * pinned by unit tests; the plumbing that feeds it is a device smoke item.
 */
internal class NodeVisibilityDetector(
    private val view: View,
    private val onActiveChanged: (Boolean) -> Unit,
) {
    /** Reused across every sample so scroll-rate polling allocates nothing. */
    private val scratchRect = Rect()

    /** Resolved ONCE so [stop] removes the observer from the very lifecycle
     *  [start] added it to. `null` = this app has no process lifecycle. */
    private val processLifecycle: Lifecycle? =
        runCatching { ProcessLifecycleOwner.get().lifecycle }.getOrNull()

    /** With no process lifecycle there is nothing to tell us the app went
     *  away, so the foreground half is held permanently true rather than
     *  permanently false — the cost is the pre-fix behaviour, not a paywall
     *  whose timers never start. */
    private var appForegrounded: Boolean = processLifecycle == null

    /**
     * The current answer, and the reason a consumer can read it synchronously
     * (the carousel re-derives its delay on every page change, not only when
     * visibility flips). Starts `true` for the same fail-open reason
     * [isNodeOnScreen] does: before [start] there has been no sample.
     */
    var isActive: Boolean = true
        private set

    /** Last value handed to [onActiveChanged], or `null` if nothing has been
     *  published since the most recent [start]. */
    private var published: Boolean? = null

    private val foregroundObserver = LifecycleEventObserver { _, event ->
        when (event) {
            Lifecycle.Event.ON_START -> {
                appForegrounded = true
                publish()
            }

            Lifecycle.Event.ON_STOP -> {
                appForegrounded = false
                publish()
            }

            else -> Unit
        }
    }

    /** Android's `IntersectionObserver`: the window's scroll signal, which is
     *  what changes whether this node intersects the viewport. */
    private val scrollListener = ViewTreeObserver.OnScrollChangedListener { publish() }

    /** Scrolling is not the only way a node's position changes — the FIRST
     *  layout pass is what turns an unmeasured (fail-open) node into one whose
     *  real position is known, and no scroll need ever follow it. Without
     *  this, a node laid out below the fold would keep ticking until the user
     *  happened to scroll. */
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { publish() }

    fun start() {
        view.viewTreeObserver.takeIf { it.isAlive }?.let { observer ->
            observer.addOnScrollChangedListener(scrollListener)
            observer.addOnGlobalLayoutListener(layoutListener)
        }
        // Adding an observer to a `LifecycleRegistry` immediately replays the
        // owner's current state, so a foregrounded app delivers ON_START (and
        // therefore a publish) from inside this call, while a backgrounded one
        // correctly delivers nothing.
        processLifecycle?.addObserver(foregroundObserver)
        // ...which is why start() publishes explicitly as well: the
        // backgrounded and no-lifecycle cases must still get their first
        // answer. publish() de-duplicates, so the foregrounded case does not
        // fire twice.
        publish()
    }

    fun stop() {
        view.viewTreeObserver.takeIf { it.isAlive }?.let { observer ->
            observer.removeOnScrollChangedListener(scrollListener)
            observer.removeOnGlobalLayoutListener(layoutListener)
        }
        processLifecycle?.removeObserver(foregroundObserver)
        // Back to the fail-open starting point so a re-attach re-publishes
        // rather than being swallowed as "no change".
        published = null
        isActive = true
    }

    /**
     * Samples both signals and notifies ONLY on a change.
     *
     * The de-duplication is load-bearing, not an optimisation:
     * `OnScrollChangedListener` fires on every scrolled frame, and a consumer
     * that removes and re-posts its handler callback on each one would have
     * its timer permanently reset — a countdown that never ticks while the
     * user is scrolling, and a carousel that never advances.
     */
    private fun publish() {
        val next = isNodeTimerActive(
            onScreen = isNodeOnScreen(currentVisibleRect(), view.width, view.height),
            appForegrounded = appForegrounded,
        )
        isActive = next
        if (next == published) return
        published = next
        onActiveChanged(next)
    }

    /** `getLocalVisibleRect` returns false — and leaves [scratchRect]
     *  untouched — when no part of the view is visible, which is exactly the
     *  `null` [isNodeOnScreen] expects. */
    private fun currentVisibleRect(): Rect? =
        if (view.getLocalVisibleRect(scratchRect)) scratchRect else null
}
