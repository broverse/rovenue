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

// Measured as entry + every chunk it reaches: 3589 / 1121 / 39692 bytes
// gzipped. Budgets sit ~40% above — enough headroom that a few lines do not
// fail the build, tight enough that any real dependency does, which is the
// thing this guards against.
//
// The first version of this test measured the entry FILES, and with
// `splitting: true` those are often re-export stubs: react.js was 208 bytes
// pointing at a 3 KB chunk. Its 400-byte budget was therefore both unfailable
// and below the real figure, and the workspace-import scan never looked at
// the chunk where an offending import would actually live.
const BUDGETS_GZIPPED_BYTES = {
  "dist/index.js": 5_000,
  "dist/react.js": 1_600,
  "dist/paywall.js": 56_000,
} as const;

/**
 * Every file an entry point actually pulls in, entry included.
 *
 * `splitting: true` means an entry file is often a re-export stub — the built
 * `react.js` was 208 bytes pointing at a 3 KB chunk. Measuring the stub makes
 * the budget unfailable and the workspace-import scan blind to the chunk that
 * holds the real code, which is where an offending import would live.
 */
function entryFiles(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(new URL(`../${current}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/from\s*["'](\.\/[^"']+)["']/g)) {
      queue.push(`dist/${match[1]!.replace(/^\.\//, "")}`);
    }
  }
  return [...seen];
}

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

/** Gzipped size of an entry and every chunk it reaches. */
function entrySize(entry: string): number {
  return entryFiles(entry).reduce((total, f) => total + gzippedSize(f), 0);
}

describe("bundle budget", () => {
  it.each(Object.entries(BUDGETS_GZIPPED_BYTES))(
    "%s stays under budget",
    (path, budget) => {
      const size = entrySize(path);
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
    expect(entrySize("dist/index.js") * 5).toBeLessThan(
      entrySize("dist/paywall.js"),
    );
  });

  it("does not ship a workspace import a consumer cannot resolve", () => {
    // @rovenue/* packages are private and ship TypeScript sources, so
    // `workspace:*` is not resolvable from npm. They must be inlined — and
    // only the built artifact shows whether they were.
    // Scans the chunks too, not just the three entry files. With splitting,
    // an offending import lives in whichever chunk holds the code — an
    // entry-only scan looks at re-export stubs and finds nothing.
    for (const entry of Object.keys(BUDGETS_GZIPPED_BYTES)) {
      for (const path of entryFiles(entry)) {
        const source = readFileSync(
          new URL(`../${path}`, import.meta.url),
          "utf8",
        );
        expect(source, `${path} imports a workspace package`).not.toMatch(
          /from\s*["']@rovenue\//,
        );
      }
    }
  });
});
