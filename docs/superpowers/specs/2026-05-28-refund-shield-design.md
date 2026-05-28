# Refund Shield — Design Spec

**Date:** 2026-05-28
**Status:** Draft, pending user review
**Scope:** iOS-only refund saver (Apple `CONSUMPTION_REQUEST` response pipeline) + Android SDK hygiene improvements (`obfuscatedAccountId`/`obfuscatedProfileId`).

---

## 1. Problem

When an App Store customer requests a refund, Apple sends developers a `CONSUMPTION_REQUEST` notification (App Store Server Notifications v2) and gives them a **12-hour window** to respond with consumption data. If you respond with rich, accurate signals, Apple's refund-decision algorithm is more likely to decline unjustified refunds. Apps that ignore the window typically see the refund approved by default.

Adapty markets their equivalent as "Refund Saver" and claims:
- ~50% reduction in approved refunds
- ~80% win rate on disputed refunds
- Recovery of 2–3% of total revenue

Rovenue today does not handle `CONSUMPTION_REQUEST` at all — these notifications drop into `webhook_events` unhandled.

**Refund Shield** closes this gap.

## 2. Non-goals (YAGNI)

- **Android refund saver** — Google Play has no `CONSUMPTION_REQUEST` equivalent. The closest mechanic (Voided Purchases API / `VOIDED_PURCHASE` RTDN) is reactive: Google decides, then notifies. Out of scope; would be a separate "automated entitlement clawback" spec.
- **Multi-region Apple endpoint failover.** Apple exposes a single global endpoint per environment.
- **Adaptive response delay tuning.** v1 ships a manual per-project slider.
- **A/B testing the bucket mapping.** v1 ships one deterministic mapping.
- **End-user notification of refund outcome.** Apple already notifies users directly.
- **Backfilling `apple_app_account_token` for legacy purchases.** Apple requires the token at purchase time; it cannot be retroactively attached.

## 3. Architecture

Three parallel pipelines:

### Pipeline 1 — Tag the user (per purchase)

1. SDK calls StoreKit2 `Product.purchase(options:)` with `appAccountToken=<stable per-subscriber UUID>`.
2. JWS receipt flows to Rovenue backend.
3. Apple webhook receipt handler decodes JWS and persists `subscribers.apple_app_account_token`.

### Pipeline 2 — Collect usage telemetry (continuous)

1. SDK subscribes to React Native `AppState` (or native lifecycle on pure-Swift/Kotlin consumers — v2).
2. Emits `open` / `background` / `close` events with `durationMs`.
3. Batches every 30s and POSTs to `POST /v1/sdk/sessions` (public Bearer auth).
4. Backend produces directly to Kafka topic `rovenue.sdk-sessions` (no Postgres write — telemetry has no transactional partner).
5. ClickHouse `sdk_session_events_raw` (Kafka Engine) → `sdk_sessions_daily` MV aggregates per-subscriber-per-day.

### Pipeline 3 — Respond to refund requests (the core feature)

1. Apple sends `CONSUMPTION_REQUEST` → existing webhook → new switch case in `apps/api/src/services/apple/apple-webhook.ts:215`.
2. Handler validates project is enabled; if so inserts a `refund_shield_responses` row with `status='PENDING'` and `scheduled_for = now() + project.refund_shield_response_delay_minutes` (default 60). Otherwise inserts a `SKIPPED_*` row.
3. New polling worker `refund-shield-responder` reads due rows (`FOR UPDATE SKIP LOCKED`).
4. Worker aggregates signals (ClickHouse + Postgres), maps to Apple's bucket scales, POSTs `PUT /inApps/v1/transactions/consumption/{transactionId}`.
5. Writes audit row (per-project SHA-256 hash chain).
6. Subsequent Apple notifications (`REFUND` / `REFUND_DECLINED_NOTIFICATION` / `REFUND_REVERSED`) update `refund_shield_responses.outcome` for win-rate metrics.

**Why polling worker, not BullMQ:** The codebase doesn't use BullMQ today; `outgoing-webhooks` and `scheduled-actions` are the existing internal-queue pattern. Consistency wins.

**Why outbox, then no outbox:** Refund Shield queue is internal — no downstream Kafka consumer needs the events. The dedicated `refund_shield_responses` table doubles as queue and outcome log; no `outbox_events` row needed for this path.

## 4. Data model

### 4.1 Postgres — `subscribers` (modify)

```sql
ALTER TABLE subscribers ADD COLUMN apple_app_account_token UUID;
CREATE UNIQUE INDEX idx_subscribers_apple_app_account_token
  ON subscribers (project_id, apple_app_account_token)
  WHERE apple_app_account_token IS NOT NULL;
```

### 4.2 Postgres — `projects` (modify)

```sql
ALTER TABLE projects
  ADD COLUMN refund_shield_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN refund_shield_consent_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN refund_shield_consent_acknowledged_by UUID REFERENCES "user"(id),
  ADD COLUMN refund_shield_response_delay_minutes INTEGER NOT NULL DEFAULT 60;
```

Consent is **project-level**: the project owner ticks one box affirming their ToS / privacy policy discloses consumption-data sharing. Legal risk attribution lives in customer ToS, not in Rovenue.

### 4.3 Postgres — new table `refund_shield_responses`

```sql
CREATE TABLE refund_shield_responses (
  id                              UUID PRIMARY KEY,
  project_id                      UUID NOT NULL REFERENCES projects(id),
  subscriber_id                   UUID REFERENCES subscribers(id),
  apple_notification_uuid         TEXT NOT NULL UNIQUE,
  apple_original_transaction_id   TEXT NOT NULL,
  apple_transaction_id            TEXT NOT NULL,
  detected_at                     TIMESTAMPTZ NOT NULL,
  scheduled_for                   TIMESTAMPTZ NOT NULL,
  sent_at                         TIMESTAMPTZ,
  request_payload                 JSONB,
  apple_http_status               INTEGER,
  apple_response_body             TEXT,
  status                          TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | SENT | FAILED | SKIPPED_NOT_FOUND | SKIPPED_DISABLED
  outcome                         TEXT,
  -- REFUND_APPROVED | REFUND_DECLINED | REFUND_REVERSED
  outcome_received_at             TIMESTAMPTZ,
  error                           TEXT,
  retry_count                     INTEGER NOT NULL DEFAULT 0,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rss_due ON refund_shield_responses (status, scheduled_for)
  WHERE status = 'PENDING';
CREATE INDEX idx_rss_outcome_lookup
  ON refund_shield_responses (apple_original_transaction_id);
CREATE INDEX idx_rss_dashboard
  ON refund_shield_responses (project_id, detected_at DESC);
```

Not partitioned in v1. If volume warrants it later, partition by `detected_at` monthly.

### 4.4 ClickHouse — new migrations

`packages/db/clickhouse/migrations/0009_sdk_session_events_kafka.sql`:
```sql
CREATE TABLE sdk_session_events_raw (
  project_id        UUID,
  subscriber_id     UUID,
  event_type        LowCardinality(String),
  occurred_at       DateTime64(3, 'UTC'),
  duration_ms       UInt32,
  app_version       LowCardinality(String),
  sdk_version       LowCardinality(String)
) ENGINE = Kafka(...)
  SETTINGS kafka_topic_list = 'rovenue.sdk-sessions';
```

`0010_sdk_sessions_daily_mv.sql` — SummingMergeTree aggregation per (project_id, subscriber_id, day):
- `session_ms_state` — `sumState(duration_ms)` filtered to `event_type IN ('background','close')`
- `session_count_state` — `countState()`

`0011_revenue_lifetime_subscriber_mv.sql` — SummingMergeTree fed by existing `revenue_events` raw, aggregating per-subscriber lifetime cents:
- `lifetime_dollars_purchased_cents` — sum of positive revenue
- `lifetime_dollars_refunded_cents` — sum of refund-type events

### 4.5 Kafka

New topic `rovenue.sdk-sessions`. SDK ingest endpoint produces directly (no outbox). Producer failure surfaces as HTTP 503 to SDK; SDK retries.

### 4.6 Outbox / audit

- **No new outbox aggregate type.** Worker reads `refund_shield_responses` directly.
- **No audit schema change.** Existing `audit()` helper logs `entityType='refund_shield_response'`, actions `SENT | FAILED | OUTCOME_RECORDED`.

## 5. API surfaces

### 5.1 Apple webhook — new switch cases (`apple-webhook.ts:215`)

| `notificationType` | Handler | Action |
|---|---|---|
| `CONSUMPTION_REQUEST` | `applyConsumptionRequest` | Insert `refund_shield_responses` row; status decided by project enabled flag and subscriber lookup result |
| `REFUND` | extend existing `applyRefund` | `UPDATE ... SET outcome='REFUND_APPROVED'` |
| `REFUND_DECLINED_NOTIFICATION` | `applyRefundDeclined` | `outcome='REFUND_DECLINED'`; no revenue_events impact |
| `REFUND_REVERSED` | `applyRefundReversed` | `outcome='REFUND_REVERSED'`; compensating revenue_events row |

Subscriber lookup priority: `apple_app_account_token` (exact) → `purchases.original_transaction_id` JOIN (fallback). If neither resolves, status `SKIPPED_NOT_FOUND`.

### 5.2 Apple Server API client (new module)

`apps/api/src/services/apple/apple-server-api.ts` — thin wrapper over existing `getAppleAuthToken()`. v1 exposes one method:

```ts
sendConsumptionInfo(
  ctx: ProjectAppleContext,
  transactionId: string,
  payload: ConsumptionRequest,
): Promise<{ status: 202 }>
```

`ConsumptionRequest` is a Zod schema mirroring Apple's documented payload (12 fields). Sandbox vs production base URL follows the existing pattern in `apple-webhook.ts`.

### 5.3 Worker — `refund-shield-responder`

`apps/api/src/workers/refund-shield-responder.ts`. Loop pattern copied from `outgoing-webhooks`:
- Poll interval: 30s
- Batch size: 50
- `FOR UPDATE SKIP LOCKED` for multi-instance safety
- Per-row pipeline: re-verify project enabled → resolve subscriber → aggregate signals → map to buckets → build payload → POST to Apple → status update + audit
- Retries: exponential backoff (1m, 5m, 30m, 2h, 6h) with jitter
- Max retries: 5
- SLA timeout: if `detected_at + 12h < now()` and not yet SENT, mark `FAILED` with `error='SLA_EXCEEDED'`

### 5.4 SDK ingest — `POST /v1/sdk/sessions`

Public Bearer auth. Body (Zod):
```ts
{
  subscriberId: z.string().uuid(),
  events: z.array(z.object({
    type: z.enum(['open', 'background', 'close']),
    occurredAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative().optional(),
    appVersion: z.string().max(32),
    sdkVersion: z.string().max(32),
  })).min(1).max(200),
}
```

Produces directly to `rovenue.sdk-sessions` topic. No Postgres write. Rate limit: 60 req/min per subscriber.

### 5.5 Dashboard endpoints

Mounted under `apps/api/src/routes/dashboard/refund-shield/`. Auth: existing `dashboardSession` middleware + project-role check (settings mutations require `owner`).

| Endpoint | Purpose |
|---|---|
| `GET /api/dashboard/projects/:projectId/refund-shield/settings` | Read settings |
| `PUT /api/dashboard/projects/:projectId/refund-shield/settings` | Enable/disable, set delay, record consent (audited) |
| `GET /api/dashboard/projects/:projectId/refund-shield/responses` | Paginated list with filters (status, outcome, date range) |
| `GET /api/dashboard/projects/:projectId/refund-shield/responses/:id` | Single row + full Apple payload + outcome timeline |
| `GET /api/dashboard/projects/:projectId/refund-shield/metrics` | Win rate, sent count, estimated revenue saved (date-range query against Postgres + ClickHouse) |

## 6. Signal aggregation and bucket mapping

### 6.1 Aggregation queries

ClickHouse (single query):
```sql
SELECT
  sumMerge(session_ms_state)         AS lifetime_session_ms,
  lifetime_dollars_purchased_cents,
  lifetime_dollars_refunded_cents
FROM sdk_sessions_daily_tbl
JOIN revenue_lifetime_subscriber_mv USING (subscriber_id)
WHERE subscriber_id = :id;
```

Postgres (single query) — `first_seen_at` drives `accountTenure`:
```sql
SELECT
  s.first_seen_at,
  exists(SELECT 1 FROM subscriber_access
         WHERE subscriber_id = :id
           AND revoked_at IS NULL
           AND expires_at > now())                AS has_active_entitlement,
  (SELECT min(purchased_at) FROM purchases
   WHERE original_transaction_id = :otid)        AS purchase_started_at,
  (SELECT expires_at FROM purchases
   WHERE original_transaction_id = :otid
   ORDER BY purchased_at DESC LIMIT 1)           AS purchase_ends_at,
  (SELECT was_in_trial FROM purchases
   WHERE original_transaction_id = :otid
   ORDER BY purchased_at DESC LIMIT 1)           AS was_in_trial
FROM subscribers s
WHERE s.id = :id;
```

### 6.2 Bucket mapping

Pure TS function in `apps/api/src/services/apple/refund-shield-buckets.ts`:

| Apple field | Rovenue source | Bucket rule |
|---|---|---|
| `customerConsented` | project consent flag | bool |
| `consumptionStatus` | `purchase_started_at` vs `now()` vs `purchase_ends_at` | elapsed>90% → 3 (FULLY); 25-90% → 2 (PARTIAL); <25% → 1 (NOT_CONSUMED) |
| `platform` | constant | 1 (APPLE) |
| `sampleContentProvided` | `was_in_trial` | bool |
| `deliveryStatus` | constant | 0 (DELIVERED) |
| `appAccountToken` | `subscribers.apple_app_account_token` | UUID; omit if NULL |
| `accountTenure` | `now() - subscribers.first_seen_at` | 0=undeclared, 1=0-3d, 2=3-10d, 3=10-30d, 4=30-90d, 5=>90d |
| `playTime` | `lifetime_session_ms` | 0=und, 1=0-5m, 2=5-60m, 3=1-6h, 4=6-16h, 5=>16h |
| `lifetimeDollarsPurchased` | `lifetime_dollars_purchased_cents` | Apple's 0-7 tiers ($0, <$50, $50-100, $100-500, $500-1k, $1k-2k, $2k-3k, >$3k) |
| `lifetimeDollarsRefunded` | `lifetime_dollars_refunded_cents` | same tiers |
| `userStatus` | `has_active_entitlement` | 1 (ACTIVE) if true, else 0 (undeclared) |
| `refundPreference` | constant | 2 (PREFER_DECLINE) |

Pure function → unit-testable with snapshot fixtures.

## 7. SDK changes

### 7.1 librovenue Rust core (out-of-monorepo)

New optional purchase parameters:
```rust
pub struct PurchaseOptions {
    pub apple_app_account_token: Option<Uuid>,
    pub google_obfuscated_account_id: Option<String>, // max 64 ascii
    pub google_obfuscated_profile_id: Option<String>, // max 64 ascii
}
pub fn purchase(product_id: &str, opts: PurchaseOptions) -> Result<PurchaseReceipt>;
```

New session event API:
```rust
pub enum SessionEventKind { Open, Background, Close }
pub fn record_session_event(
  kind: SessionEventKind,
  occurred_at: DateTime<Utc>,
  duration_ms: Option<u32>,
);
```
Core buffers locally (cap 1000 events, FIFO drop) and flushes every 30s via existing HTTP client.

Versioning: minor bump (additive, default values keep existing consumers working).

### 7.2 RN TS façade (`packages/sdk-rn/src/`)

New internal module `accountToken.ts`:
- Generates stable UUIDv4 the first time `identify()` is called per project.
- Persists in MMKV under `rovenue.appAccountToken.<projectId>`.
- Same UUID reused for both Apple `appAccountToken` and Android `obfuscatedAccountId` (Android accepts strings, so the UUID's string form works).
- `obfuscatedProfileId` set to `projectId` (fraud detection signal for Google).

New internal module `sessionTracker.ts`:
- Subscribes to React Native `AppState`.
- Debounces sub-1s transitions.
- Calls core's `record_session_event`.

`purchase()` public signature unchanged — token injection is internal.

Versioning: minor bump.

### 7.3 iOS Swift façade

Pod minimum bump (`librovenue 0.6.0+`). `RovenueModule.swift` accepts UUID from RN and forwards. No native iOS lifecycle hooks in v1 — RN `AppState` covers the RN consumer path. Pure-Swift consumers get the API but native lifecycle wiring is a follow-up.

### 7.4 Android Kotlin façade

Same pattern: aar minimum bump, `obfuscatedAccountId` + `obfuscatedProfileId` forwarded to `BillingFlowParams.Builder`. Android benefits from these for fraud detection even though it has no Refund Saver mechanic.

## 8. Dashboard UI

Routes under `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/`:

- **Overview** (`/refund-shield`) — KPI cards (sent count 30d, win rate, estimated revenue saved), trend sparkline, status breakdown donut.
- **Responses list** (`/refund-shield/responses`) — paginated table; filters: status, outcome, date range; search by transactionId.
- **Response detail** (`/refund-shield/responses/$id`) — timeline (detected → scheduled → sent → outcome), Apple payload (collapsible JSON), Apple response, subscriber lifetime snapshot, audit log entries.
- **Settings** (`/refund-shield/settings`) — enable toggle, delay slider (30-360min, default 60), consent acknowledgement.

**Onboarding wizard** appears when `refund_shield_enabled=false`:
1. SDK requirements check (live ClickHouse query: % of last-24h purchases with `appAccountToken` set) — warning if <50%.
2. ToS update acknowledgement with template language.
3. Response delay slider.
4. Enable button.

**Subscriber detail integration:** new "Refund Shield" tab on existing subscriber drill-in showing this subscriber's responses (usually 0-3 rows), Apple outcomes, bucket profile.

Component library: reuse existing `DataTable`, `StatCard`, `Timeline`, `JsonViewer`, `DateRangeFilter`. No new primitives.

## 9. Rollout plan

**Phase 1 — quiet collection (1 week):**
- All code shipped to production with `refund_shield_enabled=false` for every project.
- SDK update live; `apple_app_account_token` and `obfuscatedAccountId` start populating.
- Session telemetry flowing; `sdk_sessions_daily` MV filling.
- Incoming `CONSUMPTION_REQUEST` notifications recorded as `SKIPPED_DISABLED` rows. Dashboard shows raw count: "Apple asked you about N refunds in the last 30 days that you didn't answer."

**Phase 2 — alpha (1-2 weeks):**
- Enable on internal Rovenue test project + 2-3 design partners.
- Sandbox + TestFlight manual `CONSUMPTION_REQUEST` triggering.
- Monitor win rate and failure rates via dashboards/alerts.

**Phase 3 — public release:**
- Blog post + docs.
- Default remains OFF — customers opt in.
- Onboarding wizard surfaces ToS-disclosure responsibility on customer.

## 10. Observability

Prometheus / OTLP metrics via existing helper:
- `refund_shield.received` — counter, labels: `project_id`
- `refund_shield.sent` — counter, labels: `project_id`
- `refund_shield.failed` — counter, labels: `project_id`, `reason` (`apple_4xx | apple_5xx | sla_exceeded | not_found | disabled`)
- `refund_shield.sla_remaining_seconds` — histogram (recorded when response sent, value = `12h - (now - detected_at)`)
- `refund_shield.outcome.approved` / `.declined` / `.reversed` — counters
- `refund_shield.win_rate_30d` — derived gauge

Alerts:
- `refund_shield.failed{reason='apple_5xx'}` sustained > 5% of `received` for 30m → page
- `refund_shield.sla_remaining_seconds` p99 < 1h → page (we're cutting too close to SLA)
- Worker liveness via existing worker-heartbeat pattern.

## 11. Testing

| Test | Location | Type | Verifies |
|---|---|---|---|
| `refund-shield-buckets.test.ts` | api/services/apple | unit | Pure bucket mapping — snapshot per scenario |
| `refund-shield-responder.test.ts` | api/workers | unit (mocks) | Happy path, 5xx retry, 4xx fail, SLA exceeded, skip cases |
| `apple-webhook.consumption-request.test.ts` | api/services/apple | unit (JWS fixtures) | New `notificationType` cases |
| `refund-shield.integration.test.ts` | api | integration (testcontainers + WireMock) | End-to-end: webhook → table → worker → Apple stub → outcome notification → final state |
| `accountToken.test.ts` | sdk-rn | unit | Stable token in MMKV, scoped per projectId |
| `sessionTracker.test.ts` | sdk-rn | unit | AppState transitions → events; sub-1s debounce |
| `purchase.integration.test.ts` | sdk-rn | integration (mock native bridge) | Correct token passed to native |
| librovenue Rust unit tests | librovenue repo | unit | Buffer cap, FIFO drop, flush cadence |

E2E in real sandbox is manual (requires TestFlight build to trigger `CONSUMPTION_REQUEST`).

## 12. Open questions / future work

- **Auto-tuning the response delay** based on per-project win-rate experiments. v1 manual; v2 candidate.
- **Native iOS / Android lifecycle wiring** for pure-Swift / pure-Kotlin SDK consumers (RN consumers covered in v1).
- **Apple `refundPreference` experiments** — Apple defines 1 (PREFER_GRANT) and 3 (NO_PREFERENCE) too; some apps may want to A/B these.
- **Refund Shield bundled in `subscribers` export** for GDPR/KVKK — currently `audit_logs` carries it implicitly; no extra work assumed but verify before public release.
- **Android automated entitlement clawback** spec — separate effort; uses Voided Purchases API + RTDN `VOIDED_PURCHASE`.

## 13. Glossary of named artifacts

- **`refund_shield_responses` table** — Postgres queue + outcome log
- **`refund-shield-responder` worker** — polling worker in `apps/api/src/workers/`
- **`apple-server-api.ts` module** — new HTTP client wrapping Apple's Server API
- **`refund-shield-buckets.ts` module** — pure bucket-mapping function
- **`rovenue.sdk-sessions` Kafka topic** — SDK telemetry stream
- **`sdk_sessions_daily` MV** — ClickHouse aggregate (project_id, subscriber_id, day, session_seconds)
- **`revenue_lifetime_subscriber_mv` MV** — ClickHouse per-subscriber lifetime cents
- **`accountToken.ts`** — RN SDK stable-UUID generator
- **`sessionTracker.ts`** — RN SDK AppState lifecycle observer
