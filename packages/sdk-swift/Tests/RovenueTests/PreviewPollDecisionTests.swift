import XCTest
@testable import Rovenue

final class PreviewPollDecisionTests: XCTestCase {

    func test_previewPollDecision_bothNil_noChange() {
        XCTAssertEqual(previewPollDecision(current: nil, latest: nil), .noChange)
    }

    func test_previewPollDecision_sameRevision_noChange() {
        XCTAssertEqual(previewPollDecision(current: "a", latest: "a"), .noChange)
    }

    func test_previewPollDecision_differentRevision_refetch() {
        XCTAssertEqual(previewPollDecision(current: "a", latest: "b"), .refetch)
    }

    func test_previewPollDecision_latestNil_noChange() {
        // A poll that comes back with no revision info must never be
        // treated as a change — only a concrete, different revision string
        // triggers a re-bind.
        XCTAssertEqual(previewPollDecision(current: "a", latest: nil), .noChange)
    }
}
