// withRovenueAndroid — Expo config plugin mods that wire the M4 Kotlin
// façade into the consumer's Gradle build via composite build
// (settings.gradle.kts includeBuild + app/build.gradle dep).
//
// M6 hard-codes the monorepo-relative path. M7 will support an
// option-driven external path and/or a Maven Central artifact.

import { ConfigPlugin, withSettingsGradle, withAppBuildGradle } from "@expo/config-plugins";

type Options = { rovenueKotlinPath?: string } | undefined;

export const withRovenueAndroid: ConfigPlugin<Options> = (config, opts) => {
  const kotlinPath = opts?.rovenueKotlinPath ?? "../../../packages/sdk-kotlin";

  config = withSettingsGradle(config, (cfg) => {
    const includeLine = `includeBuild("${kotlinPath}")`;
    // Gradle's default composite-build substitution matches an
    // `implementation` dependency to an included build by the included
    // project's OWN name (sdk-kotlin's settings.gradle.kts sets
    // `rootProject.name = "sdk-kotlin"`), not by its maven-publish
    // coordinate (`dev.rovenue:sdk`, declared in sdk-kotlin's
    // build.gradle.kts). Without an explicit `dependencySubstitution`
    // rule mapping the coordinate onto the included project,
    // `implementation("dev.rovenue:sdk:...")` in the consumer's
    // app/build.gradle never resolves. Mirrors
    // packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle,
    // which carries the identical rule for the identical reason.
    const block = `${includeLine} {
    dependencySubstitution {
        substitute module("dev.rovenue:sdk") using project(":")
    }
}`;
    if (!cfg.modResults.contents.includes(includeLine)) {
      cfg.modResults.contents = `${block}\n${cfg.modResults.contents}`;
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    const dep = `    implementation("dev.rovenue:sdk:0.1.0")`;
    if (!cfg.modResults.contents.includes("dev.rovenue:sdk")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n${dep}`,
      );
    }
    return cfg;
  });

  return config;
};
