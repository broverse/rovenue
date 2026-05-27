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
    const line = `includeBuild("${kotlinPath}")`;
    if (!cfg.modResults.contents.includes(line)) {
      cfg.modResults.contents = `${line}\n${cfg.modResults.contents}`;
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
