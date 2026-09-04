# Rovenue Roadmap

Goal: close the gap with RevenueCat / Adapty in every area — target **95%** parity (or better) per area.
Scores are a self-assessment of "% of a mature best-in-class solution" as of 2026-09-03.

| # | Area | Now | Target |
|---|------|-----|--------|
| 1 | Store integrations & receipt validation | 85% | 95% |
| 2 | Subscription state & entitlements | 85% | 95% |
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

## 2. Subscription state & entitlements (85 → 95)

- [ ] Upgrade/downgrade proration, cross-grade, entitlement transition rules on plan change
- [ ] Google billing issue / account hold as a first-class state (separate from GRACE_PERIOD)
- [ ] Apple Family Sharing + win-back offer states in the state machine
- [ ] Continuous `subscriber_access` consistency checker (reconciliation job that detects drift)

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
- [ ] Stripe one-time (non-subscription) purchases reach no integration
      provider — funnel completion emits only `funnel.session.paid` on a
      separate `FUNNEL` aggregate, never `revenue.event.recorded`. Found by
      the 2026-09-03 enumeration; genuinely separate scope (the funnel/
      revenue bridge, not store lifecycle normalization).
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
- [ ] Web SDK (TS: Stripe checkout + entitlement reads; funnel/web payment backend exists)
- [ ] Unity SDK (games market; natural fit with credits/leaderboards)
- [ ] Capacitor / Cordova façades
- [ ] Fix release blockers: Rust fmt/clippy CI reds, Swift podspec sha256 placeholder — this also
      blocks publishing `rovenue_flutter_ios`'s CocoaPods dependency (`Rovenue`), so Flutter's iOS
      distribution shares the same blocker
- [x] Align Swift/Kotlin versions with core (already true before this work) — core-rs, sdk-swift,
      sdk-kotlin, and sdk-rn were all at 0.16.0 prior to the Flutter SDK; sdk-flutter shipped at
      0.16.0 too, so all five packages are aligned as of 2026-08-31
- [ ] Make the RN iOS pod externally consumable (persist the M7 fix-set); RN SDK distribution
      (open item from 2026-08-23 batch)
- [ ] Official macOS / tvOS / watchOS / visionOS targets in the Swift SDK

## 8. Self-hosting & data ownership (95 — keep)

- [ ] One-command install: Coolify template + Helm chart
- [ ] Version upgrade runbook
- [ ] Backup / restore documentation
- [ ] Close the nosniff/ETag edge-layer gap (asset CDN)

## 9. GDPR / KVKK tooling (85 → 95)

- [ ] Self-service DSAR API (exposed by customers to their end users)
- [ ] Per-table data-retention policy automation
- [ ] Externally verifiable proof format for the audit hash chain

## 10. Production maturity & scale proof (45 → 95) — earned over time

- [ ] Load-test suite: k6/vegeta with realistic traffic profiles (receipt spikes,
      webhook storms) + published benchmark page
- [ ] SLOs + status page
- [ ] Chaos tests: dispatcher death, Kafka outage, ClickHouse lag (outbox architecture
      is built to prove exactly this)
- [ ] 3–5 pilot apps in production; millions of live events as reference
- [ ] All CI green and required (including pre-existing red tests); testcontainers
      suite running in CI
- [ ] `pnpm db:migrate`'s fresh-vs-upgrade detection misfired on a healthy
      dev database (114 migrations, 291 tables applied) with "fresh install
      detected," found 2026-09-03 while working §1's items and reproduced
      with that batch's schema changes stashed, so it predates this plan.
      Worked around by resetting the dev Postgres volume (dev only,
      user-authorised); the detection heuristic itself needs investigation
      before it fires against a database that isn't disposable.

## 11. Docs & developer experience (65 → 95)

- [ ] Quickstart + full API reference per SDK (auto-generated: rustdoc / DocC / Dokka / TypeDoc)
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
- [ ] Google purchase-token second pass (final-fix-wave FIX 9, 2026-09-01 review):
      the `revenuecat_google_token` preset can be DETECTED but never actually IMPORTED —
      its 3-column file can never satisfy the mapper's required `store`/`purchaseDate`
      fields, so `PATCH /mapping` and `POST /dry-run` both 400 on it, and no code path
      joins a token file to an existing purchase by `user_id` regardless. The guide and
      this roadmap previously described this as a working two-pass import; corrected to
      say "not yet available" in both places 2026-09-01. Real follow-up: either (a) give
      this preset its own validation/commit path that patches `googlePurchaseToken` onto
      an existing purchase found by (subscriberExternalId, productIdentifier) instead of
      running through the normal create/update writer, or (b) drop the preset entirely
      until that path exists — do not resurrect the "detected but broken" middle state.
- [ ] Working example apps (iOS / Android / RN / Flutter demo repos)
- [ ] Interactive API explorer
- [ ] Error-code catalog
- [ ] Self-host operator handbook (scaling, monitoring, disaster recovery)

## 12. Feature breadth (85 → 95)

- [ ] Feature flags: percentage rollout + kill switch
- [ ] Real-time audience segment updates
- [ ] Leaderboards: season/reset automation
- [ ] Subscription-renewing credit grant automation (merges with the PR3
      `product_currency_grants` work)
