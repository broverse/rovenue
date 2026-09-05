import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// =============================================================
// Bundle budget
// =============================================================
//
// A budget asserted in CI turns a careless dependency into a failing test
// rather than a slow page nobody measures. The numbers below were taken from
// the first real build and rounded up modestly: a budget nothing can meet
// gets deleted, and one nothing can breach guards nothing.
//
// Only the CORE is tightly budgeted. It is what a plain site loads, and it is
// the number that decides whether a marketing page will take the SDK at all.
// The paywall entry is deliberately generous — it inlines the full builder
// renderer — and it exists as a SEPARATE entry precisely so a core-only
// consumer never pays for it. If these two ever converge, the entry split has
// stopped working.

// Measured on the first real build: 3179 / 163 / 38428 bytes gzipped. The
// budgets sit ~40% above that — enough headroom that a few lines of code do
// not fail the build, tight enough that any real dependency does. A dependency
// is the thing this is guarding against; nothing else moves these numbers by
// kilobytes.
const BUDGETS_GZIPPED_BYTES = {
  "dist/index.js": 4_500,
  "dist/react.js": 400,
  "dist/paywall.js": 54_000,
} as const;

function gzippedSize(path: string): number {
  const url = new URL(`../${path}`, import.meta.url);
  if (!existsSync(url)) {
    throw new Error(
      `${path} is missing. Run \`pnpm --filter @rovenue/web-sdk build\` first — ` +
        "this test measures the published artifact, not the source.",
    );
  }
  return gzipSync(readFileSync(url)).byteLength;
}

describe("bundle budget", () => {
  it.each(Object.entries(BUDGETS_GZIPPED_BYTES))(
    "%s stays under budget",
    (path, budget) => {
      const size = gzippedSize(path);
      expect(
        size,
        `${path} is ${size} bytes gzipped, over the ${budget} budget. If the ` +
          "growth is deliberate, raise the number in the same commit and say " +
          "why; if not, look at what was just imported.",
      ).toBeLessThan(budget);
    },
  );

  it("keeps the core far smaller than the paywall entry", () => {
    // The entry split only earns its complexity while this holds. If the core
    // ever approaches the paywall bundle, something has leaked across the
    // boundary and a core-only consumer is paying for the renderer.
    expect(gzippedSize("dist/index.js") * 5).toBeLessThan(
      gzippedSize("dist/paywall.js"),
    );
  });

  it("does not ship a workspace import a consumer cannot resolve", () => {
    // @rovenue/* packages are private and ship TypeScript sources, so
    // `workspace:*` is not resolvable from npm. They must be inlined — and
    // only the built artifact shows whether they were.
    for (const path of Object.keys(BUDGETS_GZIPPED_BYTES)) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source, `${path} imports a workspace package`).not.toMatch(
        /from\s*["']@rovenue\//,
      );
    }
  });
});
