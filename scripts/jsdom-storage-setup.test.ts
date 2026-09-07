// Every vitest project running under jsdom must load the Node >= 26
// localStorage polyfill, or its storage-touching tests die before reaching
// any assertion and look like broken features rather than a broken
// environment.
//
// This is not hypothetical. On 2026-09-07 the collision produced 16 red tests
// in apps/dashboard and 6 in packages/paywall-renderer. The dashboard's were
// diagnosed and fixed first; paywall-renderer stayed broken because nothing
// connected the two. The failure mode is silent by construction — a new jsdom
// package simply never opts in — so a guard is the only thing that closes it.
//
// Deliberately a repo-wide sweep rather than a per-package assertion: the
// defect is a MISSING project, and a per-package test cannot fail for a
// package that does not exist yet.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { globSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The one implementation both jsdom projects share. A setup file counts as
// wiring it up if it mentions this basename — the import is relative and its
// depth differs per package, so matching the full path would be brittle.
const POLYFILL_BASENAME = "jsdom-node26-storage";

const VITEST_CONFIG_GLOBS = ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"];

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Resolve a config's `setupFiles` entries to absolute paths. */
function setupFilePaths(configPath: string, config: string): string[] {
  const match = /setupFiles:\s*\[([^\]]*)\]/s.exec(config);
  if (!match) return [];
  return [...match[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) =>
    resolve(dirname(configPath), m[1]!),
  );
}

describe("jsdom vitest projects load the Node >= 26 localStorage polyfill", () => {
  const configs = VITEST_CONFIG_GLOBS.flatMap((pattern) =>
    globSync(pattern, { cwd: REPO_ROOT }).map((p) => join(REPO_ROOT, p)),
  );

  const jsdomConfigs = configs.filter((path) => {
    const body = readIfPresent(path);
    return body != null && /environment:\s*["'`]jsdom["'`]/.test(body);
  });

  it("finds the jsdom projects at all (guards against a broken sweep)", () => {
    // Without this, a glob that silently matched nothing would make every
    // assertion below pass vacuously — the exact shape of failure this guard
    // exists to catch elsewhere.
    expect(configs.length).toBeGreaterThan(0);
    expect(jsdomConfigs.length).toBeGreaterThan(0);
  });

  it.each(
    jsdomConfigs.map((path) => [relative(REPO_ROOT, path), path] as const),
  )("%s wires up the polyfill", (_label, configPath) => {
    const config = readIfPresent(configPath)!;
    const setups = setupFilePaths(configPath, config);

    expect(
      setups.length,
      `${relative(REPO_ROOT, configPath)} runs under jsdom but declares no setupFiles. ` +
        `Add one importing scripts/vitest/${POLYFILL_BASENAME}, or every test in that ` +
        `package touching localStorage will fail with "Cannot read properties of ` +
        `undefined (reading 'getItem')" on Node >= 26.`,
    ).toBeGreaterThan(0);

    const wired = setups.some((setupPath) =>
      (readIfPresent(setupPath) ?? "").includes(POLYFILL_BASENAME),
    );

    expect(
      wired,
      `${relative(REPO_ROOT, configPath)} runs under jsdom, but none of its setupFiles ` +
        `imports scripts/vitest/${POLYFILL_BASENAME}. See that file for why Node >= 26 ` +
        `shadows jsdom's localStorage.`,
    ).toBe(true);
  });
});
