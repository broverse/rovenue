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

// Sentinel returned by findInsertionPointAfterLeadingSettingsHeader when the
// content starts with a recognized header block but the brace-depth scan
// could not confidently locate its real close before running off the end of
// the string. A naive brace counter treats every literal `{`/`}` as
// structural — but a `}` can legitimately appear inside a string literal, a
// `//` line comment, or a `/* */` block comment, none of which close
// anything. Landing an insertion mid-string or mid-comment doesn't just fail
// to fix the defect this file exists to fix — it corrupts a real consumer's
// settings.gradle with a syntax error that never mentions Rovenue and points
// at code the plugin itself injected in the wrong place. AMBIGUOUS_HEADER
// means "don't guess": the caller must refuse to modify the file rather than
// silently inserting somewhere it can't vouch for.
export const AMBIGUOUS_HEADER = -2;

/**
 * Scans forward from `start` and, if an opaque (brace-blind) span begins
 * exactly there, returns the index just past it; otherwise returns `start`
 * unchanged. "Opaque" means: whatever `{`/`}` characters appear inside must
 * NOT be counted as structural braces, because they're inside a string
 * literal or a comment, not Groovy syntax.
 *
 * Handles:
 *   - `'''...'''` / `"""..."""` — Groovy triple-quoted strings (can span
 *     multiple lines; `\`-escaped delimiters respected).
 *   - `'...'` / `"..."` — single-quoted / double-quoted strings, including
 *     GStrings with `${...}` interpolation (the ENTIRE string, `${...}`
 *     included, is treated as one opaque span, so ordinary interpolated
 *     braces are correctly skipped as a side effect of not looking inside
 *     the string at all — not because interpolation is specifically parsed).
 *     `\`-escaped delimiters respected; unterminated at end-of-line is
 *     treated as ending at the newline (single-quoted/double-quoted Groovy
 *     strings cannot legitimately span lines).
 *   - `// ...` — line comments, to end of line.
 *   - `/* ... *\/` — block comments.
 *
 * Deliberately NOT handled (documented, not silently mishandled): a GString
 * whose `${...}` interpolated expression itself contains an unescaped
 * matching quote character (e.g. `"${foo('}')}"` — vanishingly rare in a
 * settings.gradle header); Groovy slashy (`/.../`) or dollar-slashy
 * (`$/.../$`) string/regex literals. A `}` hidden inside one of those forms
 * can still defeat the brace counter below — which is exactly the case
 * findInsertionPointAfterLeadingSettingsHeader's AMBIGUOUS_HEADER fallback
 * exists to catch by running off the end of the content without the depth
 * counter reaching zero, rather than returning a wrong-but-confident offset.
 */
function skipOpaqueSpan(contents: string, start: number): number {
  for (const triple of ['"""', "'''"] as const) {
    if (contents.startsWith(triple, start)) {
      let i = start + 3;
      while (i < contents.length) {
        if (contents[i] === "\\") {
          i += 2;
          continue;
        }
        if (contents.startsWith(triple, i)) {
          return i + 3;
        }
        i++;
      }
      return contents.length;
    }
  }
  const ch = contents[start];
  if (ch === '"' || ch === "'") {
    let i = start + 1;
    while (i < contents.length) {
      if (contents[i] === "\\") {
        i += 2;
        continue;
      }
      if (contents[i] === ch) {
        return i + 1;
      }
      if (contents[i] === "\n") {
        return i;
      }
      i++;
    }
    return contents.length;
  }
  if (contents.startsWith("//", start)) {
    const nl = contents.indexOf("\n", start);
    return nl === -1 ? contents.length : nl + 1;
  }
  if (contents.startsWith("/*", start)) {
    const close = contents.indexOf("*/", start + 2);
    return close === -1 ? contents.length : close + 2;
  }
  return start;
}

/**
 * Finds the end of the leading run of `pluginManagement {}` / `buildscript
 * {}` / `plugins {}` blocks at the very start of a Gradle settings script
 * (any of the three, any count, any order, back to back — only
 * whitespace between them), tracking nested braces so a block containing
 * its own `if (...) { ... }` (as the RN-generated `pluginManagement`
 * block does) isn't truncated at its first inner `}` — and skipping over
 * string literals and comments (see skipOpaqueSpan) so a `}` inside a
 * quoted string or a `//`/`/* *\/` comment doesn't decrement the depth
 * counter early. Returns the index just past the last such block — i.e.
 * where new top-level statements can safely be inserted without landing
 * inside, or before the end of, that header region.
 *
 * Returns -1 when the content doesn't start with any such block at all —
 * the caller should fall back to prepending at the top (unchanged from
 * before — there's no header to respect).
 *
 * Returns AMBIGUOUS_HEADER when the content DOES start with a recognized
 * header block but its true close couldn't be confidently located (the
 * scan ran off the end of the content with unclosed braces, most likely
 * because of a Groovy form skipOpaqueSpan doesn't handle) — the caller
 * must refuse to modify the file rather than guess.
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
    // counter at 1 and scan forward for the matching close, treating
    // string/comment spans as opaque (see skipOpaqueSpan).
    let depth = 1;
    let i = cursor + leadingWhitespace + match[0].length;
    while (i < contents.length && depth > 0) {
      const skipped = skipOpaqueSpan(contents, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      if (contents[i] === "{") depth++;
      else if (contents[i] === "}") depth--;
      i++;
    }
    if (depth !== 0) {
      // Ran off the end without finding the real close — don't guess.
      return AMBIGUOUS_HEADER;
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
      if (insertAt === AMBIGUOUS_HEADER) {
        // The file starts with a pluginManagement/buildscript/plugins
        // block, but its real close couldn't be confidently located
        // (see skipOpaqueSpan's documented gaps). Guessing an insertion
        // point here risks landing mid-string or mid-comment and
        // corrupting a real consumer's settings.gradle with a syntax
        // error that points at code THIS plugin injected in the wrong
        // place — strictly worse than the unresolved-dependency defect
        // this file exists to fix. Refuse and tell the consumer instead.
        throw new Error(
          "withRovenueAndroid: could not safely locate the end of the leading " +
            "pluginManagement/buildscript/plugins block(s) in android/settings.gradle " +
            "(the scan ran off the end of a string, triple-quoted string, or comment " +
            "form it doesn't recognize). Refusing to modify the file automatically to " +
            "avoid corrupting it. Please add the following manually, immediately after " +
            "that leading block:\n\n" +
            block,
        );
      } else if (insertAt === -1) {
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
