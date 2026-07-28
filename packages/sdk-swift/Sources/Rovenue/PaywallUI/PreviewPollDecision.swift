//
//  PreviewPollDecision.swift
//  Pure decision helper for `RovenuePaywallPreviewView`'s poll loop — no UI,
//  no I/O, fully unit-testable in isolation from the view. A poll only ever
//  triggers a re-bind when it comes back with a CONCRETE, DIFFERENT revision
//  string; a `nil` latest revision (paywall carries no revision stamp, or
//  the fetch failed to resolve one) must never be treated as a change.
//

enum PreviewPollDecision {
    case refetch
    case noChange
}

/// - Parameters:
///   - current: the `revision` of the paywall currently on screen.
///   - latest: the `revision` returned by the most recent poll.
/// - Returns: `.refetch` when `latest` is non-nil and differs from
///   `current`; `.noChange` otherwise (covers both-nil, equal, and
///   latest-nil cases).
func previewPollDecision(current: String?, latest: String?) -> PreviewPollDecision {
    guard let latest, latest != current else { return .noChange }
    return .refetch
}
