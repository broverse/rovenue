# Rovenue.podspec — CocoaPods wrapper for the M3 Swift façade.
# M3 is SPM-primary; this podspec exists so the RN sample app (and any
# Expo / bare RN consumer) can pull the M3 sources via `pod 'Rovenue',
# :path => '...'`. CocoaPods Trunk publish is deferred to M7.

Pod::Spec.new do |s|
  s.name             = 'Rovenue'
  s.version          = '0.1.0'
  s.summary          = 'Rovenue Swift façade'
  s.homepage         = 'https://rovenue.dev'
  s.license          = { :type => 'AGPL-3.0' }
  s.authors          = 'Rovenue'
  s.platforms        = { :ios => '13.0' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.source_files     = 'Sources/Rovenue/**/*.swift'
  s.vendored_libraries = 'Sources/Rovenue/librovenue.a'
end
