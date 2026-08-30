#
# rovenue_flutter_ios.podspec — CocoaPods spec for the iOS platform package
# of the federated `rovenue_flutter` plugin.
#
# Wraps the existing Swift façade (the `Rovenue` pod, packages/sdk-swift) the
# same way the Swift/Kotlin SDKs already wrap the shared Rust core
# (librovenue) — this package adds no native logic of its own beyond a thin
# Flutter method-channel/pigeon bridge added in a later task.
#
# Release-order prerequisite (spec §4.6): the `Rovenue` CocoaPods pod must be
# published to Trunk at the matching version BEFORE `flutter pub get` can
# resolve this podspec for a real (non-local) consumer, because CocoaPods
# fetches `s.dependency 'Rovenue'` from the Trunk registry, not from this
# monorepo. The example app under this package overrides the dependency with
# a local `:path` pod reference during development so it never needs a
# published pod.
#
Pod::Spec.new do |s|
  s.name             = 'rovenue_flutter_ios'
  s.version          = '0.16.0'
  s.summary          = 'Rovenue Flutter SDK — iOS platform implementation'
  s.description      = <<-DESC
iOS platform implementation for the rovenue_flutter federated plugin.
                       DESC
  s.homepage         = 'https://rovenue.app'
  s.license          = { :type => 'AGPL-3.0' }
  s.author           = { 'Rovenue' => 'oss@rovenue.app' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'

  s.dependency 'Flutter'
  s.dependency 'Rovenue', '0.16.0'

  # Must be >= the `Rovenue` pod's own minimum (packages/sdk-swift/
  # Rovenue.podspec: iOS 16.0, its arm64-device-only static lib) — Task 8's
  # example app build surfaced the mismatch ("Compiling for iOS 15.0, but
  # module 'Rovenue' has a minimum deployment target of iOS 16.0").
  s.platform = :ios, '16.0'
  s.swift_version = '5.9'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
