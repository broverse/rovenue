// @rovenue/react-native-sdk — Expo config plugin entry.
//
// Used by consumers via `"plugins": ["@rovenue/react-native-sdk"]` in
// their app.json. At prebuild time we patch the consumer's iOS Podfile
// and Android settings.gradle/app build.gradle to wire the M3 Swift +
// M4 Kotlin façades.

import { ConfigPlugin } from "@expo/config-plugins";
import { withRovenueIos } from "./withRovenueIos";
import { withRovenueAndroid } from "./withRovenueAndroid";

export type RovenueConfigOptions = {
  rovenueSwiftPath?: string;
  rovenueKotlinPath?: string;
};

const withRovenue: ConfigPlugin<RovenueConfigOptions | void> = (config, opts) => {
  config = withRovenueIos(config, opts ?? undefined);
  config = withRovenueAndroid(config, opts ?? undefined);
  return config;
};

export default withRovenue;
