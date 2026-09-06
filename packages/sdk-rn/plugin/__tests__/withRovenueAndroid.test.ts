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
import {
  findInsertionPointAfterLeadingSettingsHeader,
  withRovenueAndroid,
} from "../withRovenueAndroid";

const MIN_SETTINGS_GRADLE = `rootProject.name = 'sampleApp'
include ':app'
`;

// The exact shape a real `expo prebuild` emits for this repo's pinned
// Expo/RN version — reproduced (with the plugin's own injected
// `includeBuild` line removed, i.e. the PRISTINE pre-plugin state) from
// examples/sample-rn-expo/android/settings.gradle, a gitignored,
// genuinely prebuild-generated fixture kept out of git specifically
// because it's a build artifact — so it is copied inline here rather
// than read from disk, keeping this test hermetic in CI where that
// gitignored file won't exist. Its `pluginManagement {}` block nests an
// `if (...) { ... }` — the reason a naive "match the first `}`" approach
// would truncate the block and insert into the middle of it.
const REAL_PREBUILD_SETTINGS_GRADLE = `pluginManagement {
  def version = providers.exec {
    commandLine("node", "-e", "console.log(require('react-native/package.json').version);")
  }.standardOutput.asText.get().trim()
  def (_, reactNativeMinor, reactNativePatch) = version.split("-")[0].tokenize('.').collect { it.toInteger() }

  includeBuild(new File(["node", "--print", "require.resolve('@react-native/gradle-plugin/package.json')"].execute(null, rootDir).text.trim()).getParentFile().toString())
  if(reactNativeMinor == 74 && reactNativePatch <= 3){
    includeBuild("react-settings-plugin")
  }
}

plugins { id("com.facebook.react.settings") }

def getRNMinorVersion() {
  def version = providers.exec {
    commandLine("node", "-e", "console.log(require('react-native/package.json').version);")
  }.standardOutput.asText.get().trim()

  def coreVersion = version.split("-")[0]
  def (major, minor, patch) = coreVersion.tokenize('.').collect { it.toInteger() }

  return minor
}

if (getRNMinorVersion() >= 75) {
  extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
    if (System.getenv('EXPO_UNSTABLE_CORE_AUTOLINKING') == '1') {
      println('\\u001B[32mUsing expo-modules-autolinking as core autolinking source\\u001B[0m')
      def command = [
        'node',
        '--no-warnings',
        '--eval',
        'require(require.resolve(\\'expo-modules-autolinking\\', { paths: [require.resolve(\\'expo/package.json\\')] }))(process.argv.slice(1))',
        'react-native-config',
        '--json',
        '--platform',
        'android'
      ].toList()
      ex.autolinkLibrariesFromCommand(command)
    } else {
      ex.autolinkLibrariesFromCommand()
    }
  }
}

rootProject.name = 'sample-rn-expo'

dependencyResolutionManagement {
  versionCatalogs {
    reactAndroidLibs {
      from(files(new File(["node", "--print", "require.resolve('react-native/package.json')"].execute(null, rootDir).text.trim(), "../gradle/libs.versions.toml")))
    }
  }
}

apply from: new File(["node", "--print", "require.resolve('expo/package.json')"].execute(null, rootDir).text.trim(), "../scripts/autolinking.gradle");
useExpoModules()

include ':app'
includeBuild(new File(["node", "--print", "require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile())
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

  // Regression coverage for the "moved, not fixed" defect: MIN_SETTINGS_GRADLE
  // above has no pluginManagement/plugins header at all, so a naive
  // unconditional prepend passed every earlier test here while still being
  // unsafe against a real consumer. A real `expo prebuild` output ALWAYS
  // starts with `pluginManagement {}` immediately followed by
  // `plugins { id("com.facebook.react.settings") }` — Gradle enforces TWO
  // separate rules about this header region (pluginManagement must be
  // literally first; nothing but buildscript{}/pluginManagement{}/plugins{}
  // may precede a plugins{} block) — so inserting anywhere inside that
  // header, including right after pluginManagement but before plugins{},
  // produces a settings-file compile error that never mentions Rovenue.
  // These tests use the real prebuild shape specifically because it's the
  // one shape that can catch this — REAL_PREBUILD_SETTINGS_GRADLE has both
  // blocks back to back, exactly like the real fixture.
  it("inserts the includeBuild/dependencySubstitution block AFTER the entire leading pluginManagement+plugins header, not inside it", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runSettingsGradleMod(cfg, REAL_PREBUILD_SETTINGS_GRADLE);

    // pluginManagement must remain the file's first statement.
    expect(patched.trimStart().startsWith("pluginManagement")).toBe(true);

    const pluginMgmtIdx = patched.indexOf("pluginManagement");
    // The plugins{} block right after pluginManagement is part of the
    // original content and must stay put, immediately after
    // pluginManagement — our insertion must NOT land between them.
    const facebookReactSettingsIdx = patched.indexOf('id("com.facebook.react.settings")');
    const includeIdx = patched.indexOf('includeBuild("../../../packages/sdk-kotlin")');
    const subIdx = patched.indexOf("dependencySubstitution");
    // The next original statement after the header (a `def` function
    // declaration) must come after our whole inserted block — proving we
    // landed past BOTH header blocks, not just past pluginManagement.
    const getRnMinorVersionIdx = patched.indexOf("def getRNMinorVersion()");

    expect(pluginMgmtIdx).toBeGreaterThanOrEqual(0);
    expect(facebookReactSettingsIdx).toBeGreaterThan(pluginMgmtIdx);
    expect(includeIdx).toBeGreaterThan(facebookReactSettingsIdx);
    expect(subIdx).toBeGreaterThan(includeIdx);
    expect(getRnMinorVersionIdx).toBeGreaterThan(subIdx);

    // The rest of the original content (untouched) must still be present.
    expect(patched).toContain("rootProject.name = 'sample-rn-expo'");
  });

  it("is idempotent against real prebuild-shaped content with a leading pluginManagement+plugins header", async () => {
    const cfg1 = withRovenueAndroid(makeFakeConfig(), undefined);
    const once = await runSettingsGradleMod(cfg1, REAL_PREBUILD_SETTINGS_GRADLE);

    const cfg2 = withRovenueAndroid(makeFakeConfig(), undefined);
    const twice = await runSettingsGradleMod(cfg2, once);

    expect(twice).toBe(once);
    expect(twice.trimStart().startsWith("pluginManagement")).toBe(true);
    expect((twice.match(/includeBuild\("\.\.\/\.\.\/\.\.\/packages\/sdk-kotlin"\)/g) ?? []).length).toBe(
      1,
    );
    expect((twice.match(/dependencySubstitution/g) ?? []).length).toBe(1);
  });
});

describe("findInsertionPointAfterLeadingSettingsHeader", () => {
  it("returns -1 when the content does not start with pluginManagement/buildscript/plugins", () => {
    expect(findInsertionPointAfterLeadingSettingsHeader(MIN_SETTINGS_GRADLE)).toBe(-1);
  });

  it("skips past BOTH the pluginManagement block and the plugins{} block that follows it", () => {
    const idx = findInsertionPointAfterLeadingSettingsHeader(REAL_PREBUILD_SETTINGS_GRADLE);
    expect(idx).toBeGreaterThan(0);
    // Everything before the returned index must be exactly the header:
    // pluginManagement{...} followed by plugins{ id(...) }.
    const before = REAL_PREBUILD_SETTINGS_GRADLE.slice(0, idx);
    expect(before.trimStart().startsWith("pluginManagement")).toBe(true);
    expect(before).toContain('plugins { id("com.facebook.react.settings") }');
    expect(before.trim().endsWith('plugins { id("com.facebook.react.settings") }')).toBe(true);
    // What follows must be the rest of the original file, starting with
    // the `def getRNMinorVersion()` declaration — proving the cut landed
    // after BOTH header blocks' real closes, not after the first stray
    // `}` inside pluginManagement's nested `if (...) { ... }`, and not
    // between pluginManagement and the plugins{} block.
    const after = REAL_PREBUILD_SETTINGS_GRADLE.slice(idx);
    expect(after.trimStart().startsWith("def getRNMinorVersion()")).toBe(true);
  });
});

describe("withRovenueAndroid — app/build.gradle", () => {
  it("still injects the dev.rovenue:sdk implementation dependency", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runAppBuildGradleMod(cfg, MIN_APP_BUILD_GRADLE);
    expect(patched).toContain('implementation("dev.rovenue:sdk:0.1.0")');
  });
});
