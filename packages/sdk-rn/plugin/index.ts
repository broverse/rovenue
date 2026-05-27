// @rovenue/react-native-sdk — Expo config plugin entry.
//
// Used by consumers via `"plugins": ["@rovenue/react-native-sdk"]` in
// their app.json. At prebuild time we patch the consumer's iOS Podfile
// and Android settings.gradle/app build.gradle to wire the M3 Swift +
// M4 Kotlin façades.

import { ConfigPlugin } from "@expo/config-plugins";
import { withRovenueIos } from "./withRovenueIos";
import { withRovenueAndroid } from "./withRovenueAndroid";

/**
 * Options for the `@rovenue/react-native-sdk` Expo config plugin.
 *
 * Both fields default to "use the published artifact" — i.e. iOS pulls
 * `pod 'Rovenue'` from CocoaPods Trunk, Android resolves
 * `dev.rovenue:sdk` from… (Android-external publish lands in M7.2).
 *
 * Monorepo consumers (this repo's `examples/sample-rn-expo`) override
 * both with paths relative to the consumer's generated native project
 * directory (`ios/Podfile` for iOS, `android/settings.gradle` for
 * Android — both produced by `expo prebuild`).
 */
export type RovenueConfigOptions = {
  /**
   * If set: emit `pod 'Rovenue', :path => '<value>'` into the consumer's
   * iOS Podfile. The path is interpreted relative to `ios/Podfile`.
   *
   * If unset (default): emit `pod 'Rovenue', '~> 0.1'` which resolves
   * via CocoaPods Trunk. Requires the first Trunk push to have happened
   * (see `packages/sdk-swift/scripts/release-pod.sh`).
   */
  rovenueSwiftPath?: string;

  /**
   * If set: emit `includeBuild("<value>")` into `settings.gradle` so
   * Gradle composite-build resolves `dev.rovenue:sdk` from a local
   * checkout. The path is interpreted relative to
   * `android/settings.gradle`.
   *
   * If unset (default): emit only the `implementation("dev.rovenue:sdk:0.1.0")`
   * dependency. M7.2 will publish that artifact to Maven Central; until
   * then external Android consumers cannot resolve it.
   */
  rovenueKotlinPath?: string;
};

const withRovenue: ConfigPlugin<RovenueConfigOptions | void> = (config, opts) => {
  config = withRovenueIos(config, opts ?? undefined);
  config = withRovenueAndroid(config, opts ?? undefined);
  return config;
};

export default withRovenue;
