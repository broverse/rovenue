import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Regression guard for a real bug: `error-catalog.ts` imports `ERROR_CODE`
// from "./index" and dereferences it eagerly, at module-evaluation time, in
// the `ERROR_CATALOG` object literal. `index.ts` USED TO re-export it via
// `export * from "./error-catalog"`, which made the two modules mutually
// dependent. Under plain Node ESM resolution (any real consumer of the
// `@rovenue/shared` package — e.g. apps/docs's error-catalog generator,
// run via `tsx`, not through a bundler), that cycle threw:
//
//   ReferenceError: Cannot access 'ERROR_CODE' before initialization
//
// because importing "@rovenue/shared" makes index.ts the traversal root, so
// ALL of its dependencies (including error-catalog.ts, reached via that
// `export *`) must finish evaluating before index.ts's own top-level body
// runs — but error-catalog.ts's own dependency is index.ts itself, already
// mid-evaluation, so the ERROR_CODE binding it reads back is hoisted but not
// yet assigned.
//
// `../error-catalog.test.ts` does NOT catch this: it imports via relative
// paths (`../index`, `../error-catalog`), and Node's ESM resolver never
// consults `package.json#exports` for relative imports — it never exercises
// the barrel boundary that broke. Vitest/Vite's own resolver additionally
// does not reproduce Node's real evaluation order for this cycle, so even a
// package-specifier import of `@rovenue/shared` run *inside* Vitest would
// not have caught it either (this is exactly how the original defect
// survived Task 7's review: its own report noted the cycle, reasoned "Both
// tsc and Vitest/Vite resolved it fine", and shipped).
//
// So this test deliberately does NOT import `@rovenue/shared` in-process.
// It shells out to a real `tsx` (plain Node ESM, no bundler) subprocess that
// imports `@rovenue/shared` and `@rovenue/shared/error-catalog` by their
// real package specifiers, the way `apps/docs/scripts/generate-error-
// catalog.mjs` actually does. If the barrel cycle ever comes back, this is
// the one test in the suite that will still notice.
describe("error-catalog barrel boundary (real Node ESM resolution)", () => {
  it("resolves @rovenue/shared and @rovenue/shared/error-catalog as real package specifiers without a TDZ crash", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const packageRoot = join(__dirname, "..", "..");
    const fixture = join(__dirname, "fixtures", "smoke-import-error-catalog.mjs");

    // Resolve tsx's CLI the same way any consumer would (a real devDependency
    // of this package, not a hoisting assumption) so the subprocess gets
    // real Node ESM semantics rather than Vitest's transform.
    const require = createRequire(import.meta.url);
    const tsxCli = require.resolve("tsx/cli");

    let result;
    try {
      const stdout = execFileSync(process.execPath, [tsxCli, fixture], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      result = { ok: true, stdout };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      result = {
        ok: false,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        message: e.message ?? String(err),
      };
    }

    if (!result.ok) {
      throw new Error(
        "The @rovenue/shared barrel boundary broke under real Node ESM resolution " +
          "(packages/shared/src/index.ts <-> packages/shared/src/error-catalog.ts).\n" +
          "This almost certainly means index.ts re-exports error-catalog.ts again " +
          '(e.g. `export * from "./error-catalog"`), recreating the circular import ' +
          "whose eager top-level ERROR_CODE dereference throws a TDZ ReferenceError " +
          "under plain Node ESM (Vitest's bundler-aware resolver will NOT catch this " +
          "— it hid the original bug). Keep `@rovenue/shared/error-catalog` as its " +
          "own subpath export, never re-exported from the package root.\n\n" +
          `subprocess stderr:\n${result.stderr}\n\nsubprocess stdout:\n${result.stdout}\n\n` +
          `error: ${result.message}`,
      );
    }

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.ok, "fixture reported failure — see its own SMOKE FAIL message above").toBe(true);
    expect(parsed.entries, "ERROR_CATALOG entry count resolved via the real barrel").toBeGreaterThan(0);
  });
});
