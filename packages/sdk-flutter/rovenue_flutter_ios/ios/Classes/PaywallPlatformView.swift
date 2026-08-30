// PaywallPlatformView.swift — hosts the SwiftUI `RovenuePaywallView`
// (packages/sdk-swift/Sources/Rovenue/PaywallUI/) inside a Flutter
// `FlutterPlatformView`. Task 7.
//
// Model: `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`. Flutter's
// platform-view contract differs from Expo's in one load-bearing way that
// simplifies this file relative to that model: creation params arrive
// ONCE, atomically, at `init` — there is no per-prop update channel a
// Flutter host can use to change `placementIdentifier`/`locale`/etc. after
// the view exists (unlike Expo's `onViewDidUpdateProps`, which fires once
// per prop batch and can fire many times over a view's life). So there is
// no `reload()`/prop-diffing/content-key-cache dance here: the paywall is
// resolved exactly once, the result is cancelled on `deinit` if still in
// flight, and `mount` either builds the hosting controller (first
// successful resolve) or swaps its `rootView` (a mount from a background
// queue racing a cancelled task, defensively — in practice this only ever
// runs once per view).
//
// iOS-only — see `PaywallViewFactory.swift`'s header for why this file is
// excluded from the macOS SwiftPM test harness rather than branched with
// `#if os(macOS)`.

import Foundation
import UIKit
import SwiftUI
import Flutter
import Rovenue

/// Code sent for an `onPurchaseFailed` error that reached `fail(_:)`'s
/// generic (non-`RovenueError`) branch. `"Internal"` there is a REAL UDL
/// `ErrorKind` variant, so unlike the RN bridge's own sentinel this needs
/// no special casing here — `errorArgs(_:)` already produces the right
/// `code` for every error shape via `fail(_:)`.
final class PaywallPlatformView: NSObject, FlutterPlatformView {
  private let containerView = UIView()
  private let channel: FlutterMethodChannel

  private let placementIdentifier: String
  private let locale: String?
  private let colorSchemeOverride: String?
  private let hasRestoreHandler: Bool
  private let hasUrlHandler: Bool

  private var hostingController: UIHostingController<AnyView>?
  private var loadTask: Task<Void, Never>?

  init(frame: CGRect, viewId: Int64, args: Any?, messenger: FlutterBinaryMessenger) {
    let params = args as? [String: Any] ?? [:]
    self.placementIdentifier = params["placementIdentifier"] as? String ?? ""
    self.locale = params["locale"] as? String
    self.colorSchemeOverride = params["colorSchemeOverride"] as? String
    self.hasRestoreHandler = params["hasRestoreHandler"] as? Bool ?? false
    self.hasUrlHandler = params["hasUrlHandler"] as? Bool ?? false
    self.channel = FlutterMethodChannel(
      name: "dev.rovenue.flutter/paywall_view_\(viewId)",
      binaryMessenger: messenger
    )
    containerView.frame = frame
    containerView.clipsToBounds = true
    super.init()
    load()
  }

  func view() -> UIView { containerView }

  deinit {
    loadTask?.cancel()
  }

  private func load() {
    guard !placementIdentifier.isEmpty else { return }
    let placement = placementIdentifier
    let requestedLocale = locale
    loadTask = Task { [weak self] in
      // A resolution failure renders nothing — matches the RN bridge and
      // the SwiftUI renderer's own behavior for a nil/undecoded config.
      // There is no props contract here to preserve by staying silent
      // (unlike the RN bridge's comment on this point), it's simply that
      // this view has no error slot to surface one through.
      let paywall = try? await Rovenue.shared.getPaywall(placementId: placement, locale: requestedLocale)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        self?.mount(paywall)
      }
    }
  }

  private func scheme() -> ColorScheme? {
    switch colorSchemeOverride {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  private func mount(_ paywall: Paywall?) {
    guard let paywall else { return }

    let content = RovenuePaywallView(
      paywall: paywall,
      locale: locale,
      colorSchemeOverride: scheme(),
      onPurchaseCompleted: { [weak self] result in
        self?.channel.invokeMethod("onPurchaseCompleted", arguments: ["result": dtoFromPurchaseResult(result)])
      },
      onPurchaseFailed: { [weak self] error in
        self?.channel.invokeMethod("onPurchaseFailed", arguments: errorArgs(error))
      },
      onClose: { [weak self] in self?.channel.invokeMethod("onCloseRequested", arguments: nil) },
      onRestore: hasRestoreHandler ? { [weak self] in self?.channel.invokeMethod("onRestoreRequested", arguments: nil) } : nil,
      onUrl: hasUrlHandler ? { [weak self] url in
        self?.channel.invokeMethod("onUrlRequested", arguments: ["url": url.absoluteString])
      } : nil
    )

    if let hostingController {
      hostingController.rootView = AnyView(content)
      return
    }

    let controller = UIHostingController(rootView: AnyView(content))
    controller.view.backgroundColor = .clear
    controller.view.frame = containerView.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    containerView.addSubview(controller.view)
    hostingController = controller
  }
}
