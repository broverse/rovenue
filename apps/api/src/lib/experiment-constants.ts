// =============================================================
// Experiments — decision-engine constants
// =============================================================
//
// Every literal the Bayesian module (`experiment-bayes.ts`) and the
// frequentist module (`experiment-stats.ts`) depend on lives here, named,
// with a comment saying what it is and why it has that value. No magic
// numbers in the modules that consume these.

// `DEFAULT_MINIMUM_DETECTABLE_EFFECT` is declared in
// `packages/shared/src/experiments/constants.ts`, not here — `packages/db`'s
// Drizzle schema needs it as a column default and cannot import from
// `apps/api`. Re-exporting it (rather than redeclaring the literal) keeps
// exactly one source of truth for the number; do not copy the value here.
export { DEFAULT_MINIMUM_DETECTABLE_EFFECT } from "@rovenue/shared/experiments";

/** Uniform prior. Weak and conservative at the 1-5% conversion rates
 *  typical of mobile paywalls; stated explicitly so a future change is
 *  a decision rather than a discovery. */
export const CONVERSION_PRIOR_ALPHA = 1;
export const CONVERSION_PRIOR_BETA = 1;

/** Equal-tailed credible interval level reported per variant. */
export const CREDIBLE_LEVEL = 0.95;

/** Ship when the leader's expected loss falls below this, expressed as a
 *  fraction of the control's metric value — not an absolute amount, so it
 *  means the same thing for a conversion rate and for ARPU. */
export const EXPECTED_LOSS_THRESHOLD = 0.002;

/** Posterior draws. Fixed, so results are reproducible; large enough that
 *  the Monte Carlo error is well under EXPECTED_LOSS_THRESHOLD. */
export const POSTERIOR_DRAWS = 50_000;

/** Days after a subscriber's first exposure during which their revenue
 *  counts. Subscribers whose window has not fully elapsed are excluded
 *  from revenue metrics entirely. */
export const MATURATION_WINDOW_DAYS = 7;

/** Whole weekly cycles an experiment must run before any recommendation,
 *  regardless of sample size — guards against day-of-week and novelty. */
export const MINIMUM_WEEKLY_CYCLES = 1;

/** Fraction of subscribers assigned to more than one variant of the same
 *  experiment above which the recommendation is suppressed. */
export const CROSSOVER_SUPPRESSION_RATE = 0.001;

/** Relative refund-rate degradation vs. control above which a leader is
 *  not recommended and never auto-shipped. */
export const REFUND_GUARDRAIL_MARGIN = 0.25;

/** Minimum converters per variant before the value factor can be fitted —
 *  the log-variance needs at least two. */
export const MINIMUM_CONVERTERS_FOR_VALUE_MODEL = 2;
