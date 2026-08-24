# Integrations Wave-1 Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six first-class integration providers (Amplitude, Mixpanel, AppsFlyer, Adjust, Slack, Firebase/GA4) plus delivery-time identity enrichment and narrow store-lifecycle normalization — with zero schema migrations.

**Architecture:** Every provider is a registry entry riding the existing fanout → BullMQ deliver pipeline (foundation shipped 2026-08-24). Identity enrichment happens in the deliver worker via a cached subscriber-attributes lookup merged into the envelope before `mapEvent`. Store-native lifecycle events get a narrow normalization map at the webhook-processor outbox bridge.

**Tech Stack:** Hono/TS, Drizzle/Postgres, BullMQ, undici, Zod, Vitest, React/TanStack Query, Fumadocs.

**Spec:** `docs/superpowers/specs/2026-08-24-integrations-wave1-providers-design.md`

## Global Constraints

- NEVER create or switch branches/worktrees; commit on current HEAD (main). Conventional commits.
- TS strict; no magic values (named consts); `{ data }`/`{ error: { code, message } }` envelopes; Zod input.
- No self-confirming tests; integration claims against real Postgres/Redis (`docker ps` first — vitest hangs if Docker is down); run api tests as `cd /Volumes/Development/rovenue/apps/api && npx vitest run <files>`.
- Registry is the sole provider authority — no provider list is hardcoded anywhere else.
- ZERO schema migrations in this plan (spec §5). If a task seems to need one, stop and escalate.
- Vendor endpoints below are design-time references — verify against current vendor docs (WebFetch) before implementing `deliver`/`validateCredentials`, and note what you verified in your report.
- New reserved attribute keys (exact, RC-compatible): `$appsflyerId`, `$adjustId`, `$firebaseAppInstanceId`, `$mixpanelDistinctId`, `$amplitudeDeviceId`, `$amplitudeUserId`.
- New public event keys (exact): `subscription.billing_issue`, `subscription.grace_period`, `subscription.uncancelled`, `subscription.product_changed`.
- ATT gate: `$idfa`/`$gpsAdId` are EXCLUDED from enrichment whenever `$attConsentStatus` is present and ≠ `"authorized"`.
- CUSTOM_WEBHOOK stays PII-free (its `buildWebhookData` untouched).
- Provider file skeleton: mirror `apps/api/src/services/integrations/providers/meta-capi.ts` (helpers → defaultEventMapping → eventCatalog → credentialsSchema `z.object({...}).catchall(z.string())` → provider object). All six: `allowMultipleConnections: false`, no `retryPolicy` (DEFAULT applies), `mapEvent` throws on empty `outboxEventId` (idempotency guard, same as meta-capi).

---

### Task 1: Reserved vendor-id attributes + subscriber identity lookup

**Files:**
- Modify: `packages/shared/src/attributes/catalog.ts` (RESERVED_ATTRIBUTES)
- Modify: `packages/db/src/drizzle/repositories/subscribers.ts` (new projection)
- Test: `packages/shared/src/attributes/catalog.test.ts` (or the existing catalog test file — find it), `packages/db/src/drizzle/repositories/subscribers.test.ts` (extend)

**Interfaces:**
- Produces: six catalog entries `def("$appsflyerId", ok)` etc. (all `ok`-validated, VALUE_MAX applies automatically via `def`); repo `findSubscriberIdentityById(db: Db, id: string): Promise<{ appUserId: string | null; attributes: unknown } | undefined>` (Drizzle `.select({ appUserId, attributes })` by primary key, soft-delete-aware: `isNull(subscribers.deletedAt)`).

- [ ] **Step 1: Failing tests** — catalog: `validateReservedValue("$appsflyerId", "abc")` returns null; `validateReservedValue("$appsflyerId", "x".repeat(501))` returns the ≤500 message; all six keys present. Repo (real PG): seeded subscriber returns `{appUserId, attributes}`; soft-deleted subscriber returns undefined; unknown id undefined.
- [ ] **Step 2: Implement** — six `def(key, ok)` entries under a `// --- vendor ids (RC-compatible names) ---` banner; the repo projection next to `findSubscriberById`.
- [ ] **Step 3: Docs** — find the attributes/reserved-keys documentation page (`grep -rl 'attConsentStatus\|reserved attribute' apps/docs/content`) and add the six new keys with one-line purposes; if no such page exists, add a "Subscriber identity attributes" section to `apps/docs/content/docs/integrations/outbound-webhooks.mdx`'s neighborhood instead (state which in your report). `pnpm --filter @rovenue/docs build` green.
- [ ] **Step 4: Run** `pnpm --filter @rovenue/shared test` + `pnpm --filter @rovenue/db test` (DATABASE_URL exported), expect green.
- [ ] **Step 5: Commit** `feat(attributes): RC-compatible vendor-id reserved keys + subscriber identity projection`

---

### Task 2: Delivery-time identity enrichment in the worker

**Files:**
- Create: `apps/api/src/services/integrations/subscriber-identity-cache.ts` + unit test
- Create: `apps/api/src/services/integrations/enrich-envelope.ts` + unit test
- Modify: `apps/api/src/services/integrations/types.ts` (envelope), `apps/api/src/workers/integrations-deliver.ts` (dep + call), one real-PG test in `apps/api/src/workers/integrations-deliver.integration.test.ts`

**Interfaces:**
- Consumes: `findSubscriberIdentityById` (Task 1); `flattenAttributes` from `@rovenue/shared` (`packages/shared/src/attributes/helpers.ts:64`, returns `AttributeMap = Record<string,string>`).
- Produces:

```ts
// types.ts — envelope gains (optional, backward compatible):
subscriberAttributes?: Record<string, string>;

// subscriber-identity-cache.ts — mirror connection-cache.ts exactly (Map + ttlMs + loader):
export interface SubscriberIdentity { appUserId: string | null; attributes: Record<string, string>; }
export function createSubscriberIdentityCache(opts: { ttlMs: number; loader: (subscriberId: string) => Promise<SubscriberIdentity | null> }): { get(id: string): Promise<SubscriberIdentity | null> };
export const SUBSCRIBER_IDENTITY_CACHE_TTL_MS = 60_000;

// enrich-envelope.ts — pure:
export function enrichEnvelope(envelope: RovenueEventEnvelope, identity: SubscriberIdentity | null): RovenueEventEnvelope;
```

- `enrichEnvelope` rules (test each): returns the envelope unchanged when identity is null; `identityContext.email ??= attributes.$email`, `phone ??= attributes.$phoneNumber` (envelope-provided values WIN); `subscriberAttributes` = attributes + `{ appUserId }` when present + passthrough of `platform` if the attributes carry it; ATT gate — delete `$idfa`/`$gpsAdId` from the result when `$attConsentStatus` present and ≠ `"authorized"` (test both directions: `"denied"` strips, `"authorized"` keeps, absent keeps).
- Worker (`DeliverStepDeps`): new optional `loadSubscriberIdentity?: (subscriberId: string) => Promise<SubscriberIdentity | null>`; in `runDeliverStep`, after credential decrypt and before `mapEvent`: `if (deps.loadSubscriberIdentity && job.envelope.subscriberId) { try { envelope = enrichEnvelope(...) } catch → log + proceed unenriched }` (soft failure — test it). `ensureIntegrationsDeliverWorker` wires the cache with `findSubscriberIdentityById` + `flattenAttributes`. CUSTOM_WEBHOOK: no change needed (its `buildWebhookData` already ignores identityContext PII — add one regression assertion that a webhook body contains neither `$email` value nor `subscriberAttributes`).

- [ ] **Step 1: Failing unit tests** (cache TTL/loader-miss; every enrichEnvelope rule above; worker soft-failure).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Real-PG test** in the M2.7 file: seed subscriber with `attributes: { $email: {…entry shape used by applyMutations — copy from an existing attributes test}, $appsflyerId: … }`; deliver a Meta CAPI event whose envelope has NO email; assert the intercepted Meta body carries `hashPii(normalizeEmail("…"))` for `em` — enrichment reached the wire. Assert a CUSTOM_WEBHOOK delivery body for the same event contains no email.
- [ ] **Step 4: Run** the touched unit tests + M2.7 file, `npx tsc --noEmit`; expect green. **Commit** `feat(integrations): delivery-time subscriber identity enrichment with ATT consent gate`

---

### Task 3: Store-lifecycle normalization (narrow) + Google numeric-classify fix

**Files:**
- Modify: `apps/api/src/services/google/google-mappers.ts:54` (`classifyNotification`)
- Modify: `packages/shared/src/integrations.ts` (4 new keys), `packages/shared/src/webhook-events.ts` (or a new `store-event-normalization.ts` in shared — one exported map)
- Modify: `apps/api/src/services/webhook-processor.ts` (bridge), `apps/api/src/services/integrations-fanout/consumer.ts` (`toSubscriptionEnvelope` whitelist)
- Modify: `apps/docs/content/docs/integrations/outbound-webhooks.mdx` (+4 catalog rows)
- Test: google-mappers test, shared tests, webhook-processor integration test, consumer.test.ts, one e2e assertion

**Interfaces:**
- Produces (shared): `STORE_EVENT_TO_PUBLIC_KEY: Record<string, RovenueEventKey>` — exact table:

```ts
// Apple notificationType
DID_FAIL_TO_RENEW: "subscription.billing_issue",
GRACE_PERIOD_EXPIRED: "subscription.billing_issue",
DID_CHANGE_RENEWAL_STATUS: "subscription.uncancelled",   // NOTE: fires for BOTH directions; see step 2
DID_CHANGE_RENEWAL_PREF: "subscription.product_changed",
// Google (NAMED types — the numeric fix below makes these reachable)
SUBSCRIPTION_ON_HOLD: "subscription.billing_issue",
SUBSCRIPTION_IN_GRACE_PERIOD: "subscription.grace_period",
SUBSCRIPTION_RESTARTED: "subscription.uncancelled",
SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: "subscription.product_changed",
SUBSCRIPTION_DEFERRED: "subscription.product_changed",
// Stripe
"invoice.payment_failed": "subscription.billing_issue",
"customer.subscription.updated": "subscription.product_changed",
```

  Apple `DID_CHANGE_RENEWAL_STATUS` ambiguity: it fires for cancel AND re-enable. The bridge site has the store payload — if the processor already distinguishes auto-renew off/on (read `apps/api/src/services/apple/` handling of that type), map off→(already covered by v1 `subscription.cancel_requested` semantics — do NOT double-map; exclude) and on→`subscription.uncancelled`. If the direction is not available at the bridge site, map ONLY the re-enable direction if distinguishable, else drop the Apple row from the table with a comment — accuracy beats coverage. Same judgment for Stripe `customer.subscription.updated` (only a cancel_at_period_end flip false→true/true→false is meaningful; if the processor can't see the delta at the bridge, drop it with a comment).
- Google fix: `classifyNotification` maps the numeric RTDN `notificationType` through a named table (1 SUBSCRIPTION_RECOVERED, 2 RENEWED, 3 CANCELED, 4 PURCHASED, 5 ON_HOLD, 6 IN_GRACE_PERIOD, 7 RESTARTED, 8 PRICE_CHANGE_CONFIRMED, 9 DEFERRED, 10 PAUSED, 12 REVOKED, 13 EXPIRED; unknown → keep `SUBSCRIPTION_${n}` fallback so nothing breaks). **Named risk:** grep all consumers of `classifyNotification`'s return (audit rows? logs? v1 category filtering via `toWebhookEventCategory`) and verify the change is an improvement everywhere it lands, not a regression; list consumers in your report.
- Bridge: where the gate currently is (`webhook-processor.ts:342` `isRovenueEventKey(args.eventType)`), it becomes: `const publicKey = isRovenueEventKey(args.eventType) ? args.eventType : STORE_EVENT_TO_PUBLIC_KEY[args.eventType]; if (publicKey) { …bridge with eventType: publicKey… }` — dedupe still keyed correctly (same signals, publicKey as the type).
- Fanout: `toSubscriptionEnvelope` whitelist grows to the 6 subscription keys (2 existing + 4 new).
- `ROVENUE_EVENT_KEYS` grows 13→17; update its exact-list test; the webhook drawer's events step (uses the shared const) needs no code change — verify.

- [ ] **Step 1: Failing tests** — google-mappers numeric→named (incl. unknown fallback); shared map keys are all valid `RovenueEventKey`s (type-level + runtime assertion); webhook-processor integration: a synthetic Apple `DID_FAIL_TO_RENEW` post-processing writes ONE outbox row with `eventType: "subscription.billing_issue"` (run-twice = still one, dedupe holds); consumer maps the 4 new keys; unknown still null.
- [ ] **Step 2: Implement** (with the ambiguity judgments above documented in code comments + report).
- [ ] **Step 3: e2e assertion** — extend `integrations-webhook.e2e.integration.test.ts`: wrapper with `eventType: "subscription.billing_issue"` on `rovenue.subscription` → webhook endpoint receives `type: "subscription.billing_issue"` (spec acceptance 4's fanout half; the bridge half is the integration test above).
- [ ] **Step 4: Docs** — 4 rows in the outbound-webhooks event table.
- [ ] **Step 5: Run** all touched suites + `pnpm --filter @rovenue/docs build` + tsc; green. **Commit** `feat(integrations): narrow store-lifecycle normalization; fix Google RTDN numeric classify`

---

### Task 4: Drawer credential-field generalization (all six providers' fields defined once)

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-credentials.tsx` (+ its test)
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts` (`IntegrationProviderId` already covers new ids after Task 5+ — here: no hook changes; only if the file hardcodes provider unions locally, widen via the shared type)

**Interfaces:**
- Produces: a declarative per-provider field list replacing the current single-id+token special case:

```ts
export interface CredentialFieldDef { id: string; label: string; secret?: boolean; placeholder?: string; }
export const PROVIDER_CREDENTIAL_FIELDS: Record<string, CredentialFieldDef[]> = {
  META_CAPI: [{ id: "pixel_id", label: "Dataset ID (Pixel ID)" }, { id: "access_token", label: "Access token", secret: true }],
  TIKTOK_EVENTS: [{ id: "pixel_code", label: "Pixel ID" }, { id: "access_token", label: "Access token", secret: true }],
  AMPLITUDE: [{ id: "api_key", label: "API key", secret: true }, { id: "region", label: "Region (us or eu)", placeholder: "us" }],
  MIXPANEL: [{ id: "service_account_username", label: "Service account username" }, { id: "service_account_secret", label: "Service account secret", secret: true }, { id: "project_id", label: "Project ID" }, { id: "region", label: "Region (us or eu)", placeholder: "us" }],
  APPSFLYER: [{ id: "dev_key", label: "Dev key", secret: true }, { id: "app_id_ios", label: "iOS app ID (optional)" }, { id: "app_id_android", label: "Android app ID (optional)" }],
  ADJUST: [{ id: "app_token", label: "App token", secret: true }],
  SLACK: [{ id: "webhook_url", label: "Incoming webhook URL", secret: true, placeholder: "https://hooks.slack.com/services/..." }],
  FIREBASE_GA4: [{ id: "api_secret", label: "Measurement Protocol API secret", secret: true }, { id: "firebase_app_id", label: "Firebase app ID", placeholder: "1:1234567890:android:abc123" }],
};
```

  These field ids ARE the backend contract — provider tasks 5–10 write `credentialsSchema`s that accept exactly these ids (required unless "(optional)" in the label; `region` optional with default).
- Existing META/TIKTOK rendering must be pixel-identical in behavior (their component tests are the net; refactor the two hardcoded fields onto the new map).
- CUSTOM_WEBHOOK keeps its dedicated `step-credentials-webhook.tsx` (not in this map).

- [ ] **Step 1: Failing component tests** — a 4-field provider (MIXPANEL) renders 4 inputs with labels, secret fields use the existing token input styling, submit posts `credentials` keyed by the field ids.
- [ ] **Step 2: Implement; existing META/TIKTOK tests stay green unmodified.**
- [ ] **Step 3: Run** `pnpm --filter @rovenue/dashboard test` + typecheck; green. **Commit** `feat(dashboard): declarative per-provider credential fields`

---

### Tasks 5–10: The six providers (one task each, same gate structure)

Each provider task = ONE new provider file + unit tests, registry entry, `IntegrationProviderId` union member (packages/shared), dashboard `AppDescriptor` + i18n names (+ rail/homepage entries for a NEW category), one docs page (+ meta.json), and — where the vendor requires identity — skip-reason consts. Follow the meta-capi skeleton (Global Constraints). Every task ends: run the provider's unit tests + registry tests + dashboard suite for the card + `pnpm --filter @rovenue/docs build` + tsc; commit `feat(integrations): <provider> first-class provider`.

**Task 5: AMPLITUDE** — file `providers/amplitude.ts`.
- `topics: ["rovenue.revenue", "rovenue.subscription"]`; `defaultEventMapping`: revenue.INITIAL→"purchase_initial", revenue.TRIAL_CONVERSION→"trial_conversion", revenue.RENEWAL→"renewal", revenue.CREDIT_PURCHASE→"credit_purchase", revenue.REFUND→"refund", revenue.CANCELLATION→"cancellation", subscription.trial.started→"trial_started", subscription.cancel_requested→"cancel_requested", subscription.expired→"subscription_expired", subscription.billing_issue→"billing_issue", subscription.grace_period→"grace_period", subscription.uncancelled→"uncancelled", subscription.product_changed→"product_changed"; `eventCatalog` = exactly those keys.
- creds `z.object({ api_key: z.string().min(1), region: z.enum(["us","eu"]).optional() }).catchall(z.string())`; endpoint const map `AMPLITUDE_ENDPOINTS = { us: "https://api2.amplitude.com/2/httpapi", eu: "https://api.eu.amplitude.com/2/httpapi" }`.
- Event body: `{ user_id, device_id?, event_type, time: Date.parse(occurredAt), insert_id: outboxEventId, event_properties: { rovenue_event: eventKey, product_id }, revenue?, price?, quantity: 1, revenueType? }` — `user_id` = `subscriberAttributes.$amplitudeUserId ?? subscriberAttributes.appUserId ?? subscriberId`; `device_id` = `$amplitudeDeviceId` when present; revenue fields only for revenue.* keys (amount parsed float; REFUND negative revenue per Amplitude convention — document in code).
- `deliver`: POST JSON `{ api_key, events: [event] }`; 200 ok; 400 `invalid_api_key` in body → non-retriable; 413/429 retriable; 5xx retriable. `validateCredentials`: POST an empty-events probe or minimal event to the SAME endpoint; Amplitude returns `invalid_api_key` for bad keys — treat any response proving key validity/invalidity as the check (implementer verifies the current contract via vendor docs and encodes it).
- Dashboard: category `analytics` (NEW category → rail + homepage section per `mock-data.ts`/`types.ts` shapes), vendorKey `amplitude` (add i18n if missing), logo glyph "A".
- Docs page `apps/docs/content/docs/integrations/amplitude.mdx`: setup, fields, mapping table, identity ($amplitudeUserId/$amplitudeDeviceId), dedup note (insert_id).

**Task 6: MIXPANEL** — file `providers/mixpanel.ts`.
- Topics/catalog/mapping keys identical to Amplitude (vendor event names: same snake_case values).
- creds `service_account_username`, `service_account_secret`, `project_id` (all min(1)), `region` optional enum; endpoints `{ us: "https://api.mixpanel.com/import", eu: "https://api-eu.mixpanel.com/import" }`, query `?strict=1&project_id=`.
- Event: `{ event: providerEvent, properties: { time: ms, distinct_id, $insert_id: outboxEventId, amount?, currency?, product_id, rovenue_event: eventKey } }` — `distinct_id` = `$mixpanelDistinctId ?? appUserId ?? subscriberId`. Auth: `authorization: Basic base64(username:secret)`.
- `deliver`: 200 ok; 400 strict-validation → non-retriable; 401 non-retriable; 429/5xx retriable. `validateCredentials`: POST empty batch (strict) — 200/401 distinguishes credentials (verify contract at build time).
- Dashboard: analytics, vendorKey `mixpanel`, glyph "M". Docs page mixpanel.mdx (mention Service Account requirement explicitly).

**Task 7: APPSFLYER** — file `providers/appsflyer.ts`.
- `topics: ["rovenue.revenue", "rovenue.subscription"]`; mapping values `af_`-style: revenue.INITIAL→"af_purchase", revenue.TRIAL_CONVERSION→"af_subscribe", revenue.RENEWAL→"af_subscription_renewal", revenue.REFUND→"af_refund", revenue.CANCELLATION→"af_cancel", revenue.CREDIT_PURCHASE→"af_credit_purchase", subscription.trial.started→"af_start_trial", subscription.cancel_requested→"af_cancel_requested", subscription.expired→"af_subscription_expired", subscription.billing_issue→"af_billing_issue", subscription.grace_period→"af_grace_period", subscription.uncancelled→"af_uncancel", subscription.product_changed→"af_product_change".
- creds: `dev_key` min(1), `app_id_ios` optional, `app_id_android` optional — schema `.refine`: at least one app id present.
- Skip consts: `SKIP_NO_APPSFLYER_ID = "no_user_data"` (reuse existing reason) when `$appsflyerId` absent; `SKIP_NO_PLATFORM_APP_ID = "no_platform_app_id"` — NEW reason string: extend `MapEventSkipReason` union in `types.ts` (check drawer deliveries UI renders unknown reasons as-is — it does, skipReason is text; verify). App-id rules exactly per spec §4.2 (platform match → single-configured → skip).
- Body: `{ appsflyer_id: $appsflyerId, customer_user_id: appUserId?, eventName: providerEvent, eventTime: occurredAt reformatted "yyyy-MM-dd HH:mm:ss.SSS" UTC, eventCurrency: currency, eventValue: JSON.stringify({ af_revenue: amount, af_currency: currency, af_order_id: outboxEventId, product_id }) }`; POST `https://api2.appsflyer.com/inappevent/${appId}` header `authentication: dev_key`.
- `deliver`: 200 ok; 401/403 non-retriable; 400 non-retriable; 429/5xx retriable. `validateCredentials`: AppsFlyer has no auth-probe endpoint — validate shape-only (dev_key non-empty, ≥1 app id) and document in the provider + docs page that the first delivery is the live proof (mirror how the drawer's test-event step covers this).
- Dashboard: category `attribution` (NEW → rail/homepage), vendorKey `appsflyer`, glyph "AF". Docs page (identity requirement: host app must call `setAttributes({"$appsflyerId": appsFlyerUID})`).

**Task 8: ADJUST** — file `providers/adjust.ts`.
- `topics: ["rovenue.revenue", "rovenue.subscription"]`; `defaultEventMapping: {}` — **Adjust has NO defaults**: `eventMapping` values' `eventName` IS the Adjust event token; events without an explicit token → existing skip `no_mapping`. `eventCatalog` = the same 13 revenue+subscription keys (drives the drawer's mapping step rows).
- creds: `app_token` min(1).
- Identity: device id = `$adjustId` (param `adid`) else `$idfa` (param `idfa`) else `$gpsAdId` (param `gps_adid`) else skip `no_user_data`. (ATT gate already stripped idfa/gps upstream when denied.)
- Body (form-encoded POST `https://s2s.adjust.com/event`): `{ app_token, event_token, s2s: 1, adid|idfa|gps_adid, revenue?: amount, currency?, created_at_unix: epoch(occurredAt), callback_params: JSON.stringify({ rovenue_event: eventKey, outbox_event_id: outboxEventId, product_id }), deduplication_id: outboxEventId }`.
- `deliver`: 200 ok; 400 with `error` body non-retriable; 401/403 non-retriable; 429/5xx retriable. `validateCredentials`: shape-only (Adjust S2S has no probe) — same documented pattern as AppsFlyer.
- Dashboard: attribution, vendorKey `adjust`, glyph "AJ". Docs page (event-token mapping explained on the mapping step; $adjustId requirement).

**Task 9: SLACK** — file `providers/slack.ts`.
- `topics`: all four (`rovenue.revenue`, `rovenue.subscription`, `rovenue.paywall_events`, `rovenue.credit`); `defaultEventMapping`: every catalog key → itself (Slack has no vendor event names; providerEvent = eventKey); `eventCatalog` = all 17 public keys.
- creds: `webhook_url` — `.refine`: parses as URL, protocol https, host exactly `hooks.slack.com` (named const `SLACK_WEBHOOK_HOST`). Same check re-run at deliver time (two-phase, allowlist).
- Message builder (pure, unit-tested per event family): revenue → `":moneybag: {eventKey} — {amount} {currency} · {productId} · subscriber {maskedId}"` where `maskedId` = first 4 + "…" of subscriberId; subscription lifecycle → `":repeat:"` prefix; paywall → `":eyes:"`; credit → `":coin:"`. NO email/phone/attributes in messages (assert in test). Body `{ text }`.
- `deliver`: POST JSON via the standard `http` client; 200 + body "ok" → ok; 404/410 (`no_service`) non-retriable; 400 `invalid_payload` non-retriable; 429 retriable; 5xx retriable. `validateCredentials`: POST `{ text: "Rovenue connected :white_check_mark:" }` — a REAL message is RC-parity behavior for Slack connect; document it in the drawer copy + docs.
- Dashboard: category `communication` (NEW → rail/homepage), vendorKey `slack` (i18n exists), glyph "S". Docs page (duplicate-message at-least-once note from spec §4.2 verbatim).

**Task 10: FIREBASE_GA4** — file `providers/firebase-ga4.ts`.
- `topics: ["rovenue.revenue", "rovenue.subscription"]`; mapping: revenue.INITIAL→"purchase", revenue.RENEWAL→"purchase", revenue.TRIAL_CONVERSION→"purchase", revenue.REFUND→"refund", revenue.CREDIT_PURCHASE→"purchase", revenue.CANCELLATION→"rovenue_cancellation", subscription.*→"rovenue_" + suffix (GA4 custom events must match `^[A-Za-z]\w*$` — derive names by replacing dots with underscores, test the regex); `eventCatalog` = those keys.
- creds: `api_secret` min(1), `firebase_app_id` min(1).
- Identity: REQUIRES `$firebaseAppInstanceId` else skip `no_user_data`.
- Body: POST `https://www.google-analytics.com/mp/collect?firebase_app_id=&api_secret=` with `{ app_instance_id, timestamp_micros, events: [{ name, params: { currency, value: parseFloat(amount), transaction_id: outboxEventId, product_id, rovenue_event: eventKey } }] }`.
- `deliver`: MP returns 2xx regardless — classification: 2xx ok, 4xx non-retriable, 5xx retriable. `validateCredentials`: POST the same body to `https://www.google-analytics.com/debug/mp/collect?...` and fail when `validationMessages` is non-empty (a REAL check — this is the one vendor with a purpose-built validation endpoint).
- Dashboard: analytics, vendorKey `firebase` (or `google` — match existing i18n; add if missing), glyph "F". Docs page (Firebase app streams only, per spec; $firebaseAppInstanceId requirement).

---

### Task 11: Backfill widening to all fanout aggregates

**Files:**
- Modify: `apps/api/src/services/integrations/backfill.ts` (aggregate IN-list + per-shape projectId extraction)
- Test: `apps/api/src/services/integrations/backfill.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `outboxRowToEnvelope` (already normalizes all four aggregates via `toFanoutEnvelope`); `AGGREGATE_TO_TOPIC` from `apps/api/src/lib/outbox-topics.ts`.
- The SQL currently filters `aggregateType IN ('REVENUE_EVENT')` and extracts `payload->>'projectId'`. Widen to `('REVENUE_EVENT','SUBSCRIPTION','PAYWALL_EVENT','CREDIT_LEDGER')` — but FIRST verify each aggregate's payload carries top-level `projectId` (SUBSCRIPTION: yes, bridge guarantees it; CREDIT_LEDGER: yes, `credit-ledger.ts` payload; PAYWALL_EVENT: **verify** against the dispatcher's `shapePaywallEventMessage` — the OUTBOX row payload may differ from the shaped Kafka message; if the row payload lacks top-level projectId, EXCLUDE that aggregate with a comment, don't guess).
- Rows that `outboxRowToEnvelope` returns null for are skipped (already the behavior) — the widening must not enqueue unmappable jobs.

- [ ] **Step 1: Failing real-PG test** — enable a CUSTOM_WEBHOOK connection with a seeded SUBSCRIPTION outbox row (bridge-shaped payload) in the window → backfill enqueues it; a CREDIT_LEDGER row likewise; an unmappable row is not enqueued.
- [ ] **Step 2: Implement (with the PAYWALL_EVENT verification documented).**
- [ ] **Step 3: Run** backfill tests + tsc; green. **Commit** `feat(integrations): backfill covers all fanout-backed aggregates`

---

### Task 12: Verification + ROADMAP tick

**Files:**
- Modify: `ROADMAP.md` §6 (tick Wave-1 bullet, update Now score with reasoning, keep Wave-2 + full store passthrough as remaining)

- [ ] **Step 1: Full battery** (report actual numbers; do not fix unrelated reds — report them):

```bash
docker ps
cd /Volumes/Development/rovenue && pnpm build
cd apps/api && npx vitest run && VITEST_CONTAINER_PASS=1 npx vitest run
pnpm --filter @rovenue/db test && pnpm --filter @rovenue/shared test && pnpm --filter @rovenue/dashboard test && pnpm --filter @rovenue/docs build
```

- [ ] **Step 2: ROADMAP §6 update** — Wave-1 shipped (6 providers + enrichment + normalization), score reasoning in the report; stage ONLY ROADMAP.md (unrelated dirty files asset-library.tsx / seed.ts must never be committed).
- [ ] **Step 3: Commit** `docs(roadmap): §6 Wave-1 providers shipped` with the numbers in the body.

---

## Self-review notes (for executors)

- Task 4 locks ALL credential field ids before any provider exists — providers 5–10 must match those ids exactly; drift between the map and a credentialsSchema is a review-blocking defect.
- AppsFlyer/Adjust have NO credential probe endpoint — shape-only validation is a deliberate, documented deviation from the "real vendor call" pattern (the drawer's test-event step is the live proof for them). Slack/GA4/Amplitude/Mixpanel DO real calls.
- Adjust reuses `eventMapping.eventName` as the event token — no UI change, but the docs + drawer helper copy must say it.
- The spec's ATT gate lives in Task 2's `enrichEnvelope`, so providers never see gated ids — provider code must NOT re-implement consent logic.
- Zero migrations: `MapEventSkipReason` union extension (Task 7) is type-only; delivery `skip_reason` column is already text.
