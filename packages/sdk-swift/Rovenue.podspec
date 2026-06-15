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
  s.platforms        = { :ios => '13.0' }
  s.swift_version    = '5.9'
  s.source           = {
    :http   => "https://github.com/rovenue/rovenue/releases/download/sdk-swift-v#{s.version}/Rovenue-#{s.version}.zip",
    :sha256 => '0000000000000000000000000000000000000000000000000000000000000000'
  }
  s.source_files       = 'Sources/Rovenue/**/*.swift'
  s.vendored_libraries = 'Sources/Rovenue/librovenue.a'
end
