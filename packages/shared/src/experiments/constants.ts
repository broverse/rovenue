// =============================================================
// Experiments — shared constants
// =============================================================
//
// BROWSER CODE MUST IMPORT THIS BY SUBPATH: `@rovenue/shared/experiments/
// constants`, never `@rovenue/shared/experiments`. That barrel re-exports
// `bucketing.ts`, which imports `node:crypto`, and pulling it into the
// dashboard bundle fails the Vite build with "createHash is not exported
// by __vite-browser-external". `./import/keys` exists as its own subpath
// export for exactly this reason. This file has no runtime dependencies,
// so it is safe on both sides.
//
// `DEFAULT_MINIMUM_DETECTABLE_EFFECT` replaces the bare `0.1` that
// `apps/api/src/services/experiment-engine.ts:623` passes as the
// second argument to `estimateSampleSize` today, and is also the
// Drizzle column default for `experiments.minimumDetectableEffect`
// (see `packages/db/src/drizzle/schema.ts`). Both call sites must
// read from here rather than re-declaring the literal, so a future
// change to the default only happens in one place.

export const DEFAULT_MINIMUM_DETECTABLE_EFFECT = 0.1;
