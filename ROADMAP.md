# Rovenue Roadmap

Goal: close the gap with RevenueCat / Adapty in every area — target **95%** parity (or better) per area.
Scores are a self-assessment of "% of a mature best-in-class solution" as of 2026-09-03.

| # | Area | Now | Target |
|---|------|-----|--------|
| 1 | Store integrations & receipt validation | 85% | 95% |
| 2 | Subscription state & entitlements | 95% | 95% ✅ |
| 3 | Paywall builder & native rendering | 94% | 95% |
| 4 | A/B testing & experiments | 88% | 90%+ |
| 5 | Analytics (MRR / LTV / cohorts) | 95% | 95% ✅ |
| 6 | Third-party integrations | 95% | 95% |
| 7 | SDK platform coverage | 70% | 95% |
| 8 | Self-hosting & data ownership | 95% | keep |
| 9 | GDPR / KVKK tooling | 85% | 95% |
| 10 | Production maturity & scale proof | 45% | 95% |
| 11 | Docs & developer experience | 78% | 95% |
| 12 | Feature breadth (flags, audiences, leaderboards, credits) | 85% | 95% |

## Priority order (impact / cost)

1. Flutter SDK (§7)
2. RevenueCat / Adapty migration guides + data import tool (§11)
3. Remaining analytics gaps: full country coverage, full chart-catalog
   series coverage in the metrics export (§5 — most of the section is
   already shipped, see below)
4. Bayesian experiment engine (§4)
5. Store-native full lifecycle passthrough (§6 — the last integrations gap;
   low priority, narrow scope)

Integrations (§6) is effectively done as of Wave 2 (framework + webhook v2 +
14 first-class providers across two waves, plus the vendor-agnostic CUSTOM_WEBHOOK escape hatch). Analytics (§5) is CLOSED as of 2026-09-04 (all 16 catalog charts served) — cohort
retention, churn/refund KPIs, predicted LTV, trial→paid, and the paywall
funnel predate this plan; country revenue, estimated proceeds, and the
metrics export are new but each has a documented partial-coverage edge.
Completing 1–2 should lift the overall picture toward ~88%; items 3–5 close
the remaining analytics/experiments/integrations gaps on the way to 95%.

---

## 1. Store integrations & receipt validation (85 → 95)

Three of this section's six items shipped 2026-09-03
(`.superpowers/sdd/2026-09-03-store-integrations-completeness/`), each
differently from how the item was originally phrased — see below. Amazon
Appstore, Paddle and Roku Pay (whole new store/processor integrations, not
gaps in existing ones) remain untouched, which is why the score moves to 85
rather than closing the section.

- [x] Stripe dunning / billing-portal flows fully covered (card renewal,
      involuntary churn recovery) — shipped as an SDK-facing
      `POST /v1/billing-portal` session endpoint (Stripe customer resolved
      server-side from the authenticated subscriber only, never from the
      request body; return URL allow-listed against the project's
      **verified** `custom_domains` rows, reusing that admin-verified record
      rather than inventing a second, unverified one; seven security tests),
      plus handling `invoice.payment_action_required` — it surfaces the
      existing `subscription.billing_issue` key, but a new `storeEventType`
      field on the outbox payload distinguishes "tap to approve" from "your
      card was declined" in storage, since a consumer cannot write either
      email from an undifferentiated event. Alongside this, closed a fail-open:
      `mapStripeSubscriptionStatus`'s `default` branch used to silently
      return `ACTIVE` — full entitlement — for any Stripe status it didn't
      recognise. **This was a future hazard closed early, not an outage that
      happened**: Stripe's SDK (15.12.0) documents exactly eight subscription
      statuses and the mapper named all eight, so the `default` branch was
      unreachable for any status Stripe currently sends. It would have fired
      for the first time, silently, during a routine SDK version bump that
      introduced a ninth status. The mapper now returns `null` on an
      unrecognised value — callers leave the stored status alone rather than
      promoting *or* revoking on a status they don't understand — and logs
      the unrecognised value. Not built: `customer.subscription.trial_will_end`
      was dropped in the plan audit as scope creep — a voluntary-conversion
      nudge, not involuntary churn, and this item is about the latter. Also
      still open, unrelated to this batch: `customer.subscription.updated`
      remains unmapped to a lifecycle key (see §6) and Stripe one-time
      (non-subscription) purchases still reach no integration provider (also
      §6) — both intentionally left there rather than duplicated here.
- [x] Apple StoreKit External Purchase / EU DMA scenarios (alternative
      payment links) in the event model — **the boundary matters more than
      the feature here.** Apple's `EXTERNAL_PURCHASE_TOKEN` notification
      payload is `{ externalPurchaseId, tokenCreationDate, appAppleId }` and
      Apple documents `data` / `summary` / `externalPurchaseToken` as
      mutually exclusive on the decoded payload — so this notification never
      carries a transaction and never carries a subscriber-resolvable
      identifier. **It says a purchase happened in your app, not whose.**
      Recorded accordingly as a project-level fact in its own table
      (`apple_external_purchases`, keyed by project + `externalPurchaseId`,
      migration adds no `DROP`) — no subscriber is inferred, no revenue row
      is written, and no integration event is emitted, because all three
      would be fabrications the outbox has no subscriber to key on. **Do not
      read this as end-to-end external-purchase support**: the External
      Purchase Server API, token reporting deadlines and commission
      accounting are not implemented, and the handling above was verified
      against the documented payload shape only — this repo has no
      external-purchase entitlement to test against live Apple traffic.
- [x] Google reconciliation job (open item from the 2026-08-23 store-billing
      correctness batch) — a scheduled sweep (`rovenue-google-reconciliation`
      queue) that re-verifies Play Store purchases the RTDN pipeline may have
      missed: an `ACTIVE` purchase past its `expiresDate`, or any purchase not
      re-checked within 24h, capped at 200 candidates/run, claimed with
      `FOR UPDATE OF p SKIP LOCKED` so concurrent sweeps can't double-transition
      one row. **First-run decision: an explicit backfill mode, not a low
      cap.** A cap alone would still eventually flood every configured
      integration with one event per historical drift, just spread over
      several days, with no way to tell "genuinely new drift" from "backlog
      predating this feature" — and reporting a months-old lapse as live news
      would trigger win-back campaigns for subscribers who left long ago.
      Backfill mode (`{ backfill: true }`, run once by an operator after
      deploy) still corrects the row, syncs entitlements and writes the audit
      trail — it only withholds the externally-visible outbox event. The
      scheduled job itself always runs live (`backfill: false`) once the
      one-time drain is done.

## 2. Subscription state & entitlements (85 → 95) — CLOSED 2026-09-05

All four items shipped 2026-09-03…05
(`.superpowers/sdd/2026-09-03-subscription-state-entitlements/`). The whole
section turned out to hang off one missing state: `BILLING_ISSUE`, the
INVOLUNTARY suspension that is neither `GRACE_PERIOD` (retry *with* access)
nor `PAUSED` (the subscriber's own choice). Before it, an account hold and a
voluntary pause landed on the same row value, so every rollup that reads
`involuntary` mislabelled dunning as churn-by-choice.

**Two tasks were needed that the plan never contained.** A review found that
`GRACE_PERIOD` was declared `grantsAccess: true` in
`packages/shared/src/subscription-status.ts` and yet granted nothing: the
access engine compared against `purchases.expiresDate`, which is by
definition already past for a row in grace, so the entitlement was computed
as expired the moment grace began. That made the entire
GRACE_PERIOD-versus-BILLING_ISSUE distinction meaningless *in entitlement
terms* — the two states were different labels for the same denial. Task 12b
made the access window run to `gracePeriodExpires`; Task 12c stopped the
expiry sweeper retiring a grace period that was still open. Neither was
foreseen, and without both the headline item would have shipped as a
reporting change dressed up as an entitlement one.

Residual, recorded rather than fixed (see `deferred-and-open.md` in the plan
directory): `receipt-verify.ts` supersedes a Google purchase without emitting
`product_changed` for the identical-replacement flow; the DOWNGRADE
redemption path bypasses the upsert and so writes none of the offer columns
that exist to make a win-back cohort queryable; and CSV-migrated projects
keep a residual revenue double-count because the importer's dedupe namespace
(`import:<store>:<txn>:<n>`) does not meet the live one (`apple:<txn>:<kind>`).

- [x] Upgrade/downgrade proration, cross-grade, entitlement transition rules
      on plan change — plan-change detection and a `subscription.product_changed`
      event across all three stores, plus `pendingProductId` /
      `pendingChangeType` / `pendingChangeEffectiveAt` on `purchases` (0117) for
      the deferred case where the store announces a switch that takes effect at
      the next renewal. **`changeType` is store-reported or `null`, never
      derived from price.** The tempting heuristic — compare the new price to
      the old — is wrong precisely where it matters: the amount on a plan-change
      transaction is what the store *charged*, and a prorated upgrade charges
      *less* than list price because the unused remainder of the old term is
      credited against it. A price comparison would therefore label upgrades as
      downgrades on exactly the flow this item exists for. Apple reports the
      direction in its notification subtype and is read straight off it; Google
      and Stripe report nothing usable, so they emit `changeType: null` and the
      consumer is told "the product changed" without a fabricated direction.
      No proration-specific `RevenueEventType` was added: Apple sends the
      prorated refund as its own REFUND notification, Stripe puts proration
      lines on the invoice the existing path already reads, and Google's
      replacement token carries the real `priceAmountMicros` — net revenue is
      already correct, and a new enum value would reach the ClickHouse schema
      for nothing. That ruling is pinned by a test asserting the exact
      `RevenueEventType` membership, so a future proration type has to be a
      deliberate act. Alongside it, Apple upgrade **supersession**: the row the
      upgrade cut short is retired instead of being left live beside its
      replacement. **Deliberately narrow.** Apple mints a new transaction id for
      every renewal, so a chain under one `originalTransactionId` holds one row
      per *billing period*, not one row per subscription; matching on the
      original id alone would sweep the entire renewal history into EXPIRED. Only
      a row whose period has not yet ended can be the one an upgrade replaced.
- [x] Google billing issue / account hold as a first-class state (separate
      from GRACE_PERIOD) — `BILLING_ISSUE` added to `PurchaseStatus` (0115) with
      a `billingIssueDetectedAt` stamp written on ENTRY only (a repeated hold
      signal must not reset a dunning campaign's clock) and cleared only on
      recovery into an access-granting status; a lapse to EXPIRED keeps the
      stamp, because it is the evidence the churn was involuntary. All three
      stores route to it: Google `ON_HOLD`, Stripe `unpaid` / `incomplete`, and
      Apple `DID_FAIL_TO_RENEW` **without** the `GRACE_PERIOD` subtype.
      **That last mapping is a deliberate reversal of the earlier behaviour
      (OD-1) and it takes access away.** Apple sends the `GRACE_PERIOD` subtype
      only when the app actually has a billing grace period configured; without
      it, Apple has already stopped the subscription on its own side, so the
      previous mapping to `GRACE_PERIOD` was granting entitlement Apple itself
      had withdrawn. Because that flips live rows out of an access-granting
      status on deploy, it ships with a read-only pre-deploy blast-radius
      script (`apps/api/scripts/billing-issue-blast-radius.ts`) that counts them
      first. **The enum had to be added by recreating the type, not with
      `ALTER TYPE … ADD VALUE`.** Postgres forbids using a value added that way
      inside the transaction that added it, and the drizzle migrator wraps all
      pending migrations in one transaction — so splitting the ADD and the USING
      across two files does not help: on a fresh install both land in the same
      transaction and the run fails with `unsafe use of new value`, while
      passing on the developer machine where the two files happened to run
      separately. 0115 therefore renames the old type, creates the new one, and
      recasts the column, dropping and rebuilding the two partial indexes whose
      predicates embed Const nodes of the type being dropped. Completing the
      loop: the status-write guard now returns a **before-image** (previous
      status, product and auto-renew flag) so a transition can be judged against
      what was actually there rather than re-read; a bounded ageing pass retires
      a hold nobody is still retrying, so a `BILLING_ISSUE` row cannot sit
      forever waiting for a store event that will never come; and
      `subscription.recovered` is emitted for Apple and Stripe when the store
      finally collects, which is the event a win-back campaign has to suppress
      on.
- [x] Apple Family Sharing + win-back offer states in the state machine —
      family-shared revenue suppression moved **into the repository**:
      `createRevenueEvent` returns `null` for a purchase whose ownership type is
      family-shared, so the suppression cannot be forgotten by a new caller the
      way a check at each call site can. A family member's entitlement is real;
      the revenue is the payer's and must not be counted twice. Win-back and
      promotional offers get a real `OFFER_REDEEMED` handler with the offer
      identity persisted on the purchase (0118) so a redeemed cohort is
      queryable rather than inferred.
- [x] Continuous `subscriber_access` consistency checker — a scheduled
      reconciler (0119, index fixed in 0120) that recomputes desired access for
      the least-recently-checked subscribers, heals the drift it finds, and
      records the sweep. It runs behind a **circuit breaker with a minimum batch
      size**: a sweep that wants to change an implausible share of a
      sufficiently large batch stops instead of healing, because at that point
      the likelier explanation is that the *computation* is wrong, not the
      stored rows — and a reconciler that trusts itself unconditionally is a
      single bug away from revoking every entitlement in a project.

## 3. Paywall builder & native rendering (85 → 94) — five of six items closed 2026-09-04

- [x] trialLabelKey override UI — the base editor already existed in the Binding tab; the
      **override** editor omitted it because its prop union was hand-written. The union is now a
      mapped type over `OVERRIDABLE_PROP_KEYS`, so a schema prop with no editor case fails the
      build by name (2026-09-01)
- [x] Commerce-binding cache invalidation — the earlier "no invalidation" framing was stale:
      `purgeResolvedPriceCache` already fired from five routes (products, offerings, placements,
      experiments, paywalls). What was missing was the **credential** case — `credentials.ts` never
      purged, so rotating a key or disconnecting a store kept serving the previous account's prices
      for up to 15 minutes. The cache is now keyed on a digest of the stored credential ciphertext,
      so no purge call is needed and none can be forgotten (2026-09-01)
- [x] Element-level experiments (deferred from P7) — **already shipped with §4** on
      2026-09-02 (`materializeElementVariants`, save-time validation, and a builder
      flow to launch one from the canvas); this line was a stale duplicate nobody
      re-visited when §4 closed the same day. The only real gap left inside the
      feature was in the builder: `border` was offered in the element-experiment
      prop picker but no probe matched it, so it fell to the free-text editor where a
      `NodeBorder` can never be typed and Create stayed disabled forever. Fixed, with
      a test that walks every `OVERRIDABLE_PROP_KEYS` entry and fails by name on a
      prop with no usable editor (2026-09-04)
- [ ] On-device smoke test session (pending) — needs physical iOS/Android devices and store sandbox
      accounts; not automatable from this repo
- [x] New node types at RC Paywalls v2 parity — the 2026-09-01 recon held: `carousel`,
      `timeline` and `video` already existed on all three platforms, and only a footer
      link group was absent. `footerLinks` is now the **18th** node type — shared schema,
      web/SwiftUI/Android renderers, and `render-fixtures.json` (edited last, after all
      three could decode it). It reuses `ButtonNode`'s action union rather than inventing
      a second one, and applies the renderers' existing "an inert restore control is
      misleading" rule PER LINK, computing separators over the surviving links so a
      hidden link can never leave a leading, trailing or doubled separator. Authoring
      support closed a hole next door: the inspector's Content and Style switches ended
      in `default: return null`, so a node type with no editor shipped an empty inspector
      silently — both are now exhaustive (2026-09-04)
- [x] Template gallery: 15–20 proven paywall templates — **18 templates** across six
      categories, each a composition of a section-factory kit rather than a hand-written
      tree, each ending in a `footerLinks` row. One test runs over EVERY entry: strict
      schema parse, save-validity, no package ids, no `defaultSelected`, no asset URLs,
      copy for every key, exactly one purchase button. The gallery gained category chips,
      search, and cards that render the template's real tree through `PaywallRenderer`
      against a synthetic offering — the abstract silhouette worked for two presets and
      stops distinguishing anything at eighteen.

      This is where the App Store import stayed *unused*: it hot-links Apple's CDN and is
      driven by one listing, so it is a good tree-assembly reference and a poor template
      source. It remains its own start tab.

      Two defects surfaced from the work rather than from the item's wording. The spec
      claimed a template's empty image URL "passes the save tier and is caught by the
      publish gate" — the validator checked no URL of any kind, so a blank hero image has
      always been publishable; `EMPTY_MEDIA_URL` and `EMPTY_ACTION_URL` are now
      publish-tier issues, which is what makes the placeholder story true. And an image
      node with a blank url rendered `<img src="">`, which a browser answers by
      re-requesting the hosting document — eighteen cards made that eighteen wasted
      page-sized requests. The `video` node had guarded exactly this for a wave; `image`
      was simply never wired to the same rule (2026-09-04)
- [x] Localization workflow: in-builder translation management + auto-translate (Rovi) —
      a Rovi endpoint that returns entries the builder merges client-side through the
      existing `setLocalizations` op (a server-side write would lose to the builder's next
      autosave tick), per-column and per-cell translation that fills gaps by default and
      overwrites only behind a confirm, one-undo revert, and machine-translated cells
      marked in builder state rather than in `BuilderConfig` — the config is the SDK wire
      format, not a place for dashboard bookkeeping.

      The correctness guard is placeholder preservation: `resolveVariables` leaves an
      unknown `{{token}}` verbatim rather than throwing, so a model renaming `{{price}}`
      would ship literal braces to a paying customer with nothing to catch it. A string
      whose placeholders cannot be preserved is retried once, then left untranslated and
      reported by name — a gap falls back to the base locale and reads correctly, a
      corrupted string does not.

      Shipped with it, because the feature does not reach users without it: `resolveText`
      matched locales EXACTLY, so a device passing `pt-BR` at a `pt`-keyed table fell
      silently through to the default language. It now resolves by language across all
      three renderers, and the free-text "add locale" box became a picker over the store
      locale set — the two together are what make a translated table one the SDK can
      actually find (2026-09-04)

## 4. A/B testing & experiments (75 → 88) — decision engine shipped

This section previously read as five missing features. It was one missing
decision rule plus four disconnected wires: the frequentist statistics
module (`experiment-stats.ts`, Welch cross-check, SRM, sample-size
estimation) already existed and was already tested; its richest consumer,
`experiment-engine.getExperimentResults`, was unreachable dead code that the
routes never called; `ELEMENT` was already a declared experiment type with a
JSON editor in the builder and no consumer materializing it; and the
dashboard results page hardcoded `confidence: 0` / `leadingVariant: null`, so
the "ship the winner" banner had never once rendered. The
2026-09-01 experiments-decision-engine plan
(`.superpowers/sdd/2026-09-01-experiments-decision-engine/`) closed the
actual gap: a Bayesian posterior module, a subscriber-level windowed
ClickHouse reader, and the single results service (with the dead duplicate
deleted) that the four-gate stopping rule needed to exist at all.

- [x] Sequential/Bayesian statistics engine: revenue-based metrics (ARPU/proceeds) winner
      selection + expected-loss display — shipped: `apps/api/src/lib/experiment-bayes.ts`
      (seeded Monte Carlo posterior, log-normal per-subscriber value model) wired into the
      single results service (`apps/api/src/services/experiment-results.ts`) behind a
      four-gate stopping rule (expected loss, sample size, whole weekly cycles, no
      integrity/guardrail firing); the pre-existing frequentist module now runs alongside it
      as an assumption-free cross-check, never the decision. `experiment-engine.ts`'s dead
      `getExperimentResults` path is deleted — one results implementation, not two. The
      metric and the minimum detectable effect are chosen per experiment in the
      new-experiment form (`primaryMetric` / `minimumDetectableEffect`, settable on create
      and on a DRAFT patch), so ARPU and proceeds-per-user are reachable without touching
      the database.
- [x] Element-level (single-node) experiments — shipped: variants materialize server-side
      into per-variant paywall snapshots (`materializeElementVariants`); no renderer,
      `render-fixtures.json`, or emitted paywall JSON changed. Builder support (launch an
      ELEMENT experiment from the canvas) shipped alongside it.
- [x] Holdout groups — shipped: project-level holdout percentage, decided server-side in
      `resolvePlacement` (the variant draw is client-side, so holdout must be decided before
      the client ever sees an experiment), exposure still recorded against a reserved
      holdout cohort. Raising the percentage only adds members (safe); lowering removes
      members whose exposures are already recorded and retroactively mixes cohorts (lossy) —
      the dashboard warns only on lowering.
- [x] Experiment scheduling/sequencing per placement — shipped: a scheduler worker with
      per-row claims (no double-start/double-stop across workers), chaining (a stopped
      experiment can auto-start the next one queued for its placement), and
      `autoWinnerOnStop`.
- [x] Confidence intervals + minimum-sample warnings on the results page — shipped: 95%
      equal-tailed credible intervals per variant, plus the sample-size/runtime gates
      surfaced as named blockers (`SAMPLE_SIZE`, `RUNTIME`, `SRM`, `CROSSOVER`,
      `REFUND_GUARDRAIL`, `EXPECTED_LOSS`, `NO_LEADER`, `PROCEEDS_RATE_UNCONFIGURED`) rather
      than a single opaque "not ready" state.

## 5. Analytics (70 → 95) — CLOSED 2026-09-04

This section previously presented the entire area as unstarted. That framing
was stale: cohort retention, churn/refund KPIs, predicted LTV, trial→paid,
and the paywall funnel were already live in the dashboard before the
2026-09-01 analytics-integrity-and-proceeds plan
(`.superpowers/sdd/2026-09-01-analytics-integrity-and-proceeds/`). That plan
added the country revenue dimension, query-time estimated proceeds (after
store commission), a ClickHouse-Postgres schema-contract test guarding every
chart/metrics reader, and a metrics export API — none of it invented from
nothing, but real net-new coverage on top of what was already there.

- [x] Cohort retention grid — already shipped (`/cohorts` route,
      `apps/dashboard/src/components/cohorts/retention-heatmap.tsx`)
- [x] Churn / refund rate charts — already shipped (`RevenueKpisCard`
      churnRate/refundRate/refunds tiles, backed by
      `apps/api/src/services/metrics/summary.ts`)
- [x] Trial → paid conversion funnel — already shipped (`FunnelCard`'s
      `trial_to_paid` step plus `RevenueKpisCard`'s trialToPaid tile)
- [x] Predicted LTV — already shipped (`PredictedLtvCard` +
      `apps/api/src/services/metrics/ltv-extrapolation.ts` prediction service)
- [x] End-to-end paywall funnel in dashboard (paywall_view → purchase
      attribution already exists) — already shipped (`paywall_view_rate` /
      `paywall_purchase` wired in `readChartSeries`)
- [x] Proceeds view (after store commission; Apple Small Business Program
      15% vs 30%) — shipped by this plan: per-project store commission
      rates, `ProceedsCard` + `readProceeds`/`GET /proceeds`, computed at
      query time only — never written into `raw_revenue_events`. The rate
      itself is **API-configured only** today (`PUT/DELETE
      /dashboard/projects/:projectId/commission-rates/:store`, audited);
      there is no settings UI, so a project without an API call sees "rate
      not configured — proceeds unknown". `COMMISSION_RATE_PRESETS`
      (Apple 15/30, Google 15) exists in `services/metrics/proceeds.ts`
      with sourced citations but is read by nothing outside its own test —
      it is NOT offered to anyone yet
- [x] Commission-rate settings UI — shipped 2026-09-03. One row per store
      in `SettingsForm.tsx`, writing through the existing audited
      `PUT/DELETE /dashboard/projects/:projectId/commission-rates/:store`
      and gated on the same `assertProjectCapability` the endpoints use
      (`project:settings:write`). `COMMISSION_RATE_PRESETS` moved to
      `packages/shared/src/commission-rates.ts` so the dashboard and the
      API read ONE copy of the rates and their citations — the citations
      are shown, not summarised, because choosing 15% vs 30% is a claim
      about Small Business Program status. **Offering a preset is not
      configuring one**: a store with no rate still reports "not
      configured — proceeds unknown", and rendering the form issues no
      write (asserted by test).
- [x] Country revenue dimension — shipped by this plan, coverage is
      partial by store and by time: Apple full, Google full except
      voided-purchase refunds, Stripe only `charge.refunded` (most Stripe
      volume carries no country), and nothing before migration 0023. A row
      without a store-supplied country is left without one, never
      backfilled from a device attribute
- [x] Metrics export API for customer BI (ClickHouse-backed) — shipped by
      this plan: channels/proceeds/funnel/heatmap rows plus per-day series
      for the chart-catalog ids that have a reader
- [x] Schema-contract test guarding every chart/metrics ClickHouse query —
      added by this plan (`schema-contract.integration.test.ts`); runs each
      reader's real SQL against the live schema so a column rename/drop
      fails CI instead of shipping a silently-broken chart
- [~] Full country coverage — **CLOSED 2026-09-03: neither done nor open.**
      Both halves were investigated and both resolve as won't-do, for
      different reasons:
      - **Stripe half — a deliberate ruling, not an oversight.**
        `invoice.paid` carries no per-transaction country, and its only
        country-shaped field, `customer_address`, is a **billing address**,
        which the analytics-country design forbids as not store-supplied.
        The reasoning sits at the call site
        (`services/stripe/stripe-webhook.ts:877-886`). `charge.refunded` is
        wired precisely because it *does* carry a real one. Mixing a
        self-declared billing address into the same column as Apple's
        `storefront` and Google's `regionCode` would silently change what
        the column means.
      - **Backfill half — impossible from retained data.** The only
        `country` column in the entire Postgres schema is on
        `projectStripeConnections` (the connected account's own country).
        `revenue_events` and `purchases` have none, and no table retains a
        raw store payload to re-derive one from. A backfill would mean
        re-verifying every historical transaction against three
        rate-limited third-party APIs — a re-verification campaign, not a
        data migration.
      If country-by-billing is ever wanted, it must be a **separately named
      dimension**, never merged into the store-supplied `country` column.
- [x] Chart-catalog series coverage — shipped 2026-09-03
      (`.superpowers/sdd/2026-09-02-analytics-catalog-coverage/`). **12 of
      16** catalog ids returned a real series and the export streamed all
      of them; it was 2 of 16. The remaining four closed 2026-09-04 (next
      item), taking it to 16 of 16. Every reader **delegates to the service that
      already owns the concept** and `charts.ts` contains no SQL of its
      own — a second query set drifts from the first, which is why the
      export was built to issue none. Where a daily grain did not exist it
      was added *inside the owning service* (`mrr-decomposition.ts`,
      `summary.ts`, `credits.ts`), with the existing caller's numbers
      pinned by test first. No migration was needed. The export now fans
      out with `Promise.allSettled`, so **one failing reader emits its own
      `# error:` marker and every other series still streams** rather than
      truncating the file.
- [x] The four catalog ids that stayed `supported: false` — **closed
      2026-09-04** (`docs/superpowers/specs/2026-09-04-analytics-catalog-last-four-design.md`).
      All **16 of 16** ids now return a measured series, and
      `charts.catalog-coverage.test.ts` fails by name if a seventeenth is
      ever added without a reader. They were not one item, and each of
      the three earlier rulings turned out to be a different kind of
      claim:
      - **`rev_per_install`** — the ruling was "no install event exists
        anywhere in the product; needs SDK-side work first". No SDK work
        was needed, on any of the five platforms. `resolveOrCreateSubscriber`
        is reachable ONLY from the SDK's public-key `/v1` surface, so
        creating a subscriber there *is* an install — the product had
        been recording it all along, in the `platform` attribute that
        path writes on create and the importer is forbidden to touch
        (`services/import/write.ts` rule 6). It is now a dedicated
        `subscribers.sdkInstalledAt` column (migration 0116, backfilled
        from that attribute) rather than a query over `attributes`,
        because GDPR erasure clears attributes and an aggregate install
        count must not shrink when a person is erased. The metric is
        same-day net revenue ÷ same-day installs, with both inputs
        exposed; `services/metrics/installs.ts` is the one definition of
        an install in the codebase. Rows anonymized before the migration
        stay NULL — not recoverable, not guessed.
      - **`liability`** — the ruling was "no balance history is retained
        anywhere, so a 12-month line would be today's figure repeated or
        a reconstruction no service owns". `credit_ledger` retained it
        the whole time: append-only, every row carrying the signed delta
        *and* the balance after it. `getCreditLiabilityDaily` anchors on
        today's authoritative outstanding total and walks it BACKWARDS
        through the window's deltas — so the last point equals the
        `/credits` gauge by construction, and the query reads no row
        outside the window (a forward sum would silently lose its
        opening balance the day an old monthly partition is detached).
        Credits, not USD: the paid-reserve figure needs a window-derived
        average credit price and has no historical meaning.
      - **`retention_curve`** and **`ltv`** — this ruling was **right**,
        and it named its own fix: a catalog modelling gap, not a wiring
        gap. Both are lines over *periods since cohort start*, and
        `ChartSeriesResponse` could only describe lines over calendar
        dates. The contract now carries a required `axis` discriminator
        (`"date" | "period"`) — required, not optional-with-a-default, so
        the compiler walked every existing reader instead of letting a
        period-shaped one ship claiming to be dated. Both ids serve
        `axis: "period"` over the same fixed cohort (everyone whose first
        revenue event falls in the window), so the two panels describe
        one population; `ltv` is cumulative net revenue per cohort
        member, from `computeCohortLtvCurve`, because
        `v_revenue_lifetime_subscriber` has no day dimension to widen by
        at all. `/cohorts` keeps the arbitrary-rule heatmap. The
        catalog's long-standing `chartType: "line"` finally describes
        both, and neither id nor type had to change.
      The metrics export gained a `period` column for the two
      period-axis ids — the long/tidy row format existing precisely so a
      section with an unrelated grain gets its own column instead of
      being bent into one that means something else.
- Note on the schema-contract harness: `trials_started`, `churn`,
  `liability` and the install half of `rev_per_install` are
  **Postgres-backed** and issue zero ClickHouse queries, so
  `schema-contract.integration.test.ts` cannot guard them — a `purchases`
  or `subscribers` column rename would break them with the harness still
  green. Each has a separate real-Postgres integration test instead
  (`installs.integration.test.ts`,
  `credits.liability-daily.integration.test.ts`). "Registered in the
  harness" does not mean "guarded" for those four.

## 6. Third-party integrations (75 → 95) — CLOSED 2026-09-03

Framework + webhook v2 shipped 2026-08-24
(`docs/superpowers/specs/2026-08-24-integrations-foundation-webhook-v2-design.md`).
Wave 1 first-class providers + delivery-time identity enrichment + narrow
store-lifecycle normalization shipped 2026-08-24/25
(`docs/superpowers/specs/2026-08-24-integrations-wave1-providers-design.md`).
Wave 2 first-class providers shipped 2026-08-25
(`docs/superpowers/specs/2026-08-25-integrations-wave2-providers-design.md`):
Braze, OneSignal, Iterable (lifecycle category), Airbridge, Singular
(attribution), Discord (communication) — zero schema migrations, five new
RC-compatible vendor-id attributes, Slack's message builder hoisted to a
shared chat module reused by Discord, plus Wave-1 parked cleanup
(`STANDARD_PROVIDER_EVENT_KEYS` rename, `Readonly` typings, stale comments).
Score moved from 75 to 90: fourteen first-class providers now exist across
lifecycle, attribution, analytics, and communication categories (Meta CAPI,
TikTok, Amplitude, Mixpanel, AppsFlyer, Adjust, Slack, Firebase/GA4, Braze,
OneSignal, Iterable, Airbridge, Singular, Discord — see the full checklist
below), the vendor-agnostic `CUSTOM_WEBHOOK` escape hatch is at Svix parity,
delivery-time identity enrichment covers the major attribution/analytics
vendors, and Google's RTDN lifecycle-classification bug is fixed. This is
judged a 90 rather than a full 95 because one real gap remains: store-native
normalization is still narrow (4 lifecycle keys) rather than full passthrough
of every raw Apple/Google/Stripe event shape — the deferral documented back
in Wave 1. That gap is the entirety of what's left in this area; everything
else in the framework/provider-breadth dimension is done.

- [x] Integrations framework (migration 0060, fanout consumer, deliver worker,
      6-step dashboard drawer, Meta CAPI + TikTok providers) — this was already
      ~80% shipped before this plan; the framework itself was never "half-built."
- [x] Fixed the 6 flaky tests on main (queue-name isolation, not a missing
      migration — the old "missing `0053_integrations_framework.sql`" framing
      was stale/false)
- [x] `provider_id` enum → text + partial unique index (migration 0104)
- [x] Declarative registry (topics / eventCatalog / credentialsSchema /
      allowMultipleConnections / retryPolicy)
- [x] Public event-key catalog v2 (13 keys)
- [x] Registry-driven fanout over 4 topics: `rovenue.revenue` / `subscription` /
      `paywall_events` / `credit` (`rovenue.billing` deliberately excluded —
      internal Rovenue-cloud billing, not a subscriber-facing event)
- [x] SUBSCRIPTION outbox bridge so lifecycle events reach integrations v2
- [x] Outbound webhook v2 at Svix parity, shipped as the `CUSTOM_WEBHOOK`
      provider: Svix-format signing + key rotation with 24h grace, multi-endpoint
      (cap 10), per-event filtering, pinned-IP SSRF guard, per-provider retry
      policy (≥31h for webhooks), dead-letter + notification + manual redeliver,
      dashboard UI, docs at
      `apps/docs/content/docs/integrations/outbound-webhooks.mdx` — unlocks
      "write your own integration"
- [x] Fixed two pre-existing prod bugs found along the way: dead backoff on
      immediate-retry (`attempts: 5` with no `backoff`), and camelCase drawer
      credentials that broke live Meta/TikTok setup
- [x] Wave 1 first-class providers: Amplitude, Mixpanel, AppsFlyer, Adjust,
      Slack, Firebase/GA4 — zero schema migrations, entirely registry-driven
      as the foundation promised (credential fields, event catalog mapping,
      dashboard drawer/cards, docs all declarative on top of the existing
      framework)
- [x] Delivery-time subscriber identity enrichment: cached, ATT-consent-gated
      vendor-id attributes (`$appsflyerId`/`$adjustId`/`$firebaseAppInstanceId`/
      `$mixpanelDistinctId`/`$amplitudeDeviceId`/`$amplitudeUserId`) attached
      at send time, RC-compatible — closes the standing Meta/TikTok
      email-match gap too
- [x] Narrow store-lifecycle normalization: 4 new public keys
      (`subscription.billing_issue`/`grace_period`/`uncancelled`/
      `product_changed`) flowing to webhooks + providers; fixed a Google RTDN
      numeric-classification bug along the way (v1 category filtering now
      works for Google for the first time)
- [x] Backfill widened to SUBSCRIPTION + CREDIT_LEDGER aggregates
      (PAYWALL_EVENT deliberately excluded, rationale verified)
- [x] Wave 2: Braze, OneSignal, Iterable (lifecycle), Airbridge, Singular
      (attribution), Discord (communication) — first-class providers, zero
      schema migrations, five new RC-compatible vendor-id attributes, Slack's
      message builder hoisted to a shared chat module reused by Discord
- [x] Store-native lifecycle normalization — shipped 2026-09-03
      (`.superpowers/sdd/2026-09-03-store-lifecycle-normalization/`).
      **The item as written asked for the wrong thing, and this is the part
      worth carrying forward: the unit is a distinct subscriber-facing
      MEANING, not a raw store event type.** A key per raw type would give
      consumers two events for one real-world fact — renewals, refunds and
      revokes already reach them through `revenue.event.recorded` — and the
      fan-out is at-least-once, so deduplicating them would become the
      consumer's problem. Task 1's enumeration traced all 37 handled store
      event types to confirm that before anything was added.
      Delivered against that principle:
      - **Two previously-excluded rows re-examined.** Apple
        `DID_CHANGE_RENEWAL_STATUS` is now mapped, but only with the
        direction threaded through to the bridge (`resolveStorePublicKey`
        + `StoreEventContext`): ON → `subscription.uncancelled`, OFF stays
        unmapped because a cancel is already carried by
        `subscription.cancel_requested`. `STORE_EVENT_TO_PUBLIC_KEY` itself
        stayed untouched, preserving its documented invariant that every
        row in it is unconditionally true.
      - **Stripe `customer.subscription.updated` deliberately still out.**
        The prior `cancel_at_period_end` is unreachable without widening
        `lockPurchaseStatusByStoreTransaction`'s SELECT, a helper shared by
        Apple/Google/Stripe/refunds/supersede. A row that misclassifies half
        its deliveries is worse than no row; the blocker is named in the
        exclusion comment for whoever picks it up.
      - **Three keys added** — `subscription.paused`, `.recovered`,
        `.revoked` — mapped ONLY where a store sends a native signal.
        Per-store coverage is documented in `outbound-webhooks.mdx`:
        paused/recovered are Google-only, revoked is Apple + Google. Nothing
        is inferred; a guessed recovery would stop a consumer's dunning
        campaign for a subscriber who has not recovered.
      - **`subscription.revoked` closed a real hole.** `applyRevoke` wrote
        the chain status and revoked access while emitting NOTHING, and it
        carried the same missing `outcome.subscriberId` found in
        `applyRenewalStatusChange` — so a subscriber could lose access with
        zero signal to any consumer, and a mapping row alone would never
        have fired. Both were fixed and proven end-to-end against the outbox.
      - **A catalog-coverage guard is the durable part.** Every provider
        mapping table is `Partial<Record<RovenueEventKey, string>>`, so a
        provider advertising a key with no name for it compiles, ships and
        silently drops the event. The guard names the provider and key,
        declares deliberate omissions with reasons, and fails when an
        exemption goes stale.
- [x] One-time purchase revenue typing — shipped 2026-09-04
      (`docs/superpowers/specs/2026-09-04-one-time-revenue-typing-design.md`).
      **The item as written named the Stripe symptom; the real defect was
      one level deeper and affected all three stores, not just Stripe.**
      Verifying the Stripe gap turned up the same defect, one step milder,
      already live on Apple and Google: every one-time (non-subscription)
      purchase — consumable or non-consumable — was recorded as
      `revenue.INITIAL`, the same type as a new subscription. Stripe's
      funnel path had it worse: `grantOneTimePurchase` wrote a `purchases`
      row and an entitlement and recorded no revenue at all, so a funnel
      sale was invisible to every integration provider, to
      gross/net revenue, MRR, LTV, country revenue, and the transactions
      list alike — the "top credit packages" and "credit revenue" metrics
      were permanently zero because nothing had ever written
      `CREDIT_PURCHASE`, and the ad platforms received `Subscribe` for a
      coin pack.
      Delivered:
      - **One rule, one place.** `oneTimeRevenueTypeFor`
        (`services/revenue/one-time-type.ts`) is a total
        `Record<ProductType, RevenueEventType | null>` — `CONSUMABLE` →
        `CREDIT_PURCHASE`, `NON_CONSUMABLE` → `NON_RENEWING_PURCHASE`
        (new enum value, migration 0121), `SUBSCRIPTION` →
        `null` so the caller's own INITIAL/RENEWAL/TRIAL_CONVERSION
        classification stands untouched. A fourth `ProductType` is a
        compile error, not a silent fallthrough. All four producers —
        Apple and Google receipt verification, the Stripe funnel's
        one-time purchase completion, and the CSV importer — call it.
      - **Stripe funnel purchases now record revenue**, inside the same
        transaction that grants access, with USD conversion hoisted
        outside the transaction and a dedupe key that converges the
        `/confirm` and webhook-backstop racers.
      - **`revenue.REACTIVATION` became a public key**, closing a gap
        that predates this plan: it had been produced since Apple's
        RESUBSCRIBE handler shipped but had no catalog key, so every
        provider silently filtered it with `filtered_by_event_scope`.
        It carries two economic meanings under one key — a win-back and
        a reversed-refund accounting correction — disambiguated by a
        `metadata.reason` tag only `applyRefundReversed` sets. The tag
        reaches the delivered CUSTOM_WEBHOOK payload as `data.reason`
        (`revenueEventReason` on `RovenueEventEnvelope`, lifted from the
        outbox payload's `metadata.reason`, never the whole `metadata`
        object) — a fix from the whole-branch review, since the first
        cut lifted the tag into the outbox row and stopped there,
        leaving a consumer unable to tell the two cases apart.
      - **A compile-time bijection guard**
        (`services/integrations/revenue-key-bijection.ts`) makes "a
        `RevenueEventType` has no public key" a `tsc` error instead of a
        silent skip — the exact failure shape `REACTIVATION` had been
        shipping under. It does not cover SQL allow-lists, which a string
        literal hides from the type system.
      - **Named revenue-type groupings** replace fourteen hand-copied
        `IN (...)` allow-lists across metrics/analytics/dashboard code
        (`ALL_REVENUE_TYPES`, `REVENUE_TYPES_MONEY_OUT`,
        `REVENUE_TYPES_PURCHASE_COUNT`, `REVENUE_TYPES_NEW_RECURRING`,
        `REVENUE_TYPES_LIFETIME_PURCHASED`) — one decision point instead
        of fourteen. That these lists had already drifted from the enum
        was not a hypothesis: `CHARGEBACK` appears in eight predicates
        and has never been a `RevenueEventType` value, so no row could
        ever have carried it.
      - **A ClickHouse contract test** runs `v_revenue_lifetime_subscriber`
        against a real testcontainer with one row of every
        `RevenueEventType` and fails by name on any type the view drops —
        the only thing holding a SQL view and the TypeScript enum in step,
        since the view can't import the constant.
      - **A migration (0123) widens existing integration connections**:
        any connection with `revenue.INITIAL` already enabled gains
        `revenue.CREDIT_PURCHASE` and `revenue.NON_RENEWING_PURCHASE` too,
        so splitting one key into three doesn't silently stop deliveries
        a customer integration already receives. `revenue.REACTIVATION`
        is deliberately **not** added by that migration — a genuinely new
        signal nobody has ever received ships opt-in, not retroactively
        enabled.
      - **History is not rewritten.** Rows recorded before this release
        keep `revenue.INITIAL` for what was, in fact, a one-time purchase.
      Two rulings, recorded: `CREDIT_PURCHASE` means "a consumable IAP was
      bought," not "a credit grant was recorded" — a misconfigured
      `CONSUMABLE` product with no currency-grant rows is still filed
      here, deliberately, because keying on the grants table instead
      would make the type a function of mutable configuration. And
      `ltv-prediction`'s cohort anchor stays subscription-only, on
      purpose — a one-time buyer is not a subscription-cohort member, and
      anchoring them there would project recurring revenue for someone
      who bought once.
      Stripe `customer.subscription.updated`'s prior
      `cancel_at_period_end` — §6's other named exclusion from the
      2026-09-03 entry above — is untouched and stays open; this plan did
      not touch it.
      Open residuals from the whole-branch review's final fix wave
      (2026-09-05), recorded rather than fixed:
      - ~~A `CONSUMABLE` sold through a Stripe funnel books `CREDIT_PURCHASE`
        revenue while granting zero credits.~~ **Closed 2026-09-05.**
        `grantOneTimePurchase` (`services/funnel/complete-purchase.ts`) now
        returns which product/purchase/subscriber to grant for when the
        product is CONSUMABLE, and `completeFunnelPurchase` calls
        `grantPurchaseCurrencies` for it AFTER its transaction commits — not
        inside. It has to be outside: `addCredits`
        (`services/credit-engine.ts`) always opens its own
        `drizzle.db.transaction` (no `tx` parameter to join), so nesting it
        in the paid-transition transaction would either graft an
        independently-committing transaction onto it (credits could survive
        a rollback of the paid transition, or the reverse) or, if it threw,
        violate `grantOneTimePurchase`'s "nothing here throws" contract and
        strand a buyer who really paid. `addCredits` dedupes on
        (subscriberId, referenceType: "purchase", referenceId: purchaseId,
        currencyId), so a failure here is safe to re-run — but nothing
        currently retries it automatically, since a second
        `completeFunnelPurchase` call for the same session short-circuits
        before reaching this code again; a failure is logged loudly for an
        operator to re-run by hand rather than silently dropped. Verified
        against a real Postgres
        (`services/funnel/complete-purchase.integration.test.ts`): a
        CONSUMABLE with currency grants ends with both the `CREDIT_PURCHASE`
        revenue row and the credits granted; a NON_CONSUMABLE with grants
        configured anyway gets neither; a replayed `/confirm` does not
        double-grant.
      - `apps/api`'s test typecheck (`tsconfig.tests.json`) is red on
        `main` with ~358 pre-existing errors from a repo-wide `vi.fn()`
        typing idiom. Nothing gates on it — `typecheck:tests` is not in
        `build` or the turbo pipeline.
- Architecture note (now implemented, not just planned): the outbox → Kafka
  fanout consumer + deliver worker is the "integration dispatcher"; each
  integration = registry entry (mapping + credential schema) + credential
  record.

## 7. SDK platform coverage (55 → 95)

- [x] Flutter SDK (shipped 2026-08-31) — `packages/sdk-flutter/` (federated plugin: `rovenue_flutter` +
      `rovenue_flutter_platform_interface` + `rovenue_flutter_ios` + `rovenue_flutter_android`), Dart
      bindings over the same Swift/Kotlin façades (and Rust core) the native SDKs already wrap; 5-way
      CI parity wired; docs at `/docs/platforms/flutter`. Known gap: RN's `resolveFunnelClaim`
      retry/fallback chain was not ported (single-shot claim only) — see the docs page's parity table.
- [x] Web SDK (shipped 2026-09-05) — `packages/sdk-web/` (`@rovenue/web-sdk`):
      framework-agnostic core, a React layer, and a paywall binding that feeds the
      renderer the dashboard already uses. Docs at `/docs/platforms/web`.

      The item's parenthetical was half wrong, and the correction is the useful
      part. The "web payment backend" that existed is the funnel's ANONYMOUS
      on-page flow — session identity in the URL, `origin: "*"`, no credentials —
      which an SDK-authenticated app cannot use; and `checkout.sessions` appeared
      nowhere in the API. More importantly the first blocker was not checkout at
      all: `/v1` was unreachable from a browser, and since a CORS preflight
      carries no `Authorization` header, per-project CORS is impossible unless
      the project is resolvable from the URL. Hence `api_keys.allowedOrigins`
      plus a `/v1/web/:publicKey` mount.

      Also shipped as prerequisites: `POST /v1/checkout` (security shape copied
      from `/v1/billing-portal` — identity only from the app-user header, a
      `.strict()` body with no price/amount/customer field, redirect URLs
      allow-listed against verified custom domains), and a WebCrypto bucketing
      implementation, because `assignBucket` hashed with `node:crypto` and would
      not run in a browser at all. It is verified against the same
      `bucketing-vectors.json` the Node and Rust implementations are, so a user's
      experiment variant does not change between web and native.
- [ ] Unity SDK (games market; natural fit with credits/leaderboards)
- [ ] Capacitor / Cordova façades
- [x] Fix release blockers (shipped 2026-09-05) — the Rust half was stale: fmt,
      clippy and the workspace tests were already green. The real blocker was
      the vendored `librovenue_ffi.a`, which `otool` reports as an iOS
      *simulator* slice despite the podspec documenting it as arm64 device — a
      published pod would not have linked on device. Replaced by
      `RovenueFFI.xcframework` (iOS device / iOS simulator / macOS). The
      podspec sha256 stays a placeholder until the operator cuts the first
      release; `release-sdk.yml` pins it.
- [x] Align Swift/Kotlin versions with core (already true before this work) — core-rs, sdk-swift,
      sdk-kotlin, and sdk-rn were all at 0.16.0 prior to the Flutter SDK; sdk-flutter shipped at
      0.16.0 too, so all five packages are aligned as of 2026-08-31
- [x] Make the RN iOS pod externally consumable (shipped 2026-09-05) — both
      `SWIFT_INCLUDE_PATHS` blocks are gone. They existed only to put
      sdk-swift's module map on the import path; `${PODS_ROOT}/../../../..`
      resolves to nothing in an npm install. The module map now ships inside
      the xcframework. The same workaround in the Flutter example's Podfile,
      whose comment called it unfixable from the podspec, is gone too.
- [x] Official macOS target in the Swift SDK (shipped 2026-09-05) — a macOS
      slice plus `:osx => '12.0'`; `pod lib lint --platforms=macos` and
      `swift test` both pass. tvOS / watchOS / visionOS remain open: those
      Rust targets are Tier 3 and need a nightly toolchain with `-Z build-std`,
      a second build pipeline rather than a fourth slice.
- [ ] tvOS / watchOS / visionOS targets in the Swift SDK (Tier 3 Rust targets)
- Nothing is published yet: CocoaPods Trunk, pub.dev, npm, and GitHub
  Releases were all empty as of 2026-09-05, so version `0.16.0` has no
  consumers and the first release is still ahead. The distribution
  repository `broverse/rovenue-swift` that the podspec and Swift docs now
  point at does not exist yet either — it is created by the operator as
  part of cutting that first release.

## 8. Self-hosting & data ownership (95 — keep)

- [ ] One-command install: Coolify template + Helm chart
- [x] Version upgrade runbook — `docs/operations/upgrade.md` (296 lines).
      Covers Docker Compose in full; it says itself that Coolify and Helm are
      not covered, which is the open item above, not this one.
- [x] Backup / restore documentation — `docs/operations/backup-restore.md`
      (422 lines), alongside `deploy/backup/restore.sh` and its test suite.
- [ ] Close the nosniff/ETag edge-layer gap (asset CDN)
- [ ] `scripts/rotate-encryption-key.ts` does not typecheck and cannot run.
      Found while writing the operator handbook's secret-rotation section
      (`docs/runbooks/secret-rotation.md`). It does
      `import prisma, { ... } from "@rovenue/db"` — a leftover from before
      this codebase moved to Drizzle — and `@rovenue/db` has no default
      export at all (`pnpm --filter @rovenue/scripts typecheck` fails on it
      today). Its `CREDENTIAL_FIELDS` list also includes `stripeCredentials`,
      a column that does not exist on `projects`
      (`appleCredentials`/`googleCredentials` are the only two encrypted
      JSONB fields there; Stripe uses Connect OAuth, not a stored encrypted
      credential). The three real building blocks it should be rewritten
      around already work — `encryptCredential`, `decryptCredential`,
      `isEncryptedCredential` (`packages/db/src/helpers/encrypted-field.ts`)
      — a corrected version would use Drizzle to select/update
      `projects.appleCredentials`/`googleCredentials` directly. Do not point
      an operator at the script as-is; the `ENCRYPTION_KEY` rotation tool is
      broken.
- [ ] Fresh self-hosted installs never register `revenue_events` or
      `credit_ledger` with `partman.part_config`. Migration `0019` calls
      `partman.create_parent(...)` for both tables, but the fresh-install
      runner (`packages/db/src/fresh-install.ts`'s `TIMESCALE_LEGACY_TAGS`)
      intentionally skips `0019` — running it against a fresh install would
      abort with "would overlap partition" against the 60 monthly partitions
      `0015`/`0016` already pre-create through 2028-12. That skip is
      deliberate and already commented in the source, but nothing outside
      the source told an operator: a fresh install's `revenue_events` and
      `credit_ledger` are absent from `partman.part_config`, so nothing
      creates a partition for either table once 2028-12 passes, and an
      insert with `eventDate`/`createdAt` outside 2024–2028 fails outright
      with "no partition found for row." Documented live (with the actual
      `partman.part_config` query output) in `docs/operations/handbook.md`'s
      "fresh-install divergence" section — an operator needs to run
      `partman.create_parent(...)` by hand before 2028, or migrate onto
      partman management sooner. Distinct from the earlier partition-worker
      bug: the maintenance worker itself runs fine here — it correctly
      refuses to touch tables that were never registered with it.

## 9. GDPR / KVKK tooling (85 → 95) — CLOSED 2026-09-06

- [x] Self-service DSAR API (exposed by customers to their end users) — four
      secret-key S2S endpoints (`POST /v1/dsar/export`, `POST
      /v1/dsar/erasure`, `GET /v1/dsar/:id`, `GET /v1/dsar/:id/download`) let
      a customer's own backend fulfil export/erasure for its own end users
      without a Rovenue support ticket; Rovenue never authenticates that end
      user itself. Export and erasure run on two separate BullMQ queues (a
      backlog of heavy exports must never delay erasure, which carries a
      statutory deadline export does not), each with its own claim-lease
      recovery so a crashed worker's row is reclaimed rather than stuck
      `RUNNING` forever. A second request for a subject already `PENDING` or
      `RUNNING` returns the same request record rather than starting a
      second job — idempotent both by an application-level check and by the
      database's own partial unique index as the race-proof backstop.
      Erasure anonymises rather than deletes the Postgres row (the row's own
      id survives, `appUserId` becomes a deterministic HMAC token, attributes
      clear — preserving the append-only `credit_ledger`'s guarantee), then
      purges the subscriber from every ClickHouse table carrying a plain
      subscriberId at rest (`raw_exposures`, `raw_revenue_events`,
      `raw_credit_ledger`, `raw_sdk_session_events`, `raw_paywall_events`),
      polling each `ALTER ... DELETE` mutation to actual completion before
      marking the request `COMPLETED` — never on submission alone. A
      completed export is a point-in-time snapshot (not a subscription),
      downloadable for 30 days through an authenticated stream with no
      shareable link — no signed URL exists. Two open gaps, stated rather
      than papered over: the artifact bucket has no expiry sweep of its own
      (access is gated by `expiresAt`, the object itself isn't purged), and
      the guard that stops an erased subscriber's next SDK call from
      silently un-erasing them is enforced per write-route today, true by
      audit rather than by a CI check. Documented at
      `apps/docs/content/docs/guides/dsar.mdx`.
- [x] Per-table data-retention policy automation — `RETENTION_POLICIES`
      (`packages/shared/src/retention/policies.ts`) is the single registry: a
      window per project resolves from its billing tier (optional — self-host
      has none) clamped by an override that may only shorten it, floored at a
      per-policy minimum. A tier-less, override-less project is skipped (keeps
      everything) for every table EXCEPT `webhook_events` and
      `copilot_messages`, which carry a `defaultDays` of 90 — the exact window
      each was deleted at unconditionally by the bespoke worker it replaces,
      carried forward so removing that worker did not silently stop retention
      for the ~90% of projects with no billing tier (fix round 1, Finding 1).
      A nightly sweep (`workers/retention-sweep.ts`) reclaims `audit_logs`
      (checkpoint-then-truncate, preserving a verifiable proof bundle),
      `credit_ledger` / `revenue_events` (fleet-wide partition drops, gated on
      every project having resolved a window), and `outgoing_webhooks` /
      `webhook_events` / `copilot_messages` (per-project DELETE). Replaces the
      three bespoke workers (`rovi-retention`, `webhook-retention`, plus
      `import-retention`'s hardcoded window) this task retired or converted.
      `import_jobs` keeps its own worker — it also deletes object-storage
      files, which the generic sweep deliberately does not model — but now
      resolves its window the same way, with NO default: a tier-less project
      keeps its import files forever until it sets an override, unlike
      `webhook_events`/`copilot_messages`. ClickHouse's fixed `INTERVAL 2
      YEAR` TTL is explicitly out of scope. Documented at
      `apps/docs/content/docs/guides/retention-policies.mdx`.
- [x] Externally verifiable proof format for the audit hash chain — `GET
      /dashboard/audit-logs/proof` exports a bundle over the canonical
      encoder in `@rovenue/shared/audit-chain`; verify offline with
      `scripts/verify-audit-bundle.ts` (no Rovenue code, no server trust).
      Documented at `apps/docs/content/docs/guides/audit-proof.mdx`.

## 10. Production maturity & scale proof (45 → 95) — earned over time

- [x] Load-test suite (2026-09-05, `load/k6/`) — **benchmark page WON'T DO**.
      Three profiles: steady SDK reads (`/v1/me/entitlements` +
      `/v1/placements/:identifier`), an event storm ramping into `/v1/events`
      (the OLTP write path that backpressures clients on a release day), and a
      receipt spike.

      All three use an OPEN model — arrival rate, never a fixed VU pool. With
      fixed VUs each one waits for its response before sending the next, so a
      server that gets slower receives less traffic and the throughput number
      stays flat: the suite cannot see the regression it exists to find.

      Pass criteria are imported from `deploy/prometheus/rules/slo.yml` rather
      than chosen locally, so a passing run and a paging service cannot
      disagree about what "fast enough" means.

      The receipt profile aborts unless `LOAD_ALLOW_OUTBOUND=1`: `verifyReceipt`
      calls Apple's App Store Server API, so that endpoint points a load
      generator at a third party with your credentials. Its docs also refuse to
      conflate two numbers — with synthetic payloads it measures the REJECTION
      path, not a successful purchase.

      The **published benchmark page is won't-do**: a throughput figure means
      nothing without the hardware and dataset that produced it, and there is no
      reference deployment here. A laptop number presented as characterising the
      software is worse than no number.

- [x] ClickHouse lag under a Kafka-fed materialized view — the third chaos
      scenario (2026-09-05, `apps/api/tests/ch-kafka-engine.integration.test.ts`).
      ClickHouse sits downstream of Kafka, so its absence must be invisible to
      the write path: the dispatcher publishes and marks the row published
      while nothing is consuming, the row is genuinely absent from CH during
      that window, and it arrives on its own afterwards — no replay, no
      backfill, no operator step.

      Producing the outage took three attempts and the two rejected ones are
      recorded in the test, because each made it a decoration.
      `clickhouse.restart()` takes the schema with it (the migrations run once,
      in `beforeAll`), so it tests the container's storage rather than the
      pipeline. Repointing `CLICKHOUSE_URL` proves nothing: the dispatcher
      never reads it, so the "outage" is a no-op and the test passes against a
      dispatcher that queries ClickHouse on every batch. Detaching the
      MATERIALIZED VIEW does not stop the consumer promptly — CH keeps polling
      after its last reader goes away, and the row landed inside ten seconds.
      Detaching the Kafka Engine queue table is the real thing; the group
      offset lives in Kafka, so it survives. Verified falsifiable by removing
      the DETACH, which turns the zero-rows assertion red.
- [x] SLOs (2026-09-05, `deploy/prometheus/rules/slo.yml`) — **status page
      WON'T DO**. `deploy/prometheus/` had a config with no rules in it. Two
      objectives now exist on the API's own RED metrics: 99.9% non-5xx and 99%
      under 500ms, both over 30 days. 4xx burns neither budget — a rejected key
      is the caller's outcome, not an outage — and there is a test that floods
      the service with 401s and asserts perfect availability. 500ms is an actual
      histogram bucket boundary, not a tidy-looking number; a threshold between
      boundaries would interpolate and the SLI would stop meaning what it says.

      Alerts are multi-window multi-burn-rate. A single "error rate above X"
      must choose between catching a fast outage and not paging on a blip;
      pairing a long window with a short one removes the choice, so an incident
      that has already recovered stops paging on its own. That behaviour has its
      own test.

      Four more alerts come from sentences already written beside the counters
      in `lib/metrics.ts` that nothing had ever acted on — the circuit-breaker
      comment literally says "ALERT ON ANY NON-ZERO VALUE".

      Verified with compose's own Prometheus (v2.54.1): `promtool check config`
      and `check rules` pass, `promtool test rules` passes 6 scenarios, and the
      tests were proven falsifiable by raising the burn threshold.

      The **status page is won't-do here**: it needs hosting and a domain, which
      is an operator decision, not a repository one. Nothing in the repo can
      close it.
- [ ] No Alertmanager is wired into `docker-compose.yml`. `slo.yml`'s own
      header already says so (`ROUTING: there is no Alertmanager in
      docker-compose.yml`) — the multi-window burn-rate alerts above (99.9%
      availability, 99% under 500ms) plus the correctness alerts labelled
      `page` evaluate and are visible in Prometheus/Grafana, but nothing
      actually pages anyone: `deploy/prometheus/prometheus.yml` has no
      `alerting:` block and no `alertmanager` service exists in
      `docker-compose.yml`. Add the service plus `alerting.alertmanagers`,
      or point operators at Grafana's own contact points instead — the SLO
      rules evaluate correctly either way, only routing is missing.
- [x] Chaos tests: dispatcher death + Kafka outage/recovery (2026-09-05,
      `apps/api/tests/outbox-dispatcher.integration.test.ts`). The
      dispatcher's crash window is between `producer.send` and
      `markPublished`: `claimBatch` releases its lock when its own tx commits,
      so a process that dies after the ack has published an event the database
      still considers unpublished. `outbox-replay-idempotency.test.ts` already
      proved the downstream half — ClickHouse collapses the duplicate — but
      says in its own header that it BYPASSES the outbox → dispatcher path, so
      the OLTP half, the part that decides between duplicated and LOST, had no
      test. It does now: the post-crash state is constructed directly and the
      next tick recovers it with no operator step.

      Kafka outage asserts the one-directional invariant — a failed send must
      never advance `publishedAt` — plus the topic backoff that makes recovery
      deliberately not instant. Writing it surfaced that: a naive retry test
      would have failed and read as data loss. Verified by inverting the rule
      (mark everything claimed as published regardless of send outcome), which
      turns two of the four red.

      Also fixed a pre-existing flake in that file while there: its first test
      starts `runOutboxDispatcher()` and never stops it, so a background loop
      kept draining the table and holding connections. That test now passes in
      ~2.8s where it previously timed out.

      ClickHouse lag is covered by the item above.
- [ ] 3–5 pilot apps in production; millions of live events as reference —
      **CANNOT BE DONE FROM THE REPOSITORY.** This is earned by shipping to real
      customers over real time. No commit closes it.
- [~] CI unblocked and the testcontainer pass given a database (2026-09-05).
      **"Required" remains the repository owner's** — it is a branch-protection
      setting, not a file.

      CI had been red since July, failing in under twenty seconds, before a
      single test ran: the workflow pinned `node-version: 20` while the root
      package.json requires `>=22.7`, so `pnpm install` refused outright. Every
      red run since was that. Fixed, along with the pnpm version pin, which lived
      in two places (workflow `version: 9`, package.json `pnpm@9.15.9`) and now
      lives in one.

      Behind it was a second wall: `pnpm audit --prod --audit-level=high` gates
      the pipeline and was failing with 56 high and 2 critical across 15
      packages. It now exits 0 with zero unignored high-or-critical advisories —
      twelve pinned through per-major pnpm overrides, three bumped (better-auth,
      react-router, a sharp override), three suppressed because they enter
      through an example app's Expo CLI or a Prisma peer that is not installed
      at all. The better-auth bump was not version-only: `twoFactor.enable()`
      became a discriminated union and the account-security dialog read
      `totpURI` off it unconditionally.

      The suppression list had its own problem — seventeen opaque GHSA ids in
      JSON whose rationale lived in a git-ignored scratch directory. A
      suppression nobody can audit is one nobody can retire, so it is now
      `docs/security/dependency-audit-suppressions.md`.

      The workflow also now runs Postgres (built from `deploy/postgres`, since
      the suites need pg_partman and `services:` can only pull) and Redis.
      apps/api's `test` script has always been two passes, so CI was already
      invoking the testcontainer suites — they just had nothing to connect to.

      UNVERIFIED until pushed: none of this can be confirmed green from a
      workstation, and the container pass has never executed on a runner.
- [x] `pnpm db:migrate`'s "misfire" diagnosed and the real defect fixed
      (2026-09-05). The routing was never wrong: a database created by the
      fresh-install runner is stamped `__rovenue_install.mode = 'fresh'`
      permanently, and that is by design — it must keep marking the
      TimescaleDB-era migrations applied without executing them, because the
      shipped image has no `timescaledb.control`. The runner already skips
      already-applied migrations by content hash.

      What was actually broken was what the runner SAID. "fresh install
      detected — applying the full journal", printed against a database with
      a hundred applied migrations and then followed by silence, reads as
      "about to reapply everything" — which is how two separate people
      concluded it had misfired, one of them resetting a dev Postgres volume
      over it. It now names the reason for the routing and prints a summary:
      `journal: 125 entries — 125 already applied, 0 executed, 0 marked
      without running`, so a no-op is visibly a no-op.

      Found while fixing it, and worse: a migration FILE not listed in
      `meta/_journal.json` is invisible to both runners, so the schema change
      silently never lands. That happened to 0122 during the Web SDK work and
      surfaced only when a test harness rebuilt a database from the journal.
      `db:migrate` now refuses to be quiet about it — it warns, by filename,
      before either runner starts.
- [ ] Migration journal timestamps keep needing hand-fixes to stay reachable.
      0121–0126 are all hand-set to the same synthetic future +86400000
      (1-day) cadence — `0121`'s `when` is 2026-09-05 22:40 UTC, `0126`'s is
      2026-09-10 22:40 UTC, each exactly one day after the last — putting the
      journal watermark days ahead of wall clock. Any migration
      `drizzle-kit generate` produces afterward from real time lands BELOW
      that watermark and is silently skipped forever on upgrade-path
      databases (see `journal-monotonic.test.ts`'s header for the mechanism);
      this hit `0125` and `0126` independently while they were authored in
      this same batch and had to be hand-corrected onto the same future
      cadence rather than fixed at the root. **Correction to how this was
      first reported:** `packages/db/tests/journal-monotonic.test.ts`
      (added 2026-09-05, commit `634fb2e0`) is not an orphaned guard — it
      matches `packages/db`'s default `vitest run` test glob with no config
      excluding it, and CI's `pnpm test` (`ci.yml`) exports `DATABASE_URL`
      for turbo's `test` task, so it already executes on every CI build and
      currently passes (confirmed via `vitest list` and a direct run). What's
      still unsolved is the habit, not the coverage: nothing stops the next
      hand-set round timestamp from repeating this pattern, and the test can
      only catch it once a bad entry is actually committed.

## 11. Docs & developer experience (65 → 90)

Eight of ten items closed this batch: per-SDK quickstarts and full API references (six
SDKs, auto-generated, doc-coverage ratchet in CI), the RevenueCat/Adapty migration guides,
the vendor-agnostic data import tool plus its Google purchase-token second pass, working
example apps for all four remaining platforms (each CI-built, not just claimed), the
error-code catalog (generated, compile-time total over `ERROR_CODE`), the self-host
operator handbook and its two runbooks, and — this task — the interactive API explorer.
Not 95: two items are deliberately left open and recorded as their own entries above
rather than folded into this summary — `methods.mdx`'s missing RN Paywalls/Remote
Config/Attributes section, and docs search being unreachable behind the production
Caddy image. Neither blocks a self-hoster from using the docs; both are real, named gaps
for whoever picks them up next.

- [x] Quickstart + full API reference per SDK (auto-generated: rustdoc / DocC / Dokka / TypeDoc)
      — shipped 2026-09-06. Six SDKs, not five — `@rovenue/web-sdk` was omitted from the original
      plan and added: `.github/workflows/sdk-docs.yml` generates all six (rustdoc, DocC, Dokka,
      TypeDoc for sdk-rn AND sdk-web, dartdoc) on runners that can actually build each toolchain
      and verified producing real output (rustdoc 402 files, DocC 6082, Dokka 902, TypeDoc-rn 52,
      TypeDoc-web 35, dartdoc 348); `apps/docs/Dockerfile` downloads them into
      `apps/docs/public/api/<sdk>/` before `react-router build` and FAILS the image build by name
      if one is missing (never a silent 404); served at `docs.rovenue.app/api/<sdk>/`. A quickstart
      was written on each of the five platform pages, each verified to match its example app's real
      code (`examples/*`) rather than invented — `web.mdx` is the one exception by necessity: the
      web SDK has no `purchase()`, so its "quickstart" ends at a Stripe Checkout redirect instead
      of a native purchase.

      **This is a fully-documented FAÇADE over a partially-documented type layer — not full
      coverage.** Façade doc coverage was raised across the five SDKs whose façade doc-pass was in
      scope (core-rs, sdk-swift, sdk-kotlin, sdk-rn, sdk-flutter — ~96 methods total); sdk-web's
      façade doc-pass was explicitly out of scope and sits at its measured floor alongside
      everything else. Across all six SDKs, roughly 1,390 DTO fields, enum variants and internal
      plumbing remain undocumented — that's its own, not-yet-scheduled ROADMAP item. A doc-coverage
      ratchet (`scripts/sdk-doc-coverage.mjs` + `.json`) now fails CI if any SDK's measured
      documented-symbol density drops below its recorded floor: core-rs 32.8%, sdk-swift 25.4%,
      sdk-kotlin 32.1%, sdk-rn 65.5%, sdk-web 38.8%, sdk-flutter 85.9%.

      Writing the quickstarts against the real example apps (rather than trusting the existing
      platform pages) surfaced real, pre-existing doc bugs: fictional purchase-cancel/pending error
      types on the iOS/Android/RN platform pages (`.purchaseCancelled`/`.purchasePending` etc. —
      none of those names exist in any SDK; the real shape is one error type with an `ErrorKind`),
      a `debug: boolean` config field that was removed when logging moved to `logLevel` but still
      documented on five platform pages plus the `methods.mdx`/`types.mdx` reference (that
      enumeration was itself incomplete — `guides/configuring.mdx`'s RN and Swift samples and
      `getting-started/quickstart.mdx`'s `RovenueConfig` type block and prose also carried it;
      missed by this pass, caught and fixed only in the branch's final review), Android
      `configure()` examples missing `context` (so purchases would fail with
      `STORE_PROBLEM` while `configure()` itself appeared to succeed), and a Flutter change-listener
      example that called `refreshEntitlements()` from inside `onChange` — the exact re-emit
      infinite-loop footgun the SDK's own doc comment warns against.
- [x] "Migrate from RevenueCat" and "Migrate from Adapty" guides — strategically the two
      most valuable docs (correction: the RevenueCat guide already existed as a lean
      concept-mapping page before this line was written — it was never unwritten, only
      missing the import procedure; 2026-09-01 extended it with the full history-import
      walkthrough and added the new "Migrate from Adapty" guide, both under
      `apps/docs/content/docs/resources`)
- [x] Data import tool (RC export CSV → subscriber/transaction import) — shipped: a
      column-mapping engine with vendor presets (RevenueCat Transactions), anchor-gated
      preset detection, a generic hand-mapper for unconfirmed schemas (Adapty), async
      mandatory dry run, and a two-phase commit (Phase A history import, Phase B store
      re-verification with resumable `VERIFICATION_INCOMPLETE`)
- [x] Google purchase-token second pass — shipped 2026-09-06 as option (a): the
      `revenuecat_google_token` preset now uploads as its own job kind
      (`import_jobs.kind = GOOGLE_TOKEN_ENRICHMENT`, migration 0126), which gates the
      required-field set per kind, and `runEnrichmentJob` patches
      `purchases.googlePurchaseToken` (migration 0125) onto purchases a previous history
      import already wrote, then hands the new tokens to the SAME Phase-B verification
      the history import uses. The guide's "not yet available" note is replaced with the
      real procedure.

      Three things in this item's own proposed fix were not buildable as written, and
      each one is why the work was larger than "give the preset its own path":

      1. **There was no column to store the token.** `purchases` had no
         `googlePurchaseToken` at all — the field existed only on the CSV row. Patching
         it onto an existing purchase presupposed a destination that did not exist
         (added by migration 0125).
      2. **`(subscriberExternalId, productIdentifier)` is not a unique key.** `purchases`
         has exactly one unique index, `(store, storeTransactionId)`. A subscriber holds
         one row per renewal, and over time several distinct subscription chains for the
         same product (a resubscribe after a lapse). "Find the existing purchase" by that
         pair is ambiguous BY CONSTRUCTION; the shipped rule groups candidate rows by
         `originalTransactionId` and refuses — reports, never guesses — when more than one
         chain matches. That refusal turns out to catch the COMMON case, because
         RevenueCat's export has no original-transaction column and write.ts's NOT NULL
         fallback makes every renewal its own one-row chain, so the pass ships with an
         explicit `enrichUngroupedChains` opt-in (off by default, surfaced in the dry-run
         summary and documented) for exactly that shape.
      3. **The required-field gate was doubled.** `validateMapping` ran at BOTH
         `PATCH /mapping` and `POST /dry-run`; fixing one would have moved the 400 rather
         than removed it.

      Also fixed along the way: `purchases.googlePurchaseToken` would otherwise have been
      a column with a producer and no consumer — the history job's Phase B discovers its
      anchors by re-reading its own CSV, which has no token column, so those Android rows
      would stay unverifiable forever. The enrichment commit hands its chains to a new
      `verifyEnrichedGoogleAnchors` entry point that shares the whole store-facing half of
      `verifyImportedAnchors`.
- [x] Working example apps (iOS / Android / RN / Flutter demo repos) — the
      Flutter example (`packages/sdk-flutter/example`) already existed and was
      already CI-built before this item was written, so it was partly done
      going in. This pass added the two that were missing — a native SwiftUI
      example (`examples/ios-swift`) and a native Jetpack Compose example
      (`examples/android-kotlin`) — and, the actual point of the item, put a
      CI job around EVERY example so "working" is enforced, not claimed:
      `example-ios`, `example-android` and (Flutter's) `flutter-android-native`
      all compile the real app in `.github/workflows/sdk.yml`. The fourth,
      `examples/sample-rn-expo`, is CI-verified TYPECHECK-ONLY, not a full
      Metro bundle or native build — two independent, pre-existing hazards
      make either un-greenable: (1) a CocoaPods monorepo-hoisting bug
      (`ExpoModulesCore.podspec` resolves the React Native version from the
      wrong, hoisted `node_modules`, baking a mismatched
      `REACT_NATIVE_TARGET_VERSION` into the Pods project) and (2)
      `packages/sdk-rn` declaring `expo >=52` / `react-native >=0.76` while
      the example pins `expo ~51` / `react-native 0.74.5`, which hoists an
      incompatible `@expo/cli` that fails in its own startup before ever
      reading app code. Both are documented in
      `examples/sample-rn-expo/README.md`.

      The concrete justification for doing this at all: `sample-rn-expo` was
      found silently BROKEN — it imported a hook removed in the
      credit→virtual-currency rename — precisely because nothing had ever
      built it. Building things nobody had built surfaced two real SDK
      defects along the way, not just the example's own bug:

      1. `packages/sdk-rn/plugin/withRovenueAndroid.ts` patches a consuming
         app's Gradle files with `includeBuild(...)` +
         `implementation("dev.rovenue:sdk:0.1.0")` but adds NO
         `dependencySubstitution` rule. Gradle's default included-build
         substitution matches by the included project's own project name
         (`sdk-kotlin`), not the maven coordinate (`dev.rovenue:sdk`) the
         plugin's own `implementation(...)` line depends on — so any real
         Expo app using this plugin gets a non-resolving Android build
         ("Could not find dev.rovenue:sdk:0.1.0"). Confirmed by reproducing
         it; `examples/android-kotlin/settings.gradle.kts` carries the
         missing rule and documents the reasoning.
      2. `packages/sdk-swift/RovenueFFI.xcframework` is a gitignored binary
         artifact that `Package.swift` requires via `.binaryTarget(path:)` —
         a fresh clone cannot build any native Swift consumer (including this
         SDK's own example) until `packages/sdk-swift/scripts/build-xcframework.sh`
         generates it, and until now that requirement was documented nowhere
         a new consumer would think to look.

      Deferred follow-up on hazard (2): upgrading `sample-rn-expo` to
      `expo >=52` / `react-native >=0.76` may also dissolve hazard (1) rather
      than just uncover it — the CocoaPods hoisting bug depends on which
      React Native version gets hoisted where in the monorepo's
      `node_modules`, and a version bump changes that resolution. Not
      verified; recorded so whoever does the upgrade checks it rather than
      assuming both hazards still need independent fixes.
- [ ] `apps/docs/content/docs/reference/methods.mdx` has no section for
      three real, exported RN SDK method groups: Paywalls
      (`RovenuePaywallView`, exported from `packages/sdk-rn/src/index.ts`),
      Remote Config (`getRemoteConfig` / `refreshRemoteConfig`), and
      Attributes (`setAttributes`). All three exist and work; the reference
      page simply never grew a section for them. Distinct from the fiction
      already purged from this file elsewhere in this batch — this is
      absent coverage, not false coverage.
- [ ] Docs search does not work in the shipped image. `apps/docs`'s
      production `Dockerfile` builds the static site in a `node:22-alpine`
      stage and serves the output from a `caddy:2-alpine` runtime stage with
      no Node process at all. `/api/search`'s loader
      (`apps/docs/app/routes/search.ts`, `fumadocs-core/search/server`)
      needs a live server to answer requests, so it is unreachable behind
      Caddy in production. Either switch to a static/client-side search
      index (fumadocs supports this) or run the docs app as a Node server
      instead of prerendered-static-behind-Caddy.
- [x] Interactive API explorer — shipped 2026-09-06 at `/docs/reference/api-explorer`,
      rendering `apps/api/openapi/openapi.json` (33 canonical `/v1` endpoints) with a
      real "try it" panel (an actual `fetch()` per endpoint, editable path/query/header
      params and JSON body, Bearer token) plus a copyable `curl` command per endpoint as
      the always-works fallback.

      **Honest about provenance, not a claim of full generation.** Request bodies and
      auth are GENERATED by walking Hono's route table
      (`apps/api/scripts/generate-openapi.ts`); responses and parameters are
      HAND-AUTHORED in `apps/api/openapi/responses.ts`, because `ok<T>()` is an identity
      generic erased at runtime and no route validates query or path params — there is
      nothing at runtime to introspect for either. A `SpecProvenance` callout on the page
      itself states this split plainly, sourced from `openapi.json`'s own
      `x-rovenue-generation` object, rather than letting a reader assume every field on
      the page was derived from source.

      Two guarantees keep the generated half from drifting: a contract test
      (`apps/api/tests/openapi-contract.test.ts`) fails BY NAME when the served endpoint
      set and the documented set diverge, and a CI `openapi:check` step fails when the
      committed spec is stale relative to the live route table.

      The explorer page is pure client-side and SSR-guarded (`fetch`/`window` calls live
      only inside a post-mount `useEffect`), because the production docs image
      (`caddy:2-alpine`, no Node process) full-site-prerenders — the same constraint
      recorded above for docs search, satisfied here rather than run into.

      Closing this also closed a gap in the tooling meant to protect it: `check:links`
      validated `/docs/...` route existence but not `#fragment` anchors, and the explorer
      links every `ERROR_CATALOG` entry to `/docs/reference/api-errors#<wire-value>` —
      five of which (`asset_in_use`, `asset_missing`, `purchase_not_paid`,
      `apple_offer_signing_unavailable`, `apple_offer_signing_failed`) differ from their
      `ERROR_CODE` key. `apps/docs/scripts/check-links.mjs` now computes the real
      github-slugger anchors every page renders and validates both literal
      `#fragment` links and this one dynamic, wire-value-driven source against them —
      proven by deliberately renaming a heading and watching the check fail by name
      (`pnpm --filter @rovenue/docs check:links` exits 1, naming both the page's own
      broken self-link and the dynamic explorer link), then restoring it. It is now a
      `.github/workflows/ci.yml` step ("Docs links + anchors are valid", next to
      "OpenAPI spec is up to date") — it runs in well under a second, so shipping it
      unwired was the one gap worth closing before this batch ended: the first real
      defect this whole batch found (migration 0125's journal-timestamp bug) got as far
      as it did because a test that would have caught it, `packages/db/tests/journal-
      monotonic.test.ts`, already existed and nothing ran it. A guard nobody runs is
      indistinguishable from no guard.

      Running the check for the first time — reproducibly: `git checkout <pre-fix
      commit> -- outbound-webhooks.mdx singular.mdx methods.mdx types.mdx` and re-run
      `check-links.mjs` against that content — surfaced **22** pre-existing broken
      same-page/cross-page anchor links across `outbound-webhooks.mdx` (4),
      `singular.mdx` (1), `methods.mdx` (1 `#trackparams` + 11 `#funnelclaimresult`),
      and `types.mdx` (5 `#pricinphase`). All 22 fixed, not just detected: numbered-
      heading anchors that don't match their unnumbered link text, a bolded
      pseudo-heading with no real anchor, a `FunnelClaimResult` type referenced 11 times
      but never documented, and a `#pricinphase` → `#pricingphase` typo. The checker
      itself first reported only 21 — its markdown-link regex used `[^\]]*` for the link
      label, which truncates at the first `]` and silently fails to match a label
      containing its own `]` (`` [`PricingPhase[]`](#pricinphase) ``, one of the five
      `#pricinphase` occurrences), undercounting by exactly one. Fixed by switching to a
      lazy `.*?` label match; re-verified against the same reverted content that the
      count is 22, then re-verified clean (0) against the real, fixed content.
- [x] Error-code catalog — shipped 2026-09-06: `packages/shared/src/error-catalog.ts`'s
      `ERROR_CATALOG` (one entry per code — wire value, HTTP status, summary, resolution)
      is typed as a TOTAL `Record<keyof typeof ERROR_CODE, ...>`, never `Partial` or an
      index signature, so adding a code to `ERROR_CODE` without documenting it here is a
      compile error, not a doc that quietly falls behind. `apps/docs/scripts/generate-
      error-catalog.mjs` renders it into `apps/docs/content/docs/reference/api-errors.mdx`
      (42 entries) and is wired into the docs `build` script, so a built image can never
      serve a stale page. Five codes are lowercase on the wire despite a SCREAMING_CASE
      key (`ASSET_IN_USE` → `asset_in_use`, `ASSET_MISSING`, `PURCHASE_NOT_PAID`,
      `APPLE_OFFER_SIGNING_UNAVAILABLE`, `APPLE_OFFER_SIGNING_FAILED`) — a generator naive
      enough to publish the object key instead of `entry.code` would have shipped five
      strings no client could ever match against a real response; the generator emits
      `entry.code` throughout and a test (`error-catalog.test.ts`) pins all five.

      Writing real per-code prose (not templated boilerplate) surfaced two producer
      defects, neither fixed here — raised separately:
      1. **Four API-key-auth codes have no producer at all.** `BEARER_REQUIRED`,
         `INVALID_API_KEY`, `INVALID_API_KEY_FORMAT`, and `API_KEY_KIND_MISMATCH` exist in
         `ERROR_CODE` but `middleware/api-key-auth.ts` throws bare `HTTPException`s with no
         `cause` for every one of their failure modes, so they all collapse to the generic
         `UNAUTHORIZED`/`FORBIDDEN` on the wire — a client can never distinguish "missing
         Bearer header" from "revoked key" from "wrong key kind" by code alone today.
      2. **`STRIPE_NOT_CONNECTED` is inconsistently wired.** `billing-portal.ts` sets it
         properly as an `HTTPException` `cause`, so it reaches `error.code` correctly. The
         funnel-builder validation route and the public funnel-payment checkout route
         reject with the identical string but embed it inside a JSON-stringified `message`
         on a generic HTTPException with no `cause` — those two never surface the code on
         the wire (`error.code` reads `VALIDATION_ERROR`/`HTTP_ERROR` instead).

      Also found and fixed while wiring the generator: `packages/shared/src/index.ts`'s
      `export * from "./error-catalog"` made the barrel and error-catalog.ts mutually
      dependent, and error-catalog.ts dereferences `ERROR_CODE` eagerly at module-eval
      time — under plain Node ESM (the generator, run via `tsx`) that's a `ReferenceError:
      Cannot access 'ERROR_CODE' before initialization`, which Vitest's bundler-aware
      resolver hid completely (its own `error-catalog.test.ts` passed throughout). Fixed
      by dropping the barrel re-export and exposing `@rovenue/shared/error-catalog` as its
      own subpath export instead, matching several sibling modules already exposed that
      way (`./crypto`, `./subscription-status`, `./experiments`, ...).
- [x] Self-host operator handbook (scaling, monitoring, disaster recovery) —
      shipped 2026-09-06: `docs/operations/handbook.md` (scaling, monitoring
      and alerting, capacity planning, pg_partman partition maintenance,
      connection pooling, disaster recovery with RPO/RTO worked as
      arithmetic against real numbers, and secret rotation), plus
      `docs/runbooks/secret-rotation.md` and
      `docs/runbooks/incident-response.md` (one scenario per alert:
      what it means, how to confirm it against live data, where to look
      first), and a root `README.md` — the repository had none.

      Backup/restore and the upgrade/rollback runbook were already well
      covered (`docs/operations/backup-restore.md`,
      `docs/operations/upgrade.md`) and are linked from the handbook, not
      restated. The actual gap this closed: the monitoring stack (Prometheus,
      Grafana, Alloy, the SLO rules) had already shipped in §10 and was
      documented nowhere an operator would find it before this.

      Every command in the handbook was run against the live compose stack
      and its real output recorded, not invented — table sizes, `pg_dump`
      timings, `SELECT` output from `partman.part_config`, Grafana/Prometheus
      URLs that actually resolve. Anything that needed a running `api`
      process and could not be executed from this session is labelled as
      such rather than presented as verified. Writing it surfaced two real
      operational defects, recorded above in §8: `scripts/rotate-encryption-key.ts`
      does not typecheck, and fresh self-hosted installs never register
      `revenue_events`/`credit_ledger` with `partman.part_config`.

## 12. Feature breadth (85 → 95)

- [x] Feature flags: percentage rollout + kill switch — already implemented
      (`isEnabled` kill switch + per-rule `rolloutPercentage` through
      `isInRollout`); regression-tested in
      `apps/api/tests/flag-engine.rollout-kill.test.ts` (2026-09-04)
- [x] Real-time audience segment updates — attribute writes publish a
      per-subscriber Redis invalidation that the SSE `/v1/config/stream`
      matches against its own resolved subscriber id and coalesces, proven
      end-to-end over real Postgres/Redis in
      `apps/api/src/routes/v1/config-stream.integration.test.ts` (2026-09-05)
- [x] Leaderboards: season/reset automation — three tables, season-window
      arithmetic, a shared ClickHouse standings query, a
      `leaderboard-scheduler` worker that opens/closes seasons on cadence,
      dashboard CRUD + season/standings endpoints, and a dashboard UI
      (configured-leaderboards list, create/edit form, season selector)
      surfacing all of it alongside the pre-existing ad-hoc range view
      (2026-09-05)
- [x] Subscription-renewing credit grant automation (merges with the PR3
      `product_currency_grants` work) — `grantOn` (PURCHASE/RENEWAL/BOTH)
      end-to-end: schema + trigger matrix, trigger-aware grant service,
      BullMQ queue/worker, Kafka renewal consumer, dashboard selector with
      server-side rejection of RENEWAL/BOTH on non-subscription products
      (2026-09-05)
