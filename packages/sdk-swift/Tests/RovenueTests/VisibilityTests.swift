//  VisibilityTests.swift
//  Mirrors packages/shared/src/paywall/visibility.test.ts and
//  packages/sdk-rn/src/paywall-ui/__tests__/visibility.test.ts /
//  packages/sdk-kotlin/.../paywallui/VisibilityTest.kt verbatim (including
//  every FAILS OPEN case) — the Swift evaluator must agree with the
//  shared implementation and the RN/Kotlin siblings exactly. See
//  BuilderConfigModelTests.swift for the cross-platform render-fixtures.json
//  `visibility` vector conformance proof.

import XCTest
@testable import Rovenue

final class VisibilityTests: XCTestCase {
    // MARK: - compareVersions

    func test_comparesComponentWise_notLexically() {
        XCTAssertGreaterThan(compareVersions("1.10.0", "1.9.0")!, 0)
        XCTAssertLessThan(compareVersions("1.9.0", "1.10.0")!, 0)
    }

    func test_treatsMissingComponentsAsZero() {
        XCTAssertEqual(compareVersions("1.2", "1.2.0"), 0)
        XCTAssertEqual(compareVersions("2", "2.0.0"), 0)
    }

    func test_looksAtALongerVersionsExtraComponents() {
        // Every other differing-length case here pads with zeros, so a
        // `min`-of-lengths implementation would pass them all. This one
        // would not.
        XCTAssertGreaterThan(compareVersions("1.2.5", "1.2")!, 0)
        XCTAssertLessThan(compareVersions("1.2", "1.2.5")!, 0)
    }

    func test_staysExactPastTheSafeIntegerRange() {
        XCTAssertGreaterThan(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")!, 0)
    }

    func test_refusesToGuessAtANonNumericComponent() {
        XCTAssertNil(compareVersions("1.0.0-beta", "1.0.0"))
        XCTAssertNil(compareVersions("2024.spring", "2024.1"))
    }

    // MARK: - isNodeVisible

    private let ios = "ios"
    private let version2 = "2.0.0"

    func test_showsANodeWithNoVisibilityRulesAtAll() {
        XCTAssertTrue(isNodeVisible(nil, platform: ios, appVersion: version2))
        XCTAssertTrue(isNodeVisible(Visibility(), platform: ios, appVersion: version2))
    }

    func test_honoursAPlatformList() {
        XCTAssertTrue(isNodeVisible(Visibility(platform: ["ios"]), platform: ios, appVersion: version2))
        XCTAssertFalse(isNodeVisible(Visibility(platform: ["android", "web"]), platform: ios, appVersion: version2))
    }

    func test_FAILS_OPEN_onAnEmptyPlatformList_itMeansNoConstraintNotNowhere() {
        XCTAssertTrue(isNodeVisible(Visibility(platform: []), platform: ios, appVersion: version2))
    }

    func test_FAILS_OPEN_whenTheRendererDoesNotKnowItsPlatform() {
        XCTAssertTrue(isNodeVisible(Visibility(platform: ["android"]), platform: nil, appVersion: version2))
    }

    func test_honoursBothVersionBoundsInclusively() {
        XCTAssertTrue(isNodeVisible(Visibility(minAppVersion: "2.0.0"), platform: ios, appVersion: version2))
        XCTAssertFalse(isNodeVisible(Visibility(minAppVersion: "2.0.1"), platform: ios, appVersion: version2))
        XCTAssertTrue(isNodeVisible(Visibility(maxAppVersion: "2.0.0"), platform: ios, appVersion: version2))
        XCTAssertFalse(isNodeVisible(Visibility(maxAppVersion: "1.9.9"), platform: ios, appVersion: version2))
        XCTAssertTrue(isNodeVisible(
            Visibility(minAppVersion: "1.0.0", maxAppVersion: "3.0.0"), platform: ios, appVersion: version2))
    }

    func test_FAILS_OPEN_whenTheAppVersionIsUnknown() {
        XCTAssertTrue(isNodeVisible(Visibility(minAppVersion: "99.0.0"), platform: ios, appVersion: nil))
        XCTAssertTrue(isNodeVisible(Visibility(maxAppVersion: "0.0.1"), platform: ios, appVersion: nil))
    }

    func test_FAILS_OPEN_whenAVersionCannotBeCompared() {
        XCTAssertTrue(isNodeVisible(Visibility(minAppVersion: "99.0.0"), platform: ios, appVersion: "1.0.0-beta"))
    }

    func test_hidesAsSoonAsAnyApplicableRuleSaysHide() {
        XCTAssertFalse(isNodeVisible(
            Visibility(platform: ["ios"], minAppVersion: "3.0.0"), platform: ios, appVersion: version2))
        XCTAssertFalse(isNodeVisible(
            Visibility(platform: ["android"], minAppVersion: "1.0.0"), platform: ios, appVersion: version2))
    }
}
