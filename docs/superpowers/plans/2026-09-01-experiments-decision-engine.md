# Experiments Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the experiments area a decision rule — "ship / keep running / stop" — grounded in a Bayesian posterior over the metric the operator chose, and connect the four features that were built next to it but never wired: element-level experiments, holdouts, scheduling, and the results page's own recommendation.

**Architecture:** One statistical engine (Bayesian, decision-theoretic), fed by one ClickHouse reader that aggregates at the subscriber level, consumed by one results service. The two duplicate results implementations collapse to one and the unreachable richer path is deleted. Element experiments are materialised server-side into the per-variant paywall slot the placement envelope already has, so no renderer changes.

**Tech Stack:** TypeScript (strict), Hono, Drizzle/PostgreSQL, ClickHouse, BullMQ, React (Vite) dashboard, Fumadocs.

**Spec:** `docs/superpowers/specs/2026-09-01-experiments-bayesian-engine-design.md` — read it in full before Task 1. §4.1's unit-of-analysis rule, §4.6's suppression rule, and the non-goals are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts`.
- **Throttle:** `nice -n 19` on every heavy command; vitest `--maxWorkers=2`; suites strictly sequential; kill lingering vitest processes before starting another run.
- **`docker ps` first** for anything DB-, Redis- or ClickHouse-backed — check the *services* you need are up, not just the daemon. "Docker is up" is not "the stack is up".
- **`apps/api`'s `pnpm test` is two passes**: `vitest run` excludes testcontainer suites; `VITEST_CONTAINER_PASS=1 vitest run` runs them. Any number you report must name which pass it covers.
- **No change to any renderer, to `render-fixtures.json`, or to the paywall model's emitted JSON.**
- **No change to `packages/shared/src/experiments/bucketing.ts`'s algorithm, to `bucketing-vectors.json`, or to `packages/core-rs`.** Holdout reuses `assignBucket` with a different seed string; that is the whole mechanism.
- **No magic values.** Every statistical parameter is a named constant in one module or an experiment field. This is the plan's most-violated constraint by default — the code being replaced contains `estimateSampleSize(baselineForSizing, 0.1)`.
- **No self-confirming tests.** No mocked ClickHouse for anything that queries it; no test whose assertion is the thing under test restated.
- TypeScript strict. Zod for API input. Responses are `{ data }` or `{ error: { code, message } }`.
- Conventional commits. One task = one commit unless the task says otherwise.

### Confirmed facts (verified 2026-09-01 — do not re-derive; re-confirm only if something fails)

**The two results implementations**
- `apps/api/src/services/experiment-results.ts:62` `computeExperimentResults` is the SHIPPED one — wired to `GET /dashboard/experiments/:id/results` (`routes/dashboard/experiments.ts:787`) and `routes/v1/experiments.ts:235`. Its `aggregate()` hardcodes `revenueSeries: []` (`:148`) so `revenue` is always `null`, and it returns `sampleSize: null` (`:132`).
- `apps/api/src/services/experiment-engine.ts:488` `getExperimentResults` is DEAD — every reference outside its own module is a test (`tests/experiment-engine.test.ts`, plus `vi.fn()` stubs in `tests/dashboard-routes.test.ts`, `tests/audit-log.test.ts`, `tests/queries-execute-logging.test.ts`). No route, no worker.
- `experiment-engine.ts`'s LIVE exports, which must keep working: `loadBundleFromCache`, `invalidateExperimentCache`, `evaluateExperiments`, `resolveProductGroup`, `recordEvent`.

**Statistics that already exist** — `apps/api/src/lib/experiment-stats.ts`: `analyzeConversion` (two-proportion z-test), `analyzeRevenue` (Welch + normal-approx p), `estimateSampleSize` (power formula, has a private `inverseStdNormal` binary search), `checkSRM` (chi-square + Wilson-Hilferty), `analyzeFunnel`. Tested in `apps/api/tests/experiment-stats.test.ts`. `simple-statistics` is already a dependency and exports `cumulativeStdNormalProbability`, `mean`, `sampleVariance`.

**ClickHouse**
- The reader is `apps/api/src/services/analytics-router.ts`, `kind: "experiment_results"`, returning `ExperimentVariantRow { variant_id, exposures, unique_users, conversions, attributed_conversions }`. It already sub-aggregates `(variantId, subscriberId)` to compute `min(exposedAt) AS firstExposedAt`.
- `rovenue.raw_exposures`: `eventId, experimentId, variantId, projectId, subscriberId, platform, country, exposedAt, insertedAt`. ReplacingMergeTree; use `uniqExact(eventId)` for replay safety.
- `rovenue.raw_revenue_events`: `eventId, revenueEventId, projectId, subscriberId, purchaseId, productId, type, store, amountUsd, …` plus `country` (0023) and `placementId, paywallId, variantId, experimentKey` (0019). Purchase-class types are `('INITIAL','RENEWAL','TRIAL_CONVERSION','REACTIVATION')`; refund-class are `('REFUND','CHARGEBACK')` and `amountUsd` is stored POSITIVE for them (use `abs()` defensively, as `summary.ts:74` does).
- The schema-contract harness is `apps/api/src/services/metrics/schema-contract.integration.test.ts`; it enumerates exports reflectively and FAILS BY NAME on an unregistered reader. It needs `VITEST_CONTAINER_PASS=1`.

**Placements / ELEMENT**
- `apps/api/src/lib/placement-resolution.ts:138` `ResolvedPlacementData.experiment.variants[]` is already `{ variantId, weight, paywall }` — **a fully hydrated paywall per variant.** Materialising an ELEMENT variant into that slot needs NO envelope shape change and no SDK change.
- `resolvePlacement` (`:164`) never throws for a resolution failure; a bad reference falls through to the next row.
- `OVERRIDABLE_PROP_KEYS` is `packages/shared/src/paywall/schema.ts:449`, typed `as const satisfies Record<PaywallNode["type"], readonly string[]>` as of commit `28740204` — its per-node arrays are literal tuples, so `OVERRIDABLE_PROP_KEYS[nodeType]` is a literal union usable as an allowlist type.

**Experiments schema** — `packages/db/src/drizzle/schema.ts:1341`: `id, projectId, name, description, type, key, audienceId, status, variants (jsonb), metrics (jsonb), mutualExclusionGroup, startedAt, completedAt, winnerVariantId, createdAt, updatedAt`. `experimentAssignments` at `:1388`. `metrics` is a free-text `string[]` used only as a display label (`format.ts` reads `metrics[0]`) — do NOT repurpose it as a selector.

**Bucketing** — `packages/shared/src/experiments/bucketing.ts` exports `assignBucket(subscriberId: string, seed: string): number`, `selectVariant`, `isInRollout`. The `seed` parameter is the salt.

**Workers** — the house pattern, from `apps/api/src/workers/funnel-token-expirer.ts`: `<X>_QUEUE_NAME` const, `run<X>Sweep()`, `get<X>Queue()`, `schedule<X>()` (adds a repeatable job with `repeat: { pattern: REPEAT_CRON }` and a stable `REPEATABLE_JOB_ID`), `create<X>Worker()`. Wired in `apps/api/src/index.ts:186-205`. **Queue names must be unique** — three integration files sharing a queue name is the known cause of main's flaky integration tests.

**Other**
- `audit()` is `apps/api/src/lib/audit.ts:297` and runs inside the caller's Drizzle tx.
- Proceeds: `resolveCommissionRate`, `computeProceeds` in `apps/api/src/services/metrics/proceeds.ts`; `COMMISSION_RATE_PRESETS` at `:51`.
- Dashboard: `components/experiments/format.ts:122` hardcodes `confidence: 0`, `leadingVariant: null`. `experiment-hero.tsx:86` gates the "ship the winner" banner on `leadingVariant !== null`. `experiment-analysis-card.tsx` renders conversion/SRM/sampleSize rows that today always show the "unavailable" string. `useExperimentResults.ts` is the typed RPC hook.
- **Correction to spec §4.6's wording:** `services/metrics/summary.ts` computes refund rate for a project *window*, not per variant. The per-variant refund figure for the guardrail must come from the new experiment reader (Task 3), not from `summary.ts`. `summary.ts` is the precedent for the SQL, not the source of the number.

---

## Task 1: Schema — the columns every later task needs

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_experiments_decision_engine.sql` (generated, then hand-checked)

**Interfaces:**
- Produces: `experiments.primaryMetric`, `experiments.minimumDetectableEffect`, `experiments.scheduledStartAt`, `experiments.scheduledEndAt`, `experiments.startAfterExperimentId`, `experiments.autoWinnerOnStop`, `projects.holdoutPercentage`; the `experimentPrimaryMetric` pg enum.

- [ ] **Step 1: Add the enum and columns to the Drizzle schema.** `experimentPrimaryMetric` with values `CONVERSION`, `ARPU`, `PROCEEDS_PER_USER`. Then on `experiments`: `primaryMetric` (notNull, default `CONVERSION`), `minimumDetectableEffect` (numeric, notNull, default from the named constant added in Task 2 — until Task 2 exists, use the literal in the migration and replace the *code-side* default with the constant in Task 2), `scheduledStartAt`/`scheduledEndAt` (timestamptz nullable), `startAfterExperimentId` (text nullable, self-reference with `onDelete: "set null"`), `autoWinnerOnStop` (boolean notNull default false). On `projects`: `holdoutPercentage` (integer notNull default 0).
- [ ] **Step 2: Re-export the new enum from `schema.ts`'s re-export block.** Seven enums were missing from that block earlier this session, which made `drizzle-kit` emit `DROP TYPE` for each on the next generate. Find the block, add `experimentPrimaryMetric`, and confirm by running the generate in Step 3 and reading the output for `DROP TYPE`.
- [ ] **Step 3: Generate the migration and read it.** `nice -n 19 pnpm db:migrate:generate`. **Read the generated SQL before running it.** It must contain only the new enum, the new columns, and the FK/CHECK below — no `DROP TYPE`, no unrelated ALTERs. If it contains anything else, that is a finding: report it rather than editing around it.
- [ ] **Step 4: Add the CHECK constraint by hand.** `projects.holdoutPercentage` must be constrained `>= 0 AND <= 100`. Drizzle will not emit this; append it to the generated file. Trim nothing else out of the generated file.
- [ ] **Step 5: Apply and verify.** `nice -n 19 pnpm db:migrate`, then confirm every existing `experiments` row reads `primaryMetric = 'CONVERSION'` and `autoWinnerOnStop = false`, and every `projects` row reads `holdoutPercentage = 0` — the migration must be inert on existing data.
- [ ] **Step 6: Commit** `feat(experiments): schema for primary metric, scheduling and holdout`.

---

## Task 2: The Bayesian module — pure functions, no wiring

**Files:**
- Create: `apps/api/src/lib/experiment-bayes.ts`
- Create: `apps/api/src/lib/experiment-constants.ts`
- Create: `apps/api/src/lib/experiment-bayes.test.ts`
- Modify: `apps/api/src/lib/experiment-stats.ts` (comment only — label the p-values fixed-horizon)

**Interfaces:**
- Produces: `analyzeBayesian(input): BayesianAnalysis` and the constants module. Nothing imports it yet; Task 4 wires it.

- [ ] **Step 1: Write the constants module first.** Everything the spec named, in one file, each with a comment saying what it is and why it has that value:

```ts
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

/** Default minimum detectable effect (relative lift) for power planning,
 *  replacing the bare 0.1 the deleted code passed at its call site. */
export const DEFAULT_MINIMUM_DETECTABLE_EFFECT = 0.1;

/** Fraction of subscribers assigned to more than one variant of the same
 *  experiment above which the recommendation is suppressed. */
export const CROSSOVER_SUPPRESSION_RATE = 0.001;

/** Relative refund-rate degradation vs. control above which a leader is
 *  not recommended and never auto-shipped. */
export const REFUND_GUARDRAIL_MARGIN = 0.25;

/** Minimum converters per variant before the value factor can be fitted —
 *  the log-variance needs at least two. */
export const MINIMUM_CONVERTERS_FOR_VALUE_MODEL = 2;
```

- [ ] **Step 2: Write the failing tests first.** Cover, at minimum: (a) determinism — the same input computed twice returns deep-equal output; (b) the closed-form oracle below; (c) a variant with zero users does not produce `NaN`; (d) fewer than `MINIMUM_CONVERTERS_FOR_VALUE_MODEL` converters yields a null value factor rather than a fabricated one; (e) expected loss of a clearly dominant variant is near zero and of a clearly dominated one is not.

  The oracle for (b) is the exact two-variant Beta probability, which for integer parameters is a finite sum — implement it **in the test file only**, and assert the Monte Carlo result matches within a stated tolerance:

```ts
// P(B > A) for Beta(aA,bA), Beta(aB,bB) with integer parameters.
// Evan Miller's closed form; test-only oracle, never shipped code.
function exactProbBBeatsA(aA: number, bA: number, aB: number, bB: number): number {
  let total = 0;
  for (let i = 0; i < aB; i += 1) {
    total += Math.exp(
      lnBeta(aA + i, bA + bB) - Math.log(bB + i) - lnBeta(1 + i, bB) - lnBeta(aA, bA),
    );
  }
  return total;
}
```

- [ ] **Step 3: Run the tests and watch them fail.** `cd apps/api && nice -n 19 npx vitest run src/lib/experiment-bayes.test.ts --maxWorkers=2`. Paste the real failure into your report. A module whose tests were never red has not been shown to test anything.
- [ ] **Step 4: Implement the seeded sampler.** A small deterministic PRNG (mulberry32 or xorshift128 — pick one and name it), Box-Muller for normals, Marsaglia-Tsang for gammas, chi-square via gamma. **Seed from the experiment id**, not from `Date.now()` or `Math.random()`. There must be no reachable path to global randomness in this file; say so in the module comment.
- [ ] **Step 5: Implement the conversion factor.** Posterior `Beta(CONVERSION_PRIOR_ALPHA + converters, CONVERSION_PRIOR_BETA + users - converters)`. Sample by two gammas.
- [ ] **Step 6: Implement the value factor** from `(converters, sumLogValue, sumLogValueSquared)` using a Normal-Inverse-Gamma / Jeffreys posterior on `log(value)`:

```
meanLog = sumLog / n
varLog  = (sumLogSq - sumLog^2 / n) / (n - 1)
draw:  sigma2 = (n - 1) * varLog / chi2(n - 1)
       mu     = meanLog + sqrt(sigma2 / n) * z
       value  = exp(mu + sigma2 / 2)      // E[x] for log-normal
```

  Return `null` for the whole value factor when `n < MINIMUM_CONVERTERS_FOR_VALUE_MODEL` or `varLog` is not finite. Never substitute a point estimate for a missing posterior.

- [ ] **Step 7: Compose the metric.** `CONVERSION` uses the Beta draw alone; `ARPU` and `PROCEEDS_PER_USER` use `betaDraw * valueDraw` per draw (the two-part decomposition — multiply per draw, never multiply the means). Return per variant: posterior mean, equal-tailed credible interval at `CREDIBLE_LEVEL`, `probabilityBest`, `expectedLoss`.
- [ ] **Step 8: Run the tests green**, then commit `feat(experiments): Bayesian posterior module with a seeded sampler`.
- [ ] **Step 9: Label the frequentist module.** In `experiment-stats.ts`, add a header comment stating the p-values are fixed-horizon — valid at the planned sample size, not a continuous monitor — and that for >2 variants the pairwise tests are control-only with no multiplicity correction. **Comment only; change no behaviour.** Fold into the same commit or a second one, your choice.

---

## Task 3: The ClickHouse reader — subscriber-level, windowed, honest about exclusions

**Files:**
- Modify: `apps/api/src/services/analytics-router.ts`
- Test: `apps/api/src/services/analytics-router.experiment.integration.test.ts` (new)
- Modify: `apps/api/src/services/metrics/schema-contract.integration.test.ts`

**Interfaces:**
- Consumes: `MATURATION_WINDOW_DAYS` from Task 2's constants.
- Produces: an extended `ExperimentVariantRow` carrying `converters`, `sum_log_value`, `sum_log_value_sq`, `revenue_usd`, `refunds_usd`, `excluded_immature`, `excluded_crossover`, and a per-store breakdown.

- [ ] **Step 1: Restructure the query around a per-subscriber CTE.** This is the task's whole point: aggregate each subscriber's revenue first, then aggregate subscribers into variants. An order-level `sum()` would let one subscriber with three renewals count three times in a comparison that randomised subscribers. Shape:

```sql
WITH exposure AS (
  SELECT variantId, subscriberId, min(exposedAt) AS firstExposedAt
  FROM rovenue.raw_exposures
  WHERE projectId = {projectId:String} AND experimentId = {experimentId:String}
  GROUP BY variantId, subscriberId
),
crossover AS (          -- subscribers seen under >1 variant
  SELECT subscriberId FROM exposure GROUP BY subscriberId HAVING uniqExact(variantId) > 1
),
per_subscriber AS (
  SELECT
    e.variantId AS variantId,
    e.subscriberId AS subscriberId,
    e.firstExposedAt AS firstExposedAt,
    sumIf(r.amountUsd, r.type IN ('INITIAL','RENEWAL','TRIAL_CONVERSION','REACTIVATION')) AS gross,
    sumIf(abs(r.amountUsd), r.type IN ('REFUND','CHARGEBACK'))                            AS refunds
  FROM exposure e
  LEFT JOIN rovenue.raw_revenue_events r
    ON  r.subscriberId = e.subscriberId
    AND r.projectId    = {projectId:String}
    AND r.eventDate   >= e.firstExposedAt
    AND r.eventDate   <  e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY   -- the upper bound that was missing
  WHERE e.subscriberId NOT IN (SELECT subscriberId FROM crossover)
    AND e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY <= now()           -- window must have elapsed
  GROUP BY e.variantId, e.subscriberId, e.firstExposedAt
)
SELECT
  variantId                                        AS variant_id,
  count()                                          AS mature_users,
  countIf(gross - refunds > 0)                     AS converters,
  sumIf(log(gross - refunds), gross - refunds > 0) AS sum_log_value,
  sumIf(pow(log(gross - refunds), 2), gross - refunds > 0) AS sum_log_value_sq,
  sum(gross)                                       AS revenue_usd,
  sum(refunds)                                     AS refunds_usd
FROM per_subscriber
GROUP BY variantId
```

  Keep the existing `exposures` / `unique_users` / `attributed_conversions` columns — they are the un-windowed exposure counts and SRM still needs them. Return the exclusion counts (`excluded_immature`, `excluded_crossover`) as their own aggregates; a number that was dropped must be reported, never silently absent.

- [ ] **Step 2: `log()` only over strictly positive values.** `gross - refunds > 0` gates every value aggregate. A fully-refunded subscriber is not a converter (spec §4.1) — this is a deliberate semantic change from the current endpoint and must be noted in the row type's doc comment.
- [ ] **Step 3: Add the per-store split** as a second result set (or a `GROUP BY variantId, store` companion query — your call, state which and why). Proceeds need a per-store commission rate; a single blended revenue figure cannot be converted to proceeds.
- [ ] **Step 4: Write the integration test against a real ClickHouse.** Testcontainer, `VITEST_CONTAINER_PASS=1`, real rows inserted. It must prove, each with its own case: one subscriber with three renewals counts once; a subscriber exposed yesterday is excluded when the window is 7 days; a subscriber in two variants is excluded and counted as crossover; a fully-refunded subscriber is not a converter. **Do not mock the ClickHouse client anywhere in this file.**
- [ ] **Step 5: Register the reader in the schema-contract harness.** It enumerates exports reflectively and fails by name on an unregistered one — so run it and confirm it passes rather than assuming. This is the guard that exists because §5 shipped a reader querying columns that never existed, green in CI.
- [ ] **Step 6: Commit** `feat(experiments): subscriber-level windowed experiment reader`.

---

## Task 4: One results service, with a decision

**Files:**
- Modify: `apps/api/src/services/experiment-results.ts`
- Modify: `apps/api/src/services/experiment-engine.ts` (delete `getExperimentResults` + its private helpers)
- Modify: `packages/shared/src/dashboard.ts` (response type)
- Test: `apps/api/tests/experiment-results.test.ts`, and move what is worth keeping out of `apps/api/tests/experiment-engine.test.ts`

**Interfaces:**
- Consumes: Task 2's `analyzeBayesian` + constants; Task 3's reader; `resolveCommissionRate`/`computeProceeds`; `experiments.primaryMetric` and `minimumDetectableEffect` from Task 1.
- Produces: the `ExperimentResultsResponse` shape Task 5 renders.

- [ ] **Step 1: Delete the dead path.** Remove `getExperimentResults`, `VariantAggregate`, `ExperimentResults`, and the private helpers (`toNumber`, `countEventOccurrences`) from `experiment-engine.ts`, plus the now-unused `experiment-stats` imports. **Do not touch `loadBundleFromCache`, `invalidateExperimentCache`, `evaluateExperiments`, `resolveProductGroup` or `recordEvent`** — those are live. Delete the matching `describe` block from `tests/experiment-engine.test.ts` and the `vi.fn()` stubs in the three test files that mock it.
- [ ] **Step 2: Extend the response type** in `packages/shared/src/dashboard.ts`: per variant, add posterior mean, credible interval bounds, `probabilityBest`, `expectedLoss`, refund rate, and the exclusion counts. At the top level add `primaryMetric`, `recommendation` (`{ leadingVariantId, shipRecommended, blockedBy }`), `sampleSize` (now actually populated), `runtimeDays`, and the integrity block (`srm`, `crossoverRate`).
- [ ] **Step 3: Populate `sampleSize` for real.** It has returned `null` since it was written. Call `estimateSampleSize(baselineRate, experiment.minimumDetectableEffect)` — the experiment's own MDE from Task 1, never a literal.
- [ ] **Step 4: Compute proceeds per store, then combine.** Use `resolveCommissionRate` and `computeProceeds`. A store with no configured rate makes `PROCEEDS_PER_USER` **unknown for the whole experiment** — report it as unknown rather than silently substituting gross revenue for the unpriced store. Mirror what `ProceedsCard` already does.
- [ ] **Step 5: Implement the stopping rule, all four clauses.** Expected loss below `EXPECTED_LOSS_THRESHOLD`, sample gate passed, `MINIMUM_WEEKLY_CYCLES` of runtime elapsed, and no suppression firing. `blockedBy` names which clause failed — an operator asking "why is there no recommendation?" must get an answer from the payload, not from reading this file.
- [ ] **Step 6: Implement suppression.** SRM firing, crossover above `CROSSOVER_SUPPRESSION_RATE`, or the leader's refund rate worse than control by more than `REFUND_GUARDRAIL_MARGIN` each **suppress** the recommendation — `shipRecommended` is false and `leadingVariantId` is withheld. They do not annotate a recommendation that still renders.
- [ ] **Step 7: Test each clause independently.** One test per gate, each proving the gate alone withholds the recommendation while the others pass. A single "happy path" test plus a single "everything wrong" test would pass with three of the four clauses unimplemented.
- [ ] **Step 8: Commit** `feat(experiments): single results service with a Bayesian decision rule`.

---

## Task 5: The results page tells the truth

**Files:**
- Modify: `apps/dashboard/src/components/experiments/format.ts`, `experiment-analysis-card.tsx`, `experiment-hero.tsx`, `experiments-list.tsx`, `types.ts`
- Modify: `apps/dashboard/src/locales/en.json` (and any sibling locale files that exist)
- Test: alongside each component, following the existing `*.test.tsx` convention

**Interfaces:**
- Consumes: Task 4's `ExperimentResultsResponse`.

- [ ] **Step 1: Delete the hardcoded neutrals.** `format.ts:122`'s `confidence: 0` and `leadingVariant: null` come from the results endpoint. `mapApiExperiment` maps a list item that has no results attached, so either give it the results as a second argument or move the hydration to the call site — pick one, and make it impossible for a caller to get a silently-zero confidence back.
- [ ] **Step 2: Render the posterior per variant** in `variants-table.tsx` / the analysis card: posterior mean, credible interval, `probabilityBest`, `expectedLoss`. The existing p-value row stays but is labelled fixed-horizon.
- [ ] **Step 3: Make "not enough data" and "no difference" visually and textually distinct.** They mean opposite things to whoever is deciding, and today the card renders one "unavailable" string for both. Distinct copy, distinct treatment.
- [ ] **Step 4: Surface `blockedBy`.** When there is no recommendation, the page says which gate is holding it — sample, runtime, SRM, crossover, or the refund guardrail — in the operator's words.
- [ ] **Step 5: The "ship the winner" banner becomes reachable.** It has never rendered. Gate it on `recommendation.shipRecommended`, never on a p-value or a bare confidence number.
- [ ] **Step 6: Add every new i18n key.** `en.json` has no missing-key handler — an absent key renders as the raw key path in the UI. Grep the finished components for `t("` and confirm each key exists.
- [ ] **Step 7: Test.** RTL, following the existing convention in this directory. Assert the banner does NOT render when a gate is blocked, and DOES when every gate passes — the negative case is the one that matters, since the banner's whole history is being unreachable.
- [ ] **Step 8: Commit** `feat(dashboard): experiment results show the posterior and the decision`.

---

## Task 6: Element-level experiments — the backend

**Files:**
- Modify: `packages/shared/src/experiments/types.ts` (ELEMENT variant value schema)
- Modify: `apps/api/src/lib/placement-resolution.ts`
- Modify: `apps/api/src/routes/dashboard/experiments.ts` (save-time validation)
- Test: alongside each

**Interfaces:**
- Produces: `elementVariantValueSchema`; ELEMENT experiments resolving into `ResolvedPlacementData.experiment.variants[].paywall`.

- [ ] **Step 1: Give the ELEMENT variant value a typed shape.** `{ nodeId: string, props: Record<string, unknown> }` against the experiment's target paywall. `variant.value` stays `unknown` in the generic engine — the engine must keep treating it as opaque JSON — so this schema is applied at the ELEMENT-specific boundaries only: save-time validation and resolve-time materialisation.
- [ ] **Step 2: Validate at save time, not resolve time.** On create and update, an ELEMENT experiment's variant must name a `nodeId` that exists in the target paywall and props that are all in `OVERRIDABLE_PROP_KEYS[node.type]`. Reject with a `{ error: { code, message } }` naming the offending node or prop. `OVERRIDABLE_PROP_KEYS` is the right allowlist because it is exactly the set already honoured by all three renderers — a prop outside it would be silently ignored on some platform.
- [ ] **Step 3: Materialise one snapshot per variant at resolve time.** In `placement-resolution.ts`, an ELEMENT experiment hydrates the target paywall once, then emits one **patched copy per variant** into the existing `variants[].paywall` slot. The envelope shape does not change, so no SDK, renderer or fixture changes. Patch immutably — never mutate the hydrated snapshot in place, or variant B will inherit variant A's patch.
- [ ] **Step 4: Fall through, never throw.** A patch whose `nodeId` has since disappeared from the paywall must fall through to the next placement row exactly as a dangling reference already does (`resolvePlacement` never throws for a resolution failure). Save-time validation is the guard; this is the backstop.
- [ ] **Step 5: Test.** Two variants patching the same node produce two snapshots differing in exactly that node; the base paywall is unmodified; a variant naming an unknown node is rejected at save; an unknown prop is rejected at save. **Assert `render-fixtures.json` and the renderer packages have empty diffs** — that is acceptance criterion 8 and the plan's main structural claim.
- [ ] **Step 6: Commit** `feat(experiments): element-level experiments materialise per-variant snapshots`.

---

## Task 7: Element experiments in the builder

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/experiment-popover.tsx`
- Test: `apps/dashboard/src/components/paywall-builder/experiment-popover.test.tsx`

- [ ] **Step 1: Use the `ELEMENT` kind that is already declared.** The popover has `type ExperimentKind = "PAYWALL" | "ELEMENT"` and only implements PAYWALL. Add the element flow: the user picks the selected node, then the props to vary, then the per-variant values.
- [ ] **Step 2: Offer only props the schema allows.** Drive the prop list from `OVERRIDABLE_PROP_KEYS[node.type]` — the same constant the override editor now derives its union from, so the builder cannot offer a prop the backend will reject.
- [ ] **Step 3: Respect the builder's client-side-apply invariant.** Autosave clobbers server-side writes to the paywall; launching an element experiment must not write to the paywall body. It creates an experiment that references the paywall; it does not edit it.
- [ ] **Step 4: Test** following the existing convention in this directory, including that no paywall mutation is issued when an element experiment is launched.
- [ ] **Step 5: Commit** `feat(paywall-builder): launch element-level experiments from the canvas`.

---

## Task 8: Project-level holdout

**Files:**
- Modify: `apps/api/src/services/experiment-engine.ts` (`evaluateExperiments`)
- Modify: `apps/api/src/lib/placement-resolution.ts`
- Modify: `apps/api/src/routes/dashboard/experiments.ts` or the project settings route (reserved-id validation)
- Modify: the project settings dashboard route + UI for the percentage
- Test: alongside each

**Interfaces:**
- Consumes: `projects.holdoutPercentage` (Task 1); `assignBucket` from shared.
- Produces: `HOLDOUT_COHORT_ID` and `HOLDOUT_BUCKET_SEED` constants.

- [ ] **Step 1: Add the two constants** to Task 2's constants module: a reserved cohort id that no user-chosen variant id may equal, and a dedicated bucket seed string. A distinct seed is what makes holdout membership uncorrelated with variant assignment — the property the whole comparison rests on. Say that in the comment.
- [ ] **Step 2: Reject the reserved id** wherever variant ids are validated, so a user cannot create a variant that collides with the holdout cohort.
- [ ] **Step 3: Exclude held-out subscribers in `evaluateExperiments`.** `assignBucket(subscriberId, HOLDOUT_BUCKET_SEED)` under the project's percentage means every experiment returns its default/control. Do not write experiment assignments for them.
- [ ] **Step 4: Still record the exposure**, against `HOLDOUT_COHORT_ID`. A holdout that is not measured is just a smaller audience — the feature's entire value is the comparison.
- [ ] **Step 5: Stamp the decision into the placement envelope.** The variant draw is client-side, so the server decides holdout and omits the experiment entries; the client is never asked to compute membership. Confirm the SDKs tolerate an envelope with no experiment (they already do — an unknown placement returns an empty envelope, never a 404).
- [ ] **Step 6: Warn on lowering, not on raising.** Raising the percentage only adds members and leaves the accumulated comparison valid; lowering removes members whose exposures are already recorded and retroactively mixes cohorts. Audit both; the UI warns only on the lossy direction. Do not treat them as symmetric.
- [ ] **Step 7: Test.** Membership is deterministic across calls; a held-out subscriber gets control from every experiment; the exposure is still written; raising the percentage keeps every previously-held-out subscriber held out (assert this directly — it is the property that makes the feature safe to tune).
- [ ] **Step 8: Commit** `feat(experiments): project-level holdout`.

---

## Task 9: The scheduler

**Files:**
- Create: `apps/api/src/workers/experiment-scheduler.ts`
- Create: `apps/api/src/workers/experiment-scheduler.integration.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/dashboard/experiments.ts` (cycle rejection, blocked surfacing)

**Interfaces:**
- Consumes: Task 1's scheduling columns; Task 4's decision rule for `autoWinnerOnStop`.

- [ ] **Step 1: Follow the house worker pattern exactly** — `EXPERIMENT_SCHEDULER_QUEUE_NAME` (**unique**; a shared queue name is the known cause of main's flaky integration tests), `runExperimentSchedulerSweep`, `getExperimentSchedulerQueue`, `scheduleExperimentScheduler`, `createExperimentSchedulerWorker`, wired in `index.ts` beside the existing four.
- [ ] **Step 2: Claim per row.** Two instances must not both start the same experiment. Use the per-row claim pattern from the 2026-08-24 stability batch (`UPDATE … WHERE status = 'DRAFT' RETURNING`), not a read-then-write.
- [ ] **Step 3: Audit every transition** through `audit()` inside the same transaction, attributed to the scheduler rather than to a user, so the chain answers "who started this" truthfully.
- [ ] **Step 4: Reject cycles at write time.** `startAfterExperimentId` forming a cycle is a `400` on save, not a runtime detection. Walk the chain on write.
- [ ] **Step 5: Surface blocked successors.** A successor whose predecessor was deleted, or which has waited past `scheduledStartAt` by more than a named grace constant, is reported as blocked. A queued experiment that waits silently forever is indistinguishable from one that is working.
- [ ] **Step 6: `autoWinnerOnStop` reuses the manual stop-with-winner path** in `routes/dashboard/experiments.ts:544-660` — including its placement healing — rather than reimplementing the transition. When false (the default) a scheduled stop selects no winner. When true, a leader that fails the refund guardrail is not shipped.
- [ ] **Step 7: Integration test with real Postgres and Redis.** Testcontainers. Prove: a scheduled start fires; two workers cannot double-start; a chain advances on the predecessor's completion; a cycle is rejected on save; `autoWinnerOnStop = false` stops without a winner. Do not assert scheduling by mocking the clock only — the claim behaviour needs a real database.
- [ ] **Step 8: Commit** `feat(experiments): scheduler worker for start, stop and sequencing`.

---

## Task 10: Docs, ROADMAP, battery

**Files:**
- Create: `apps/docs/content/docs/guides/experiments.mdx` (confirm the right directory from `meta.json` before creating)
- Modify: `ROADMAP.md`

- [ ] **Step 1: Write the experiments docs page.** `apps/docs` has no experiments content at all today. It must state: the decision rule and all four gates; **what expected loss does and does not guarantee** (expected regret, not Type-I error); the log-normal value model and its assumption; the maturation window and that recent exposures are therefore not yet counted; that a fully-refunded purchase is not a conversion; holdout semantics including the raise/lower asymmetry; and that **the offline fallback file serves control**, since it is bundled before any variant draw. Avoid bare `{{var}}` — it breaks the MDX prerender.
- [ ] **Step 2: Tick only what shipped.** §4's five items, each with the framing correction the recon found — in particular that the statistics module already existed and that ELEMENT was already a declared type with no consumer. Do not tick anything this plan did not deliver.
- [ ] **Step 3: Update the stale scores** while you are in the file: §7 still reads 55% though the Flutter SDK shipped 2026-08-31, and §11 still reads 65% though two of its items shipped 2026-09-01. Update §4's own score too, and the table's "as of" date.
- [ ] **Step 4: Battery**, sequential and throttled, reporting real numbers and **naming which api pass each covers**: `nice -n 19 pnpm build --concurrency=2`; `@rovenue/shared`; the dashboard suite; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; then `VITEST_CONTAINER_PASS=1` for the container pass. Known-good baselines: api non-container 407 files / 3496 tests, container 10 files / 61 tests, dashboard 126 files / 1115 tests, shared 44 files / 832 tests, build 9/9. `pnpm --filter @rovenue/docs check:links` already exits 1 on a pre-existing `funnel-attribution` link — report it, do not fix it here.
- [ ] **Step 5: Commit** `docs: experiments guide and ROADMAP §4 update` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Ordering is 1 → 2 → 3 → 4 → 5, then 6 → 7, then 8, then 9, then 10.** Tasks 6-9 are independent of 5 and of each other; the order is only so the battery runs last.
- Task 2's value dies if the sampler reaches global randomness. A results page whose numbers move on refresh is worse than one with no numbers.
- Task 3's value dies if the aggregation is per order rather than per subscriber. That is the single most consequential line in this plan.
- Task 4 must delete `getExperimentResults`. Leaving two implementations is exactly what produced the situation this plan is fixing.
- Task 6 must not change any renderer, `render-fixtures.json`, or the paywall model's emitted JSON. If it seems to need to, the approach is wrong.
- No task may change `bucketing-vectors.json` or `packages/core-rs`.
