# Integrations Wave 1 — First-Class Providers — Design Spec

**Date:** 2026-08-24
**Roadmap area:** §6 Third-party integrations — sub-project 2 of 2 (foundation shipped same day, see
`2026-08-24-integrations-foundation-webhook-v2-design.md`)
**Parity bar:** RevenueCat's first-party integration set; RC-compatible attribute naming for
migration-guide leverage (roadmap priority 3).

## 1. Context

The foundation is live: declarative registry (a provider = registry entry + mapper, zero schema
work), 4-topic fanout, delivery worker with per-provider retry/dead-letter/redeliver, credentials
encryption, 6-step drawer, docs page. Exploration findings this spec builds on:

- `subscribers.attributes` jsonb + reserved `$`-catalog (`packages/shared/src/attributes/catalog.ts`):
  `$email`, `$phoneNumber`, `$idfa`, `$idfv`, `$gpsAdId`, `$attConsentStatus`, campaign keys. Unknown
  `$`-keys are REJECTED — vendor ids need catalog entries.
- Fanout envelopes carry `identityContext = { externalId: subscriberId }` only ("enrichment is a
  follow-up in the delivery worker" — that follow-up is this spec). `POST /v1/events` payloads may
  already carry a rich identityContext.
- Deliver worker slot: enrich between credential decrypt and `mapEvent` via a new optional dep.
- `attributes.platform` is set at subscriber creation (first-install ios/android/web) — used to pick
  per-platform vendor app ids.
- No Slack code exists; dashboard i18n already has `apps.slack.*` strings. Dashboard catalog additions
  are descriptor + i18n + (for new categories) rail entries.

## 2. Goals

1. Six first-class providers at RC parity: **Amplitude, Mixpanel, AppsFlyer, Adjust, Slack,
   Firebase/GA4** — each a registry entry + mapper + credential schema + drawer card + docs page,
   riding the existing pipeline unchanged.
2. **Delivery-time identity enrichment**: subscriber attributes loaded (cached) in the deliver worker
   and merged into the envelope — closes the standing email/phone gap for Meta/TikTok too.
3. **RC-compatible vendor-id attributes** in the reserved catalog: `$appsflyerId`, `$adjustId`,
   `$firebaseAppInstanceId`, `$mixpanelDistinctId`, `$amplitudeDeviceId`, `$amplitudeUserId`.
4. **Narrow store-lifecycle normalization**: a store-type → public-key map at the webhook-processor
   bridge so billing-issue/grace/uncancel/product-change events reach v2 consumers (webhooks + these
   providers). New public keys: `subscription.billing_issue`, `subscription.grace_period`,
   `subscription.uncancelled`, `subscription.product_changed`.
5. Carried backlog: backfill widened beyond `REVENUE_EVENT` to all four fanout aggregates.

## 3. Non-goals

- SDK convenience setters for the new attributes (generic `setAttributes` suffices; sugar lands with
  the Flutter-SDK sub-project). Auto-collection of device/ad ids by SDKs.
- Wave 2 providers (Braze, OneSignal, Iterable, Airbridge, Singular, Discord).
- Full store-native passthrough (raw Apple/Google/Stripe types stay unbridged beyond the normalized
  set; Google `SUBSCRIPTION_<n>` classify bug fix rides the normalization task since it blocks Google
  types from matching anything).
- Slack interactive features (slash commands, OAuth app). Incoming-webhook URL only — RC parity.

## 4. Design

### 4.1 Identity enrichment (deliver worker)

- New reserved keys added to `RESERVED_ATTRIBUTES` (validation: non-empty ≤500 chars, RC-compatible
  names above).
- New repo projection `findSubscriberIdentityById(db, id)` → `{ appUserId, attributes }`.
- Worker: optional dep `loadSubscriberIdentity(subscriberId) → Promise<SubscriberIdentity | null>`
  with a per-worker TTL cache (mirror `connection-cache.ts`, 60s TTL) keyed by subscriber id.
  Applied AFTER `mapEvent`'s config build, BEFORE `mapEvent`: merge — envelope-provided
  identityContext fields WIN (event-time data beats profile data);
  `email ??= $email`, `phone ??= $phoneNumber`; envelope gains
  `subscriberAttributes?: Record<string, string>` (flattened reserved keys + `appUserId` + `platform`)
  for vendor-id consumption. Enrichment failures are soft: log + proceed unenriched (delivery must
  not fail because a subscriber row is missing).
- CUSTOM_WEBHOOK is EXCLUDED from enrichment-derived PII: its `buildWebhookData` continues stripping
  identityContext to `externalId` (customers fetch their own PII; webhook bodies stay lean).

### 4.2 Provider matrix

All six mirror the meta-capi file skeleton (helpers → defaultEventMapping → eventCatalog →
credentialsSchema → provider object). All `allowMultipleConnections: false`. Endpoints/API versions
below are design-time references — **implementers verify current vendor docs at build time** and the
validateCredentials call is the live proof.

| Provider | Topics | Identity requirement | Credentials | Dedup key |
|---|---|---|---|---|
| AMPLITUDE | revenue, subscription | user_id = `appUserId` ?? subscriberId; device_id ← `$amplitudeDeviceId`; `$amplitudeUserId` overrides user_id | `api_key`, `region` (us/eu) | `insert_id` = outboxEventId |
| MIXPANEL | revenue, subscription | distinct_id ← `$mixpanelDistinctId` ?? appUserId ?? subscriberId | `project_token`, `api_secret`, `region` (us/eu) | `$insert_id` = outboxEventId |
| APPSFLYER | revenue, subscription | REQUIRES `$appsflyerId` else skip `no_user_data`; per-platform app id chosen via `subscriberAttributes.platform` | `dev_key`, `app_id_ios`, `app_id_android` (≥1 app id) | `eventTime` + af dedup; outboxEventId in `eventValue` |
| ADJUST | revenue, subscription | REQUIRES `$adjustId` (adid) or `$idfa`/`$gpsAdId` else skip | `app_token` + per-event tokens via `eventMapping` (eventName = Adjust event token) | Adjust server-side dedup on `deduplication_id` = outboxEventId |
| SLACK | revenue, subscription, paywall_events, credit | none | `webhook_url` (host-allowlisted `hooks.slack.com`, https) | n/a (notification) |
| FIREBASE_GA4 | revenue, subscription | REQUIRES `$firebaseAppInstanceId` else skip | `api_secret`, `firebase_app_id` | Measurement Protocol; outboxEventId as event param |

Provider notes:
- **Amplitude**: HTTP V2 (`https://api2.amplitude.com/2/httpapi`, EU `api.eu.amplitude.com`); revenue
  events set `revenue`, `price`, `quantity: 1`, `revenueType` = event key. `validateCredentials`:
  post a `$identify`-free noop batch or use the API-key error contract — implementer picks the
  cheapest real call.
- **Mixpanel**: `/import?strict=1` (EU `api-eu.mixpanel.com`) with basic auth `api_secret`; revenue
  amount in properties. `validateCredentials`: strict-mode import of an empty/probe batch or the
  documented auth-check.
- **AppsFlyer**: S2S `https://api2.appsflyer.com/inappevent/{app_id}` header `authentication:
  dev_key`; af_revenue/af_currency in eventValue; missing platform-matching app id → skip
  `no_mapping`-style reason (named const).
- **Adjust**: `https://s2s.adjust.com/event`; `eventMapping` semantic REUSE: value's `eventName` IS
  the Adjust event token — drawer mapping step already edits this; events without a token → skip
  (Adjust requires per-event tokens; no defaults possible). Revenue: `revenue` + `currency`.
- **Slack**: message built per event key (compact text: emoji + event + amount/currency + product +
  masked subscriber), posted to the stored webhook URL. Delivery classification: Slack returns 200
  "ok" / 4xx body strings; 404 `no_service` = endpoint revoked → non-retriable dead-letter (surfaces
  the existing dead-letter notification). Host allowlist `hooks.slack.com` at validate AND deliver
  (same two-phase shape as the SSRF guard, but allowlist not blocklist).
- **GA4**: `https://www.google-analytics.com/mp/collect?firebase_app_id=&api_secret=`; `purchase` /
  `refund` canonical names in defaultEventMapping; `validateCredentials` uses the
  `debug/mp/collect` validation endpoint (it returns validation messages — a real check).

`IntegrationProviderId` union grows by six; registry entries added; `providerIds()`/Zod/fanout pick
them up automatically (that was the point of the foundation).

### 4.3 Store-lifecycle normalization (narrow)

At the webhook-processor bridge (the I1 gate site): a `STORE_EVENT_TO_PUBLIC_KEY` table maps the
store-native `args.eventType` → new public keys (billing_issue, grace_period, uncancelled,
product_changed) where a confident mapping exists (Apple `DID_FAIL_TO_RENEW`/`GRACE_PERIOD_*`,
Google account-hold/grace/restarted, Stripe `invoice.payment_failed`/`customer.subscription.updated`
cancel-flip — implementer derives the exact table from `packages/shared/src/webhook-events.ts` and
the store processors' classify functions, and MUST fix the Google numeric-suffix classify bug so
Google types are matchable). Bridge gate becomes: mapped → bridge with the public key; unmapped →
skip (unchanged). Fanout's `toSubscriptionEnvelope` whitelist grows by the four keys; catalog + docs
+ drawer follow the shared const. The four new keys join `ROVENUE_EVENT_KEYS`; the webhook docs page
table gains four rows.

### 4.4 Backfill widening

`enqueueBackfillForConnection`'s aggregate `IN`-list grows from `('REVENUE_EVENT')` to the four
fanout-backed aggregates. The SQL's `payload->>'projectId'` extraction must be verified per shape
(paywall rows carry projectId at top level per the dispatcher's shaping — verify; rows whose payload
lacks a top-level projectId are excluded with a comment, not guessed). `outboxRowToEnvelope` already
normalizes all four (foundation fix C1).

### 4.5 Dashboard

Six `AppDescriptor` entries (categories: analytics ×3, attribution ×2, communication ×1 — new
categories need rail + homepage-section entries per the existing shape; i18n names largely exist).
Credentials step: field definitions per provider (the drawer's generic credential fields keyed by
snake_case ids — same contract as Meta/TikTok). Adjust's mapping step gets helper copy ("value =
Adjust event token"). No new step types.

### 4.6 Docs

One page per provider under `apps/docs/content/docs/integrations/` (setup, credential fields, event
mapping table, identity requirements incl. which `$attributes` the app must set, vendor-side dedup
notes) + the attributes-catalog doc updated with the six new keys. MDX `{{}}` gotcha applies.

## 5. Data changes

None. (Registry-driven — the foundation's acceptance criterion 5, now cashed in.)

## 6. Testing

- Per provider: unit tests for mapEvent (mapping, skip reasons, identity fallback chains, dedup id
  presence) and deliver classification against a undici MockAgent with the vendor's documented
  response shapes; credentialsSchema round-trips.
- Enrichment: worker unit tests (merge precedence: envelope wins; missing subscriber = soft) + one
  real-PG integration test (subscriber with `$email` + `$appsflyerId` → Meta receives hashed email,
  AppsFlyer receives af id).
- Normalization: table-driven tests from real store fixture types incl. the Google numeric-suffix
  regression.
- Backfill widening: real-PG test enqueueing a SUBSCRIPTION row on enable.
- e2e: one scenario extending the existing webhook e2e file — a revenue event fans out to Slack
  (local listener, message shape asserted) alongside a webhook endpoint.

## 7. Acceptance criteria

1. Each provider connectable via the drawer with real-shaped credentials, `validateCredentials`
   performing a genuine vendor call (MockAgent in tests), events delivered with vendor-side dedup
   ids = outboxEventId.
2. A subscriber with `$email` set gets hashed-email match data on Meta/TikTok deliveries (the
   standing enrichment gap closed), with event-supplied identityContext taking precedence.
3. AppsFlyer/Adjust/GA4 deliveries skip with a distinct reason when their required device id is
   absent — visible in the deliveries log, not dead-lettered.
4. `subscription.billing_issue` (Apple DID_FAIL_TO_RENEW fixture) reaches a CUSTOM_WEBHOOK endpoint
   end-to-end; Google's numeric-suffix types classify correctly.
5. Zero schema migrations; `pnpm build` green; full suites green.
