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

/** Days in a weekly cycle. Named so the runtime gate reads
 *  `MINIMUM_WEEKLY_CYCLES * DAYS_PER_WEEK` rather than carrying a bare 7
 *  that could be mistaken for `MATURATION_WINDOW_DAYS`, which happens to
 *  share the value today but means something entirely different. */
export const DAYS_PER_WEEK = 7;

/** Fraction of subscribers assigned to more than one variant of the same
 *  experiment above which the recommendation is suppressed. */
export const CROSSOVER_SUPPRESSION_RATE = 0.001;

/** Relative refund-rate degradation vs. control above which a leader is
 *  not recommended and never auto-shipped. */
export const REFUND_GUARDRAIL_MARGIN = 0.25;

/** Minimum converters per variant before the value factor can be fitted —
 *  the log-variance needs at least two. */
export const MINIMUM_CONVERTERS_FOR_VALUE_MODEL = 2;

/** Relative tolerance separating a DEGENERATE log-value variance (every
 *  converter paid the same price, so the true variance is exactly zero and
 *  the value is known exactly) from a GENUINELY IMPOSSIBLE one (a negative
 *  variance, which means the sufficient statistics are inconsistent and
 *  nothing can be fitted).
 *
 *  A tolerance is needed at all because the sufficient-statistic form
 *  `Σx² − (Σx)²/n` catastrophically cancels when every observation is
 *  equal: the two terms agree to the last bit in exact arithmetic, so what
 *  survives in floating point is pure rounding noise and can land either
 *  side of zero. It is RELATIVE because that noise scales with the
 *  magnitude of the values being cancelled (~`n · meanLog²`), so an
 *  absolute epsilon would be too tight for large log-values and too loose
 *  for small ones.
 *
 *  1e-9 is roughly seven orders of magnitude above double precision's
 *  accumulated cancellation error at realistic cohort sizes (~n · 2.2e-16,
 *  i.e. ~2e-10 even at a million converters), and still seven orders of
 *  magnitude below any variance that could matter statistically — a
 *  log-value variance of 1e-9 is a coefficient of variation of ~3e-5,
 *  prices differing in their fifth decimal place. Nothing real lands in
 *  the gap. */
export const DEGENERATE_VARIANCE_RELATIVE_TOLERANCE = 1e-9;

/** Reserved synthetic cohort id for the project-level holdout (spec §4.4).
 *  No user-chosen variant id may equal this — `assertNoReservedVariantId`
 *  (experiment-create.ts) rejects it at experiment create/update time — so
 *  it can safely stand in for "no variant drawn" as the `variantId` on a
 *  held-out subscriber's exposure event without ever colliding with a real
 *  arm of whichever experiment they were withheld from. */
export const HOLDOUT_COHORT_ID = "__rovenue_holdout__";

/** Dedicated bucketing seed for holdout-cohort membership. `assignBucket`
 *  (packages/shared/src/experiments/bucketing.ts) is reused as-is — no new
 *  hash — but keyed on THIS seed rather than any experiment's own `key`.
 *  A distinct seed is the entire mechanism: it is what makes holdout
 *  membership statistically independent of every experiment's variant
 *  assignment, which is the property the whole holdout-vs-everyone
 *  revenue comparison rests on. Never reuse an experiment key (or this
 *  seed) as the other's seed. */
export const HOLDOUT_BUCKET_SEED = "__rovenue_holdout_seed__";
