# Rovenue Roadmap

Goal: close the gap with RevenueCat / Adapty in every area — target **95%** parity (or better) per area.
Scores are a self-assessment of "% of a mature best-in-class solution" as of 2026-08-23.

| # | Area | Now | Target |
|---|------|-----|--------|
| 1 | Store integrations & receipt validation | 75% | 95% |
| 2 | Subscription state & entitlements | 85% | 95% |
| 3 | Paywall builder & native rendering | 80% | 95% |
| 4 | A/B testing & experiments | 75% | 90%+ |
| 5 | Analytics (MRR / LTV / cohorts) | 70% | 95% |
| 6 | Third-party integrations | 75% | 95% |
| 7 | SDK platform coverage | 55% | 95% |
| 8 | Self-hosting & data ownership | 95% | keep |
| 9 | GDPR / KVKK tooling | 85% | 95% |
| 10 | Production maturity & scale proof | 45% | 95% |
| 11 | Docs & developer experience | 65% | 95% |
| 12 | Feature breadth (flags, audiences, leaderboards, credits) | 85% | 95% |

## Priority order (impact / cost)

1. Integrations Wave 2 providers (framework + webhook v2 + Wave 1 first-class
   providers are all done — §6)
2. Flutter SDK (§7)
3. RevenueCat / Adapty migration guides + data import tool (§11)
4. Analytics chart set (§5)
5. Bayesian experiment engine (§4)

Completing 1–3 should lift the overall picture to ~85%; the rest of the way to 95% is
largely maturity and live production proof.

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

## 3. Paywall builder & native rendering (80 → 95)

- [ ] trialLabelKey override UI (known gap)
- [ ] Element-level experiments (deferred from P7)
- [ ] On-device smoke test session (pending)
- [ ] New node types at RC Paywalls v2 parity: carousel, video hero, timeline/feature-list,
      footer link group — each on all three platforms via `render-fixtures.json`
- [ ] Template gallery: 15–20 proven paywall templates (leverage App Store import)
- [ ] Commerce-binding cache invalidation (known gap)
- [ ] Localization workflow: in-builder translation management + auto-translate (Rovi)

## 4. A/B testing & experiments (75 → 90+)

- [ ] Sequential/Bayesian statistics engine: revenue-based metrics (ARPU/proceeds) winner
      selection + expected-loss display
- [ ] Element-level (single-node) experiments
- [ ] Holdout groups
- [ ] Experiment scheduling/sequencing per placement
- [ ] Confidence intervals + minimum-sample warnings on the results page

## 5. Analytics (70 → 95)

- [ ] Cohort retention grid
- [ ] Churn / refund rate charts
- [ ] Trial → paid conversion funnel
- [ ] Proceeds view (after store commission; Apple Small Business Program 15% vs 30%)
- [ ] Predicted LTV
- [ ] End-to-end paywall funnel in dashboard (paywall_view → purchase attribution already exists)
- [ ] Country / currency-normalized revenue reports
- [ ] Metrics export API for customer BI (ClickHouse-backed)

## 6. Third-party integrations (25 → 75) — biggest single effort

Framework + webhook v2 shipped 2026-08-24
(`docs/superpowers/specs/2026-08-24-integrations-foundation-webhook-v2-design.md`).
Wave 1 first-class providers + delivery-time identity enrichment + narrow
store-lifecycle normalization shipped 2026-08-24/25
(`docs/superpowers/specs/2026-08-24-integrations-wave1-providers-design.md`).
Score moved from 55-60 to 75: eight first-class providers now exist
(Meta CAPI, TikTok, Amplitude, Mixpanel, AppsFlyer, Adjust, Slack,
Firebase/GA4) plus the vendor-agnostic `CUSTOM_WEBHOOK` escape hatch, the
delivery path now carries vendor identity attributes instead of only
email/phone hashes, and Google's lifecycle classification bug (RTDN numeric
codes) is fixed. Not 95 yet: Wave 2's six providers (Braze, OneSignal,
Iterable, Airbridge, Singular, Discord) are still open, and store-native
normalization is narrow (4 lifecycle keys) rather than full passthrough of
every Apple/Google/Stripe event shape.

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
- [ ] Wave 2: Braze, OneSignal, Iterable, Airbridge, Singular, Discord
- [ ] Full store-native lifecycle event normalization: raw Apple/Google/Stripe
      event types → the public event-key catalog end to end (currently only
      the 4 keys above are mapped; most raw event shapes still pass through
      only partially normalized)
- Architecture note (now implemented, not just planned): the outbox → Kafka
  fanout consumer + deliver worker is the "integration dispatcher"; each
  integration = registry entry (mapping + credential schema) + credential
  record.

## 7. SDK platform coverage (55 → 95)

- [ ] Flutter SDK — highest ROI; Dart bindings over the Rust core FFI
- [ ] Web SDK (TS: Stripe checkout + entitlement reads; funnel/web payment backend exists)
- [ ] Unity SDK (games market; natural fit with credits/leaderboards)
- [ ] Capacitor / Cordova façades
- [ ] Fix release blockers: Rust fmt/clippy CI reds, Swift podspec sha256 placeholder
- [ ] Align Swift/Kotlin versions with core
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
- [ ] "Migrate from RevenueCat" and "Migrate from Adapty" guides — strategically the two
      most valuable docs
- [ ] Data import tool (RC export CSV → subscriber/transaction import)
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
