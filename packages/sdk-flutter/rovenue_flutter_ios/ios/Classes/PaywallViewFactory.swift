// PaywallViewFactory.swift — registers the native paywall PlatformView
// (Task 7) under view type `dev.rovenue.flutter/paywall_view`.
//
// iOS-only by design: unlike every other file in `Classes/`, this one does
// NOT carry a `#if os(iOS) import Flutter #elseif os(macOS) import
// FlutterMacOS` branch, because `PaywallPlatformView` hosts a
// `UIHostingController` (UIKit-only — macOS's SwiftUI hosting type is
// `NSHostingController`, a different type this package does not support).
// Per the controller ruling carried from Task 4 (see task-7-context.md),
// this file and `PaywallPlatformView.swift` are deliberately EXCLUDED from
// the `ios/Package.swift` local SwiftPM test-harness target's sources
// rather than contorted with cross-platform conditionals to force them
// into a macOS build — see that file's `exclude:` list.

import Foundation
import Flutter

final class PaywallViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func create(
    withFrame frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?
  ) -> FlutterPlatformView {
    PaywallPlatformView(frame: frame, viewId: viewId, args: args, messenger: messenger)
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}
