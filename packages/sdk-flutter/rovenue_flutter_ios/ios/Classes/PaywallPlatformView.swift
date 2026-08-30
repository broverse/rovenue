// PaywallPlatformView.swift — hosts the SwiftUI `RovenuePaywallView`
// (packages/sdk-swift/Sources/Rovenue/PaywallUI/) inside a Flutter
// `FlutterPlatformView`. Task 7.
//
// Model: `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`. Creation
// params arrive once, atomically, at `init` — but unlike Expo's
// `onViewDidUpdateProps`, Flutter's `AndroidView`/`UiKitView` never resend
// them on a prop change. Task 8's carry-forward closes that gap with an
// explicit `updateParams` call the Dart side (`RovenuePaywallView`'s
// `didUpdateWidget`, see `packages/sdk-flutter/rovenue_flutter/lib/src/
// paywall_view.dart`) sends over this view's own per-instance channel —
// the same pattern `google_maps_flutter`/`webview_flutter` use for
// prop-diffing platform views. `handleMethodCall` only re-resolves the
// paywall (cancelling any in-flight `loadTask`) when
// `placementIdentifier`/`locale`/`colorSchemeOverride` actually changed; a
// pure `hasRestoreHandler`/`hasUrlHandler` flip just re-mounts the cached
// `currentPaywall` with new closures, so an unchanged prop never triggers
// a re-fetch.
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

  private var placementIdentifier: String
  private var locale: String?
  private var colorSchemeOverride: String?
  private var hasRestoreHandler: Bool
  private var hasUrlHandler: Bool

  private var hostingController: UIHostingController<AnyView>?
  private var loadTask: Task<Void, Never>?
  /// Cached so a handler-only `updateParams` (no placement/locale/scheme
  /// change) can re-`mount` without re-resolving the paywall.
  private var currentPaywall: Paywall?

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
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handleMethodCall(call, result: result)
    }
    load()
  }

  func view() -> UIView { containerView }

  deinit {
    loadTask?.cancel()
  }

  /// Handles Dart's `updateParams` call (see this file's header). Any other
  /// method name is answered with `FlutterMethodNotImplemented` — this
  /// channel is also used the other way (native → Dart `invokeMethod`
  /// calls below), so an unrecognized method here isn't necessarily a bug.
  private func handleMethodCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard call.method == "updateParams" else {
      result(FlutterMethodNotImplemented)
      return
    }
    let params = call.arguments as? [String: Any] ?? [:]
    let newPlacement = params["placementIdentifier"] as? String ?? ""
    let newLocale = params["locale"] as? String
    let newColorScheme = params["colorSchemeOverride"] as? String
    let newHasRestore = params["hasRestoreHandler"] as? Bool ?? false
    let newHasUrl = params["hasUrlHandler"] as? Bool ?? false

    let needsReload = newPlacement != placementIdentifier
      || newLocale != locale
      || newColorScheme != colorSchemeOverride
    let handlersChanged = newHasRestore != hasRestoreHandler || newHasUrl != hasUrlHandler

    placementIdentifier = newPlacement
    locale = newLocale
    colorSchemeOverride = newColorScheme
    hasRestoreHandler = newHasRestore
    hasUrlHandler = newHasUrl

    if needsReload {
      loadTask?.cancel()
      load()
    } else if handlersChanged {
      mount(currentPaywall)
    }
    result(nil)
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
    currentPaywall = paywall

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
