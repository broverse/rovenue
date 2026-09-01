import { describe, expect, it } from "vitest";
import { isInRollout } from "@rovenue/shared/experiments";
import { HOLDOUT_BUCKET_SEED, HOLDOUT_COHORT_ID } from "./experiment-constants";

// =============================================================
// Task 8 — project-level holdout constants
// =============================================================
//
// No new hash: holdout membership is `isInRollout(subscriberId,
// HOLDOUT_BUCKET_SEED, percentage)`, the exact same primitive every
// percentage-rollout feature flag already uses (flag-engine.ts), keyed
// on a seed distinct from any experiment's own `key`. These tests pin
// the two properties the whole feature depends on:
//
//   1. The seed does not collide with a real experiment's bucketing —
//      holdout membership must be independent of variant assignment.
//   2. Threshold bucketing is monotonic in the percentage: raising it
//      can only ADD members, never remove one. This is what makes
//      raising the holdout safe and lowering it lossy (spec §4.4) —
//      asserted directly here, not inferred from reading the code.

const SUBSCRIBER_COUNT = 2_000;
const subscriberIds = Array.from(
  { length: SUBSCRIBER_COUNT },
  (_, i) => `sub_${i}`,
);

describe("HOLDOUT_COHORT_ID / HOLDOUT_BUCKET_SEED", () => {
  it("are non-empty and distinct from each other", () => {
    expect(HOLDOUT_COHORT_ID.length).toBeGreaterThan(0);
    expect(HOLDOUT_BUCKET_SEED.length).toBeGreaterThan(0);
    expect(HOLDOUT_COHORT_ID).not.toBe(HOLDOUT_BUCKET_SEED);
  });

  it("membership is deterministic across repeated calls", () => {
    for (const id of subscriberIds.slice(0, 50)) {
      const first = isInRollout(id, HOLDOUT_BUCKET_SEED, 0.3);
      const second = isInRollout(id, HOLDOUT_BUCKET_SEED, 0.3);
      expect(second).toBe(first);
    }
  });

  it("holdout membership is independent of an experiment's own bucketing", () => {
    // A real experiment seeds on its `key` (see evaluateExperiments'
    // `assignBucket(subscriberId, exp.key)`). Using a real-looking key as
    // the holdout seed would correlate holdout membership with that
    // experiment's variant draw — exactly what a DISTINCT seed prevents.
    // Proven empirically: over a real subscriber population, membership
    // in a 50% holdout and a 50% "pretend experiment" split disagree for
    // a substantial share of subscribers (independent binary variables
    // agree ~50% of the time; a shared/correlated hash would agree ~100%).
    const experimentKey = "exp_some_real_experiment";
    let agree = 0;
    for (const id of subscriberIds) {
      const heldOut = isInRollout(id, HOLDOUT_BUCKET_SEED, 0.5);
      const inTreatment = isInRollout(id, experimentKey, 0.5);
      if (heldOut === inTreatment) agree += 1;
    }
    const agreementRate = agree / SUBSCRIBER_COUNT;
    // Perfectly independent 50/50 splits agree ~50% of the time; a
    // shared seed would agree 100% of the time. 0.4-0.6 comfortably
    // rejects the "same hash" failure mode without being a flaky exact
    // match on 0.5.
    expect(agreementRate).toBeGreaterThan(0.4);
    expect(agreementRate).toBeLessThan(0.6);
  });

  it("raising the holdout percentage keeps every previously-held-out subscriber held out (monotonicity)", () => {
    const membersAt30 = subscriberIds.filter((id) =>
      isInRollout(id, HOLDOUT_BUCKET_SEED, 0.3),
    );
    expect(membersAt30.length).toBeGreaterThan(0);

    // Raise 30% -> 70%: every subscriber held out at the lower
    // percentage MUST still be held out at the higher one. Threshold
    // bucketing (bucket < percentage * BUCKET_COUNT) guarantees this —
    // a higher threshold is a superset — but the property is asserted
    // here directly rather than trusted from reading bucketing.ts.
    for (const id of membersAt30) {
      expect(isInRollout(id, HOLDOUT_BUCKET_SEED, 0.7)).toBe(true);
    }

    // And it is a STRICT superset, i.e. raising actually adds members —
    // otherwise the monotonicity check above would pass vacuously for a
    // percentage that (by some bug) never included anyone.
    const membersAt70 = subscriberIds.filter((id) =>
      isInRollout(id, HOLDOUT_BUCKET_SEED, 0.7),
    );
    expect(membersAt70.length).toBeGreaterThan(membersAt30.length);
  });

  it("lowering the holdout percentage only ever removes members, never adds one", () => {
    const membersAt70 = new Set(
      subscriberIds.filter((id) => isInRollout(id, HOLDOUT_BUCKET_SEED, 0.7)),
    );
    const membersAt30 = subscriberIds.filter((id) =>
      isInRollout(id, HOLDOUT_BUCKET_SEED, 0.3),
    );
    // Every member at the lower percentage must already have been a
    // member at the higher one — lowering cannot introduce a new member,
    // it can only drop subscribers whose exposure was already recorded.
    for (const id of membersAt30) {
      expect(membersAt70.has(id)).toBe(true);
    }
  });
});
