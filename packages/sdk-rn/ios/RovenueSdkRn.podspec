require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RovenueSdkRn'
  s.version        = package['version']
  s.summary        = 'Rovenue React Native SDK — Expo Module bridge'
  s.homepage       = 'https://rovenue.io'
  s.license        = { :type => 'AGPL-3.0' }
  s.authors        = 'Rovenue'
  s.platforms      = { :ios => '13.0' }
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
end
