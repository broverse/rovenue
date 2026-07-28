//  PaywallMediaSourceTests.swift — THE three-platform media-source contract.
//
//  The table below is the deliverable. The same five inputs with the same five
//  answers are asserted in packages/paywall-renderer's `renderer.test.tsx`
//  ("media source usability — the three-platform table") and in sdk-kotlin's
//  `NodeViewFactoryTest.kt`. If the three files ever disagree, the divergence
//  this table exists to kill has come back.
//
//  A separate file from PaywallRenderSupportTests.swift on purpose: it needs
//  no render context, so the rule is exercised as the pure function it is. It
//  can safely `import SwiftUI` (which PaywallRenderSupportTests.swift cannot —
//  SwiftUI ships its own `Visibility`) because it never names this SDK's
//  `Visibility`.

import SwiftUI
import XCTest
@testable import Rovenue

final class PaywallMediaSourceTests: XCTestCase {
    /// One row of the contract: an authored source, and whether it is usable.
    private struct SourceUsabilityCase {
        let source: String
        let usable: Bool
    }

    /// THE CONTRACT. Note the two rows that are deliberately USABLE despite
    /// not being valid URLs — syntax is the platform's business at LOAD time,
    /// where the failure takes the ordinary route to `fallback`. Pinning this
    /// to what URL parsers agree on is exactly what broke before: this
    /// platform's `URL(string:)` accepts `" "`, Android's `Uri` rule rejected
    /// `"not a url"`, and this platform's own answer changed between CFURL
    /// (pre-iOS 17) and the RFC-3986 parser that replaced it.
    private let sourceUsabilityTable: [SourceUsabilityCase] = [
        SourceUsabilityCase(source: "", usable: false),
        SourceUsabilityCase(source: " ", usable: false),
        SourceUsabilityCase(source: "a/b.mp4", usable: true),
        SourceUsabilityCase(source: "not a url", usable: true),
        SourceUsabilityCase(source: "https://x/a.mp4", usable: true),
    ]

    /// The rule itself, on the shared helper every caller goes through.
    func test_theMediaSourceRuleIsTrimThenNonBlank() {
        for row in sourceUsabilityTable {
            XCTAssertEqual(
                mediaSourceIsUsable(row.source), row.usable,
                "\(String(reflecting: row.source)) must be \(row.usable ? "usable" : "unusable")")
        }
    }

    /// The demonstration that the rule is NOT `URL(string:)`, kept as a live
    /// assertion rather than a comment: this platform's parser accepts `" "`,
    /// which the rule rejects. If a future OS ever changed that, this test
    /// would tell us the comment above had gone stale — it does not make the
    /// rule depend on the parser, it only records that they differ.
    func test_theRuleIsDeliberatelyNotWhatTheUrlParserSays() {
        XCTAssertNotNil(
            URL(string: " "), "URL(string:) accepting a blank is the whole reason for the rule")
        XCTAssertFalse(mediaSourceIsUsable(" "), "the rule must reject it regardless")
    }

    /// The same answers, reached through `video`'s caller — so the table is
    /// not merely a property of a helper nobody consults.
    func test_videoAsksExactlyThisRule() {
        for row in sourceUsabilityTable {
            let props = VideoProps(id: "v1", url: ThemePair(light: row.source, dark: nil))
            XCTAssertEqual(
                videoHasUsableSource(props, dark: false), row.usable,
                "video: \(String(reflecting: row.source))")
        }
    }

    /// And through `lottie`'s caller, with a player registered so the
    /// REGISTRATION half is true and only the source half can move the answer.
    /// One helper serves both node types, as on web and Android.
    func test_lottieAsksExactlyTheSameRule() {
        registerLottieRenderer { _ in AnyView(EmptyView()) }
        defer { registerLottieRenderer(nil) }
        for row in sourceUsabilityTable {
            let props = LottieProps(id: "l1", url: ThemePair(light: row.source, dark: nil))
            XCTAssertEqual(
                lottieCanRender(props, dark: false), row.usable,
                "lottie: \(String(reflecting: row.source))")
        }
    }
}
