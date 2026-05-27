require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "package.json")))

Pod::Spec.new do |s|
  s.name         = "RovenueSdkRn"
  s.version      = package["version"]
  s.summary      = "Rovenue React Native SDK"
  s.homepage     = "https://rovenue.dev"
  s.license      = { :type => "AGPL-3.0" }
  s.authors      = "Rovenue"
  s.platforms    = { :ios => "13.0" }
  s.source       = { :path => "." }

  s.source_files = "*.swift"
  s.swift_version = "5.9"

  # Swift M3 façade, pulled in via SPM by the consuming app or via a
  # direct file reference during dev. The actual link path is set up
  # in M6 (distribution plan); for M5 the source is added but the
  # consumer is responsible for wiring `Rovenue` from sdk-swift.
  s.dependency "react-native-nitro-modules"
end
