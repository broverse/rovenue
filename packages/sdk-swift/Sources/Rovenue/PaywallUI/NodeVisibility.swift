//
//  NodeVisibility.swift
//  ONE rule for every time-driven node: a `countdown`'s clock, a
//  `carousel`'s auto-advance — and anything the media wave adds — runs only
//  while the node is actually on screen AND the app is in front. Spec §5
//  rule 1, "off-screen means paused".
//
//  This is NOT the `visibility` gate in Visibility.swift, which answers a
//  different question (does this node render on this platform/app version at
//  all). This file answers "is the node the reader is looking at right now".
//
//  The web renderer gets this from `IntersectionObserver`
//  (packages/paywall-renderer's node-visibility hook). SwiftUI has no
//  equivalent, so it is assembled from two primitives:
//
//  - a `GeometryReader` background on the node, reporting the node's frame in
//    a NAMED coordinate space anchored on the paywall's scroll viewport
//    (`paywallViewportCoordinateSpaceName`, established in
//    `RovenuePaywallView.content(_:)`), compared against that viewport's own
//    frame, which the same place publishes through
//    `EnvironmentValues.paywallViewportFrame`;
//  - `scenePhase`, for the app-in-front half.
//
//  The pure DECISION (`isNodeOnScreen` / `isNodeRunning`) is deliberately
//  kept apart from that plumbing: the decision is unit-testable on any
//  platform and is pinned in PaywallRenderSupportTests, while whether SwiftUI
//  ever hands the modifier a real rect is only observable on a device and
//  stays a smoke item. Do not fold the two back together — a predicate buried
//  in a `ViewModifier` body is a rule nothing can check.
//
//  The governing rule, as everywhere else in this renderer, is FAIL OPEN.
//  Before first layout the viewport is `.zero` and the node's frame is
//  `.zero`; both resolve to ON SCREEN. A stopped clock is a worse failure
//  than a running one, and the web renderer documents the same default (with
//  no `IntersectionObserver` available, the node counts as visible).
//

import Foundation
import SwiftUI

/// The paywall's scroll-viewport coordinate space. Node frames are measured
/// in it, so a node's `minY` is its offset from the TOP OF THE VIEWPORT (it
/// goes negative as the reader scrolls past it), not from the top of the
/// scrolled content — which is what makes comparing against the viewport
/// rect meaningful at all.
let paywallViewportCoordinateSpaceName = "rovenue.paywall.viewport"

/// How much of a node must fall inside the viewport before it counts as on
/// screen, in points. One point: the rule is "any of it is showing", matching
/// the web hook's default `threshold: 0` (fire as soon as a single pixel
/// intersects) rather than an "at least half visible" rule, which would pause
/// a tall node the reader is already reading.
///
/// Named rather than inlined at the comparison — a bare `1` in a geometry
/// test reads as an off-by-one guard, not as a policy anyone chose.
let nodeOnScreenMinimumIntersectionPoints: CGFloat = 1.0

/// Everything the run/pause decision depends on, in one value, so the
/// decision stays a pure function of it and the modifier's only job is
/// keeping it current.
///
/// `unknown` is the pre-layout value every consumer starts from: no measured
/// node frame, no viewport, app assumed in front. It resolves to RUNNING —
/// see the fail-open note at the top of this file.
struct NodeVisibilityState: Equatable {
    var nodeFrame: CGRect
    var viewportFrame: CGRect
    var appIsForeground: Bool

    static let unknown = NodeVisibilityState(
        nodeFrame: .zero, viewportFrame: .zero, appIsForeground: true)
}

/// The pure geometry decision: does `nodeFrame` show inside `viewportFrame`?
/// Both rects are in the same (viewport-anchored) coordinate space.
///
/// Fails open on a viewport with no area — that is the state before first
/// layout, and also what a host that never establishes the paywall's
/// environment value leaves behind (an ordinary node rendered outside
/// `RovenuePaywallView`, say). Treating it as off-screen would stop every
/// timer at launch, which is exactly the bug this whole mechanism exists to
/// avoid causing.
///
/// A node with no area of its own also fails open, for the same reason: a
/// node that has not laid out yet reports `.zero`, and "we cannot tell yet"
/// must never read as "off screen". The `min(...)` is what does that — the
/// requirement is one point of intersection OR the node's whole extent,
/// whichever is smaller.
func isNodeOnScreen(nodeFrame: CGRect, viewportFrame: CGRect) -> Bool {
    guard viewportFrame.width > 0, viewportFrame.height > 0 else { return true }
    let intersection = nodeFrame.intersection(viewportFrame)
    // `.intersection` returns the NULL rect for disjoint rects — a sentinel
    // whose components are infinite, so it must be checked before any
    // arithmetic reads them.
    guard !intersection.isNull else { return false }
    let requiredWidth = min(nodeOnScreenMinimumIntersectionPoints, nodeFrame.width)
    let requiredHeight = min(nodeOnScreenMinimumIntersectionPoints, nodeFrame.height)
    return intersection.width >= requiredWidth && intersection.height >= requiredHeight
}

/// The whole rule: on screen AND the app in front. Every time-driven node
/// asks this one question — a second implementation of it anywhere is the
/// failure this file exists to prevent.
func isNodeRunning(_ state: NodeVisibilityState) -> Bool {
    state.appIsForeground
        && isNodeOnScreen(nodeFrame: state.nodeFrame, viewportFrame: state.viewportFrame)
}

/// Measures the node it is applied to and reports a fresh
/// `NodeVisibilityState` whenever any input changes: the node's frame (it
/// scrolled), the viewport's frame (rotation/resize), or the app's scene
/// phase.
///
/// The modifier NEVER decides anything itself; it hands the state to the
/// consumer, which combines it with its own preconditions (a carousel also
/// needs an interval, more than one page, and an unset stop latch). That
/// split is what lets each consumer's run/pause rule be a tested pure
/// function.
///
/// `appIsForeground` starts `true` and is only ever updated from a CHANGE of
/// `scenePhase`, never from its initial value. A SwiftUI view hosted from
/// UIKit without a scene publishing a phase would otherwise read a stale
/// non-active value and disable every timer outright; reacting to changes
/// only degrades to "always in front" there instead. This preserves the exact
/// behaviour `CarouselView` had before the two consumers moved onto this
/// modifier.
struct NodeVisibilityModifier: ViewModifier {
    let onChange: (NodeVisibilityState) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.paywallViewportFrame) private var viewportFrame

    @State private var nodeFrame: CGRect = .zero
    @State private var appIsForeground = true

    func body(content: Content) -> some View {
        content
            // A background `GeometryReader` measures WITHOUT affecting the
            // node's own layout — wrapping the node in one instead would hand
            // it the parent's full proposed size and resize the paywall.
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: NodeFrameKey.self,
                        value: proxy.frame(in: .named(paywallViewportCoordinateSpaceName)))
                }
            )
            .onPreferenceChange(NodeFrameKey.self) { frame in
                nodeFrame = frame
                publish(nodeFrame: frame)
            }
            .onChange(of: viewportFrame) { newViewport in
                publish(viewportFrame: newViewport)
            }
            .onChange(of: scenePhase) { phase in
                let foreground = phase == .active
                appIsForeground = foreground
                publish(appIsForeground: foreground)
            }
            // The first report: a node that lays out entirely on screen and
            // never moves again produces no preference CHANGE after its
            // initial one, so consumers would otherwise sit on
            // `NodeVisibilityState.unknown` forever. Harmless that it does —
            // `unknown` runs — but the state the consumer holds should be the
            // real one from the start.
            .onAppear { publish() }
    }

    /// Each caller passes the value IT just changed and reads the others from
    /// storage, so nothing depends on a `@State` write being visible to a
    /// read in the same turn.
    private func publish(
        nodeFrame: CGRect? = nil, viewportFrame: CGRect? = nil, appIsForeground: Bool? = nil
    ) {
        onChange(NodeVisibilityState(
            nodeFrame: nodeFrame ?? self.nodeFrame,
            viewportFrame: viewportFrame ?? self.viewportFrame,
            appIsForeground: appIsForeground ?? self.appIsForeground))
    }
}

extension View {
    /// Applies `NodeVisibilityModifier`. Spelled as a `View` extension so a
    /// consumer reads `.nodeVisibility { ... }` alongside its other
    /// lifecycle modifiers.
    func nodeVisibility(_ onChange: @escaping (NodeVisibilityState) -> Void) -> some View {
        modifier(NodeVisibilityModifier(onChange: onChange))
    }
}

/// The node's own frame, in the paywall viewport's coordinate space.
private struct NodeFrameKey: PreferenceKey {
    /// `let`, not `var`, for the same reason as `StickyFooterHeightKey`: a
    /// mutable static on a `PreferenceKey` is shared global state nothing
    /// writes, and it trips Swift 6 strict concurrency.
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

/// The paywall's scroll viewport, in its OWN coordinate space — i.e. origin
/// `.zero`, size the visible scroll area. Published by
/// `RovenuePaywallView.content(_:)`, which is the only place that knows it.
///
/// `.zero` by default, and that default is load-bearing: any node rendered
/// outside a `RovenuePaywallView` (a host embedding a node view directly, a
/// preview) gets it, and `isNodeOnScreen` fails open on it.
private struct PaywallViewportFrameKey: EnvironmentKey {
    static let defaultValue: CGRect = .zero
}

extension EnvironmentValues {
    var paywallViewportFrame: CGRect {
        get { self[PaywallViewportFrameKey.self] }
        set { self[PaywallViewportFrameKey.self] = newValue }
    }
}
