package dev.rovenue.sdk.paywallui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Pure decision helper for [RovenuePaywallPreviewView]'s poll loop — no UI,
 * no I/O, mirrors the Swift `PreviewPollDecisionTests` exactly. A poll only
 * ever triggers a re-bind when it comes back with a CONCRETE, DIFFERENT
 * revision string; a `null` latest revision (paywall carries no revision
 * stamp, or the fetch failed to resolve one) must never be treated as a
 * change.
 */
class PreviewPollDecisionTest {

    @Test
    fun `both null is no change`() {
        assertEquals(PreviewPollDecision.NO_CHANGE, previewPollDecision(current = null, latest = null))
    }

    @Test
    fun `same revision is no change`() {
        assertEquals(PreviewPollDecision.NO_CHANGE, previewPollDecision(current = "a", latest = "a"))
    }

    @Test
    fun `different revision is refetch`() {
        assertEquals(PreviewPollDecision.REFETCH, previewPollDecision(current = "a", latest = "b"))
    }

    @Test
    fun `latest null is no change`() {
        // A poll that comes back with no revision info must never be
        // treated as a change — only a concrete, different revision string
        // triggers a re-bind.
        assertEquals(PreviewPollDecision.NO_CHANGE, previewPollDecision(current = "a", latest = null))
    }
}
