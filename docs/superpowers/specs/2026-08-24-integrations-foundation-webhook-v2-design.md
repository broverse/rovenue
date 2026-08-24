# Integrations Foundation + Outbound Webhook v2 — Design Spec

**Date:** 2026-08-24
**Roadmap area:** §6 Third-party integrations (25 → 95) — sub-project 1 of 2
**Parity bar:** RevenueCat webhooks / Adapty integrations, Svix-grade delivery semantics

## 1. Context — corrected current state

ROADMAP §6 is stale. Exploration on 2026-08-24 found the integrations framework is
largely shipped, not 25%:

- **Schema:** `integration_connections` + `integration_deliveries` (pg_partman-partitioned,
  30-day retention) exist via migrations `0060_integrations_framework.sql` +
  `0061_integration_connections_soft_delete.sql`. The "missing 0053_integrations_framework.sql"
  claim is wrong — 0053 was always an unrelated migration; the journal is contiguous 0000–0103.
- **Pipeline:** outbox → Kafka dispatcher → `integrations-fanout` consumer
  (`rovenue-integrations-fanout` group, subscribes `rovenue.revenue` + `rovenue.billing`)
  → one BullMQ job per enabled connection (`jobId = connectionId|outboxEventId`) →
  `integrations-deliver` worker (5 attempts, 30s→6h backoff, dead-letter + audit row).
- **Providers:** `META_CAPI`, `TIKTOK_EVENTS` in `apps/api/src/services/integrations/registry.ts`,
  with PII hashing, event mapping, backfill, live-events SSE, Sentry bridge.
- **Dashboard:** full 6-step integration drawer (credentials → events → mapping → activate →
  test → deliveries) + 7 React Query hooks. Not WIP.
- **Tests:** ~106 green; **6 red tests are test-isolation flakes**, not missing features
  (details §4.1).
- **Outbound webhooks v1:** single `projects.webhookUrl` + `webhookSecret`, bespoke
  Stripe-style `x-rovenue-signature: t=…,v1=…` HMAC, coarse category filtering,
  own table (`outgoing_webhooks`) + own worker (`webhook-delivery.ts`) + reaper.
- **Svix:** only inbound *verification* exists (`apps/api/src/lib/svix-signature.ts`,
  used by Resend events). No Svix-format signer, no `svix` npm dependency.

## 2. Goals

1. **All integration tests deterministic and green** (the 6 flakes fixed, proven by
   repeated runs).
2. **Framework scales to 13+ providers without a migration per provider** (Wave 1/2
   land in the next spec with zero schema changes).
3. **Fanout covers the full event surface** — every domain event category a
   RevenueCat/Adapty integration can subscribe to reaches the fanout consumer.
4. **Outbound Webhook v2 at Svix parity:** multiple endpoints per project, per-event-type
   filtering, Svix-compatible signing with secret rotation, automatic retries with
   dead-letter, delivery log with manual redeliver, consumer-verification docs.
   This is the "write your own integration" unlock the roadmap calls half of §6's score.
5. ROADMAP.md §6 corrected to reflect reality.

## 3. Non-goals

- Wave 1/2 first-class providers (Amplitude, Mixpanel, AppsFlyer, Adjust, Slack,
  Firebase/GA4, Braze, …) — **next spec**; this spec only guarantees they need no
  schema work.
- Depending on the Svix SaaS or `svix` npm package server-side (we implement the wire
  format ourselves; the format is already documented in `svix-signature.ts`).
- Removing webhook v1. It keeps working untouched; v2 is additive. Deprecation/migration
  tooling is a later decision.
- Inbound (store) webhooks — unrelated subsystem.

## 4. Design

### 4.1 Fix the 6 red tests (test isolation)

Three real-infra files (`integrations-deliver.integration.test.ts`,
`integrations-deliver.e2e.integration.test.ts`, `backfill.integration.test.ts`) each boot
a **real** BullMQ worker via `ensureIntegrationsDeliverWorker()` on the **shared** queue
name `rovenue-integrations-deliver` against ambient Redis `:6380` and hardcoded Postgres
`:5433/rovenue` — bypassing the per-worker `rovenue_test_w*` clone databases. Vitest runs
the files in parallel threads with per-thread undici `MockAgent`s, so worker A steals
worker B's jobs and processes them against the wrong mocks (401 → 200) or the wrong DB
(rows "never" appear).

**Fix (both legs):**
- **Queue-name injection:** the deliver queue/worker take an optional queue-name override
  (env or param, e.g. `INTEGRATIONS_QUEUE_SUFFIX`); each test file uses a unique
  per-run queue name. Production default unchanged.
- **DB routing:** the tests build their worker deps from the per-worker test
  `DATABASE_URL` (the `rovenue_test_w*` clone) instead of the hardcoded `:5433/rovenue`
  connection string, so assertions read the same DB the worker writes.
- **Gate:** implementation is done only after ≥5 consecutive full runs of the three files
  (parallel, default config) are green. Follow `superpowers:systematic-debugging` if the
  first fix attempt doesn't hold — the root-cause diagnosis above is strong but unproven.

No production code behavior change beyond the optional queue-name override.

### 4.2 Provider id: pg enum → text

`IntegrationProvider` is a Postgres enum (`META_CAPI | TIKTOK_EVENTS`). Every new
provider would need an enum migration, and drizzle's recreate-enum path is a known
footgun (runs all pending migrations in one tx; bit us in the pricing consolidation).

**Change:** migrate `integration_connections.provider_id` and
`integration_deliveries.provider_id` to `text`, drop the `integration_provider` pg enum.
Validation moves fully to the app layer: the Zod schema for create/update derives its
allowed values from `Object.keys(PROVIDERS)` in the registry — the registry becomes the
single source of truth. `integration_deliveries` is partitioned; the column type change
must be verified against pg_partman partitions in an integration test (testcontainers).
Keep `integrationDeliveryStatus` as an enum — its values are framework semantics, not an
open set.

### 4.3 Registry generalization

Extend `IntegrationProvider` (the TS interface) with declarative capabilities so Wave 1
is config + mapper only:

- `topics: FanoutTopic[]` — which Kafka topics this provider consumes (registry-driven
  fanout subscription, §4.4).
- `eventCatalog` — the provider's supported event keys (drives the drawer's Events step
  and `enabledEvents` validation).
- `allowMultipleConnections: boolean` — `false` for analytics providers (today's
  behavior, per-project unique), `true` for `CUSTOM_WEBHOOK`.
- `credentialsSchema` (Zod) — replaces per-provider ad-hoc validation in the route.

**Migration note:** `integration_connections_project_provider_uidx` (unique
projectId+providerId) blocks multiple webhook endpoints. It becomes a **partial unique
index** excluding the multi-connection providers by name
(`WHERE provider_id <> 'CUSTOM_WEBHOOK'`) — DB-level enforcement stays for every
single-connection provider, which is the common case. A future multi-connection
provider needs a one-line index migration; that is rare and an acceptable price for
keeping the constraint in the database rather than only in route code. Webhook
connections get an app-level per-project cap instead (named constant
`MAX_WEBHOOK_ENDPOINTS_PER_PROJECT`, tx-safe count precheck in the create route).

### 4.4 Fanout topic coverage

`FANOUT_TOPICS` grows from `[revenue, billing]` to the union of all registry providers'
`topics`, computed at boot. New envelope builders (`toFanoutEnvelope`) for
`rovenue.subscription` (new topic, below), `rovenue.paywall_events`, and
`rovenue.credit` — each envelope carries a **stable public event key** (e.g.
`revenue.RENEWAL`, `subscription.expired`, `paywall.view`) that both provider mappers
and webhook v2 payloads key on. The public event-key catalog lives in
`@rovenue/shared` (typed, exported) so API, dashboard, and docs share one list.

**Deliberately excluded topics** (verified against the emit sites 2026-08-24):
`rovenue.billing` carries Rovenue-cloud's *own* customer-billing events
(`billing.invoice.paid`, `billing.usage_lock.*`) — internal, never forwarded to
customer integrations; `rovenue.funnel` is web-funnel internals; the notifications
topic is notifier plumbing. None are RevenueCat-parity webhook events.

**SUBSCRIPTION outbox bridge (scope addition found during planning):** subscription
lifecycle events (`subscription.cancel_requested`, `subscription.expired`, and the
store-webhook-processor's lifecycle emissions) today go *straight into the v1
`outgoing_webhooks` table and never touch the outbox* — so webhook v2 would silently
miss RevenueCat's most important event class. Fix: every `enqueueOutgoingWebhook`
call site also inserts an outbox row (`aggregateType: SUBSCRIPTION`, new enum value,
new topic `rovenue.subscription`) in the same transaction. v1 behavior unchanged;
v2's event surface becomes a strict superset of v1's.

Consumer-group offset note: adding topic subscriptions to the existing
`rovenue-integrations-fanout` group starts those topics at the group's configured reset
policy — verify `fromBeginning` is false so we don't replay history into integrations
on deploy.

### 4.5 Webhook v2 = a first-class provider (`CUSTOM_WEBHOOK`)

Rather than a second bespoke webhook stack, webhook v2 is **an integration provider**
riding the existing fanout → deliver pipeline. It inherits retries, backoff,
dead-letter, audit, the deliveries log, the drawer UI, and the connection cache for
free — and stays architecturally consistent (outbox is the only path).

- **Connection:** `providerId = CUSTOM_WEBHOOK`, `allowMultipleConnections = true`
  (RevenueCat/Svix allow many endpoints per project). Credentials cipher holds
  `{ url, secrets: [{ id, key, createdAt }] }`; the endpoint URL is not secret but
  lives with the secret material for atomicity. `credentialsHint` shows the URL host +
  secret suffix.
- **Secrets:** server-generated (`whsec_` + base64(24 random bytes), Svix format),
  never client-supplied. **Rotation endpoint** appends a new secret and keeps the
  previous one active for 24h (grace window, Svix behavior); signing uses all active
  secrets — one `v1,` signature per active secret in the header, comma-space separated
  (Svix multi-signature format). A "reveal secret" dashboard action returns the current
  key (RBAC'd + audited).
- **Signing (Svix wire format, verified against our own `verifySvixSignature`):**
  - `webhook-id`: the outbox event id (stable across retries → consumer-side dedup key)
  - `webhook-timestamp`: unix seconds at send time
  - `webhook-signature`: `v1,base64(HMAC-SHA256(secretBytes, "${id}.${timestamp}.${rawBody}"))`
  - Also send the `svix-id`/`svix-timestamp`/`svix-signature` aliases — Svix sends both
    header families; consumer libraries accept either.
- **Payload envelope** (stable, versioned):
  `{ id, type, created, apiVersion: "2026-08-24", projectId, data }` where `type` is the
  public event key and `data` is the typed event body from `@rovenue/shared`. Bodies
  never include credential material; PII fields follow the same redaction rules as
  provider mappers.
- **Filtering:** `enabledEvents` (existing column) holds public event keys; the drawer's
  Events step lists the full catalog with per-key toggles (finer than v1's categories).
- **Delivery semantics:** existing worker — at-least-once, dead-letter row + audit +
  `webhook.failing`-style project notification on dead-letter (port the v1 notification
  emission). 2xx = success; 3xx is **not** followed (redirects rejected —
  signature-stripping risk); anything else retried. Response body captured truncated
  (existing behavior). Explicit per-request timeout as a named constant.
  **Retry schedule becomes registry-configurable** (`retryPolicy` on the provider
  entry): analytics providers keep today's 5 attempts / 30s→6h (a CAPI event a day
  late is worthless), while `CUSTOM_WEBHOOK` uses an extended schedule spanning
  ≥24h wall-clock (Svix retries over ~17h, RevenueCat up to a day+ — a consumer
  redeploy shouldn't dead-letter a billing event after 7 hours).
- **SSRF guard:** URL validation on create/update *and* at send time: https only
  (http allowed only when `NODE_ENV !== "production"`), block private/loopback/
  link-local/metadata ranges. At send time the guard resolves DNS, validates the
  resolved IPs, and **pins the connection to a validated IP** (undici custom
  `lookup`/connect) — validating and then letting the HTTP client re-resolve would
  leave a DNS-rebinding TOCTOU window.
- **Manual redeliver:** `POST …/integrations/:id/deliveries/:deliveryId/redeliver`
  re-enqueues the original envelope with a fresh jobId (`conn|event|redeliver-<n>`)
  bypassing the dedup jobId; RBAC'd + audited + rate-limited. UI button on the
  deliveries step (all providers get it, not just webhooks).
- **Test event:** existing `POST /:id/test-event` works as-is for the new provider.

### 4.6 Dashboard

- Apps page catalog gains a "Custom webhook" card; the existing drawer drives it.
  Provider-specific credentials step variant: URL field + generated-secret display
  (copy once), rotation + reveal actions.
- Deliveries step: add redeliver button and a dead-letter status filter.
- Multiple-connection support on the card (list of endpoints instead of the single-
  connection state) — only rendered for `allowMultipleConnections` providers.
- No new pages; everything extends the existing drawer/steps and hooks.

### 4.7 Docs (minimum for this spec)

One "Outbound webhooks" page in apps/docs: envelope schema, event-key catalog
(generated from `@rovenue/shared`), signature verification with runnable Node +
Python snippets (mirroring `svix-signature.ts`'s scheme), retry/dead-letter semantics,
idempotent-consumer guidance (`webhook-id` dedup). Full docs overhaul stays in §11.

### 4.8 ROADMAP.md correction

Rewrite §6's first bullet to the true state; check off framework items that shipped;
scope remaining bullets to Wave 1/2 (next spec).

## 5. Data changes (single migration, 0104+)

1. `provider_id` columns → `text`; drop `integration_provider` enum (verify against
   pg_partman-partitioned `integration_deliveries`).
2. `integration_connections_project_provider_uidx` → partial unique index
   (`WHERE provider_id <> 'CUSTOM_WEBHOOK'`); webhook endpoint count capped app-side
   (`MAX_WEBHOOK_ENDPOINTS_PER_PROJECT`, tx-safe precheck).

No new tables. Webhook v2 state lives entirely in `integration_connections` /
`integration_deliveries`.

## 6. Error handling & observability

- Dead-letter on a `CUSTOM_WEBHOOK` connection emits the project notification v1 already
  has for failing webhooks; `last_error` on the connection surfaces in the drawer.
- **Deliberate deviation from Svix:** no auto-disable of persistently failing endpoints
  in this spec — we notify only. Svix disables after sustained failure to protect the
  sender; with self-hosted single-tenant scale the protection matters less than the
  surprise of a silently-disabled endpoint. Revisit with production data; the
  `is_enabled` flag and dead-letter partial index make it a small follow-up.
- Fanout lag and deliver-queue depth are already visible via the existing worker
  metrics; add the new topics to whatever the observability profile scrapes.

## 7. Testing

- **Unit:** signature builder golden-vector tests round-tripped through our own
  `verifySvixSignature` *and* cross-checked against the `svix` npm lib's verifier
  (dev-dependency only, in tests); envelope schema tests; SSRF guard matrix
  (private ranges, redirects, DNS-rebind case with injected resolver); rotation
  grace-window logic; registry-derived Zod validation.
- **Integration (testcontainers):** enum→text migration on a partitioned table;
  fanout consumes a funnel/paywall event → webhook delivery row; redeliver bypasses
  jobId dedup; multi-endpoint fan-out (2 webhook connections, 1 event → 2 deliveries);
  dead-letter → notification row.
- **Flake gate (§4.1):** ≥5 consecutive green parallel runs of the three previously-red
  files before the task is called done.
- No self-confirming tests: delivery assertions read real Postgres rows written by the
  real worker; signature tests verify against an independent implementation.

## 8. Acceptance criteria

1. `pnpm test` (apps/api integrations area): 0 red, and the 3 real-infra files green
   5× consecutively.
2. A project can create ≥2 webhook endpoints, each with distinct event-key filters;
   a purchase event produces one signed delivery per subscribed endpoint, verifiable
   with the documented Node snippet **and** the `svix` npm verifier.
3. Secret rotation keeps old-secret verification passing within the 24h window and
   failing after.
4. A dead-lettered delivery can be manually redelivered from the dashboard and
   succeeds.
5. Adding a hypothetical new provider (test fixture) requires only a registry entry —
   no migration, no route change.
6. ROADMAP.md §6 reflects reality.

## 9. Follow-up (next spec)

Wave 1 providers: Amplitude, Mixpanel, AppsFlyer, Adjust, Meta CAPI (exists), TikTok
(exists), Slack, Firebase/GA4 — each = registry entry + mapper + credential schema +
docs page, on the foundation this spec lays.
