// withRovenueAndroid tests.
//
// `withSettingsGradle`/`withAppBuildGradle` operate purely on
// `cfg.modResults.contents` in memory (unlike the iOS `withDangerousMod`
// callback, which needs a real Podfile on disk) — `@expo/config-plugins`'
// `withMod` wrapper attaches an async interceptor at
// `config.mods.android.<modName>` that calls the plugin's action then
// `nextMod(results)`. With no other mod registered for that slot,
// `nextMod` is the identity function, so we can invoke the interceptor
// directly against a synthetic `modResults.contents` string and read the
// patched contents back off the result — no filesystem or Expo prebuild
// pipeline required.

import { describe, expect, it } from "vitest";
import { withRovenueAndroid } from "../withRovenueAndroid";

const MIN_SETTINGS_GRADLE = `rootProject.name = 'sampleApp'
include ':app'
`;

const MIN_APP_BUILD_GRADLE = `dependencies {
    implementation("com.facebook.react:react-android")
}
`;

function makeFakeConfig(): any {
  return { name: "test", slug: "test" };
}

async function runSettingsGradleMod(config: any, contents: string): Promise<string> {
  const mod = config?.mods?.android?.settingsGradle;
  if (typeof mod !== "function") {
    throw new Error(
      "no android settingsGradle mod registered — did the plugin run withSettingsGradle?",
    );
  }
  const result = await mod({
    modRequest: {},
    modResults: { contents, path: "settings.gradle" },
  });
  return result.modResults.contents;
}

async function runAppBuildGradleMod(config: any, contents: string): Promise<string> {
  const mod = config?.mods?.android?.appBuildGradle;
  if (typeof mod !== "function") {
    throw new Error(
      "no android appBuildGradle mod registered — did the plugin run withAppBuildGradle?",
    );
  }
  const result = await mod({
    modRequest: {},
    modResults: { contents, path: "app/build.gradle" },
  });
  return result.modResults.contents;
}

describe("withRovenueAndroid — settings.gradle", () => {
  it("emits a dependencySubstitution mapping dev.rovenue:sdk onto the included build's project", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runSettingsGradleMod(cfg, MIN_SETTINGS_GRADLE);

    // Gradle's default composite-build substitution matches by the
    // included project's own name (`sdk-kotlin`), not by its
    // maven-publish coordinate (`dev.rovenue:sdk`) — so an explicit
    // `dependencySubstitution` rule mapping the coordinate onto the
    // included project is required, or `implementation("dev.rovenue:sdk:...")`
    // in app/build.gradle never resolves.
    expect(patched).toContain("dependencySubstitution");
    expect(patched).toMatch(
      /substitute\s+module\(["']dev\.rovenue:sdk["']\)\s+using\s+project\(["']:["']\)/,
    );

    // The substitution must live inside the includeBuild block that
    // wires up the local sdk-kotlin path, not floating disconnected.
    const includeIdx = patched.indexOf("includeBuild");
    const subIdx = patched.indexOf("dependencySubstitution");
    expect(includeIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThan(includeIdx);
  });

  it("still wires includeBuild to the default monorepo-relative sdk-kotlin path", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runSettingsGradleMod(cfg, MIN_SETTINGS_GRADLE);
    expect(patched).toContain('includeBuild("../../../packages/sdk-kotlin")');
  });

  it("honors a custom rovenueKotlinPath for both includeBuild and the substitution", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), {
      rovenueKotlinPath: "../../../packages/sdk-kotlin-custom",
    });
    const patched = await runSettingsGradleMod(cfg, MIN_SETTINGS_GRADLE);
    expect(patched).toContain('includeBuild("../../../packages/sdk-kotlin-custom")');
    expect(patched).toMatch(
      /substitute\s+module\(["']dev\.rovenue:sdk["']\)\s+using\s+project\(["']:["']\)/,
    );
  });

  it("is idempotent — running twice does not duplicate the includeBuild/substitution block", async () => {
    const cfg1 = withRovenueAndroid(makeFakeConfig(), undefined);
    const once = await runSettingsGradleMod(cfg1, MIN_SETTINGS_GRADLE);

    const cfg2 = withRovenueAndroid(makeFakeConfig(), undefined);
    const twice = await runSettingsGradleMod(cfg2, once);

    expect(twice).toBe(once);
    expect((twice.match(/includeBuild/g) ?? []).length).toBe(1);
    expect((twice.match(/dependencySubstitution/g) ?? []).length).toBe(1);
  });
});

describe("withRovenueAndroid — app/build.gradle", () => {
  it("still injects the dev.rovenue:sdk implementation dependency", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runAppBuildGradleMod(cfg, MIN_APP_BUILD_GRADLE);
    expect(patched).toContain('implementation("dev.rovenue:sdk:0.1.0")');
  });
});
