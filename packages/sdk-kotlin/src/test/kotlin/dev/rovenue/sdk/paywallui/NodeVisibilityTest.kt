package dev.rovenue.sdk.paywallui

import android.graphics.Rect
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The one rule every time-driven node answers to: is this node on screen
 * right now, and is the app in front?
 *
 * SCOPE NOTE — what a JVM unit test can and cannot pin here. Under the
 * mockable `android.jar` (`isReturnDefaultValues = true`) every `Rect`
 * accessor is inert: `Rect(0, 0, 300, 200)` constructs with all four fields
 * left at `0`, `width()`/`height()` return `0`, and `isEmpty()` returns the
 * default `false`. So these tests pin the two branches that are decidable
 * off-device — an unmeasured view fails open, and a view the platform
 * reports no visible rect for is off screen — plus the composition of the
 * predicate with the foreground signal and with each consumer's own latch.
 * Whether `getLocalVisibleRect` and `OnScrollChangedListener` produce real
 * rects at real moments is device-only; see [NodeVisibilityDetector].
 */
class NodeVisibilityTest {

    // ---- the pure predicate -------------------------------------------

    @Test
    fun `a fully visible view is on screen`() {
        assertTrue(isNodeOnScreen(Rect(0, 0, 300, 200), viewWidth = 300, viewHeight = 200))
    }

    @Test
    fun `a view with no visible rect is off screen`() {
        assertFalse(isNodeOnScreen(null, viewWidth = 300, viewHeight = 200))
    }

    @Test
    fun `a partially visible view counts as on screen`() {
        assertTrue(isNodeOnScreen(Rect(0, 0, 300, 40), viewWidth = 300, viewHeight = 200))
    }

    @Test
    fun `an unmeasured view fails open`() {
        assertTrue(isNodeOnScreen(null, viewWidth = 0, viewHeight = 0))
    }

    @Test
    fun `a view measured in only one dimension still fails open`() {
        assertTrue(isNodeOnScreen(null, viewWidth = 300, viewHeight = 0))
        assertTrue(isNodeOnScreen(null, viewWidth = 0, viewHeight = 200))
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
        active = isNodeTimerActive(
            onScreen = isNodeOnScreen(null, viewWidth = 300, viewHeight = 200),
            appForegrounded = true,
        ),
        hiddenOnExpiry = false,
    )

    @Test
    fun `the countdown tick pauses while its row is off screen`() {
        assertFalse(countdownTickWhileOffScreen())
    }

    @Test
    fun `the countdown tick runs while its row is on screen`() {
        val active = isNodeTimerActive(
            onScreen = isNodeOnScreen(Rect(0, 0, 300, 200), viewWidth = 300, viewHeight = 200),
            appForegrounded = true,
        )
        assertTrue(countdownTickShouldRun(active = active, hiddenOnExpiry = false))
    }

    @Test
    fun `a countdown collapsed on expiry never ticks even while on screen`() {
        assertFalse(countdownTickShouldRun(active = true, hiddenOnExpiry = true))
    }

    // ---- consumer 2: carousel auto-advance ------------------------------

    private fun carouselDelayWhileOffScreen(stoppedAtEnd: Boolean = false) =
        carouselAutoAdvanceDelayMillis(
            active = isNodeTimerActive(
                onScreen = isNodeOnScreen(null, viewWidth = 300, viewHeight = 200),
                appForegrounded = true,
            ),
            stoppedAtEnd = stoppedAtEnd,
            autoAdvanceSeconds = 3.0,
            pageCount = 4,
        )

    private fun carouselDelayWhileOnScreen(stoppedAtEnd: Boolean = false) =
        carouselAutoAdvanceDelayMillis(
            active = isNodeTimerActive(
                onScreen = isNodeOnScreen(Rect(0, 0, 300, 200), viewWidth = 300, viewHeight = 200),
                appForegrounded = true,
            ),
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
}
