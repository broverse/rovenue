// The Expo config plugin ships as COMPILED output: `app.plugin.js` at the
// package root does `require("./plugin/build/index")`. Every other test in this
// directory imports the TypeScript source directly, so all of them can be green
// while the artifact Expo actually loads is stale.
//
// That is not hypothetical. On 2026-09-07 the first real `expo prebuild` of the
// example revealed that `plugin/build/withRovenueAndroid.js` was dated
// 2026-09-05 — before the dependencySubstitution fix landed (678fff16,
// cce03670, 2ca2a762 on 09-06) — and contained zero occurrences of
// `dependencySubstitution` while the source had two. Consumers got the ORIGINAL
// broken plugin: a bare `includeBuild(...)` on line 1, ahead of
// `pluginManagement`, producing both the Groovy ordering error and an
// unresolvable `dev.rovenue:sdk:0.1.0`. Unit tests green, review passed,
// ROADMAP ticked.
//
// `plugin/build/` is gitignored, so this cannot be closed by committing the
// artifact. It is closed by refusing to call the plugin "tested" when the
// thing consumers load is older than the thing under test.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(PLUGIN_DIR, "build");
const REBUILD_HINT =
  "Run `pnpm --filter @rovenue/react-native-sdk build:plugin`. " +
  "app.plugin.js loads plugin/build/, so a stale build ships the old plugin to " +
  "every consumer regardless of what these tests say about the source.";

function newestMtimeMs(dir: string, filter: (name: string) => boolean): number {
  return Math.max(
    ...readdirSync(dir)
      .filter(filter)
      .map((name) => statSync(join(dir, name)).mtimeMs),
  );
}

describe("the compiled Expo plugin is current", () => {
  it("has been built at all", () => {
    expect(
      () => statSync(join(BUILD_DIR, "index.js")),
      `plugin/build/index.js is missing — app.plugin.js cannot resolve. ${REBUILD_HINT}`,
    ).not.toThrow();
  });

  it("is not older than the TypeScript it is compiled from", () => {
    const newestSource = newestMtimeMs(PLUGIN_DIR, (n) => n.endsWith(".ts"));
    const oldestBuilt = Math.min(
      ...readdirSync(BUILD_DIR)
        .filter((n) => n.endsWith(".js"))
        .map((n) => statSync(join(BUILD_DIR, n)).mtimeMs),
    );
    expect(
      oldestBuilt,
      `plugin/build is older than plugin/*.ts — the compiled plugin does not ` +
        `include the latest source changes. ${REBUILD_HINT}`,
    ).toBeGreaterThanOrEqual(newestSource);
  });

  it("carries the Gradle dependencySubstitution rule the Android build needs", () => {
    // A direct content assertion on the specific fix that shipped uncompiled.
    // Gradle's composite substitution matches by PROJECT NAME, not by the
    // maven coordinate `dev.rovenue:sdk`, so without this rule the consuming
    // app cannot resolve the dependency at all.
    const built = readFileSync(join(BUILD_DIR, "withRovenueAndroid.js"), "utf8");
    expect(built, REBUILD_HINT).toContain("dependencySubstitution");
    expect(built, REBUILD_HINT).toContain("substitute module");
  });
});
