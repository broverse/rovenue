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
// content starts with a recognized header block but its real close could
// not be POSITIVELY established. A naive brace counter treats every literal
// `{`/`}` as structural — but a `}` can legitimately appear inside a string
// literal or a comment without closing anything. The design below does NOT
// try to enumerate every Groovy form well enough that a miss is provably
// impossible (that's an open-ended correctness claim nobody can discharge —
// you can never enumerate the last unhandled form). Instead it inverts the
// default: the scanner only ever advances through a span it has POSITIVELY
// classified as one of a closed, explicitly handled set (see
// skipOpaqueSpan); the instant it meets anything outside that set — an
// unrecognized string/regex form, or a GString interpolation whose nested
// content it can't fully account for — it stops and reports AMBIGUOUS_HEADER
// rather than continuing to count braces past ground it hasn't verified.
// The failure mode this errs toward is a FALSE REFUSAL (a consumer told to
// add three lines by hand), never a wrong offset (a consumer's file silently
// mangled by a tool, with a syntax error pointing at code THEY didn't
// write). A false refusal is mildly annoying; silent corruption is a much
// worse, much-harder-to-attribute outcome. AMBIGUOUS_HEADER means "don't
// guess": the caller must refuse to modify the file.
export const AMBIGUOUS_HEADER = -2;

// Internal-only signal from skipOpaqueSpan / scanDelimitedString meaning
// "I found the start of a construct outside my handled set — do not
// continue scanning past this position." Distinct from returning `start`
// unchanged (nothing special begins here; treat this character as
// ordinary Groovy code) and from any index `> start` (a span was
// positively classified and fully, confidently skipped). Never exposed
// outside this module — every caller must convert it to AMBIGUOUS_HEADER
// immediately, not attempt to interpret it as an offset.
const UNHANDLED_CONSTRUCT = -1;

/**
 * Scans a `'...'` / `"..."` / `'''...'''` / `"""..."""` string BODY,
 * starting at `bodyStart` (just past the opening `delimiter`), for the
 * matching close. `interpolated` is true for the double-quoted forms
 * (Groovy GStrings support `${...}` interpolation; single-quoted forms do
 * not — a `$`/`{` there is literal text, matching real Groovy semantics).
 *
 * When an interpolated string hits `${`, it does NOT look for the next
 * occurrence of `delimiter` to decide the string is over — that's what
 * makes `"computed: ${foo("nested")}"` corrupt-able: a naive scanner finds
 * the `"` opening `"nested"` and mistakes it for the OUTER string's close.
 * Instead it tracks the interpolation's own brace depth and recurses into
 * skipOpaqueSpan for whatever lies inside it — so a nested string (even one
 * reusing the SAME delimiter as the enclosing string) is scanned as its own
 * positively-classified span, not mistaken for the enclosing close. If that
 * recursion ever meets something outside the handled set, or the
 * interpolation's own `}` never turns up, the WHOLE string is deemed
 * unresolvable and this returns UNHANDLED_CONSTRUCT — propagating the
 * refusal outward rather than guessing where the string actually ends.
 *
 * Returns: the index just past the closing delimiter (success);
 * UNHANDLED_CONSTRUCT (an unresolvable interpolation, or nothing closed it
 * before end-of-content — treated the same way: refuse, don't guess).
 * Single-line forms (`'...'`, `"..."`) also treat an unescaped newline as
 * unterminated, since those Groovy string forms cannot legitimately span
 * lines.
 */
function scanDelimitedString(
  contents: string,
  bodyStart: number,
  delimiter: string,
  interpolated: boolean,
): number {
  const singleLine = delimiter.length === 1;
  let i = bodyStart;
  while (i < contents.length) {
    if (contents[i] === "\\") {
      i += 2;
      continue;
    }
    if (singleLine && contents[i] === "\n") {
      return UNHANDLED_CONSTRUCT;
    }
    if (contents.startsWith(delimiter, i)) {
      return i + delimiter.length;
    }
    if (interpolated && contents[i] === "$" && contents[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < contents.length && depth > 0) {
        const skipped = skipOpaqueSpan(contents, i);
        if (skipped === UNHANDLED_CONSTRUCT) {
          return UNHANDLED_CONSTRUCT;
        }
        if (skipped !== i) {
          i = skipped;
          continue;
        }
        if (contents[i] === "{") depth++;
        else if (contents[i] === "}") depth--;
        i++;
      }
      if (depth !== 0) {
        return UNHANDLED_CONSTRUCT; // interpolation's own `}` never found
      }
      continue;
    }
    i++;
  }
  return UNHANDLED_CONSTRUCT; // ran off the end before the delimiter closed
}

/**
 * Scans forward from `start` and, if a POSITIVELY CLASSIFIED span begins
 * exactly there, returns the index just past it. Returns `start` unchanged
 * when nothing special begins there (an ordinary character — including,
 * notably, `{`/`}` themselves, which the caller must count structurally).
 * Returns UNHANDLED_CONSTRUCT when `start` begins something recognizable as
 * OUTSIDE the handled set — the caller must refuse rather than continue.
 *
 * Handled (recognized, fully skipped, contents never inspected for
 * structural braces):
 *   - `'''...'''` / `"""..."""` — Groovy triple-quoted strings (can span
 *     multiple lines; `\`-escaped delimiters respected; `"""` supports
 *     `${...}` interpolation, `'''` does not — see scanDelimitedString).
 *   - `'...'` / `"..."` — single-quoted / double-quoted strings, `\`-escaped
 *     delimiters, including GStrings with `${...}` interpolation (handled
 *     by recursing into THIS function for the interpolated expression —
 *     see scanDelimitedString — not by treating the whole string as opaque
 *     text, which is what would make a nested same-delimiter quote
 *     dangerous).
 *   - `// ...` — line comments, to end of line.
 *   - `/* ... *\/` — block comments.
 *
 * Deliberately treated as OUTSIDE the handled set, on purpose, returning
 * UNHANDLED_CONSTRUCT rather than being silently mis-scanned: a bare `/`
 * that doesn't start `//` or `/*` — this is either an ordinary division
 * operator OR the start of a Groovy slashy (`/.../`) string/regex literal,
 * and there is no way to tell them apart without a real expression parser;
 * guessing wrong here is exactly the corruption this function exists to
 * prevent, so ANY bare `/` is treated as unhandled (false-refuses on
 * legitimate division inside the header — accepted, since a header doing
 * arithmetic at the top level is exotic and the alternative is corruption).
 * A `$` immediately followed by `/` (the start of dollar-slashy `$/.../$`)
 * is called out explicitly for the same reason, though in practice the
 * bare-`/` rule above would also catch it one character later.
 */
function skipOpaqueSpan(contents: string, start: number): number {
  for (const triple of ['"""', "'''"] as const) {
    if (contents.startsWith(triple, start)) {
      return scanDelimitedString(contents, start + 3, triple, triple === '"""');
    }
  }
  const ch = contents[start];
  if (ch === '"' || ch === "'") {
    return scanDelimitedString(contents, start + 1, ch, ch === '"');
  }
  if (contents.startsWith("//", start)) {
    const nl = contents.indexOf("\n", start);
    return nl === -1 ? contents.length : nl + 1;
  }
  if (contents.startsWith("/*", start)) {
    const close = contents.indexOf("*/", start + 2);
    return close === -1 ? contents.length : close + 2;
  }
  if (ch === "$" && contents[start + 1] === "/") {
    return UNHANDLED_CONSTRUCT; // dollar-slashy $/.../$
  }
  if (ch === "/") {
    return UNHANDLED_CONSTRUCT; // division, or slashy /.../ — can't tell; refuse
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
 * header block but its true close couldn't be POSITIVELY established —
 * either skipOpaqueSpan met a construct outside its handled set anywhere
 * inside the block (a bare `/`, an unresolvable GString interpolation), or
 * the scan ran off the end with braces still open. Both cases refuse
 * immediately rather than falling through to a brace count that might have
 * been thrown off by ground the scanner never actually verified — the
 * caller must refuse to modify the file rather than guess.
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
      if (skipped === UNHANDLED_CONSTRUCT) {
        // Met something outside the handled set INSIDE this block — the
        // brace count from here on can't be trusted. Refuse immediately;
        // do not keep counting past ground that wasn't verified.
        return AMBIGUOUS_HEADER;
      }
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
            "(it contains a string, comment, or code form this plugin doesn't recognize " +
            "well enough to trust a brace count past it — e.g. a Groovy slashy /.../ or " +
            "dollar-slashy $/.../$ literal, or a GString interpolation with nested quoting " +
            "it can't fully account for). Refusing to modify the file automatically to " +
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
