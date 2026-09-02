# Experiments — One Decision Engine, and the Wiring It Was Missing

**Date:** 2026-09-01
**Roadmap area:** §4 A/B testing & experiments (75 → 90+) — all five open items
**Scope:** closes the section. Large, but most of it is connective: the statistics
already exist and the richest implementation is unreachable.

---

## 1. Context — what reconnaissance found

Recon on 2026-09-01 read every experiment file in the repo rather than the roadmap
section. As with §5, §6 and §11 before it, the section's framing is wrong — but this
time in the more dangerous direction. §4 does not describe five missing features. It
describes **one missing decision rule and four disconnected wires.**

### 1.1 The statistics are already written, tested, and half-dead

`apps/api/src/lib/experiment-stats.ts` is a complete frequentist toolkit: a two-proportion
z-test (`analyzeConversion`), Welch's t-test with a normal-approximation p-value
(`analyzeRevenue`), a power-based sample-size planner (`estimateSampleSize`), an SRM
chi-square guardrail (`checkSRM`), and funnel drop-off (`analyzeFunnel`). It has 30+ tests
in `apps/api/tests/experiment-stats.test.ts`, including the degenerate cases.

It has **two** consumers, and they disagree about which one ships:

- `services/experiment-engine.ts:488` `getExperimentResults` — the rich one. Per-variant
  funnel, conversion stats, revenue analysis, SRM, and a computed sample size. It is
  imported by **no route and no worker**. Every reference outside its own module is a
  test. Roughly 145 lines of analysis that no user can reach.
- `services/experiment-results.ts:62` `computeExperimentResults` — the shipped one, wired
  to both `GET /dashboard/experiments/:id/results` and the v1 SDK route. It returns
  `revenue: null` **always**, because `aggregate()` hardcodes `revenueSeries: []`
  (`:148`), and `sampleSize: null` **always** (`:132`, commented "populated in Plan 2").

So the product ships the weaker of two implementations, and the stronger one is dead code
that would answer several of §4's open items today if anything called it.

### 1.2 The dashboard renders a decision it is never given

`apps/dashboard/src/components/experiments/format.ts:122` hardcodes `confidence: 0` and
`leadingVariant: null` for every experiment, with a comment that "Phase 3 will hydrate
them from the results endpoint." Phase 3 never happened. The consequences are live:

- the experiments list renders a confidence track at `width: 0%` for every row;
- `experiment-hero.tsx:86` gates the **"ship the winner"** banner on
  `leadingVariant !== null`, so that banner has never once been reachable;
- the project overview passes `confidence: null` to its panel deliberately
  (`projects/$projectId/index.tsx:219`).

The results endpoint likewise cannot supply them: it returns per-variant counts and a
pairwise p-value, never a leader or a decision.

### 1.3 ELEMENT is a declared type with no consumer

`packages/shared/src/experiments/types.ts:26` lists `ELEMENT` as one of four first-class
experiment types, the dashboard's new-experiment wizard has a whole arbitrary-JSON editor
for it (`experiments/new.tsx:1381`), and the paywall builder's experiment popover already
declares `type ExperimentKind = "PAYWALL" | "ELEMENT"`. **Nothing consumes an ELEMENT
variant.** No code path applies one to a paywall node. The value reaches the SDK as opaque
JSON, so an app developer could branch on it by hand — which is remote config, not an
element-level experiment.

### 1.4 Holdouts do not exist, and per-experiment holdouts should not

`grep -rni holdout` over the entire repository returns **zero hits** — no schema, no code,
no docs.

Worth stating up front, because it halves the work: a *per-experiment* holdout is
arithmetically identical to a control variant with a weight, which the variant model
already supports. The only holdout that adds information is the **project-level** one that
measures what the experimentation programme itself is worth.

### 1.5 Scheduling has no columns and no worker

The `experiments` table (`packages/db/src/drizzle/schema.ts:1341`) has `startedAt` and
`completedAt` — records of what happened, not intentions. There is no scheduled start, no
scheduled end, and no chaining field. `apps/api/src/workers/` has no experiment worker.
Every state transition today is a human pressing `POST /:id/start|pause|resume|stop`.

### 1.6 What already works, and works well

Not everything is a gap, and the plan must not rebuild these:

- **Bucketing** is deterministic and shared TS↔Rust via `bucketing-vectors.json`.
- **Mutual exclusion** is implemented (`experiments.mutualExclusionGroup`, honoured in
  `evaluateExperiments` at `experiment-engine.ts:218-272`).
- **Manual stop-with-winner** ships and is good: it heals placements to point at the
  winning paywall and can promote the winner to a feature flag
  (`routes/dashboard/experiments.ts:544-660`).
- **Attribution** is careful. The ClickHouse `experiment_results` query counts distinct
  exposed *subscribers* as the denominator, uses `uniqExact(eventId)` so outbox replays
  cannot double-count, and separates a precise `attributed_conversions` (from the
  purchase's own `presentedContext`) from the exposure-join heuristic — with the PAYWALL-
  only limitation documented at the type.
- **SRM** is computed and surfaced.

### 1.7 The shape

§4's five items are not five features. They are **one missing thing — a decision rule —
plus the wiring to reach it.** There is no answer anywhere in the system to "should I ship
this?": there is a p-value, and a p-value read repeatedly is a peeking trap, not a
decision. Every other gap is a wire that was left unconnected next to the part it should
have connected to.

## 2. Goals

1. One statistical framework that answers "ship / keep running / stop" for a chosen
   metric, valid when read continuously, with expected loss as the stopping quantity.
2. Winner selection on **revenue** metrics (ARPU and post-commission proceeds), not only
   on conversion rate.
3. Credible intervals and explicit minimum-sample, minimum-runtime and data-integrity
   warnings on the results page, so no decision is offered before it can be trusted — and
   one refund-rate guardrail, because §4.5 can ship a winner without a human.
4. Element-level experiments that actually change an element, on all three renderers,
   without touching any renderer.
5. A project-level holdout that measures the cumulative value of experimentation.
6. Scheduled start/stop and per-placement sequencing, run by a worker rather than a human.
7. Exactly one results implementation. The dead one goes.

## 3. Non-goals

- **No new bucketing algorithm.** Holdout and element assignment reuse the existing shared
  hash with a distinct salt string. `bucketing-vectors.json` and `packages/core-rs` are
  **not** touched — that file is the TS↔Rust contract and this work does not need it.
- **No renderer change.** Not `packages/paywall-renderer`, not SwiftUI, not Android Views,
  and not `render-fixtures.json`. §4.3 is designed specifically so this holds.
- **No multi-armed bandits / adaptive allocation.** Fixed weights stay. Bandits change what
  the assignment log means and deserve their own spec.
- **No CUPED or other variance reduction.** Worth doing later; it is an optimisation of a
  decision rule that does not exist yet.
- **No guardrail-metric framework.** §4.6 adds exactly one guardrail — refund rate —
  because automated shipping without it is unsafe. Configurable guardrails, custom metric
  definitions and metric libraries are a separate spec.
- **No auto-shipping of winners by default.** See §4.6.
- **Not rewriting the frequentist toolkit.** It stays, correctly labelled (§4.1).
- **No SDK-side change.** Every decision in this spec is made server-side; the envelope
  shapes the SDKs already parse do not change.

---

## 4. Design

### 4.1 One engine: Bayesian decision-theoretic, frequentist demoted to a cross-check

Add `apps/api/src/lib/experiment-bayes.ts` beside the existing stats module.

**Conversion — Beta-Binomial.** With a uniform `Beta(1, 1)` prior, each variant's posterior
is `Beta(1 + conversions, 1 + users − conversions)`. This is exact, conjugate, and needs
only the two counts the ClickHouse query already returns.

**Revenue per user — two-part decomposition, log-normal value factor.** Revenue per exposed
user is zero-inflated: most users pay nothing, a few pay a lot, so a t-test on it is badly
behaved at realistic mobile sample sizes. Decompose it the way the literature does:

```
revenue_per_user  =  P(convert)  ×  E[revenue | converted]
                     Beta            log-Normal
```

**The unit of analysis is the subscriber, because the subscriber is the unit of
randomisation.** This is the rule the whole section turns on: an order-level model would
let one user with three renewals count three times in a comparison that randomised users,
which silently inflates the variance and can flip a decision. So the value factor is
fitted over **net revenue per converting subscriber**, formed by aggregating that
subscriber's revenue events first and the variants second.

Model `log(net revenue per converter)` as Normal with unknown mean and variance
(Normal-Inverse-Gamma, conjugate), so `E[revenue | converted] = exp(μ + σ²/2)` follows from
the posterior. It needs exactly three aggregates per variant — `converters`,
`sum(log x)`, `sum(log(x)²)` — so no per-user series ever leaves ClickHouse, and it does
not carry the exponential model's `mean = sd` constraint, which is plainly false for
subscription prices that cluster around a handful of price points.

Two consequences to make explicit rather than discover:

- **A fully refunded purchase is not a conversion.** A subscriber whose net revenue is ≤ 0
  after refunds is excluded from both factors — the conversion numerator and the value
  fit — rather than being counted as a conversion worth nothing. Counting it as a
  conversion would reward a variant that drives purchases users immediately reverse, which
  is the opposite of what the experiment is for. `log(x)` is only ever taken over strictly
  positive values, so this is also what keeps the model defined.
- The existing Welch t-test is retained as an independent cross-check on raw per-subscriber
  revenue. It shares neither the log-normality nor the conjugacy assumption, so agreement
  between them is informative and disagreement is a flag worth showing.

**A maturation window, not "everything since exposure".** The current ClickHouse query
joins revenue with `r.eventDate >= e.firstExposedAt` and **no upper bound**, so a
subscriber exposed in week one has had weeks to accumulate revenue while one exposed
yesterday has had a day. Comparing arms that ramped at different times — or comparing a
holdout cohort against everyone else — then measures exposure age, not treatment. Fix it
with a fixed per-subscriber observation window (a named constant, e.g. 7 days from first
exposure): revenue counts only inside the window, and **a subscriber whose window has not
fully elapsed is excluded from the revenue metric entirely** rather than contributing a
partial sum. Conversion-rate metrics get the same treatment for the same reason.

**Crossover contamination is detected, not assumed away.** Assignment is sticky, but
subscriber merge and transfer can genuinely land one subscriber in two variants of the same
experiment. Count subscribers with more than one variant assignment, exclude them from the
analysis, and surface the count beside SRM. A silent crossover biases both arms toward each
other, which makes a real winner look like a tie — the failure mode nobody goes looking
for.

**Decision quantities.** For each variant: `probabilityBest`, `expectedLoss` (the expected
regret of shipping this variant when another is truly better), and an equal-tailed
credible interval at a named level. For two variants the Beta case has a closed form,
which the tests use as an oracle; the general k-variant case is Monte Carlo.

**Monte Carlo must be deterministic.** Seed the sampler from the experiment id, not from
system entropy. An unseeded sampler makes the same experiment show a different probability
on every dashboard refresh — the single most damaging thing this feature could do to a
user's trust in it. Draw count and seed derivation are named constants.

**The stopping rule**, which is what §4 has actually been missing:

> Declare a leader when its `expectedLoss` is below the caution threshold, **and** the
> minimum-sample gate has been passed, **and** the experiment has run for at least the
> minimum number of whole weekly cycles, **and** no guardrail or integrity check has fired.

Every clause is load-bearing:

- Expected loss alone fires on tiny samples, where the posterior is wide and the loss is
  small by accident.
- The **runtime** gate is not implied by the sample gate. A high-traffic app can pass any
  sample threshold inside a single day and ship a decision made entirely on one weekday's
  mix of users — the classic novelty/day-of-week trap. Whole weekly cycles, as a named
  constant.
- Integrity and guardrails suppress, they do not annotate (§4.6).

**What expected loss does and does not buy.** It bounds *expected regret under the model's
prior* — it is not a Type-I error rate, and calling continuous monitoring "safe" without
that qualifier would be the same overclaim in Bayesian clothing that the p-value made in
frequentist clothing. Anyone who needs error-rate guarantees under continuous monitoring
needs sequential frequentist machinery, which this spec deliberately does not build (§3).
Say this in the module comment and on the docs page.

**Every statistical parameter is named or configured, none are magic.** The dead path
called `estimateSampleSize(baselineForSizing, 0.1)` — a bare `0.1` minimum detectable
effect invented at the call site, which is both a magic value and the single input that
most determines whether an experiment is adequately powered. The MDE becomes an
experiment-level field set at creation (with a named default), and α, power, the credible
level, the prior, the expected-loss threshold, the Monte Carlo draw count, the maturation
window and the minimum weekly cycles are all named constants in one place.

**The frequentist module stays**, with two changes: its p-values are labelled in the API and
UI as *fixed-horizon* — valid at the planned sample size, not as a continuous monitor — and
where an experiment has more than two variants, the pairwise tests are computed **against
control only** and carry no multiplicity correction. Both facts are exactly why they are a
cross-check and not a decision input; the existing `confidenceLabel` must not be used as a
stopping signal anywhere.

**The dead path is deleted.** `getExperimentResults` in `experiment-engine.ts` and the
types it owns come out; anything valuable in it (the per-variant funnel, the sample-size
computation) moves into the surviving service. Deleting it is part of the work, not
cleanup to do later — leaving two implementations is what produced this situation.

### 4.2 Feeding the engine: revenue reaches the results service

The ClickHouse `experiment_results` query returns counts only. Extend it — the exposure ⋈
revenue join it already performs is where the numbers are — but extend it **through a
per-subscriber sub-aggregate**, per §4.1's unit rule: fold each subscriber's revenue events
inside their maturation window into one net figure first, then aggregate subscribers into
variants. The query already sub-aggregates by `(variantId, subscriberId)` to find
`min(exposedAt)`, so this extends a shape that exists rather than introducing one.

Per variant it must then return: `converters` (subscribers with net revenue > 0),
`sum(log net)`, `sum(log(net)²)`, the raw `revenue_sum`, the count of subscribers excluded
for an unelapsed maturation window, the count excluded for crossover, and the same figures
**split by store**, because proceeds need a per-store commission rate.

**This query must be registered in §5's schema-contract harness**
(`services/metrics/schema-contract.integration.test.ts`), and its tests must not mock
ClickHouse. That harness exists because §5 shipped a metrics reader querying columns that
had never existed, green in CI and broken live, precisely because every test mocked the
client. A new reader that skips the harness reproduces that failure exactly.

Proceeds reuse §5's shipped work: `resolveCommissionRate` and `computeProceeds` in
`services/metrics/proceeds.ts`. Do not re-derive commission logic. A project with no
configured rate for a store must yield "proceeds unknown" for that store and the metric
must degrade honestly, exactly as `ProceedsCard` already does — never silently substitute
gross revenue for proceeds.

Add a `primaryMetric` column to `experiments` (`CONVERSION` | `ARPU` | `PROCEEDS_PER_USER`,
defaulting to `CONVERSION` so every existing row keeps its current meaning). The decision
rule runs on the primary metric; the others are still computed and shown. The existing
free-text `metrics` array is descriptive labelling and stays as it is — it is not a
selector and must not be repurposed into one.

### 4.3 Element-level experiments — materialise variants server-side

The constraint that decides this design: **the placement variant draw is client-side.**
`GET /v1/placements/:identifier` returns an envelope and the SDK picks a variant with the
shared deterministic bucketing. So the server cannot know which variant a given device
will draw, and therefore cannot send one patched paywall.

Two candidate designs follow from that, and only one is cheap:

- Send the base snapshot plus a per-variant patch, and have the client apply it. This
  requires patch-application logic in the web renderer, SwiftUI, Android Views, and the
  offline fallback — a new four-place contract, exactly the kind this codebase has learned
  to avoid.
- **Send one fully materialised snapshot per variant.** The server applies each variant's
  node patch to the published snapshot and emits N snapshots — which is *precisely the
  envelope shape a PAYWALL experiment already produces*, where each variant carries its own
  `paywallId`. The client picks a snapshot, as it already does. **Zero renderer changes,
  zero fixture changes, and all three platforms plus the on-device preview get it for
  free.**

Take the second. An ELEMENT variant's value gains a typed shape —
`{ nodeId, props }` against the experiment's target paywall — and the props a variant may
patch are **allow-listed by `OVERRIDABLE_PROP_KEYS`**, the shared constant whose
schema-to-editor link became a compile-time guarantee earlier today. That is the right
allowlist for a reason beyond convenience: it is exactly the set of props already declared
safe to vary per-context and already honoured by all three renderers. Reusing it means an
element experiment can never target a prop some platform silently ignores.

Consequences to accept and document:

- The envelope grows by roughly one snapshot per extra variant, for ELEMENT experiments
  only. State the size implication; two variants is the normal case.
- The **offline fallback file freezes the undrawn menu**, not a decision. Corrected
  2026-09-02 during implementation: an earlier draft of this spec said it "serves the
  control", which is wrong. `GET /dashboard/projects/:projectId/paywalls/fallback-export`
  calls the same `resolvePlacement` anonymously, so the bundled file carries the full
  materialised variant list and the SDK draws from it with the same deterministic
  bucketing it uses online. What is actually frozen is the export's freshness: a file
  taken before an experiment started knows nothing about it until the device re-resolves
  live. State that in the docs, not the original claim.
- A patch naming a `nodeId` that no longer exists in the paywall must fail **at experiment
  save time**, not silently at resolve time.

The builder's experiment popover already has the `ELEMENT` kind; give it the element flow
(pick node → set the varying props) so this is reachable from where a user is looking at
the element, not only from the generic JSON editor.

### 4.4 Project-level holdout

Add `holdoutPercentage` to `projects` (0 by default — every existing project keeps today's
behaviour exactly).

A subscriber is held out when the existing bucketing hash over
`(projectId, subscriberId)` **with a dedicated holdout salt** falls under the percentage.
A distinct salt means holdout membership is uncorrelated with any experiment's variant
assignment, which is the property that makes the comparison valid. No new algorithm, so no
`bucketing-vectors.json` change and no Rust change.

A held-out subscriber:

- is excluded from every experiment in `evaluateExperiments` and receives default/control
  behaviour;
- **is still recorded as exposed**, to a reserved synthetic cohort id, so held-out revenue
  is measurable against everyone else. A holdout that is not measured is just a smaller
  audience, which would make the feature pointless.

Because placements draw client-side, the server stamps the holdout decision into the
envelope and omits the experiment entries. Server decides, client obeys — the client is
never asked to compute holdout membership itself.

The reserved cohort id must be a value no user-chosen variant id can collide with;
validation must reject it at experiment creation.

**Threshold bucketing makes growth safe and shrinkage lossy, and the UI must say which.**
Because membership is "hash below the threshold", *raising* the percentage only ever adds
subscribers and leaves every existing member in place, so the accumulated comparison stays
valid. *Lowering* it removes members whose past exposure is already recorded, which
retroactively mixes treated and held-out revenue in the same cohort. Both are audited; the
lowering case warns explicitly rather than being treated as a symmetric edit.

### 4.5 Scheduling and per-placement sequencing

Add to `experiments`: `scheduledStartAt`, `scheduledEndAt`, `startAfterExperimentId`, and
`autoWinnerOnStop` (boolean, default **false**).

Add `apps/api/src/workers/experiment-scheduler.ts`, a repeatable BullMQ worker following
the conventions the workers in that directory already established — in particular the
**per-row claim** pattern from the 2026-08-24 stability batch, so two instances cannot both
start the same experiment. Every transition it makes is audited through `audit()` inside
the same transaction, attributed to the scheduler rather than to a user, so the audit chain
answers "who started this" truthfully.

Sequencing is `startAfterExperimentId`: the successor starts when its predecessor reaches
`COMPLETED`. **Cycles must be rejected at write time**, not detected at run time. A
successor whose predecessor is deleted, or which has waited past its own
`scheduledStartAt` by more than a named grace period, must be **surfaced as blocked** — a
queued experiment that waits silently forever is indistinguishable from one that is
working, and the operator finds out weeks later that nothing ran.

`scheduledEndAt` stops the experiment. If `autoWinnerOnStop` is set, and only then, the
scheduler applies §4.1's decision rule and stops *with* that winner, reusing the existing
manual stop-with-winner path — including its placement healing — rather than a second
implementation of the same transition.

### 4.6 The results page tells the truth, including when it cannot decide

Wire what the dashboard already renders:

- `confidence` and `leadingVariant` come from the engine. The hardcoded `0` / `null` in
  `format.ts` go away, and the "ship the winner" banner becomes reachable for the first
  time — gated on the **full stopping rule**, never on a bare p-value.
- Per variant: posterior mean, credible interval, `probabilityBest`, `expectedLoss`.
- The **minimum-sample warning** is explicit and shown *before* any recommendation, using
  the existing `estimateSampleSize` (which today is only called from the dead path). "Not
  enough data yet" is a first-class answer and must be visually distinct from "no
  difference detected" — they mean opposite things to whoever is deciding.
- **Three things suppress a recommendation rather than annotate it**: SRM, crossover
  contamination above a named tolerance, and the refund-rate guardrail. A mis-split
  experiment's leader is not a leader, and a recommendation shown next to a warning gets
  shipped anyway.

**One guardrail metric, deliberately scoped.** Alongside the primary metric, the results
compute **refund rate per variant** and suppress the recommendation when the leader's
refund rate is materially worse than control by a named margin. This is one extra metric,
not a guardrail framework, and it earns its place for a specific reason: this product is
about subscriptions, the refund data is already computed by §5's summary service, and §4.5
can now stop an experiment and ship a winner *without a human in the loop*. A variant that
wins on conversion by driving purchases users immediately reverse is the exact failure an
automated shipper must not commit, and it is invisible to every other number on the page.

**Auto-shipping stays opt-in and off by default.** The system recommends; a human ships,
unless that human has explicitly asked otherwise per experiment. This is a money-affecting
automation, and defaulting it on would be defensible only with an operator's consent that
the default silently assumes.

Add the experiments docs page — `apps/docs` has no experiments content at all today. It
must state the decision rule, the exponential-revenue approximation, the holdout semantics,
and the offline-fallback-serves-control behaviour.

---

## 5. Data changes

Postgres (one migration):

- `experiments.primaryMetric` — enum, default `CONVERSION`.
- `experiments.minimumDetectableEffect` — numeric, defaulting to the named constant that
  replaces the dead path's magic `0.1`.
- `experiments.scheduledStartAt`, `scheduledEndAt` — nullable timestamptz.
- `experiments.startAfterExperimentId` — nullable self-reference.
- `experiments.autoWinnerOnStop` — boolean, default `false`.
- `projects.holdoutPercentage` — integer, default `0`, constrained to `0..100`.

Every column defaults to today's behaviour, so the migration is inert on existing rows.

**The new enum must be re-exported from `packages/db/src/drizzle/schema.ts`'s re-export
block.** Seven enums were missing from it earlier this session, which made drizzle-kit
emit `DROP TYPE` for each on the next generate — a repo-specific landmine that costs
nothing to avoid and is expensive to discover in a generated migration.

ClickHouse: **no migration.** §4.2 extends an existing query over existing columns; the
per-store split reads `raw_revenue_events` fields that already exist. Confirm this against
the live schema with the §5 schema-contract harness rather than by reading the migration
files — that harness exists precisely because reading was not enough.

## 6. Risks and decisions worth stating

- **Monte Carlo without a seed would be the worst possible bug here** — numbers that move
  on refresh destroy trust in a decision system faster than being wrong once. Seeded from
  the experiment id, asserted by a test that runs the same input twice.
- **The log-normal value model is still a model.** It fits subscription price points far
  better than an exponential would, but heavy tails and multi-modal price ladders can
  strain it. Documented at the module, in the API response, and on the docs page; Welch's
  t-test on raw per-subscriber revenue is the assumption-free cross-check, and a
  disagreement between them is shown rather than resolved silently.
- **Expected loss bounds expected regret, not Type-I error.** The sample, runtime and
  guardrail gates are the other parts of the rule and must not be made optional.
- **The maturation window trades freshness for validity.** A 7-day window means the revenue
  metric ignores the most recent week of exposures. That is the correct trade — the
  alternative measures how long ago a user was exposed — but it must be visible in the UI,
  or an operator will read a stale-looking number as a broken one.
- **Excluding fully-refunded converters changes the conversion rate** relative to what the
  current endpoint reports. That is a deliberate semantic correction, not a silent one:
  state it in the docs and in the API field's documentation.
- **The conversion denominator for non-PAYWALL types is an exposure-join heuristic**,
  already documented on `ExperimentVariantRow`. The new metrics inherit that limitation and
  must not present it as precise attribution.
- **Deleting `getExperimentResults` will break its tests.** That is the point; those tests
  move to the surviving service where they will actually guard shipped behaviour.
- **ELEMENT envelope growth** is linear in variant count. Acceptable at two variants;
  stated so nobody discovers it at ten.
- A **holdout percentage changed mid-flight** re-buckets subscribers and invalidates the
  comparison. Changing it is an audited event and the UI must say so plainly.

## 7. Acceptance criteria

1. A results response carries, per variant, a posterior mean, a credible interval,
   `probabilityBest`, and `expectedLoss`, for the experiment's primary metric.
2. The same experiment data produces byte-identical decision numbers on repeated calls,
   proven by a test that computes twice and compares.
3. For two variants, the Monte Carlo `probabilityBest` matches the closed-form Beta result
   within a stated tolerance.
4. Winner selection works on `ARPU` and `PROCEEDS_PER_USER`, with proceeds derived from
   §5's commission service and reporting "unknown" rather than gross when no rate is
   configured.
5. `experiment-engine.getExperimentResults` no longer exists, and exactly one results
   implementation is reachable from any route.
6. `confidence` and `leadingVariant` are no longer hardcoded; the "ship the winner" banner
   appears only when the full stopping rule passes, and never when SRM, crossover, or the
   refund guardrail has fired.
7. An under-powered experiment shows a minimum-sample warning that is visually and
   textually distinct from "no significant difference".
7a. An experiment that has passed its sample gate but not its minimum-runtime gate still
   withholds a recommendation, proven by a test that supplies ample samples inside one day.
7b. Revenue metrics are computed per subscriber, not per order: a test in which one
   subscriber has several renewals must count that subscriber once.
7c. Subscribers whose maturation window has not elapsed are excluded from the revenue
   metric, and the excluded count is reported rather than dropped.
7d. A subscriber assigned to two variants of one experiment is excluded and counted as
   crossover; above the named tolerance the recommendation is suppressed.
7e. A converter whose net revenue is ≤ 0 after refunds is not counted as a conversion.
8. An ELEMENT experiment changes a single node's props on web, SwiftUI and Android Views
   with **no diff** in any renderer, in `render-fixtures.json`, or in the paywall model's
   emitted JSON — the envelope carries one materialised snapshot per variant.
9. A variant patch targeting a non-existent `nodeId`, or a prop outside
   `OVERRIDABLE_PROP_KEYS`, is rejected when the experiment is saved.
10. With `holdoutPercentage > 0`, held-out subscribers receive control everywhere, are
    recorded against the reserved cohort, and their revenue is comparable against the rest;
    membership is deterministic and stable across calls.
11. The scheduler starts and stops experiments at their scheduled times, chains successors,
    rejects cycles at write time, cannot double-start under two instances, and writes an
    audit entry attributed to the scheduler for every transition.
12. `autoWinnerOnStop` defaults to false; with it unset, a scheduled stop never selects a
    winner on its own. With it set, a leader whose refund rate is materially worse than
    control is not shipped.
13. An experiments docs page exists and states the decision rule, what expected loss does
    and does not guarantee, the log-normal revenue model, the maturation window, the
    refunded-converter semantics, holdout semantics, and that the offline fallback serves
    control.
14. No statistical parameter appears as a literal at a call site: MDE, α, power, credible
    level, prior, expected-loss threshold, Monte Carlo draws, maturation window and minimum
    weekly cycles are each a named constant or an experiment field.
15. The new ClickHouse reader is registered in the schema-contract harness and its tests
    execute real SQL against a testcontainer ClickHouse rather than a mocked client.
