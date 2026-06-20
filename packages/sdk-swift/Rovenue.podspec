# Rovenue.podspec — CocoaPods wrapper for the M3 Swift façade.
#
# Publishable to CocoaPods Trunk. The release artifact is a sha256-pinned
# zip on GitHub Releases that contains Sources/ + a pre-built single-arch
# arm64-device librovenue.a (built by packages/sdk-swift/scripts/build-ios-static.sh).
#
# Single-platform: arm64 iOS devices only. Simulators + Intel-Mac dev loops
# require an XCFramework — tracked as M7.1 Open Question 1.

Pod::Spec.new do |s|
  s.name             = 'Rovenue'
  s.version          = '0.6.0'
  s.summary          = 'Rovenue Swift façade'
  s.homepage         = 'https://rovenue.io'
  s.license          = { :type => 'AGPL-3.0' }
  s.authors          = 'Rovenue'
  s.platforms        = { :ios => '15.0' }
  s.swift_version    = '5.9'
  s.source           = {
    :http   => "https://github.com/rovenue/rovenue/releases/download/sdk-swift-v#{s.version}/Rovenue-#{s.version}.zip",
    :sha256 => '0000000000000000000000000000000000000000000000000000000000000000'
  }
  s.source_files       = 'Sources/Rovenue/**/*.swift'
  # NOTE: must NOT be `librovenue.a` — CocoaPods names this pod's own
  # compiled static lib `libRovenue.a`, which collides case-insensitively
  # with a vendored `librovenue.a` on macOS ("conflicting names"). Use a
  # distinct basename for the vendored Rust core.
  s.vendored_libraries = 'Sources/Rovenue/librovenue_ffi.a'

  # Expose the uniffi C FFI layer (RustBuffer / RustCallStatus / ForeignBytes,
  # declared in Sources/Rovenue/Generated/RovenueFFI.h) as an importable clang
  # module so the generated RovenueFFI.swift's `#if canImport(RovenueFFI)`
  # branch succeeds. SPM wires this through a `systemLibrary` target; under
  # CocoaPods we put the module.modulemap directory on the Swift import path.
  s.preserve_paths      = 'Sources/RovenueFFI/**/*'
  s.pod_target_xcconfig = {
    'SWIFT_INCLUDE_PATHS' => '$(PODS_TARGET_SRCROOT)/Sources/RovenueFFI'
  }

  # Apple privacy manifest — bundled so the publishable CocoaPods artifact (the
  # pod that ships the collecting code) carries its own PrivacyInfo.xcprivacy,
  # not just the Expo bridge pod. The file lives in Sources/Rovenue/ already.
  s.resource_bundles   = { 'Rovenue_privacy' => ['Sources/Rovenue/PrivacyInfo.xcprivacy'] }
end
