// =============================================================
// Experiments — shared constants
// =============================================================
//
// `DEFAULT_MINIMUM_DETECTABLE_EFFECT` replaces the bare `0.1` that
// `apps/api/src/services/experiment-engine.ts:623` passes as the
// second argument to `estimateSampleSize` today, and is also the
// Drizzle column default for `experiments.minimumDetectableEffect`
// (see `packages/db/src/drizzle/schema.ts`). Both call sites must
// read from here rather than re-declaring the literal, so a future
// change to the default only happens in one place.

export const DEFAULT_MINIMUM_DETECTABLE_EFFECT = 0.1;
