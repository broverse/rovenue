// =============================================================
// Experiments — shared bucketing and targeting primitives
// =============================================================
//
// These are the correctness-critical modules that server, SDK,
// and dashboard all consume to reach the same answer for a given
// (subscriberId, seed) or (attributes, rules) pair. See
// docs/superpowers/specs/2026-04-20-tech-stack-upgrade/
//   05-experiment-engine.md §13.2 for the location decision.

export {
  assignBucket,
  isInRollout,
  selectVariant,
} from "./bucketing";

export {
  matchesAudience,
  validateAudienceRules,
} from "./targeting";
