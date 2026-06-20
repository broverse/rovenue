require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RovenueSdkRn'
  s.version        = package['version']
  s.summary        = 'Rovenue React Native SDK — Expo Module bridge'
  s.homepage       = 'https://rovenue.io'
  s.license        = { :type => 'AGPL-3.0' }
  s.authors        = 'Rovenue'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.source_files   = '**/*.{h,m,swift}'
  s.resource_bundles = { 'RovenueSdkRn_privacy' => ['PrivacyInfo.xcprivacy'] }

  # Expo Modules runtime — provided by the consuming app via autolinking
  s.dependency 'ExpoModulesCore'

  # M3 Swift façade — provided by the consumer's Podfile via
  # `pod 'Rovenue', :path => '<monorepo-relative path>'` injected by
  # our config plugin (plugin/withRovenueIos.ts).
  s.dependency 'Rovenue'

  # Importing the `Rovenue` Swift module pulls in its transitive clang
  # module `RovenueFFI` (the uniffi C layer). CocoaPods does not propagate
  # SWIFT_INCLUDE_PATHS from a dependency, so this bridge pod must also put
  # the RovenueFFI module.modulemap (in the sibling sdk-swift package) on
  # its Swift import path or the build fails with
  # "Unable to resolve module dependency: 'RovenueFFI'".
  s.pod_target_xcconfig = {
    'SWIFT_INCLUDE_PATHS' => '$(PODS_TARGET_SRCROOT)/../../sdk-swift/Sources/RovenueFFI'
  }
  # The app target also imports these modules (via the generated
  # ExpoModulesProvider), so it needs RovenueFFI on its import path too.
  # user_target_xcconfig propagates the setting to the integrating app
  # target. PODS_ROOT is <app>/ios/Pods, so the sibling sdk-swift package
  # sits four levels up.
  s.user_target_xcconfig = {
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "${PODS_ROOT}/../../../../packages/sdk-swift/Sources/RovenueFFI"'
  }
end
