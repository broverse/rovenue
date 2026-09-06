// withRovenueAndroid — Expo config plugin mods that wire the M4 Kotlin
// façade into the consumer's Gradle build via composite build
// (settings.gradle includeBuild + app/build.gradle dep). A real Expo
// Android project ships Groovy `settings.gradle`, not Kotlin DSL
// (`expo prebuild`'s generated file is Groovy — confirmed against a real
// prebuild output, examples/sample-rn-expo/android/settings.gradle) — the
// wiring below targets that dialect.
//
// M6 hard-codes the monorepo-relative path. M7 will support an
// option-driven external path and/or a Maven Central artifact.

import { ConfigPlugin, withSettingsGradle, withAppBuildGradle } from "@expo/config-plugins";

type Options = { rovenueKotlinPath?: string } | undefined;

// Gradle settings scripts reserve a "header" region at the very top:
// `pluginManagement {}`, `buildscript {}`, and `plugins {}` blocks may
// appear there, contiguously, in that kind of grouping, but NOTHING else
// may be interleaved among them or precede a `plugins {}` block — Gradle
// enforces this with two distinct, real errors (both confirmed against
// Gradle 8.9/8.14):
//   - "The pluginManagement {} block must appear before any other
//     statements in the script." (pluginManagement isn't literally first)
//   - "only buildscript {}, pluginManagement {} and other plugins {}
//     script blocks are allowed before plugins {} blocks, no other
//     statements are allowed" (something else sits between
//     pluginManagement and a later plugins {} block)
// A real `expo prebuild`-generated `android/settings.gradle` (confirmed
// against examples/sample-rn-expo/android/settings.gradle, a genuine
// prebuild output) has BOTH: a leading `pluginManagement {}` immediately
// followed by `plugins { id("com.facebook.react.settings") }`. Naively
// inserting right after `pluginManagement` (this function's first
// version) satisfies the first rule but violates the second — the
// consumer still gets a settings-file compile error that never mentions
// Rovenue, just a different one. The fix has to skip the ENTIRE leading
// run of header blocks, not just the first one.
const LEADING_HEADER_BLOCK_RE = /^(pluginManagement|buildscript|plugins)\s*\{/;

/**
 * Finds the end of the leading run of `pluginManagement {}` / `buildscript
 * {}` / `plugins {}` blocks at the very start of a Gradle settings script
 * (any of the three, any count, any order, back to back — only
 * whitespace between them), tracking nested braces so a block containing
 * its own `if (...) { ... }` (as the RN-generated `pluginManagement`
 * block does) isn't truncated at its first inner `}`. Returns the index
 * just past the last such block — i.e. where new top-level statements can
 * safely be inserted without landing inside, or before the end of, that
 * header region. Returns -1 when the content doesn't start with any such
 * block, in which case the caller should fall back to prepending at the
 * top (unchanged from before — there's no header to respect).
 */
export function findInsertionPointAfterLeadingSettingsHeader(contents: string): number {
  let cursor = 0;
  let matchedAny = false;
  for (;;) {
    const rest = contents.slice(cursor);
    const leadingWhitespace = /^\s*/.exec(rest)?.[0].length ?? 0;
    const match = LEADING_HEADER_BLOCK_RE.exec(rest.slice(leadingWhitespace));
    if (!match) {
      break;
    }
    // match[0] already consumed the opening `{` — start the brace
    // counter at 1 and scan forward for the matching close.
    let depth = 1;
    let i = cursor + leadingWhitespace + match[0].length;
    for (; i < contents.length && depth > 0; i++) {
      if (contents[i] === "{") depth++;
      else if (contents[i] === "}") depth--;
    }
    if (depth !== 0) {
      // Unterminated block (malformed input) — don't guess past it.
      break;
    }
    cursor = i;
    matchedAny = true;
  }
  return matchedAny ? cursor : -1;
}

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
      const insertAt = findInsertionPointAfterLeadingSettingsHeader(cfg.modResults.contents);
      if (insertAt === -1) {
        cfg.modResults.contents = `${block}\n${cfg.modResults.contents}`;
      } else {
        const before = cfg.modResults.contents.slice(0, insertAt);
        const after = cfg.modResults.contents.slice(insertAt);
        cfg.modResults.contents = `${before}\n${block}${after}`;
      }
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
