//
//  RovenuePaywallLottie.swift
//  The host's registered Lottie player, and the request handed to it.
//
//  This SDK ships NO Lottie runtime of its own — no `lottie-ios` in
//  Package.swift, and none is added by this wave. A `lottie` node is drawn by
//  whichever player the host app already ships, registered once at startup
//  through `registerLottieRenderer`. With nothing registered a `lottie` node
//  renders its `fallback`, else nothing: the same contract every other node
//  type already has for "cannot draw this", not a new failure mode.
//
//  The five fields of `LottieRenderRequest` are the cross-platform contract —
//  byte-for-byte the props of packages/paywall-renderer's `LottieRenderer`
//  (url/loop/autoplay/speed/playing), and the same five the Kotlin sibling
//  carries. `playing` rides the SHARED visibility signal (NodeVisibility.swift)
//  that `countdown`, `carousel` and `video` all consume, so a host player that
//  honours it pauses off screen for free.
//

import Foundation
import SwiftUI

/// Everything a host's Lottie player needs for one `lottie` node.
///
/// `Equatable` so a test can pin the RESOLVED request by value — which
/// defaults were substituted, and which theme half of `url` won — rather than
/// merely that some request arrived.
public struct LottieRenderRequest: Equatable, Sendable {
    /// The resolved, theme-picked animation URL. A `lottie` node whose URL
    /// does not parse produces no request at all (and so falls back), rather
    /// than handing the host a string it cannot use.
    public let url: URL
    public let loop: Bool
    public let autoplay: Bool
    public let speed: Double
    /// The shared "is this node on screen AND the app in front" verdict — see
    /// NodeVisibility.swift. Not the same question as `autoplay`, which is the
    /// author's instruction; this is the moment-to-moment one.
    public let playing: Bool

    public init(url: URL, loop: Bool, autoplay: Bool, speed: Double, playing: Bool) {
        self.url = url
        self.loop = loop
        self.autoplay = autoplay
        self.speed = speed
        self.playing = playing
    }
}

/// A host's Lottie player: one request in, one view out. Returning an
/// `AnyView` wrapping `EmptyView()` is a legitimate "draw nothing right now".
public typealias LottieRenderer = (LottieRenderRequest) -> AnyView

/// PROCESS-LEVEL state, deliberately: the host registers its player once, well
/// before any paywall is presented, so this is not per-view configuration.
///
/// Which also means it LEAKS ACROSS TESTS — every test that registers a
/// renderer must reset it (`registerLottieRenderer(nil)`) in `tearDown`, the
/// same warning the web sibling carries on its module-level `lottieRenderer`.
///
/// Held on an enum rather than as a bare global `var` to match this SDK's
/// existing shared-state shape (`Rovenue.logHandlers`).
enum LottieRendererRegistry {
    static var current: LottieRenderer?
}

/// Register (or, with `nil`, unregister) the host's Lottie player.
public func registerLottieRenderer(_ render: LottieRenderer?) {
    LottieRendererRegistry.current = render
}

/// The resolved request for `props`, or `nil` when the node's URL does not
/// parse. Pure, and separate from `lottieContentView` below, so the DEFAULT
/// RESOLUTION (`loop`/`autoplay`/`speed` falling back to the mirrored
/// schema.ts constants, and which theme half of `url` wins) is testable
/// without registering anything — a SwiftUI view's body is not inspectable in
/// this package, so a rule that lived only inside the view would be untestable.
func lottieRenderRequest(props: LottieProps, playing: Bool, dark: Bool = false) -> LottieRenderRequest? {
    guard let url = URL(string: themeValue(props.url, dark: dark)) else { return nil }
    return LottieRenderRequest(
        url: url,
        loop: props.loop ?? lottieDefaultLoop,
        autoplay: props.autoplay ?? lottieDefaultAutoplay,
        speed: props.speed ?? lottieDefaultSpeed,
        playing: playing)
}

/// What a `lottie` node draws right now, or `nil` when it draws nothing — no
/// registered player, or an unparsable URL. `nil` is what routes the node onto
/// the ordinary `fallback`-else-nothing path in `LottieView`; this function
/// deliberately does not know about `fallback` itself, so the one place that
/// decides "fall back" stays the one place every other node type uses.
func lottieContentView(props: LottieProps, playing: Bool, dark: Bool = false) -> AnyView? {
    guard let render = LottieRendererRegistry.current,
          let request = lottieRenderRequest(props: props, playing: playing, dark: dark)
    else { return nil }
    return render(request)
}

/// Whether a `lottie` node has anything at all to draw, WITHOUT invoking the
/// host's player.
///
/// Asked ahead of mounting by `nodeRendersContent` (a carousel decides its
/// pages before its children exist), which is exactly why it must not go
/// through `lottieContentView`: building a view is the host's side effect, and
/// a predicate must not cause one. Unlike a video's load failure, this is
/// decidable synchronously — registration is process state and the URL is in
/// hand — so an unregistered lottie inside a carousel costs no phantom dot.
func lottieCanRender(_ props: LottieProps, dark: Bool) -> Bool {
    LottieRendererRegistry.current != nil && URL(string: themeValue(props.url, dark: dark)) != nil
}
