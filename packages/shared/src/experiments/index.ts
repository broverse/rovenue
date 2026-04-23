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

export {
  assignBucket,
  isInRollout,
  selectVariant,
} from "./bucketing";

export {
  matchesAudience,
  validateAudienceRules,
} from "./targeting";
