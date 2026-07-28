package dev.rovenue.sdk.paywallui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The one rule every time-driven node answers to: is this node on screen
 * right now, and is the app in front?
 *
 * SCOPE NOTE — what a JVM unit test can and cannot pin here, and why the
 * predicate's signature is the way it is. Under the mockable `android.jar`
 * (`isReturnDefaultValues = true`) a `Rect` is inert: `Rect(0, 0, 300, 200)`
 * constructs with all four fields left at `0`, `width()`/`height()` return
 * `0`, and `isEmpty()` returns the default `false` — probed, not assumed.
 * These tests once handed [isNodeOnScreen] such a `Rect` and claimed to cover
 * the "is any of it showing?" decision; they could not, because the two rects
 * they built were indistinguishable at runtime and the decision leaned on the
 * same stub default the assertion did.
 *
 * So [isNodeOnScreen] takes px, not a `Rect`, and every branch of it is
 * genuinely exercised below. What stays device-only is the two-line adapter
 * that reads a real `Rect` — `NodeVisibilityDetector.sampleOnScreen` — and
 * whether `getLocalVisibleRect` and `OnScrollChangedListener` produce real
 * geometry at the right moments.
 */
class NodeVisibilityTest {

    // ---- the pure predicate -------------------------------------------

    @Test
    fun `a fully visible view is on screen`() {
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = VIEW_WIDTH_PX,
                visibleHeightPx = VIEW_HEIGHT_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `a view with nothing showing is off screen`() {
        assertFalse(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `a partially visible view counts as on screen`() {
        // A genuinely different input from the fully-visible case above: a
        // sliver of height showing, the rest scrolled past. ANY intersection
        // counts, so this must answer the same as full visibility.
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = VIEW_WIDTH_PX,
                visibleHeightPx = SLIVER_SHOWING_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `a view showing exactly one pixel is still on screen`() {
        // The boundary of "any intersection counts": one px is the smallest
        // thing the platform can report as visible, and it must not be
        // rounded away into "off screen".
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = SINGLE_PIXEL_PX,
                visibleHeightPx = SINGLE_PIXEL_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `a view scrolled to a zero-area sliver is off screen`() {
        // The degenerate intersection: the node is measured, and exactly its
        // edge is at the viewport boundary, so the platform reports a rect
        // with no area. Nothing is drawn, so nothing may run. THIS is the
        // branch the old Rect-shaped signature could not reach.
        assertFalse(
            isNodeOnScreen(
                visibleWidthPx = VIEW_WIDTH_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
        assertFalse(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = VIEW_HEIGHT_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `an inverted intersection is off screen`() {
        // `Rect.width()` is `right - left`, which goes NEGATIVE on the
        // degenerate rects the platform can hand back; a `> 0` test must
        // reject those rather than only the exact zero.
        assertFalse(
            isNodeOnScreen(
                visibleWidthPx = INVERTED_EXTENT_PX,
                visibleHeightPx = INVERTED_EXTENT_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `an unmeasured view fails open`() {
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = UNMEASURED_PX,
                viewHeightPx = UNMEASURED_PX,
            ),
        )
    }

    @Test
    fun `a view measured in only one dimension still fails open`() {
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = VIEW_WIDTH_PX,
                viewHeightPx = UNMEASURED_PX,
            ),
        )
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = UNMEASURED_PX,
                viewHeightPx = VIEW_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `the unmeasured check is decided before the nothing-showing one`() {
        // Order matters and is easy to invert: an unmeasured view has nothing
        // showing BY DEFINITION, so if "nothing showing" were tested first,
        // every node would start paused at attach and a paywall full of
        // countdowns would come up frozen.
        assertTrue(
            isNodeOnScreen(
                visibleWidthPx = NOTHING_SHOWING_PX,
                visibleHeightPx = NOTHING_SHOWING_PX,
                viewWidthPx = UNMEASURED_PX,
                viewHeightPx = UNMEASURED_PX,
            ),
            "an unmeasured view must fail OPEN even though nothing is showing",
        )
    }

    // ---- composing the two signals ------------------------------------

    @Test
    fun `a timer runs only when the node is on screen AND the app is in front`() {
        assertTrue(isNodeTimerActive(onScreen = true, appForegrounded = true))
        assertFalse(isNodeTimerActive(onScreen = false, appForegrounded = true))
        assertFalse(isNodeTimerActive(onScreen = true, appForegrounded = false))
        assertFalse(isNodeTimerActive(onScreen = false, appForegrounded = false))
    }

    // ---- consumer 1: the countdown tick --------------------------------

    private fun countdownTickWhileOffScreen() = countdownTickShouldRun(
        active = isNodeTimerActive(onScreen = offScreen(), appForegrounded = true),
        hiddenOnExpiry = false,
    )

    /** A measured node with none of it showing — what the detector samples for
     *  a row scrolled out of the viewport. */
    private fun offScreen() = isNodeOnScreen(
        visibleWidthPx = NOTHING_SHOWING_PX,
        visibleHeightPx = NOTHING_SHOWING_PX,
        viewWidthPx = VIEW_WIDTH_PX,
        viewHeightPx = VIEW_HEIGHT_PX,
    )

    /** The same node fully within the viewport. */
    private fun onScreen() = isNodeOnScreen(
        visibleWidthPx = VIEW_WIDTH_PX,
        visibleHeightPx = VIEW_HEIGHT_PX,
        viewWidthPx = VIEW_WIDTH_PX,
        viewHeightPx = VIEW_HEIGHT_PX,
    )

    @Test
    fun `the countdown tick pauses while its row is off screen`() {
        assertFalse(countdownTickWhileOffScreen())
    }

    @Test
    fun `the countdown tick runs while its row is on screen`() {
        val active = isNodeTimerActive(onScreen = onScreen(), appForegrounded = true)
        assertTrue(countdownTickShouldRun(active = active, hiddenOnExpiry = false))
    }

    @Test
    fun `a countdown collapsed on expiry never ticks even while on screen`() {
        assertFalse(countdownTickShouldRun(active = true, hiddenOnExpiry = true))
    }

    // ---- consumer 2: carousel auto-advance ------------------------------

    private fun carouselDelayWhileOffScreen(stoppedAtEnd: Boolean = false) =
        carouselAutoAdvanceDelayMillis(
            active = isNodeTimerActive(onScreen = offScreen(), appForegrounded = true),
            stoppedAtEnd = stoppedAtEnd,
            autoAdvanceSeconds = 3.0,
            pageCount = 4,
        )

    private fun carouselDelayWhileOnScreen(stoppedAtEnd: Boolean = false) =
        carouselAutoAdvanceDelayMillis(
            active = isNodeTimerActive(onScreen = onScreen(), appForegrounded = true),
            stoppedAtEnd = stoppedAtEnd,
            autoAdvanceSeconds = 3.0,
            pageCount = 4,
        )

    @Test
    fun `carousel auto-advance pauses while the carousel is off screen`() {
        assertNull(carouselDelayWhileOffScreen())
    }

    @Test
    fun `carousel auto-advance resumes when the carousel comes back on screen`() {
        assertEquals(3000L, carouselDelayWhileOnScreen())
    }

    @Test
    fun `a loop-false carousel stopped at the end stays stopped across a pause and resume`() {
        // Pause: nothing scheduled, for either reason.
        assertNull(carouselDelayWhileOffScreen(stoppedAtEnd = true))
        // Resume: the stop latch outlives the pause — coming back on screen
        // must NOT restart a carousel that already reached its last page.
        assertNull(carouselDelayWhileOnScreen(stoppedAtEnd = true))
    }

    @Test
    fun `carousel auto-advance is off without a positive interval`() {
        assertNull(
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = null, pageCount = 4),
        )
        assertNull(
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = 0.0, pageCount = 4),
        )
        assertNull(
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = -1.0, pageCount = 4),
        )
    }

    @Test
    fun `carousel auto-advance is off with nothing to advance to`() {
        assertNull(
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = 3.0, pageCount = 1),
        )
        assertNull(
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = 3.0, pageCount = 0),
        )
    }

    @Test
    fun `a fractional auto-advance interval keeps its sub-second precision`() {
        assertEquals(
            1500L,
            carouselAutoAdvanceDelayMillis(active = true, stoppedAtEnd = false, autoAdvanceSeconds = 1.5, pageCount = 3),
        )
    }

    private companion object {
        /** A plausible laid-out node, in px. Any positive pair works; what is
         *  under test is measured-vs-not and how much of it is showing. */
        const val VIEW_WIDTH_PX = 300
        const val VIEW_HEIGHT_PX = 200

        /** What `View.getWidth()`/`getHeight()` report before the first layout
         *  pass — the fail-open case. */
        const val UNMEASURED_PX = 0

        /** No part of the node is in the viewport. Also what the detector
         *  substitutes when the platform reports no visible rect at all. */
        const val NOTHING_SHOWING_PX = 0

        /** A node scrolled almost all the way out: still visible, so still
         *  running. Deliberately unlike [VIEW_HEIGHT_PX] so this is a
         *  different input from full visibility and not merely a second
         *  spelling of it. */
        const val SLIVER_SHOWING_PX = 40

        /** The smallest visible extent the platform can report. */
        const val SINGLE_PIXEL_PX = 1

        /** `Rect.width()` is `right - left`, so a degenerate rect can measure
         *  negative — which is off screen, not "very on screen". */
        const val INVERTED_EXTENT_PX = -10
    }
}
