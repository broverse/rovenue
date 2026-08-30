// swift-tools-version: 5.9
//
// Package.swift — LOCAL DEV/TEST HARNESS ONLY. This is *not* how the plugin
// ships to Flutter apps (that's `rovenue_flutter_ios.podspec`, which only
// picks up `Classes/**/*` via CocoaPods). This manifest exists solely so
// `HostApiImplTests.swift` can run as real, compiled, executed XCTest —
// Task 8's example app (the alternative `xcodebuild test` harness) doesn't
// exist yet.
//
// Flutter's own Swift Package Manager plugin support looks for
// `ios/<plugin_name>/Package.swift` (see flutter_tools'
// `Plugin.pluginSwiftPackagePath`) — this file deliberately lives at
// `ios/Package.swift` instead, one level up, so Flutter's tooling never
// mistakes it for (or tries to integrate) an SPM plugin manifest.
//
// `HostApiImpl`/`EventBridge`/`RovenueFlutterIosPlugin` all branch on
// `#if os(iOS) import Flutter #elseif os(macOS) import FlutterMacOS` (the
// same pattern `Messages.g.swift`, Task 2's generated Pigeon output, already
// uses) specifically so this file can link them against `FlutterMacOS`
// and run natively on macOS — no simulator required.
import Foundation
import PackageDescription

/// Locates the local Flutter SDK checkout so we can link its
/// `FlutterMacOS.xcframework` (used ONLY for compiling/running this test
/// target on macOS; production iOS builds link the real `Flutter` pod).
/// Prefers `$FLUTTER_ROOT`; falls back to resolving `flutter` on `$PATH`.
func resolveFlutterRoot() -> String {
  if let root = ProcessInfo.processInfo.environment["FLUTTER_ROOT"], !root.isEmpty {
    return root
  }
  let which = Process()
  which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  which.arguments = ["which", "flutter"]
  let pipe = Pipe()
  which.standardOutput = pipe
  which.standardError = Pipe()
  try? which.run()
  which.waitUntilExit()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  let flutterBin =
    String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !flutterBin.isEmpty else {
    fatalError(
      "Could not locate the Flutter SDK (set $FLUTTER_ROOT or put `flutter` on PATH) — needed to link FlutterMacOS.xcframework for this test-only package."
    )
  }
  // .../flutter/bin/flutter -> resolve symlinks (Homebrew installs a shim)
  // then strip "/bin/flutter" to get the SDK root.
  let resolvedBin = (flutterBin as NSString).resolvingSymlinksInPath
  return URL(fileURLWithPath: resolvedBin)
    .deletingLastPathComponent()  // .../flutter/bin
    .deletingLastPathComponent()  // .../flutter
    .path
}

/// `binaryTarget(path:)` must be relative to the package root (SwiftPM
/// rejects absolute paths) — compute that relative path manually since the
/// Flutter SDK can live anywhere on disk.
func relativePath(from base: String, to target: String) -> String {
  let baseComponents = base.split(separator: "/").map(String.init)
  let targetComponents = target.split(separator: "/").map(String.init)
  var i = 0
  while i < baseComponents.count && i < targetComponents.count
    && baseComponents[i] == targetComponents[i]
  {
    i += 1
  }
  let ups = Array(repeating: "..", count: baseComponents.count - i)
  let downs = Array(targetComponents[i...])
  return (ups + downs).joined(separator: "/")
}

let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let flutterRoot = resolveFlutterRoot()
let flutterMacOSXCFrameworkAbsolutePath =
  flutterRoot + "/bin/cache/artifacts/engine/darwin-x64/FlutterMacOS.xcframework"
let flutterMacOSXCFrameworkPath = relativePath(
  from: packageRoot, to: flutterMacOSXCFrameworkAbsolutePath)

// The `Rovenue` package's own `-L../../target/release` linker flag (see
// `packages/sdk-swift/Package.swift`) is a relative `unsafeFlags` string
// forwarded to `ld` verbatim — SwiftPM does NOT re-root it against
// `Rovenue`'s package directory, so it only resolves correctly when `swift
// build`/`swift test` is invoked FROM `packages/sdk-swift`. Invoked from
// here (`ios/`), that relative path misses. Re-supply the same
// `librovenue` static lib via an absolute `-L` on our own target instead
// of touching `sdk-swift/Package.swift` (out of scope — see
// task-4-context.md's hard constraints).
let repoRoot = URL(fileURLWithPath: packageRoot)
  .deletingLastPathComponent()  // .../packages/sdk-flutter/rovenue_flutter_ios
  .deletingLastPathComponent()  // .../packages/sdk-flutter
  .deletingLastPathComponent()  // .../packages
  .deletingLastPathComponent()  // repo root
  .path
let librovenueReleaseDir = repoRoot + "/target/release"

let package = Package(
  name: "RovenueFlutterIosTestHarness",
  platforms: [.macOS(.v12)],
  products: [
    .library(name: "RovenueFlutterIosCore", targets: ["RovenueFlutterIosCore"])
  ],
  dependencies: [
    .package(name: "Rovenue", path: "../../../sdk-swift")
  ],
  targets: [
    .binaryTarget(
      name: "FlutterMacOSBinary",
      path: flutterMacOSXCFrameworkPath
    ),
    .target(
      name: "RovenueFlutterIosCore",
      dependencies: [
        .product(name: "Rovenue", package: "Rovenue"),
        "FlutterMacOSBinary",
      ],
      path: "Classes",
      // Task 7's paywall PlatformView files are iOS-only: they host a
      // `UIHostingController` (UIKit-only — macOS's SwiftUI hosting type
      // is `NSHostingController`, a different type) and import `Flutter`
      // (not the `FlutterMacOS` this harness links). Per the Task 4
      // controller ruling, that's solved here — by excluding them from
      // this macOS-only test-harness target's sources — rather than by
      // adding `#if os(macOS)` branches to the shipping files themselves.
      exclude: [
        "PaywallPlatformView.swift",
        "PaywallViewFactory.swift",
      ],
      linkerSettings: [
        .unsafeFlags(["-L\(librovenueReleaseDir)"], .when(platforms: [.macOS]))
      ]
    ),
    .testTarget(
      name: "RovenueFlutterIosTests",
      dependencies: ["RovenueFlutterIosCore"],
      path: "Tests"
    ),
  ]
)
