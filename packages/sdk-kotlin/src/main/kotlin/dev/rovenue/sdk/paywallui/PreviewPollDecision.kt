package dev.rovenue.sdk.paywallui

/**
 * Pure decision helper for [RovenuePaywallPreviewView]'s poll loop — no UI,
 * no I/O, fully unit-testable in isolation from the view. A poll only ever
 * triggers a re-bind when it comes back with a CONCRETE, DIFFERENT revision
 * string; a `null` latest revision (paywall carries no revision stamp, or
 * the fetch failed to resolve one) must never be treated as a change.
 * Mirrors the Swift sibling (`PreviewPollDecision.swift`) exactly.
 */
enum class PreviewPollDecision {
    REFETCH,
    NO_CHANGE,
}

/**
 * @param current the `revision` of the paywall currently on screen.
 * @param latest the `revision` returned by the most recent poll.
 * @return [PreviewPollDecision.REFETCH] when [latest] is non-null and
 *   differs from [current]; [PreviewPollDecision.NO_CHANGE] otherwise
 *   (covers both-null, equal, and latest-null cases).
 */
fun previewPollDecision(current: String?, latest: String?): PreviewPollDecision =
    if (latest != null && latest != current) PreviewPollDecision.REFETCH else PreviewPollDecision.NO_CHANGE
