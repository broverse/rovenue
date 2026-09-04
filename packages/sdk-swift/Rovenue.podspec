# Rovenue.podspec — CocoaPods wrapper for the Swift façade.
#
# The release artifact is a sha256-pinned zip on GitHub Releases containing
# Sources/ + RovenueFFI.xcframework + this podspec. The xcframework carries
# three slices (iOS device, iOS simulator, macOS) and uniffi's own module map,
# which is why this spec needs no SWIFT_INCLUDE_PATHS: consumers resolve the
# RovenueFFI Clang module from inside the vendored artifact.
require 'json'

CONFIG = JSON.parse(File.read(File.join(__dir__, 'release.config.json'))).freeze

Pod::Spec.new do |s|
  s.name             = CONFIG['podName']
  s.version          = CONFIG['version']
  s.summary          = 'Rovenue Swift façade'
  s.homepage         = 'https://rovenue.app'
  s.license          = { :type => 'AGPL-3.0' }
  s.authors          = 'Rovenue'
  s.platforms        = {
    :ios => CONFIG['iosDeploymentTarget'],
    :osx => CONFIG['macosDeploymentTarget'],
  }
  s.swift_version    = '5.9'
  s.source           = {
    :http   => "https://github.com/#{CONFIG['repoSlug']}/releases/download/sdk-swift-v#{s.version}/#{s.name}-#{s.version}.zip",
    :sha256 => '0000000000000000000000000000000000000000000000000000000000000000'
  }
  s.source_files        = 'Sources/Rovenue/**/*.swift'
  s.vendored_frameworks = CONFIG['xcframeworkName']

  # Apple privacy manifest — bundled so the publishable artifact carries its
  # own PrivacyInfo.xcprivacy, not just the Expo bridge pod.
  s.resource_bundles    = { 'Rovenue_privacy' => ['Sources/Rovenue/PrivacyInfo.xcprivacy'] }
end
