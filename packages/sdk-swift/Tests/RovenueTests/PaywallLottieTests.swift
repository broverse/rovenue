//  PaywallLottieTests.swift — the `lottie` node's registration point
//  (RovenuePaywallLottie.swift) and the five-field request that IS the
//  cross-platform contract with the web renderer's `LottieRenderer` props.
//
//  A separate file from PaywallRenderSupportTests.swift for one concrete
//  reason: a host's renderer returns a SwiftUI `AnyView`, so this file must
//  `import SwiftUI` — and SwiftUI declares its own unrelated `Visibility`,
//  which makes the bare name ambiguous in any file that also names this SDK's
//  `Visibility`. `Rovenue.Visibility` is not a way out either: the module and
//  a class inside it share the name `Rovenue`, so the qualified lookup finds
//  the class.

import SwiftUI
import XCTest
@testable import Rovenue

final class PaywallLottieTests: XCTestCase {
    /// `registerLottieRenderer` is PROCESS-LEVEL state — the host registers a
    /// player once at startup — which means it LEAKS ACROSS TESTS. This reset
    /// is what its own doc comment demands.
    override func tearDown() {
        registerLottieRenderer(nil)
        super.tearDown()
    }

    private var bareLottieProps: LottieProps {
        LottieProps(id: "l1", url: ThemePair(light: "https://x/a.json", dark: nil))
    }

    func test_aLottieNodeWithNoRegisteredRendererHasNothingToDraw() throws {
        registerLottieRenderer(nil)
        XCTAssertNil(lottieContentView(props: bareLottieProps, playing: true))
    }

    /// The five fields ARE the contract, so this asserts the RESOLVED values a
    /// host actually receives — every default substituted, the light URL
    /// picked — not merely that some request arrived.
    func test_aRegisteredRendererReceivesTheResolvedDefaults() throws {
        var received: LottieRenderRequest?
        registerLottieRenderer { request in
            received = request
            return AnyView(EmptyView())
        }
        XCTAssertNotNil(lottieContentView(props: bareLottieProps, playing: true))
        let request = try XCTUnwrap(received, "a registered renderer must be invoked")
        XCTAssertEqual(request.url, URL(string: "https://x/a.json"))
        XCTAssertEqual(request.loop, lottieDefaultLoop)
        XCTAssertEqual(request.autoplay, lottieDefaultAutoplay)
        XCTAssertEqual(request.speed, lottieDefaultSpeed)
        XCTAssertTrue(request.playing)
    }

    /// Authored values reach the host untouched — including a `speed` outside
    /// LOTTIE_MIN_SPEED...LOTTIE_MAX_SPEED, which is authoring-time advice and
    /// NOT a clamp on any platform.
    func test_authoredLottieValuesReachTheRendererUnclamped() throws {
        var received: LottieRenderRequest?
        registerLottieRenderer { request in
            received = request
            return AnyView(EmptyView())
        }
        let props = LottieProps(
            id: "l1", url: ThemePair(light: "https://x/a.json", dark: "https://x/dark.json"),
            loop: false, autoplay: false, speed: lottieMaxSpeed + 1)
        _ = lottieContentView(props: props, playing: false, dark: true)
        let request = try XCTUnwrap(received)
        XCTAssertEqual(request.url, URL(string: "https://x/dark.json"), "the dark half must win in dark mode")
        XCTAssertFalse(request.loop)
        XCTAssertFalse(request.autoplay)
        XCTAssertEqual(request.speed, lottieMaxSpeed + 1, "speed is advice, never clamped")
        XCTAssertFalse(request.playing)
    }

    /// A source the shared rule rejects produces no request at all, so the
    /// node takes the same `fallback`-else-nothing path as an unregistered
    /// player — never a request the host cannot use. `" "` is the row that
    /// used to diverge: `URL(string: " ")` is non-nil, so before the rule was
    /// shared this platform built a request for it.
    ///
    /// The answers themselves are pinned input-for-input against web and
    /// Android in `PaywallMediaSourceTests.swift`.
    func test_aLottieWithNoUsableSourceProducesNoRequest() {
        registerLottieRenderer { _ in AnyView(EmptyView()) }
        for blank in ["", " "] {
            let props = LottieProps(id: "l1", url: ThemePair(light: blank, dark: nil))
            XCTAssertNil(lottieRenderRequest(props: props, playing: true), blank)
            XCTAssertNil(lottieContentView(props: props, playing: true), blank)
        }
    }

    /// The relaxed half, and the reason this file no longer asks a URL parser
    /// anything: a source that is present but not a valid URL is USABLE. It
    /// reaches the host, which fails to load it and takes the ordinary error
    /// path — exactly as a video's clip does.
    func test_aPresentButMalformedLottieSourceStillReachesTheHost() throws {
        var received: LottieRenderRequest?
        registerLottieRenderer { request in
            received = request
            return AnyView(EmptyView())
        }
        let props = LottieProps(id: "l1", url: ThemePair(light: "not a url", dark: nil))
        XCTAssertTrue(lottieCanRender(props, dark: false))
        _ = lottieContentView(props: props, playing: true)
        XCTAssertEqual(try XCTUnwrap(received).url, URL(string: "not a url"))
    }

    /// `playing` rides the SHARED visibility signal (NodeVisibility.swift)
    /// that `countdown`, `carousel` and `video` all consume — one rule for
    /// every time-driven node is this wave's central claim, and this is the
    /// lottie half of it. Asserted through `isNodeRunning`, the same function
    /// `LottieNodeView` passes into `lottieContentView`.
    func test_lottiePlayingRidesTheSharedVisibilitySignal() throws {
        for (state, expected) in [(onScreenState(), true), (offScreenState(), false),
                                  (onScreenState(appIsForeground: false), false)] {
            var received: LottieRenderRequest?
            registerLottieRenderer { request in
                received = request
                return AnyView(EmptyView())
            }
            _ = lottieContentView(props: bareLottieProps, playing: isNodeRunning(state))
            XCTAssertEqual(try XCTUnwrap(received).playing, expected)
        }
    }

    /// An unregistered lottie with no fallback draws nothing, so a carousel
    /// must not give it a page — and therefore no dot either (wave D1's rule).
    /// Decidable synchronously, unlike a video's load failure.
    func test_anUndrawableLottieIsNotACarouselPage() throws {
        let ctx = try makeCtx()
        registerLottieRenderer(nil)
        XCTAssertFalse(nodeRendersContent(.lottie(bareLottieProps), ctx: ctx, cell: nil))
        registerLottieRenderer { _ in AnyView(EmptyView()) }
        XCTAssertTrue(nodeRendersContent(.lottie(bareLottieProps), ctx: ctx, cell: nil))
    }

    /// ...but an undrawable lottie WITH a fallback that draws is still a page:
    /// the fallback is what occupies it. Same rule every other node type has.
    func test_anUndrawableLottieWithAFallbackIsStillACarouselPage() throws {
        let ctx = try makeCtx()
        registerLottieRenderer(nil)
        let withFallback = LottieProps(
            id: "l1", url: ThemePair(light: "https://x/a.json", dark: nil),
            fallback: BuilderNodeBox(node: .text(TextProps(id: "t1", key: "k", role: .body))))
        XCTAssertTrue(nodeRendersContent(.lottie(withFallback), ctx: ctx, cell: nil))
    }

    // MARK: - helpers

    /// The same 300x600 stand-in for the paywall's scroll viewport the
    /// countdown/carousel visibility cases use.
    private var testViewportFrame: CGRect { CGRect(x: 0, y: 0, width: 300, height: 600) }

    private func onScreenState(appIsForeground: Bool = true) -> NodeVisibilityState {
        NodeVisibilityState(
            nodeFrame: CGRect(x: 0, y: 100, width: 300, height: 200),
            viewportFrame: testViewportFrame, appIsForeground: appIsForeground)
    }

    private func offScreenState(appIsForeground: Bool = true) -> NodeVisibilityState {
        NodeVisibilityState(
            nodeFrame: CGRect(x: 0, y: -300, width: 300, height: 200),
            viewportFrame: testViewportFrame, appIsForeground: appIsForeground)
    }

    private func makeCtx(dark: Bool = false) throws -> PaywallRenderContext {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
         "root":{"type":"stack","id":"root","axis":"v","children":[]}}
        """
        let config = try JSONDecoder().decode(BuilderConfigModel.self, from: Data(json.utf8))
        return PaywallRenderContext(
            config: config, locale: "en", dark: dark, offering: nil,
            selectedPackageId: nil, isPurchasing: false,
            select: { _ in }, purchase: {},
            onClose: nil, onRestore: nil, onUrl: nil,
            appVersion: nil, paywallIdentifier: nil
        )
    }
}
