#!/usr/bin/env node
/* global process, console */
// sdk-doc-coverage.mjs
//
// Measures documented-public-symbol density per SDK, across the six
// language surfaces a generated reference site (rustdoc / DocC / Dokka /
// TypeDoc for sdk-rn AND sdk-web / dartdoc) would actually publish, then
// enforces a ratchet against scripts/sdk-doc-coverage.json: coverage may
// never regress below the recorded floor for an SDK.
//
// Usage:
//   node scripts/sdk-doc-coverage.mjs            # measure + enforce floors
//   node scripts/sdk-doc-coverage.mjs --json      # machine-readable report only (still enforces)
//
// Exit code is non-zero if any SDK's measured coverage falls below its
// recorded floor. Coverage above the floor never fails — the floor only
// ever moves up, and only by hand-editing sdk-doc-coverage.json.
//
// WHAT COUNTS AS A "PUBLIC SYMBOL" PER LANGUAGE (see task-19-report.md for
// the full rationale and worked examples):
//
//   Rust (core-rs):    every `pub` item — fn, struct, enum, trait, const,
//                       static, type alias — PLUS `pub` fields of `pub`
//                       structs and variants of `pub` enums (this is the
//                       same surface `#[warn(missing_docs)]` checks).
//                       `pub(crate)` / `pub(super)` / `pub(in ...)` are
//                       NOT public. `#[cfg(test)]` modules and inline
//                       `mod tests { ... }` blocks are excluded.
//
//   Swift (sdk-swift): every declaration carrying an explicit `public` (or
//                       `open`) modifier — Swift's own default for
//                       unmarked declarations is `internal`, so nothing
//                       else needs to be excluded by hand for visibility.
//                       Declarations inside a non-public enclosing type
//                       are excluded even if individually marked `public`
//                       (can't happen in valid Swift, but guarded anyway).
//
//   Kotlin (sdk-kotlin): every declaration with NO `private` / `internal`
//                       / `protected` modifier (Kotlin's default is
//                       public) AND whose enclosing scope is itself
//                       public. This is the naive-count trap the brief
//                       warned about: without the enclosing-scope check,
//                       every member of an `internal class` (the whole
//                       `internal/` package) counts as "public" because
//                       none of ITS members repeat the `internal` keyword.
//
//   React Native (sdk-rn): every binding actually reachable from
//                       `src/index.ts` — named re-exports, re-exported
//                       types, and the methods hung off the `Rovenue`
//                       object literal — resolved back to its original
//                       declaration (or, for object-literal properties
//                       declared inline, the property itself) for the
//                       TSDoc/JSDoc check. A file merely living under
//                       src/ that index.ts never re-exports (there are
//                       none today, but the rule matters for the next
//                       task) does NOT count — TypeDoc's default entry
//                       point is the package root, so an unexported
//                       symbol never gets a page.
//
//   Flutter (sdk-flutter): every symbol reachable from the barrel file
//                       `rovenue_flutter/lib/rovenue_flutter.dart`'s
//                       `export ... show ...` clauses, plus the public
//                       (non-`_`-prefixed) members of each exported
//                       class/enum/mixin. Dart/pub convention treats
//                       everything under lib/src/ as implementation
//                       detail unless re-exported — dartdoc's own
//                       coverage tooling follows the same rule.
//
// EXCLUDED EVERYWHERE: generated bindings (UniFFI output — core-rs's
// `bindgen/` crate, sdk-kotlin's `generated/librovenue.kt`, sdk-swift's
// `Generated/RovenueFFI.swift`, and anything under a `generated/` path),
// test files (`*.test.ts`, `__tests__/`, `Tests/`, `src/test/`, inline
// `#[cfg(test)]`/`mod tests`), and example apps (`sdk-flutter/example`).

import { readFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FLOORS_PATH = path.join(__dirname, "sdk-doc-coverage.json");

// ---------------------------------------------------------------------
// Generic file-walk helper
// ---------------------------------------------------------------------

function walk(dir, { exclude = [], extensions = null } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const isExcluded = (p) => exclude.some((frag) => p.includes(frag));

  function recurse(d) {
    if (isExcluded(d)) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (isExcluded(full)) continue;
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          out.push(full);
        }
      }
    }
  }
  recurse(dir);
  return out;
}

function readLines(file) {
  return readFileSync(file, "utf8").split("\n");
}

// ---------------------------------------------------------------------
// Rust (core-rs)
// ---------------------------------------------------------------------
//
// Scope: packages/core-rs/src/**/*.rs
// Excludes: packages/core-rs/bindgen (separate crate, UniFFI codegen
//   driver — not SDK surface at all), any `generated/` path (none exist
//   under src/ today, guarded for the future), `#[cfg(test)]` blocks and
//   inline `mod tests { ... }` modules.

function measureRust() {
  const files = walk(path.join(ROOT, "packages/core-rs/src"), {
    extensions: [".rs"],
    exclude: ["/generated/"],
  });

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  for (const file of files) {
    const lines = readLines(file);
    // Frame stack: track whether we're inside a `struct { }` / `enum { }`
    // body (to attribute field/variant lines correctly) and whether we're
    // inside an excluded `#[cfg(test)]` / `mod tests` block.
    const stack = []; // { kind: 'struct'|'enum'|'other', pub: bool, excluded: bool, depth: number }
    let depth = 0;
    let pendingCfgTest = false;

    const stripped = lines.map((l) => stripRustCommentsAndStrings(l));

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const code = stripped[i];

      // Track #[cfg(test)] attribute immediately preceding a mod/fn.
      if (/^#\[cfg\(test\)\]/.test(trimmed)) {
        pendingCfgTest = true;
      } else if (/^mod\s+tests\b/.test(trimmed) || (pendingCfgTest && /^mod\s+\w+/.test(trimmed))) {
        // Entering an excluded test module.
        const opensBrace = code.includes("{");
        stack.push({ kind: "other", pub: false, excluded: true, depth: depth + (opensBrace ? 1 : 0) });
        pendingCfgTest = false;
      } else if (!/^#\[/.test(trimmed)) {
        pendingCfgTest = false;
      }

      const inExcluded = stack.some((f) => f.excluded);

      // Depth bookkeeping happens after we've classified this line's
      // declaration (so a struct/enum opening line is attributed to its
      // PARENT scope, not itself).
      const enclosing = stack.length ? stack[stack.length - 1] : { kind: "other", pub: true, excluded: false };

      if (!inExcluded) {
        // Top-level / impl-level pub items.
        const itemMatch = code.match(
          /^\s*pub\s+(fn|async fn|struct|enum|trait|const|static|type)\b/,
        );
        // A struct field: `pub name: Type,` inside a struct body.
        const fieldMatch =
          enclosing.kind === "struct" && enclosing.pub && code.match(/^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        // An enum variant: bare identifier line inside a pub enum body,
        // one level below the enum's own depth. Skip attribute lines,
        // closing braces, and impl blocks that might appear nested (rare).
        const variantMatch =
          enclosing.kind === "enum" &&
          enclosing.pub &&
          /^[A-Za-z_][A-Za-z0-9_]*\s*(\(|\{|,|$)/.test(trimmed) &&
          !/^#\[/.test(trimmed);

        if (itemMatch || fieldMatch || variantMatch) {
          total++;
          if (hasDocAbove(lines, i)) {
            documented++;
          } else if (undocumentedSamples.length < 15) {
            undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
          }
        }
      }

      // Now update the scope stack based on this line's braces and
      // whether it opened a struct/enum.
      const opens = (code.match(/\{/g) || []).length;
      const closes = (code.match(/\}/g) || []).length;

      if (!inExcluded) {
        const structOrEnum = code.match(/^\s*pub\s+(struct|enum)\b/);
        if (structOrEnum && opens > 0) {
          stack.push({ kind: structOrEnum[1], pub: true, excluded: false, depth: depth + 1 });
        } else if (/^\s*(struct|enum)\b/.test(code) && opens > 0) {
          // non-pub struct/enum — still push a frame so nested lines
          // aren't mis-attributed to an outer pub struct.
          stack.push({ kind: code.match(/^\s*(struct|enum)/)[1], pub: false, excluded: false, depth: depth + 1 });
        } else if (opens > 0 && closes === 0) {
          stack.push({ kind: "other", pub: enclosing.pub, excluded: inExcluded, depth: depth + 1 });
        }
      }

      depth += opens - closes;
      while (stack.length && depth < stack[stack.length - 1].depth) {
        stack.pop();
      }
    }
  }

  return { sdk: "core-rs", total, documented, undocumentedSamples };
}

function stripRustCommentsAndStrings(line) {
  // Blank out string literal contents and `//` line comments so brace
  // counting isn't fooled by braces inside strings/comments. Doc comments
  // (`///`, `//!`) are themselves stripped to a marker-free empty line
  // here — they're detected separately by hasDocAbove.
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      out += " ";
      if (ch === '"' && line[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += " ";
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      break; // rest of line is a comment
    }
    out += ch;
  }
  return out;
}

function hasDocAbove(lines, idx) {
  // Walk upward from the declaration line, skipping attribute lines
  // (#[...], possibly stacked), stopping at the first non-attribute,
  // non-blank line. If that line is a `///` or `//!` doc comment, or the
  // declaration is inside a `/** ... */`-style block (rare in Rust, but
  // handled), it counts as documented.
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === "") return false; // blank line breaks doc association
    if (/^#\[/.test(t)) {
      i--;
      continue;
    }
    return /^\/\/\/|^\/\*\*/.test(t);
  }
  return false;
}

// ---------------------------------------------------------------------
// Swift (sdk-swift)
// ---------------------------------------------------------------------
//
// Scope: packages/sdk-swift/Sources/Rovenue/**/*.swift
// Excludes: Generated/ (UniFFI output), Tests/.

const SWIFT_DECL_RE =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(public|open)\s+(?:final\s+|static\s+|class\s+(?!func)|override\s+|mutating\s+|convenience\s+|required\s+|lazy\s+)*\b(func|class|struct|enum|protocol|var|let|init|subscript|typealias|case)\b/;

function measureSwift() {
  const files = walk(path.join(ROOT, "packages/sdk-swift/Sources/Rovenue"), {
    extensions: [".swift"],
    exclude: ["/Generated/"],
  });

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  for (const file of files) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (SWIFT_DECL_RE.test(trimmed)) {
        total++;
        if (hasSlashDocAbove(lines, i)) {
          documented++;
        } else if (undocumentedSamples.length < 15) {
          undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
        }
      }
    }
  }
  return { sdk: "sdk-swift", total, documented, undocumentedSamples };
}

function hasSlashDocAbove(lines, idx) {
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === "") return false;
    if (/^@\w+/.test(t)) {
      i--;
      continue;
    } // attribute like @discardableResult
    if (/^\/\/\/|^\/\*\*/.test(t)) return true;
    if (/\*\/$/.test(t)) {
      // could be the end of a /** ... */ block; walk up to its start
      let j = i;
      while (j >= 0 && !/^\/\*\*/.test(lines[j].trim())) j--;
      return j >= 0;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------
// Kotlin (sdk-kotlin)
// ---------------------------------------------------------------------
//
// Scope: packages/sdk-kotlin/src/main/kotlin/**/*.kt
// Excludes: generated/librovenue.kt (UniFFI output), src/test/.

const KOTLIN_DECL_RE =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(private|internal|protected|public)\s+)?(?:(?:abstract|final|open|sealed|data|inline|value|external|suspend|override|actual|expect|infix|operator|inner|companion|const|lateinit)\s+)*(fun|class|interface|object|enum class|val|var|typealias)\b/;

function measureKotlin() {
  const files = walk(path.join(ROOT, "packages/sdk-kotlin/src/main/kotlin"), {
    extensions: [".kt"],
    exclude: ["/generated/"],
  });

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  // Kinds that introduce a DECLARATIVE scope, where every subsequent
  // brace-body line is itself a candidate declaration (a class/interface/
  // object/enum body can only contain members). `fun` — and any other
  // brace body that isn't one of these — introduces an EXECUTABLE scope
  // (a function/lambda/if/when/init body), where `val`/`var`/`fun` lines
  // are LOCAL variables/functions, not public API surface, no matter how
  // public the enclosing class is. Without this distinction, a single
  // `val bridge = ObserverBridge()` local inside a public `configure()`
  // method counts as a "public symbol" — that was the ~8% estimate's
  // over-count trap in reverse (it also inflates the denominator).
  const DECLARATIVE_KINDS = new Set(["class", "interface", "object", "enum class"]);

  for (const file of files) {
    const lines = readLines(file);
    const stack = []; // { pub: bool, declarative: bool, depth: number }
    let depth = 0;
    // A class/interface/object header whose primary constructor spans
    // multiple lines (`class Rovenue private constructor(\n  val x: Y,\n) {`
    // — extremely common in this codebase) matches KOTLIN_DECL_RE with
    // `opens === 0` on the header line itself; the `{` that actually opens
    // its body arrives several lines later, possibly after further
    // declaration-shaped lines (constructor params). Without tracking
    // that as "pending", the eventual `) {` line falls through to the
    // generic non-declarative branch below and the entire class body gets
    // misclassified as executable — silently dropping every real member
    // from the count instead of correctly marking them undocumented.
    //
    // `pendingParenDepth` tracks the still-open `(...)` of that header
    // (the primary constructor's parameter list) so a BODY-LESS
    // declaration (`data class LogEntry(\n  val x: Int,\n)`, no `{}` at
    // all) correctly expires the pending scope once its parens balance
    // with no `{` following — instead of leaking it onto the NEXT
    // declaration's brace and misattributing that one's visibility.
    let pendingScope = null; // { pub, declarative } awaiting its opening brace
    let pendingParenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const code = stripLineCommentAndStrings(raw);

      const enclosing = stack.length ? stack[stack.length - 1] : null;
      const enclosingPub = enclosing ? enclosing.pub : true; // file scope is public by default
      const enclosingDeclarative = enclosing ? enclosing.declarative : true; // file scope holds declarations

      const m = code.match(KOTLIN_DECL_RE);
      let ownPub = null;
      if (m) {
        const modifier = m[1];
        ownPub = !modifier || modifier === "public"; // Kotlin default = public
      }

      if (m && enclosingDeclarative && enclosingPub && ownPub) {
        total++;
        if (hasKDocAbove(lines, i)) {
          documented++;
        } else if (undocumentedSamples.length < 15) {
          undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
        }
      }

      const opens = (code.match(/\{/g) || []).length;
      const closes = (code.match(/\}/g) || []).length;
      const parensOpen = (code.match(/\(/g) || []).length;
      const parensClose = (code.match(/\)/g) || []).length;

      if (pendingScope) {
        pendingParenDepth += parensOpen - parensClose;
        if (pendingParenDepth <= 0) {
          if (opens > 0) {
            stack.push({ ...pendingScope, depth: depth + 1 });
          }
          // else: the header's constructor parens closed with no `{`
          // anywhere — a body-less declaration. Nothing to push.
          pendingScope = null;
        }
        // else: still inside the (possibly multi-line) constructor
        // parameter list — keep waiting.
      } else if (m && enclosingDeclarative && DECLARATIVE_KINDS.has(m[2]) && opens === 0) {
        // Class/interface/object/enum header line with no brace yet —
        // remember its visibility until the brace (or end of a body-less
        // declaration) shows up.
        pendingScope = { pub: enclosingPub && ownPub, declarative: true };
        pendingParenDepth = parensOpen - parensClose;
        if (pendingParenDepth <= 0) {
          pendingScope = null; // resolved with no body on this same line
        }
      } else if (m && enclosingDeclarative && opens > 0) {
        // Push a new scope frame for a declaration whose body opens on
        // this same line, recording whether ITS effective visibility
        // (own AND enclosing) is public, and whether it's declarative,
        // so nested members inherit both restrictions correctly.
        const effectivePub = enclosingPub && ownPub;
        stack.push({ pub: effectivePub, declarative: DECLARATIVE_KINDS.has(m[2]), depth: depth + 1 });
      } else if (opens > 0 && closes === 0) {
        // Any other brace body (init {}, get()/set() accessor, if/for/
        // when/try, a local fun's own body, a lambda) is executable —
        // never declarative — regardless of what it's nested inside.
        stack.push({ pub: enclosingPub, declarative: false, depth: depth + 1 });
      }

      depth += opens - closes;
      while (stack.length && depth < stack[stack.length - 1].depth) {
        stack.pop();
      }
    }
  }
  return { sdk: "sdk-kotlin", total, documented, undocumentedSamples };
}

function stripLineCommentAndStrings(line) {
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      out += " ";
      if (ch === '"' && line[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += " ";
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

function hasKDocAbove(lines, idx) {
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === "") return false;
    if (/^@\w+/.test(t)) {
      i--;
      continue;
    }
    if (/\*\/$/.test(t)) {
      let j = i;
      while (j >= 0 && !/^\/\*\*/.test(lines[j].trim())) j--;
      return j >= 0;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------
// React Native (sdk-rn)
// ---------------------------------------------------------------------
//
// Scope: everything reachable from packages/sdk-rn/src/index.ts —
// direct/type re-exports, and the `Rovenue` object literal's own methods
// (resolved back to their source declaration, or documented inline).
// Excludes: *.test.ts, plugin/, dist/ (build output).

function measureRN() {
  const indexPath = path.join(ROOT, "packages/sdk-rn/src/index.ts");
  const indexSrc = readFileSync(indexPath, "utf8");

  const srcFiles = walk(path.join(ROOT, "packages/sdk-rn/src"), {
    extensions: [".ts", ".tsx"],
    exclude: [".test.ts", "__tests__"],
  });

  // Build name -> {file, lineIdx, lines} for every exported declaration
  // across the package (function/const/class/interface/type/enum).
  const declByName = new Map();
  const fileLines = new Map();
  for (const file of srcFiles) {
    const lines = readLines(file);
    fileLines.set(file, lines);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const m = t.match(
        /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|const|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      if (m) {
        const name = m[2];
        if (!declByName.has(name)) declByName.set(name, { file, lineIdx: i });
      }
    }
  }

  // Collect every identifier index.ts re-exports (value or type), plus
  // the property names of the `Rovenue` object literal.
  const exported = new Set();

  for (const m of indexSrc.matchAll(/export\s*(?:type)?\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      // Strip a per-specifier `type` modifier (`{ type Foo }`, TS 4.5+)
      // before taking the local/aliased name.
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) exported.add(name);
    }
  }
  // The `Rovenue` namespace object itself is a documented symbol in any
  // generated reference (it's the thing every method is a member of).
  if (/^export const Rovenue = \{/m.test(indexSrc)) {
    exported.add("Rovenue");
  }

  const rovenueObjMatch = indexSrc.match(/export const Rovenue = \{([\s\S]*?)\n\} as const;/);
  const inlineProps = new Map(); // name -> lineIdx in index.ts (for inline-defined properties)
  const indexLines = indexSrc.split("\n");
  if (rovenueObjMatch) {
    const startIdx = indexSrc.slice(0, rovenueObjMatch.index).split("\n").length - 1;
    const bodyLines = rovenueObjMatch[1].split("\n");
    for (let i = 0; i < bodyLines.length; i++) {
      const t = bodyLines[i].trim();
      // `name,` or `name: value,` or `name: (args) => {...}` — property key form.
      const pm = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|,|$)/);
      if (pm) {
        const name = pm[1];
        exported.add(name);
        if (t.includes(":") && !declByName.has(name)) {
          // Inline-defined property (e.g. addChangeListener) — its doc,
          // if any, lives directly above this line inside index.ts.
          inlineProps.set(name, startIdx + 1 + i);
        }
      }
    }
  }

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  for (const name of exported) {
    if (declByName.has(name)) {
      const { file, lineIdx } = declByName.get(name);
      total++;
      if (hasTSDocAbove(fileLines.get(file), lineIdx)) {
        documented++;
      } else if (undocumentedSamples.length < 20) {
        undocumentedSamples.push(`${path.relative(ROOT, file)}:${lineIdx + 1}: ${name}`);
      }
    } else if (inlineProps.has(name)) {
      total++;
      if (hasTSDocAbove(indexLines, inlineProps.get(name))) {
        documented++;
      } else if (undocumentedSamples.length < 20) {
        undocumentedSamples.push(`src/index.ts:${inlineProps.get(name) + 1}: ${name} (inline)`);
      }
    }
    // Names exported from index.ts that resolve to neither (e.g. a type
    // re-exported from a .d.ts-only source, or a name typo) are skipped
    // rather than silently miscounted — none observed in this codebase.
  }

  return { sdk: "sdk-rn", total, documented, undocumentedSamples };
}

function hasTSDocAbove(lines, idx) {
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === "") return false;
    if (/^@\w|^export\s*\{|^import\b/.test(t)) return false;
    if (/\*\/$/.test(t)) {
      let j = i;
      while (j >= 0 && !/^\/\*\*/.test(lines[j].trim())) j--;
      return j >= 0;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------
// Flutter (sdk-flutter)
// ---------------------------------------------------------------------
//
// Scope: everything reachable from
// packages/sdk-flutter/rovenue_flutter/lib/rovenue_flutter.dart's
// `export ... show ...` clauses, plus each exported class/enum/mixin's
// own public (non-`_`) members.
// Excludes: example/, test/, other federated packages (android/ios/
// platform_interface — those ship no dartdoc site of their own; the
// app-facing `rovenue_flutter` package is what a Flutter dev depends on
// and pub.dev would score).

function measureFlutter() {
  const libDir = path.join(ROOT, "packages/sdk-flutter/rovenue_flutter/lib");
  const barrelPath = path.join(libDir, "rovenue_flutter.dart");
  const barrelSrc = readFileSync(barrelPath, "utf8");

  // Parse `export 'src/x.dart' show A, B, C;` (and bare `export 'src/x.dart';`
  // which re-exports everything the target file itself exports/declares
  // publicly).
  const exportsByFile = []; // { file, show: Set|null }
  for (const m of barrelSrc.matchAll(/export\s+'([^']+)'(?:\s+show\s+([^;]+))?;/g)) {
    const relFile = m[1];
    const show = m[2] ? new Set(m[2].split(",").map((s) => s.trim())) : null;
    exportsByFile.push({ file: path.join(libDir, relFile), show });
  }

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  for (const { file, show } of exportsByFile) {
    if (!existsSync(file)) continue;
    const lines = readLines(file);
    const stack = []; // { pub: bool, depth: number, name: string }
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const code = stripLineCommentAndStrings(raw);

      const topLevelMatch = code.match(
        /^\s*(?:abstract\s+)?(class|enum|mixin|extension)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      const enclosing = stack.length ? stack[stack.length - 1] : null;

      // Top-level declaration: only counts if it's in the barrel's `show`
      // list (or the export has no `show`, meaning "everything").
      if (topLevelMatch && !enclosing) {
        const name = topLevelMatch[2];
        const isShown = !show || show.has(name);
        const isPublic = !name.startsWith("_");
        if (isShown && isPublic) {
          total++;
          if (hasDartDocAbove(lines, i)) {
            documented++;
          } else if (undocumentedSamples.length < 15) {
            undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
          }
        }
        const opens = (code.match(/\{/g) || []).length;
        if (opens > 0) {
          stack.push({ pub: isShown && isPublic, depth: depth + 1, name });
        }
      } else if (enclosing) {
        // Member of a class/enum/mixin already on the stack. Dart syntax
        // only allows DECLARATIONS directly inside a class/enum/mixin
        // body (fields, methods, getters/setters, constructors) — so
        // `stack.length === 1` (one level deep: directly inside the
        // top-level type, not inside one of ITS method bodies) is exactly
        // the set of lines that can legally be member declarations.
        // Anything deeper (stack.length >= 2) is executable code inside a
        // method/getter/constructor body — a local `final token = f(x);`
        // there is NOT a public symbol, no matter how the regex below
        // would otherwise read it (it matches assignment statements too).
        const atClassBodyLevel = stack.length === 1;
        const memberMatch = code.match(
          /^\s*(?:static\s+|final\s+|const\s+|late\s+|@override\s+|factory\s+)*(?:[\w<>?, ]+\s+)?(get\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(\(|=>|;|\{|=)/,
        );
        if (memberMatch && atClassBodyLevel && enclosing.pub) {
          const name = memberMatch[2];
          const isPublicName = !name.startsWith("_");
          const isKeyword = ["if", "for", "while", "switch", "return", "super", "this"].includes(name);
          if (isPublicName && !isKeyword) {
            total++;
            if (hasDartDocAbove(lines, i)) {
              documented++;
            } else if (undocumentedSamples.length < 15) {
              undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
            }
          }
        }
        const opens = (code.match(/\{/g) || []).length;
        const closes = (code.match(/\}/g) || []).length;
        if (opens > 0 && opens > closes) {
          // Push a frame regardless of depth — this may be entering a
          // method BODY (executable, uncounted below `stack.length===1`)
          // rather than another declarative scope, which is exactly why
          // deeper frames are excluded from memberMatch above.
          stack.push({ pub: enclosing.pub, depth: depth + 1, name: "nested" });
        }
      }

      const opens = (code.match(/\{/g) || []).length;
      const closes = (code.match(/\}/g) || []).length;
      depth += opens - closes;
      while (stack.length && depth < stack[stack.length - 1].depth) {
        stack.pop();
      }
    }
  }

  return { sdk: "sdk-flutter", total, documented, undocumentedSamples };
}

function hasDartDocAbove(lines, idx) {
  let i = idx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === "") return false;
    if (/^@\w/.test(t)) {
      i--;
      continue;
    }
    return /^\/\/\//.test(t);
  }
  return false;
}

// ---------------------------------------------------------------------
// Web (sdk-web)
// ---------------------------------------------------------------------
//
// Scope: everything reachable from the package's three published entry
// points (packages/sdk-web/package.json's "exports" map — ".", "./react",
// "./paywall"): src/index.ts, src/react/index.ts, src/paywall/index.tsx —
// direct/type re-exports plus declarations made directly in an entry file,
// resolved back to their original declaration site (same reachability rule
// as sdk-rn, generalized to three entry files instead of one).
//
// UNLIKE sdk-rn (whose public surface is a handful of standalone
// functions/types plus one `Rovenue` object literal), sdk-web's surface is
// almost entirely `interface`-shaped — `Rovenue`, `HttpClient`, `Identity`,
// `SdkStorage`, `EventQueue`, `EntitlementCache`, the hook state interfaces,
// etc. TypeDoc renders each interface member as its own documentable row,
// so — matching how the Rust/Swift/Kotlin/Flutter measurers above already
// expand struct/class members rather than treating the type as one opaque
// unit — every member (method or property signature) of every reachable
// exported interface is counted individually; a function/class/const/type
// alias/enum still counts as one symbol (there is no member list to expand).
// Excludes: *.test.ts(x), bundle-size.test.ts.

const WEB_ENTRY_POINTS = [
  "packages/sdk-web/src/index.ts",
  "packages/sdk-web/src/react/index.ts",
  "packages/sdk-web/src/paywall/index.tsx",
];

function measureWeb() {
  const webRoot = path.join(ROOT, "packages/sdk-web/src");
  const srcFiles = walk(webRoot, {
    extensions: [".ts", ".tsx"],
    exclude: [".test.ts", ".test.tsx", "__tests__"],
  });

  const fileLines = new Map();
  for (const file of srcFiles) fileLines.set(file, readLines(file));

  // name -> { file, lineIdx, kind } for every top-level exported
  // declaration across the package (function/const/class/interface/type/enum).
  const declByName = new Map();
  for (const file of srcFiles) {
    const lines = fileLines.get(file);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const m = t.match(
        /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|const|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      if (m && !declByName.has(m[2])) {
        declByName.set(m[2], { file, lineIdx: i, kind: m[1] });
      }
    }
  }

  // Names reachable from the three entry points: local declarations made
  // directly IN an entry file, plus `export { A, B } from "./x"` /
  // `export type { A, B } from "./x"` re-exports out of one.
  const reachable = new Set();
  for (const entryRel of WEB_ENTRY_POINTS) {
    const entryFile = path.join(ROOT, entryRel);
    if (!existsSync(entryFile)) continue;
    const src = readFileSync(entryFile, "utf8");

    for (const m of src.matchAll(/export\s*(?:type)?\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?;/g)) {
      for (const part of m[1].split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) reachable.add(name);
      }
    }
    for (const m of src.matchAll(
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
    )) {
      reachable.add(m[1]);
    }
  }

  let total = 0;
  let documented = 0;
  const undocumentedSamples = [];

  for (const name of reachable) {
    const decl = declByName.get(name);
    if (!decl) continue; // re-exported name whose declaration site wasn't found (none observed today)
    const { file, lineIdx, kind } = decl;
    const lines = fileLines.get(file);

    if (kind === "interface") {
      // Expand direct members only (one brace-depth inside the interface
      // body) — a nested inline object type inside a method signature
      // (e.g. `recordExposure(input: { ... }): Promise<void>` in the
      // Rovenue interface) sits one level deeper and must NOT be counted
      // as sibling members of the interface itself.
      let depth = 0;
      let interfaceDepth = null;
      for (let i = lineIdx; i < lines.length; i++) {
        const code = stripLineCommentAndStrings(lines[i]);
        if (i === lineIdx) {
          depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
          interfaceDepth = depth;
          continue;
        }
        if (depth === interfaceDepth) {
          const trimmed = lines[i].trim();
          const memberMatch = trimmed.match(/^(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*(\(|:)/);
          if (memberMatch) {
            total++;
            if (hasTSDocAbove(lines, i)) {
              documented++;
            } else if (undocumentedSamples.length < 20) {
              undocumentedSamples.push(`${path.relative(ROOT, file)}:${i + 1}: ${name}.${memberMatch[1]}`);
            }
          }
        }
        const opens = (code.match(/\{/g) || []).length;
        const closes = (code.match(/\}/g) || []).length;
        depth += opens - closes;
        if (depth < interfaceDepth) break; // closed the interface body
      }
    } else {
      total++;
      if (hasTSDocAbove(lines, lineIdx)) {
        documented++;
      } else if (undocumentedSamples.length < 20) {
        undocumentedSamples.push(`${path.relative(ROOT, file)}:${lineIdx + 1}: ${name}`);
      }
    }
  }

  return { sdk: "sdk-web", total, documented, undocumentedSamples };
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

function loadFloors() {
  return JSON.parse(readFileSync(FLOORS_PATH, "utf8"));
}

function pct(documented, total) {
  return total === 0 ? 0 : Math.round((documented / total) * 1000) / 10;
}

function main() {
  const asJson = process.argv.includes("--json");

  const results = [
    measureRust(),
    measureSwift(),
    measureKotlin(),
    measureRN(),
    measureFlutter(),
    measureWeb(),
  ];
  const floors = loadFloors();

  const report = results.map((r) => {
    const coverage = pct(r.documented, r.total);
    const floor = floors[r.sdk]?.floor ?? null;
    const ok = floor === null ? true : coverage >= floor;
    return { ...r, coverage, floor, ok };
  });

  if (!asJson) {
    console.log("SDK doc coverage (public symbols with a doc comment)\n");
    for (const r of report) {
      const flag = r.ok ? "OK  " : "FAIL";
      console.log(
        `[${flag}] ${r.sdk.padEnd(10)} ${r.documented}/${r.total} documented = ${r.coverage}%` +
          (r.floor !== null ? `  (floor: ${r.floor}%)` : "  (no floor recorded)"),
      );
    }
    console.log();
    const failures = report.filter((r) => !r.ok);
    if (failures.length) {
      console.log("FAILED — coverage regressed below the recorded floor:");
      for (const f of failures) {
        console.log(`  ${f.sdk}: measured ${f.coverage}% < floor ${f.floor}%`);
      }
    }
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  const failures = report.filter((r) => !r.ok);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main();
