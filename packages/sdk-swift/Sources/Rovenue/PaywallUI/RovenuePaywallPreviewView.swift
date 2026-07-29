//
//  RovenuePaywallPreviewView.swift
//  On-device preview of an unpublished paywall draft (dashboard "preview on
//  my device" flow, P9). Wraps the existing `RovenuePaywallView` renderer —
//  this is NOT a fourth renderer, just a different fetch path feeding the
//  same one. Fetches once on appear, then polls `getPaywallPreview` every
//  `previewPollIntervalSeconds` so an editor save shows up on the device
//  without the tester having to relaunch; a poll only swaps the rendered
//  paywall when `previewPollDecision` says the revision actually changed
//  (see PreviewPollDecision.swift).
//

import Foundation
import SwiftUI

/// How often the poll loop re-fetches the preview while this view is on
/// screen. Named rather than inlined per the "no magic values" convention —
/// this is the one number a reviewer/future-editor would want to tune.
let previewPollIntervalSeconds: TimeInterval = 2

// MARK: - "PREVIEW" pill styling constants (top-trailing overlay)

private let previewPillFontSize: CGFloat = 11
private let previewPillHorizontalPadding: CGFloat = 10
private let previewPillVerticalPadding: CGFloat = 4
private let previewPillCornerRadius: CGFloat = 8
private let previewPillBackgroundOpacity: Double = 0.85
private let previewPillTopInset: CGFloat = 12
private let previewPillTrailingInset: CGFloat = 12

/// Fetches and renders an on-device preview of a draft paywall by its
/// short-lived preview `token` (see `Rovenue.getPaywallPreview`). Preview
/// must never charge: the wrapped `RovenuePaywallView` is always bound with
/// `previewMode: true` (see `buildWrappedView(shown:)`), which gates its
/// internal `startPurchase()` FIRST via `purchaseGate` — a tap on
/// "Subscribe" here can never reach `Rovenue.shared.purchase`, not merely
/// suppress the reaction to it. `onClose`/`onUrl` pass straight through to
/// the caller: they're navigation, not money, and the preview host (e.g.
/// the dashboard's device-preview screen) still needs to react to them.
public struct RovenuePaywallPreviewView: View {
    private let token: String
    private let locale: String?
    private let onClose: (() -> Void)?
    private let onUrl: ((URL) -> Void)?

    @State private var shown: Paywall?
    @State private var loadError: Error?
    @State private var pollTask: Task<Void, Never>?

    public init(
        token: String,
        locale: String? = nil,
        onClose: (() -> Void)? = nil,
        onUrl: ((URL) -> Void)? = nil
    ) {
        self.token = token
        self.locale = locale
        self.onClose = onClose
        self.onUrl = onUrl
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            content
            previewPill
        }
        .onAppear { start() }
        .onDisappear { stop() }
    }

    @ViewBuilder
    private var content: some View {
        if let shown {
            buildWrappedView(shown: shown)
        } else if loadError != nil {
            retryView
        } else {
            ProgressView()
        }
    }

    /// The `RovenuePaywallView` this preview always wraps `shown` in.
    ///
    /// Previewing a draft must never charge: `previewMode: true` gates
    /// `RovenuePaywallView.startPurchase()` FIRST (see `purchaseGate`), so
    /// tapping "Subscribe" here can never reach `Rovenue.shared.purchase` —
    /// not the no-op callbacks below, the gate itself. Restore is likewise
    /// never wired to a real restore call: this view passes `onRestore: {}`
    /// (there is nothing meaningful to restore against a draft that isn't
    /// published), and `RovenuePaywallView` never calls
    /// `Rovenue.shared.restorePurchases()` internally — restore is entirely
    /// host-delegated via `onRestore`, so the no-op closure alone already
    /// closes that path; no `previewMode` gate is needed for it.
    /// `onClose`/`onUrl` are pure navigation and pass straight through to
    /// the preview host.
    ///
    /// Not `private`: `PreviewModeTests` calls this directly (via
    /// `@testable import`) to pin `previewMode: true` without needing a
    /// SwiftUI view-testing dependency this package doesn't carry.
    func buildWrappedView(shown: Paywall) -> RovenuePaywallView {
        RovenuePaywallView(
            paywall: shown,
            locale: locale,
            onPurchaseCompleted: { _ in },
            onPurchaseFailed: { _ in },
            onClose: onClose,
            onRestore: {},
            onUrl: onUrl,
            previewMode: true
        )
    }

    private var retryView: some View {
        VStack(spacing: 12) {
            Text("Couldn't load preview")
                .font(.headline)
            Button("Retry") {
                loadError = nil
                Task { await fetchOnce() }
            }
        }
        .padding()
    }

    private var previewPill: some View {
        Text("PREVIEW")
            .font(.system(size: previewPillFontSize, weight: .bold))
            .padding(.horizontal, previewPillHorizontalPadding)
            .padding(.vertical, previewPillVerticalPadding)
            .background(Color.black.opacity(previewPillBackgroundOpacity))
            .foregroundColor(.white)
            .cornerRadius(previewPillCornerRadius)
            .padding(.top, previewPillTopInset)
            .padding(.trailing, previewPillTrailingInset)
    }

    private func start() {
        Task { await fetchOnce() }
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(previewPollIntervalSeconds * 1_000_000_000))
                if Task.isCancelled { break }
                await poll()
            }
        }
    }

    private func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func fetchOnce() async {
        do {
            let fetched = try await Rovenue.shared.getPaywallPreview(token: token, locale: locale)
            shown = fetched
            loadError = nil
        } catch {
            loadError = error
        }
    }

    /// A background poll tick: fetches, then only re-binds `shown` when
    /// `previewPollDecision` says the revision actually moved — a poll
    /// that returns the same (or no) revision must not tear down and
    /// rebuild the view a tester is actively looking at. Passes the shown
    /// paywall's `revision` as `etag` so an unchanged draft comes back as a
    /// 304 (decoded to `nil` by `getPaywallPreview`) instead of paying full
    /// server-side draft rehydration on every tick; `previewPollDecision`
    /// already treats a `nil` `latest` as `.noChange`, so the 304 path needs
    /// no special-casing here.
    private func poll() async {
        do {
            let fetched = try await Rovenue.shared.getPaywallPreview(token: token, locale: locale, etag: shown?.revision)
            guard previewPollDecision(current: shown?.revision, latest: fetched?.revision) == .refetch else { return }
            shown = fetched
        } catch {
            // Minimal retry state: a transient poll failure must not blow
            // away an already-rendered preview. Only surface the error
            // when there's nothing on screen yet (i.e. the initial fetch
            // itself never succeeded and a later poll also failed).
            if shown == nil { loadError = error }
        }
    }
}
