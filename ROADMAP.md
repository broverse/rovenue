# Rovenue Roadmap

Goal: close the gap with RevenueCat / Adapty in every area — target **95%** parity (or better) per area.
Scores are a self-assessment of "% of a mature best-in-class solution" as of 2026-09-02.

| # | Area | Now | Target |
|---|------|-----|--------|
| 1 | Store integrations & receipt validation | 75% | 95% |
| 2 | Subscription state & entitlements | 85% | 95% |
| 3 | Paywall builder & native rendering | 85% | 95% |
| 4 | A/B testing & experiments | 88% | 90%+ |
| 5 | Analytics (MRR / LTV / cohorts) | 90% | 95% |
| 6 | Third-party integrations | 90% | 95% |
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
14 first-class providers across two waves, plus the vendor-agnostic CUSTOM_WEBHOOK escape hatch). Analytics (§5) is likewise mostly done — cohort
retention, churn/refund KPIs, predicted LTV, trial→paid, and the paywall
funnel predate this plan; country revenue, estimated proceeds, and the
metrics export are new but each has a documented partial-coverage edge.
Completing 1–2 should lift the overall picture toward ~88%; items 3–5 close
the remaining analytics/experiments/integrations gaps on the way to 95%.

---

## 1. Store integrations & receipt validation (75 → 95)

- [ ] Amazon Appstore support: RVS receipt validation + new store enum in `store_event_id` dedup
- [ ] Paddle integration (web/desktop alternative to Stripe: webhooks + checkout)
- [ ] Roku Pay (low priority, needed for full parity)
- [ ] Stripe dunning / billing-portal flows fully covered (card renewal, involuntary churn recovery)
- [ ] Apple StoreKit External Purchase / EU DMA scenarios (alternative payment links) in the event model
- [ ] Google reconciliation job (open item from the 2026-08-23 store-billing correctness batch)

## 2. Subscription state & entitlements (85 → 95)

- [ ] Upgrade/downgrade proration, cross-grade, entitlement transition rules on plan change
- [ ] Google billing issue / account hold as a first-class state (separate from GRACE_PERIOD)
- [ ] Apple Family Sharing + win-back offer states in the state machine
- [ ] Continuous `subscriber_access` consistency checker (reconciliation job that detects drift)

## 3. Paywall builder & native rendering (85 → 95)

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
- [ ] Element-level experiments (deferred from P7)
- [ ] On-device smoke test session (pending) — needs physical iOS/Android devices and store sandbox
      accounts; not automatable from this repo
- [ ] New node types at RC Paywalls v2 parity — **recon 2026-09-01: mostly already done.**
      `carousel`, `timeline` and `video` exist in the schema, in all three renderers and in
      `render-fixtures.json`; only a **footer link group** appears genuinely absent. Scope this
      sub-project from that finding, not from "four node types are missing"
- [ ] Template gallery: 15–20 proven paywall templates (leverage App Store import)
- [ ] Localization workflow: in-builder translation management + auto-translate (Rovi)

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
      `getExperimentResults` path is deleted — one results implementation, not two.
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

## 5. Analytics (70 → 90) — mostly already shipped; this plan closed the gap

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
- [ ] Commission-rate settings UI — the presets above are not reachable
      from the dashboard; configuring a rate currently requires an API
      call
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
- [ ] Full country coverage across all stores and all history (Stripe
      country for non-`charge.refunded` events, backfill before migration
      0023)
- [ ] Full chart-catalog series coverage in the metrics export — only 2 of
      17 catalog ids (`paywall_view_rate`, `paywall_purchase`) have a
      `readChartSeries` reader wired; the rest return no rows, so the
      export does not yet cover the catalog

## 6. Third-party integrations (75 → 90) — Wave 2 shipped, one gap left

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
- [ ] Full store-native lifecycle event normalization: raw Apple/Google/Stripe
      event types → the public event-key catalog end to end (currently only
      the 4 keys above are mapped; most raw event shapes still pass through
      only partially normalized)
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
