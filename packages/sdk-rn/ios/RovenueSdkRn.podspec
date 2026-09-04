require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RovenueSdkRn'
  s.version        = package['version']
  s.summary        = 'Rovenue React Native SDK — Expo Module bridge'
  s.homepage       = 'https://rovenue.io'
  s.license        = { :type => 'AGPL-3.0' }
  s.authors        = 'Rovenue'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.source_files   = '**/*.{h,m,swift}'
  s.resource_bundles = { 'RovenueSdkRn_privacy' => ['PrivacyInfo.xcprivacy'] }

  # Expo Modules runtime — provided by the consuming app via autolinking
  s.dependency 'ExpoModulesCore'

  # Swift façade. Pinned exactly: the bridge is compiled against this façade's
  # generated types.
  #
  # No xcconfig import-path overrides here. The `Rovenue` pod vendors
  # RovenueFFI.xcframework, which carries uniffi's module map inside each
  # slice, so the transitive `RovenueFFI` Clang module resolves without any
  # target needing a path into this monorepo. That path is precisely what made
  # this pod impossible to consume from npm.
  s.dependency 'Rovenue', package['version']
end
