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
  AMBIGUOUS_HEADER,
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

// Adversarial coverage: a naive brace counter treats every literal `{`/`}`
// as structural, but a `}` can legitimately appear inside a string
// literal or a comment without closing anything. Landing an insertion
// there doesn't just fail to find the real end of the header — it
// corrupts a real consumer's settings.gradle by inserting mid-string or
// mid-comment, producing a syntax error that points at code THIS plugin
// injected in the wrong place. Real Expo consumers hand-edit their
// settings.gradle, so this isn't theoretical. Each fixture below carries
// a `pluginManagement {}` immediately followed by `plugins { id(...) }`
// (the real shape) with one adversarial form injected into
// pluginManagement, plus a `rootProject.name` marker line right after
// the header so the true end can be asserted precisely.
describe("findInsertionPointAfterLeadingSettingsHeader — brace-blind spans", () => {
  const HEADER_TAIL = `

plugins { id("com.facebook.react.settings") }
rootProject.name = 'sampleApp'
`;

  function assertLandsAtTrueEnd(fixture: string) {
    const idx = findInsertionPointAfterLeadingSettingsHeader(fixture);
    expect(idx).not.toBe(-1);
    expect(idx).not.toBe(AMBIGUOUS_HEADER);
    const before = fixture.slice(0, idx);
    const after = fixture.slice(idx);
    // The whole adversarial pluginManagement body, AND the plugins{}
    // block that follows it, must be intact on the "before" side.
    expect(before).toContain('plugins { id("com.facebook.react.settings") }');
    expect(before.trim().endsWith('plugins { id("com.facebook.react.settings") }')).toBe(true);
    // The cut must land exactly at the true end of the header, not
    // mid-string / mid-comment / one nested closure early.
    expect(after.trimStart().startsWith("rootProject.name = 'sampleApp'")).toBe(true);
    return idx;
  }

  it("a string literal containing a stray `}` does not fool the scanner", () => {
    const fixture = `pluginManagement {
  def x = "unexpected } brace inside a string"
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a // line comment containing a stray `}` does not fool the scanner", () => {
    const fixture = `pluginManagement {
  // this comment has a stray } in it, and another } for good measure
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a /* */ block comment containing a stray `}` does not fool the scanner", () => {
    const fixture = `pluginManagement {
  /* this block comment
     has a stray } in it
     and spans multiple lines */
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a single-quoted string containing a stray `}` does not fool the scanner", () => {
    const fixture = `pluginManagement {
  def x = 'unexpected } brace inside a single-quoted string'
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a GString with ${...} interpolation and an unbalanced brace count is skipped as one opaque span, not by luck", () => {
    // The interpolated expression has ONE `{`/`}` pair from the ternary
    // plus a lone extra `}` right after it, inside the SAME string — an
    // odd, unbalanced brace count within the span. A counter that looks
    // inside the string (instead of skipping it wholesale) would get
    // this wrong regardless of which way it's wrong; skipping the whole
    // string as one opaque unit is correct independent of what's inside.
    const fixture = `pluginManagement {
  def x = "computed: \${ true ? 1 : 2 } } stray"
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a triple-quoted string containing a stray `}` and a newline does not fool the scanner", () => {
    const fixture = `pluginManagement {
  def x = """
    unexpected } brace
    inside a triple-quoted string
  """
  repositories { google() }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("a nested closure combined with a string, a line comment, and a block comment together still lands at the true end", () => {
    const fixture = `pluginManagement {
  def version = providers.exec {
    commandLine("node", "-e", "console.log('}')")
  }.standardOutput.asText.get().trim()
  // a line comment with a stray } brace
  /* a block comment
     with a stray } brace */
  if (version == "x") {
    includeBuild("some/path")
  }
}${HEADER_TAIL}`;
    assertLandsAtTrueEnd(fixture);
  });

  it("confirms the CURRENT (fixed) scanner actually differs from a naive brace counter on the string case", () => {
    // Regression guard for "fixture luck, not a structural guarantee":
    // directly demonstrate that a naive counter (blind to strings) would
    // stop after the FIRST literal `}` — which, in this fixture, is the
    // one inside the string, long before the real close.
    const fixture = `pluginManagement {
  def x = "unexpected } brace inside a string"
  repositories { google() }
}${HEADER_TAIL}`;
    const naiveIdx = (() => {
      let depth = 1;
      let i = fixture.indexOf("{") + 1;
      for (; i < fixture.length && depth > 0; i++) {
        if (fixture[i] === "{") depth++;
        else if (fixture[i] === "}") depth--;
      }
      return i;
    })();
    const fixedIdx = findInsertionPointAfterLeadingSettingsHeader(fixture);
    expect(naiveIdx).not.toBe(fixedIdx);
    // The naive index lands INSIDE the string's text, mid-statement.
    expect(fixture.slice(0, naiveIdx).endsWith("unexpected }")).toBe(true);
  });

  it("refuses (AMBIGUOUS_HEADER) rather than guess when the header's real close can't be found", () => {
    // Genuinely unterminated pluginManagement — no closing brace anywhere
    // in the content at all.
    const fixture = `pluginManagement {
  repositories { google() }
`;
    expect(findInsertionPointAfterLeadingSettingsHeader(fixture)).toBe(AMBIGUOUS_HEADER);
  });

  it("withRovenueAndroid's settingsGradle mod throws (refuses to modify) rather than corrupt an ambiguous file", async () => {
    const fixture = `pluginManagement {
  repositories { google() }
`;
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    await expect(runSettingsGradleMod(cfg, fixture)).rejects.toThrow(
      /could not safely locate the end/i,
    );
  });

  // Round-3-review regression coverage. The scanner shipped in that round
  // routed unhandled constructs to AMBIGUOUS_HEADER only when the overall
  // scan ran off the end of the content with braces still open — but a
  // stray `}` inside an UNHANDLED construct (one skipOpaqueSpan doesn't
  // recognize at all) DECREMENTS the depth counter just like a real
  // structural brace, so the scan can terminate SUCCESSFULLY at depth 0 —
  // at a confidently WRONG offset, with nothing ever throwing. The
  // reviewer demonstrated this end-to-end on three constructs, each
  // producing `includeBuild {...}` spliced into the middle of a literal.
  // The fix inverts the default: skipOpaqueSpan now returns a distinct
  // UNHANDLED_CONSTRUCT signal the INSTANT it meets one of these forms,
  // propagated as an immediate refusal rather than left to fall through
  // to brace-counting. These three fixtures are the reviewer's exact
  // constructs, each embedded in a real-shaped pluginManagement+plugins
  // header so both AMBIGUOUS_HEADER and the mod's throw path are covered.
  describe("unhandled constructs refuse immediately, not just at end-of-content", () => {
    const wrap = (statement: string) => `pluginManagement {
  ${statement}
  repositories { google() }
}${HEADER_TAIL}`;

    it("a Groovy slashy /.../ literal containing a stray `}` refuses", () => {
      const fixture = wrap("def re = /some } stray brace/");
      expect(findInsertionPointAfterLeadingSettingsHeader(fixture)).toBe(AMBIGUOUS_HEADER);
    });

    it("a Groovy dollar-slashy $/.../$ literal containing a stray `}` refuses", () => {
      const fixture = wrap("def re = $/some } stray brace/$");
      expect(findInsertionPointAfterLeadingSettingsHeader(fixture)).toBe(AMBIGUOUS_HEADER);
    });

    it("a GString interpolation with a nested SAME-delimiter quote (the JSDoc's own cited example) refuses", () => {
      // This is deliberately the exact form cited as an unhandled edge
      // case: `${...}` whose interpolated expression opens a nested
      // string reusing the enclosing `"` delimiter, without ever
      // legitimately closing the interpolation or the outer string.
      const fixture = wrap(`def x = "computed: \${foo("} tail"`);
      expect(findInsertionPointAfterLeadingSettingsHeader(fixture)).toBe(AMBIGUOUS_HEADER);
    });

    it.each([
      ["slashy", "def re = /some } stray brace/"],
      ["dollar-slashy", "def re = $/some } stray brace/$"],
      ["nested-same-delimiter-quote GString", `def x = "computed: \${foo("} tail"`],
    ])(
      "withRovenueAndroid's settingsGradle mod throws a diagnosable error for %s, rather than splicing includeBuild into the literal",
      async (_label, statement) => {
        const fixture = wrap(statement);
        const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
        const patchedOrError = await runSettingsGradleMod(cfg, fixture).then(
          (v) => ({ resolved: v as string }),
          (e) => ({ rejected: e as Error }),
        );
        expect("rejected" in patchedOrError).toBe(true);
        if ("rejected" in patchedOrError) {
          expect(patchedOrError.rejected.message).toMatch(/could not safely locate the end/i);
          // The message must actually tell the consumer what to do, not
          // just that something failed.
          expect(patchedOrError.rejected.message).toContain("includeBuild(");
          expect(patchedOrError.rejected.message).toContain("dependencySubstitution");
        }
      },
    );
  });
});

describe("withRovenueAndroid — app/build.gradle", () => {
  it("still injects the dev.rovenue:sdk implementation dependency", async () => {
    const cfg = withRovenueAndroid(makeFakeConfig(), undefined);
    const patched = await runAppBuildGradleMod(cfg, MIN_APP_BUILD_GRADLE);
    expect(patched).toContain('implementation("dev.rovenue:sdk:0.1.0")');
  });
});
