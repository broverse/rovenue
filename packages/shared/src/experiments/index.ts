// =============================================================
// Experiments — shared bucketing, targeting, and types
// =============================================================
//
// `bucketing` and `targeting` are the correctness-critical runtime
// modules that server, SDK, and dashboard all consume to reach the
// same answer for a given (subscriberId, seed) or (attributes, rules)
// pair. `types` holds the Zod schemas and TypeScript shapes for
// experiment definitions. See docs/superpowers/specs/
// 2026-04-20-tech-stack-upgrade/05-experiment-engine.md §13.2 for
// the location decision.

export * from "./types";

// bucketing is added to this barrel in Group 3 (Task 2.2) once
// bucketing.ts lands in this directory. Re-exporting it before the
// file exists would break module resolution for every consumer of
// `@rovenue/shared`.

export {
  matchesAudience,
  validateAudienceRules,
} from "./targeting";
