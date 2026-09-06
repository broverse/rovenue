// smoke-import-error-catalog.mjs — run ONLY as a real `tsx`/Node subprocess
// (see ../error-catalog-barrel-boundary.test.ts), never imported directly by
// Vitest.
//
// This resolves `@rovenue/shared` and `@rovenue/shared/error-catalog` the
// exact way a real consumer does: through Node's native ESM resolver
// consulting packages/shared/package.json's "exports" map, walking the real
// module dependency graph in real evaluation order. That is the resolution
// path that broke (index.ts's now-removed `export * from "./error-catalog"`
// made this barrel and error-catalog.ts mutually dependent, and
// error-catalog.ts dereferences ERROR_CODE eagerly at module-evaluation
// time, which threw `ReferenceError: Cannot access 'ERROR_CODE' before
// initialization` under Node ESM). Vitest/Vite's own bundler-aware resolver
// does NOT reproduce that evaluation order, which is exactly why the
// existing `error-catalog.test.ts` (importing via relative paths, which
// bypass "exports" entirely) never caught it and still wouldn't if the
// barrel cycle came back.
//
// IMPORT ORDER IS LOAD-BEARING, do not "clean up" it. ESM evaluates a
// module's dependencies in the order its import statements list them, and
// dependency evaluation for a cyclic pair completes based on which module is
// reached FIRST from this file (the entry). Importing the bare barrel
// (`@rovenue/shared`) FIRST, then the subpath second, is what reproduces the
// crash if `index.ts` ever re-exports `error-catalog.ts` again: it forces
// `index.ts` to be evaluated as an ancestor that (if the cycle exists) pulls
// in `error-catalog.ts` as ITS OWN dependency before `index.ts`'s own body
// (including `ERROR_CODE`'s definition) runs. Reversing this order (subpath
// first) was tried and does NOT reproduce the crash even with the cycle
// present — it accidentally makes `index.ts` evaluate as error-catalog.ts's
// dependency instead, which resolves cleanly regardless of the barrel
// re-export. Confirmed by hand against both directions before writing this.
import { ERROR_CODE } from "@rovenue/shared";
import { ERROR_CATALOG } from "@rovenue/shared/error-catalog";

const codeKeys = Object.keys(ERROR_CODE);
const catalogKeys = Object.keys(ERROR_CATALOG);

if (catalogKeys.length === 0) {
  console.error("SMOKE FAIL: ERROR_CATALOG resolved empty via the @rovenue/shared barrel boundary.");
  process.exit(1);
}

if (codeKeys.length !== catalogKeys.length) {
  console.error(
    `SMOKE FAIL: barrel-boundary mismatch — @rovenue/shared's ERROR_CODE has ${codeKeys.length} keys, ` +
      `@rovenue/shared/error-catalog's ERROR_CATALOG has ${catalogKeys.length}.`,
  );
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, entries: catalogKeys.length }));
