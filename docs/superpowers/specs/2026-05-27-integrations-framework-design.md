# Integrations Framework — Meta CAPI & TikTok Events API (M1)

Status: design
Date: 2026-05-27
Author: worktree integrations-framework-meta-tiktok

## 0. Summary

Rovenue ships an outbound conversion-delivery framework that forwards revenue, subscription, and identity events to Meta Conversions API (CAPI) and TikTok Events API v1.3. The framework is a thin, two-provider abstraction (no plugin system, no npm-extensible registry) that rides the existing transactional-outbox → Kafka pipeline and BullMQ worker pool: a new `integrations-fanout` Kafka consumer reads `rovenue.revenue` + `rovenue.billing`, enqueues per-connection delivery jobs into `rovenue-integrations-deliver`, and a worker maps + POSTs each event to the configured provider. PII is sourced from a per-event `identityContext` block populated by the SDK and is never persisted at rest. Connections, credentials, scope, and overrides live in two new partitioned-aware Postgres tables; the dashboard exposes them through a 5-step base-ui drawer that mirrors `product-drawer.tsx`.

## 1. Goals & non-goals

### 1.1 Goals
- Outbound Meta CAPI delivery using server-side event_id deduplication.
- Outbound TikTok Events API v1.3 delivery with the same deduplication contract.
- Per-project, per-provider configurable event scope (`enabled_events: text[]`) plus per-event name override or skip via `event_mapping: jsonb`.
- Zero at-rest PII — `identityContext` is supplied per event by the SDK and hashed (where required) at delivery time only.
- Reuse the existing outbox dispatcher, Kafka topics, BullMQ workers, audit log, sentry-notifications helper, and live-events channel — no parallel infrastructure.
- Dead-letter signaling via the existing outbox-notification pipeline (`integration.delivery.dead_letter`) so on-call sees ad-platform failures the same way as Stripe/Apple/Google webhook failures.
- Automatic 7-day backfill on activation so a freshly-connected pixel is not blind for the first week.

### 1.2 Non-goals (deferred to M2 or later)
- Inbound cost / spend data ingestion from Meta or TikTok ads accounts.
- Audience sync (Custom Audiences, TikTok Audience API).
- Plugin / SPI system — providers are first-class modules compiled into `apps/api`, not installable.
- ClickHouse mirror of `integration_deliveries` (M1 reads are 30d Postgres only).
- Per-project Key Encryption Keys (KEKs); M1 reuses the global `ENCRYPTION_KEY`.
- Per-event `action_source` override (M1 is connection-level only).
- In-process rate-limit enforcement (M1 documents Meta 100k/h, TikTok 60/s but does not throttle; provider 429s are simply retried).
- Additional providers (Google Ads, Snap, Reddit) — only Meta + TikTok in M1.

## 2. Architecture overview

```
            ┌────────────────────────────────────────────────┐
            │ Domain transaction (e.g. confirmRenewal)       │
            │   INSERT revenue_events                        │
            │   INSERT outbox_events (same tx)               │
            └─────────────────────┬──────────────────────────┘
                                  │
                                  ▼
            ┌────────────────────────────────────────────────┐
            │ outbox-dispatcher (existing)                   │
            │   reads outbox_events, publishes by aggregate  │
            │   → rovenue.revenue | rovenue.billing          │
            └─────────────────────┬──────────────────────────┘
                                  │ Kafka / Redpanda
                                  ▼
            ┌────────────────────────────────────────────────┐
            │ integrations-fanout consumer  (NEW)            │
            │   group: rovenue-integrations-fanout           │
            │   subscribes: rovenue.revenue, rovenue.billing │
            │   lookup enabled connections per projectId     │
            │   enqueue BullMQ job per (connection, event)   │
            │   jobId = `${connectionId}:${outboxEventId}`   │
            └─────────────────────┬──────────────────────────┘
                                  │ BullMQ (Redis)
                                  ▼
            ┌────────────────────────────────────────────────┐
            │ integrations-deliver worker  (NEW)             │
            │   queue: rovenue-integrations-deliver          │
            │   concurrency: 16                              │
            │   provider.mapEvent → pre-insert pending row   │
            │   provider.deliver → update status             │
            │   dead_letter → audit + outbox_notification    │
            └─────────────────────┬──────────────────────────┘
                                  │
                                  ▼
            ┌────────────────────────────────────────────────┐
            │ Meta CAPI  /  TikTok Events API                │
            │   event_id = outbox_event.id (dedup key)       │
            └────────────────────────────────────────────────┘
```

All four moving parts run in the existing `apps/api` process, supervised the same way the outbox dispatcher already is.

## 3. Data model

### 3.1 `integration_connections`

```sql
CREATE TABLE integration_connections (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id         text NOT NULL,  -- 'META_CAPI' | 'TIKTOK_EVENTS'
  display_name        text NOT NULL,
  credentials_cipher  text NOT NULL,  -- AES-256-GCM via shared/crypto encrypt()
  credentials_hint    text NOT NULL,  -- e.g. 'Pixel 1234…5678' shown in UI
  enabled_events      text[] NOT NULL DEFAULT '{}',  -- mapping keys from §5.1
  event_mapping       jsonb  NOT NULL DEFAULT '{}',  -- overrides over default
  action_source       text   NOT NULL DEFAULT 'app', -- 'app'|'website'|'system_generated'
  test_event_code     text,
  is_enabled          boolean NOT NULL DEFAULT false,
  last_validated_at   timestamptz,
  last_error          text,
  last_backfill_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_connections_action_source_chk
    CHECK (action_source IN ('app', 'website', 'system_generated')),
  CONSTRAINT integration_connections_provider_chk
    CHECK (provider_id IN ('META_CAPI', 'TIKTOK_EVENTS'))
);
CREATE UNIQUE INDEX integration_connections_project_provider_uidx
  ON integration_connections(project_id, provider_id);
CREATE INDEX integration_connections_enabled_idx
  ON integration_connections(project_id) WHERE is_enabled = true;
```

Drizzle table lives at `packages/db/src/drizzle/schema/integration-connections.ts` and is re-exported from the package barrel.

### 3.2 `integration_deliveries`

```sql
CREATE TABLE integration_deliveries (
  id               text NOT NULL,
  connection_id    text NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  project_id       text NOT NULL,
  provider_id      text NOT NULL,
  outbox_event_id  text NOT NULL,
  event_key        text NOT NULL,    -- the mapping key from §5.1
  provider_event   text,             -- e.g. 'Purchase' / 'Subscribe'
  status           text NOT NULL,    -- 'pending' | 'succeeded' | 'failed' | 'skipped' | 'dead_letter'
  attempt          smallint NOT NULL DEFAULT 0,
  skip_reason      text,
  http_status      smallint,
  response_body    text,             -- truncated to 4096 bytes
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE UNIQUE INDEX integration_deliveries_dedupe_uidx
  ON integration_deliveries(connection_id, outbox_event_id, created_at);
CREATE INDEX integration_deliveries_connection_status_idx
  ON integration_deliveries(connection_id, status, created_at DESC);
CREATE INDEX integration_deliveries_project_dead_letter_idx
  ON integration_deliveries(project_id, created_at DESC)
  WHERE status = 'dead_letter';
```

`response_body` is truncated to 4096 bytes in the worker before insert (defense-in-depth: keep ad-platform PII echoes out of the warehouse). The `(connection_id, outbox_event_id, created_at)` unique constraint is what makes replay idempotent at the database layer (in addition to BullMQ jobId dedup) — see §6.3.

Partitions are daily, premake 7, retain 30 — owned by `pg_partman` like `revenue_events` / `credit_ledger`:

```sql
SELECT partman.create_parent(
  p_parent_table => 'public.integration_deliveries',
  p_control      => 'created_at',
  p_type         => 'native',
  p_interval     => '1 day',
  p_premake      => 7
);
UPDATE partman.part_config SET retention='30 days', retention_keep_table=false
WHERE parent_table='public.integration_deliveries';
```

### 3.3 Migration plan

The next sequential migration is `0053_integrations_framework.sql` (verified against `packages/db/drizzle/migrations` — last applied was `0052_aggregate_type_funnel.sql`). Single migration creates both tables, indexes, the partman parent registration, and the initial partitions. Add `AGGREGATE_TO_TOPIC` entries are unchanged; we reuse `rovenue.revenue` + `rovenue.billing`.

No backfill of historical rows on migration apply — the 7-day automatic backfill described in §6.5 runs only when a connection is *activated*.

## 4. Provider interface

```ts
// apps/api/src/services/integrations/types.ts
export type ProviderId = "META_CAPI" | "TIKTOK_EVENTS";

export type RovenueEventType =
  | "revenue.event.recorded"
  | "subscription.trial.started"
  | "subscriber.identified";

export type RevenueEventKind =
  | "INITIAL" | "TRIAL_CONVERSION" | "RENEWAL"
  | "CREDIT_PURCHASE" | "REFUND" | "CANCELLATION";

export interface IdentityContext {
  email?: string; phone?: string; externalId?: string;
  ip?: string; userAgent?: string;
  fbp?: string; fbc?: string;
  ttclid?: string; ttp?: string;
}

export interface RovenueEventEnvelope {
  outboxEventId: string;
  projectId: string;
  eventType: RovenueEventType;
  occurredAt: string;            // ISO-8601
  revenueEventKind?: RevenueEventKind;
  amount?: string;               // original currency, decimal(12,4)
  currency?: string;             // ISO-4217
  subscriberId?: string;
  productId?: string;
  identityContext?: IdentityContext;
  eventSourceUrl?: string;       // optional, for website action_source
}

export interface ConnectionConfig {
  connectionId: string;
  projectId: string;
  enabledEvents: string[];                 // mapping keys
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode?: string;
}

export type ProviderPayload = {
  eventKey: string;
  providerEvent: string;
  body: unknown;                 // JSON-serializable
};

export type MapEventResult =
  | ProviderPayload
  | { skip: true; reason: "no_mapping" | "filtered_by_event_scope" | "no_user_data" };

export interface DeliveryResult {
  ok: boolean;
  httpStatus: number;
  responseBody: string;          // truncated to 4096 by caller
  errorMessage?: string;
  retriable: boolean;            // false → dead_letter immediately
}

export interface IntegrationProvider {
  id: ProviderId;
  defaultEventMapping: Record<string, string>;
  validateCredentials(
    creds: unknown,
    http: HttpClient
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  mapEvent(envelope: RovenueEventEnvelope, config: ConnectionConfig): MapEventResult;
  deliver(
    payload: ProviderPayload,
    creds: unknown,
    http: HttpClient
  ): Promise<DeliveryResult>;
}
```

Registry (`apps/api/src/services/integrations/registry.ts`):

```ts
export const PROVIDERS: Record<ProviderId, IntegrationProvider> = {
  META_CAPI: metaCapiProvider,
  TIKTOK_EVENTS: tiktokEventsProvider,
};
```

Shared hashing helper at `apps/api/src/services/integrations/hash.ts`:

```ts
export function hashPii(input: string): string {
  return crypto.createHash("sha256")
    .update(input.trim().toLowerCase(), "utf8")
    .digest("hex");
}
```

Providers are plain stateless objects (not classes) so unit tests can pass an `undici` MockAgent-backed `HttpClient` without DI plumbing.

## 5. Event mapping

### 5.1 Default mapping table

Mapping key format: `revenue.<KIND>` for revenue events; `<topic>` for trial/identity events.

| Mapping key                    | Rovenue source                                              | Meta event_name        | TikTok event         |
|--------------------------------|-------------------------------------------------------------|------------------------|----------------------|
| `revenue.INITIAL`              | `revenue.event.recorded` + `kind=INITIAL`                   | `Subscribe`            | `Subscribe`          |
| `revenue.TRIAL_CONVERSION`     | `revenue.event.recorded` + `kind=TRIAL_CONVERSION`          | `Subscribe`            | `Subscribe`          |
| `revenue.RENEWAL`              | `revenue.event.recorded` + `kind=RENEWAL`                   | `Purchase`             | `Subscribe`          |
| `revenue.CREDIT_PURCHASE`      | `revenue.event.recorded` + `kind=CREDIT_PURCHASE`           | `Purchase`             | `CompletePayment`    |
| `revenue.REFUND`               | `revenue.event.recorded` + `kind=REFUND`                    | skip                   | skip                 |
| `revenue.CANCELLATION`         | `revenue.event.recorded` + `kind=CANCELLATION`              | skip                   | skip                 |
| `subscription.trial.started`   | `subscription.trial.started`                                | `StartTrial`           | `StartTrial`         |
| `subscriber.identified`        | `subscriber.identified`                                     | `CompleteRegistration` | `CompleteRegistration` |

Event names follow Meta CAPI Conversions API canonical event names and TikTok Events API v1.3 server-event names.

### 5.2 Override semantics

`event_mapping` jsonb shape: `{ "<mapping key>": { eventName?: string } | { skip: true } }`. Merge precedence (lowest → highest):
1. Provider `defaultEventMapping`.
2. Stored `event_mapping` overrides.
3. The `enabled_events` filter — keys not present here resolve to `skip: true, reason: "filtered_by_event_scope"`.

A `mapEvent` skip therefore has three possible reasons:
- `no_mapping` — no default and no override defines this key (e.g., a future event type).
- `filtered_by_event_scope` — the key is not in `enabled_events`.
- `no_user_data` — `identityContext` is empty or missing every field the provider can match on (Meta requires at least one `user_data.*` matching field; TikTok similarly).

### 5.3 Per-provider payload shape

Meta CAPI (`POST https://graph.facebook.com/v18.0/{pixel_id}/events?access_token=...`):

```json
{
  "data": [{
    "event_name": "Subscribe",
    "event_time": 1716800000,
    "event_id": "<outbox_event.id>",
    "action_source": "app",
    "event_source_url": "https://app.example.com/billing",
    "user_data": {
      "em": ["<sha256(email)>"],
      "ph": ["<sha256(phone)>"],
      "external_id": ["<sha256(externalId)>"],
      "client_ip_address": "1.2.3.4",
      "client_user_agent": "Mozilla/5.0 ...",
      "fbp": "fb.1.<ts>.<rand>",
      "fbc": "fb.1.<ts>.<click>"
    },
    "custom_data": { "currency": "USD", "value": 9.99 }
  }],
  "test_event_code": "TEST12345"
}
```

TikTok Events v1.3 (`POST https://business-api.tiktok.com/open_api/v1.3/event/track/`):

```json
{
  "event_source": "web",
  "event_source_id": "<pixel_code>",
  "data": [{
    "event": "Subscribe",
    "event_time": 1716800000,
    "event_id": "<outbox_event.id>",
    "user": {
      "email": "<sha256(email)>",
      "phone": "<sha256(phone)>",
      "external_id": "<sha256(externalId)>",
      "ip": "1.2.3.4",
      "user_agent": "Mozilla/5.0 ...",
      "ttclid": "...",
      "ttp": "..."
    },
    "properties": { "currency": "USD", "value": 9.99 }
  }],
  "test_event_code": "TEST12345"
}
```

Currency: `revenue_events.amount` is sent in its original currency; we do not convert to USD. Meta auto-converts at the platform level; TikTok logs raw.

### 5.4 PII handling — identityContext + hashing rules

`identityContext` is supplied by the SDK on a per-event basis; it is never written to a Rovenue table. The worker hashes-or-not according to provider spec:

| Field        | Meta CAPI      | TikTok Events v1.3 |
|--------------|----------------|--------------------|
| `email`      | SHA-256 (`em`) | SHA-256 (`user.email`) |
| `phone`      | SHA-256 (`ph`) | SHA-256 (`user.phone`) |
| `externalId` | SHA-256 (`external_id`) | SHA-256 (`user.external_id`) |
| `ip`         | raw (`client_ip_address`) | raw (`user.ip`) |
| `userAgent`  | raw (`client_user_agent`) | raw (`user.user_agent`) |
| `fbp` / `fbc`| raw            | n/a                |
| `ttclid` / `ttp` | n/a        | raw                |

`hashPii(value)` performs `value.trim().toLowerCase()` then SHA-256 hex. Empty / undefined fields are dropped from the payload entirely rather than sent as empty strings (TikTok 400s on empty strings in `user.*`).

## 6. Dispatch path

### 6.1 Kafka fanout consumer

File: `apps/api/src/services/integrations-fanout/consumer.ts`. Consumer group: `rovenue-integrations-fanout`. Subscribes `rovenue.revenue` + `rovenue.billing`. For each message:
1. Parse the outbox envelope (the same shape the outbox dispatcher already publishes).
2. Look up enabled connections for `projectId` from `integration_connections WHERE project_id=? AND is_enabled=true`, cached in-process for 60 seconds keyed by projectId. Cache is invalidated synchronously on PATCH/DELETE in the dashboard routes (§7.2) via an in-process `EventEmitter`, and otherwise expires by TTL.
3. For each (connection, message), enqueue a BullMQ job into `rovenue-integrations-deliver` with `jobId = ${connectionId}:${outboxEventId}` — BullMQ rejects duplicates at the queue layer.

Boot wiring: add `startIntegrationsFanout()` to `apps/api/src/index.ts` next to the existing outbox-dispatcher start.

### 6.2 BullMQ deliver worker

File: `apps/api/src/workers/integrations-deliver.ts`. Queue: `rovenue-integrations-deliver`, concurrency 16. Per-job steps:
1. Load the `integration_connections` row; if not enabled or deleted, return (job becomes a no-op).
2. `decrypt(credentials_cipher)` via `packages/shared/src/crypto.ts`.
3. `provider.mapEvent(envelope, config)`. If skip → INSERT `integration_deliveries` with `status='skipped'` and `skip_reason`, then return.
4. INSERT pending row `(connection_id, outbox_event_id, status='pending', attempt=<n>)`. On UNIQUE conflict, SELECT the existing row: if its `status='succeeded'`, return (replay no-op); otherwise update `attempt` and continue.
5. `provider.deliver(payload, creds, http)`.
6. UPDATE the row: `status='succeeded' | 'failed' | 'dead_letter'`, `http_status`, `response_body` (truncated to 4096 bytes), `error_message`.
7. On `dead_letter` (either non-retriable result or attempts exhausted): write an audit row (`integration.delivery.dead_letter`) and publish through the existing outbox-notification pipeline so on-call gets the same Sentry/Slack treatment as Stripe webhook failures.

Boot wiring: add `ensureIntegrationsDeliverWorker()` next to the existing `ensureWebhookDeliveryWorker()` in `apps/api/src/index.ts`.

### 6.3 Idempotency & replay

Two layers:
- **BullMQ jobId dedup** — `${connectionId}:${outboxEventId}`. Prevents two queue inserts from the fanout consumer re-firing the same job within BullMQ's job retention window.
- **DB UNIQUE `(connection_id, outbox_event_id, created_at)`** — survives queue eviction, dispatcher restarts, and consumer re-balance replays. A conflict whose existing row is `succeeded` becomes a no-op; any other status moves to attempt+1.

The Meta `event_id` and TikTok `event_id` are both set to `outboxEventId`, giving us platform-level dedup as well (Meta 7d, TikTok 14d windows).

### 6.4 Retry & dead-letter

Backoff: exponential `[30s, 2m, 10m, 1h, 6h]` with ±10% jitter, `attempts: 5`. A `DeliveryResult.retriable=false` (e.g., 401 invalid token, 403 disabled pixel, 400 schema error) short-circuits to `dead_letter` immediately, regardless of attempt count. HTTP 429 and 5xx are always `retriable=true`.

### 6.5 Backfill on activation

When a PATCH transitions `is_enabled` `false → true`:
1. Set `last_backfill_at = now()`.
2. Enqueue a single `integrations.backfill` BullMQ job (in the same queue at lower priority) that streams:
   ```sql
   SELECT id, aggregate_type, payload, created_at
   FROM outbox_events
   WHERE project_id = $1
     AND created_at > now() - INTERVAL '7 days'
     AND aggregate_type IN ('revenue', 'billing')
   ORDER BY created_at ASC
   ```
3. For each row, push a `rovenue-integrations-deliver` job with the same `${connectionId}:${outboxEventId}` jobId format. Re-activation within 7d collides on those jobIds and on the DB UNIQUE, so re-activation is a safe no-op.
4. Audit `integration.connection.updated` with metadata `{ backfillWindowDays: 7 }`.

**Dedup-window note.** Meta's dedup window is 7d (perfect fit). TikTok's is 14d, so backfilling 7d is also safe there. If a future M2 change extends the backfill window beyond 14d, TikTok will accept duplicate conversions for events older than 14d — gate any such change on M2 work.

## 7. Dashboard UX

### 7.1 IntegrationDrawer flow

Pattern: a base-ui `Dialog` rendered as a 520px right-side slide-over, mirroring `apps/dashboard/src/components/products/product-drawer.tsx` (NOT a modal). Component: `apps/dashboard/src/components/integrations/integration-drawer.tsx`.

5-step state machine:
1. **Credentials** — provider-specific form (Meta: `pixel_id`, `access_token`; TikTok: `pixel_code`, `access_token`). On submit calls `POST /validate`.
2. **Event scope** — checkbox list keyed by mapping keys from §5.1; defaults all on.
3. **Overrides** — collapsed accordion exposing per-key `eventName` text input + `skip` checkbox.
4. **Test event** — button that posts a synthetic envelope using `test_event_code`; result rendered as success/failure with raw response body.
5. **Activate** — flips `is_enabled=true`, triggers backfill (§6.5).

### 7.2 API routes

File: `apps/api/src/routes/dashboard/integrations.ts`. All routes gated by `requireDashboardAuth` + `assertProjectAccess(..., MemberRole.CUSTOMER_SUPPORT)`.

| Method | Path | Purpose |
|---|---|---|
| GET    | `/projects/:projectId/integrations`                              | List connections |
| POST   | `/projects/:projectId/integrations`                              | Create connection |
| PATCH  | `/projects/:projectId/integrations/:id`                          | Update (scope, overrides, action_source, enabled) |
| DELETE | `/projects/:projectId/integrations/:id`                          | Hard-delete (cascade) |
| POST   | `/projects/:projectId/integrations/validate`                     | Pre-save dry-run (no DB write) |
| POST   | `/projects/:projectId/integrations/:id/test-event`               | Sends a synthetic event using `test_event_code` |
| GET    | `/projects/:projectId/integrations/:id/deliveries`               | Paginated by `?cursor=` + optional `?status=` filter |

Mount in `apps/api/src/routes/dashboard/index.ts` next to existing namespaces.

### 7.3 AppCard overlay extension

Extend `AppConnectionRow` in `packages/shared/src/dashboard.ts` with `errorReason?: string`. Extend `readAppConnections()` in the dashboard data layer to derive Meta-CAPI and TikTok-Events rows from `integration_connections` + `integration_deliveries`:

- **active** — `is_enabled=true` AND `last_validated_at > now() - 24h` AND no `dead_letter` row in the last hour.
- **error** — any `dead_letter` row in the last hour (or `last_error` is set and recent).
- **available** — otherwise (i.e., no connection or disabled).

`account` field surfaces `credentials_hint` (e.g., `"Pixel 1234…5678"`); `lastSyncLabel` is the human-relative age of the most recent `succeeded` delivery row.

## 8. Audit & observability

### 8.1 Audit actions & redaction

Add to the union in `apps/api/src/lib/audit.ts`:
- New `AuditAction` literals: `integration.connection.created`, `integration.connection.updated`, `integration.connection.deleted`, `integration.credentials.rotated`, `integration.delivery.dead_letter`.
- New `AuditResource` literal: `integration_connection`.

Successful deliveries are **not** audited (volume). Credential snapshots in audit diffs flow through the existing `redactCredentials()` so the row stores opaque `{access_token: "[REDACTED]"}`.

### 8.2 Structured logging events

Emit (via the existing pino logger) on the worker:
- `integrations.delivery.attempt` — `{connectionId, providerId, outboxEventId, attempt, eventKey}`.
- `integrations.delivery.result` — `{connectionId, providerId, outboxEventId, attempt, eventKey, status, httpStatus, durationMs}`.
- `integrations.delivery.dead_letter` — same fields plus `errorMessage`; also writes a Sentry breadcrumb through `sentry-notifications`.

Field names are stable across §6, §7 logs, and §8 dashboards.

### 8.3 Live Events stream extension

Worker publishes `{ kind: "integration_delivery", connectionId, providerId, status, eventKey, occurredAt }` to the existing `LIVE_EVENTS_CHANNEL_PREFIX` Redis pub/sub channel (best-effort, fire-and-forget). Dashboard live-events tile renders a new row type with provider icon.

## 9. Security considerations

- **Encryption.** M1 uses the global `ENCRYPTION_KEY` via `encrypt()/decrypt()` in `packages/shared/src/crypto.ts`. Decryption happens once per job in the worker; the cleartext token does not leave the process.
- **PII handling.** No `identityContext` field is ever persisted by the API. SDK consent capture is the host app's responsibility; we document this explicitly in the SDK README and TypeScript JSDoc on the new `identityContext` field. `integration_deliveries.response_body` is truncated to 4096 bytes to keep ad-platform echoes (which sometimes include hashed PII) from accumulating warehouse-wide.
- **Token rotation.** Operators rotate by submitting new credentials through the drawer; the PATCH writes a new ciphertext and emits `integration.credentials.rotated`. No grace period — the next worker job uses the new token.
- **Rate-limit hygiene.** Meta CAPI 100k/h and TikTok 60/s are not enforced in M1; provider 429s are simply marked `retriable=true` and back off through the BullMQ schedule.
- **Known M2 follow-ups.**
  - Per-project KEKs — ad-platform tokens have elevated blast radius (ad spend, audience access) and warrant project-scoped key wrapping.
  - Per-event `action_source` override (currently connection-level).
  - In-process rate-limit shaping per provider.

## 10. Testing strategy

### 10.1 Unit (vitest, colocated `*.test.ts`)
- `apps/api/src/services/integrations/providers/meta-capi.test.ts` — table-driven `mapEvent` over every (RovenueEventType × RevenueEventKind) combination including skip cases; `validateCredentials` mocked via `undici` MockAgent.
- `apps/api/src/services/integrations/providers/tiktok-events.test.ts` — symmetric.
- `apps/api/src/services/integrations/hash.test.ts` — SHA-256 lowercase / trim invariants, empty-string and undefined handling.
- `apps/api/src/services/integrations/event-mapping.test.ts` — override merge precedence (defaults → stored overrides → enabled_events filter).

### 10.2 Integration (testcontainers, `*.integration.test.ts`)
- `apps/api/src/workers/integrations-deliver.integration.test.ts` — outbox → Kafka → fanout → BullMQ → mock provider (undici MockAgent) → assert `integration_deliveries` row + that the success path did **not** emit an audit row; idempotency test (same `outbox_event.id` twice); dead-letter test (401 → `retriable=false`); replay test (dispatcher restart → at-least-once → DB UNIQUE conflict no-op).
- `apps/api/src/routes/dashboard/integrations.integration.test.ts` — CRUD round-trip; asserts AES-GCM ciphertext shape on disk; asserts `audit_logs` row with `redactCredentials` snapshot; validates `enabled_events` and `event_mapping` shapes.

### 10.3 Manual QA
- Drawer Step 4 `test_event_code` shows up in Meta Events Manager → Test Events and TikTok Events Manager → Diagnostics with the expected `event_id` and `event_name`.
- Toggle disable → re-enable triggers a visible burst of 7-day backfill jobs in BullMQ UI.

## 11. Rollout plan

**Scope assessment.** This spec is intentionally focused on a single delivery boundary (outbound Meta + TikTok). It is sized for **one implementation plan** with sequential phases inside it. No decomposition is required.

### M1 (this spec)
- Migration `0053_integrations_framework.sql` (tables, partman, indexes).
- `apps/api/src/services/integrations/` — types, registry, hash, providers (meta-capi, tiktok-events), event-mapping merger.
- `apps/api/src/services/integrations-fanout/consumer.ts` + boot wiring.
- `apps/api/src/workers/integrations-deliver.ts` + boot wiring.
- `apps/api/src/routes/dashboard/integrations.ts` — 7 routes mounted in the dashboard namespace.
- `apps/dashboard/src/components/integrations/integration-drawer.tsx` + AppCard overlay wiring through extended `AppConnectionRow`.
- 7-day backfill on activation.
- Audit-action additions + sentry-notifications + live-events hooks.
- Unit + integration test suites listed in §10.
- SDK: add `identityContext` to the React Native event payload (and propagate through Rust core envelope if it touches encoded shape).

### M2 (follow-ups, explicitly out of scope)
- BullMQ rate-limit enforcement per provider.
- ClickHouse mirror of `integration_deliveries` for cross-project analytics.
- Per-event `action_source` override.
- Per-project KEKs for ad-platform tokens.
- Ad-spend ingestion (inbound) from Meta Marketing API and TikTok Reporting API.
- Audience sync (Meta Custom Audiences, TikTok Audience API).
- Additional providers: Google Ads, Snap, Reddit.

## 12. Open risks

- **SDK envelope schema is cross-cutting.** The new `identityContext` field must land in:
  - `packages/sdk-rn` event payload types,
  - the `librovenue` Rust core envelope (if it serializes user-supplied event metadata),
  - the API ingest validator that accepts events from SDK clients.
  Coordinate with the SDK owner before merging M1 — the RN façade and Rust core ship from different release trains.
- **`pg_partman` parent-table setup.** `integration_deliveries` is the third pg_partman parent (after `revenue_events` and `credit_ledger`); the migration must invoke `create_parent` with `p_premake=7` and tune `retention=30 days` in the same transaction or risk an unmanaged parent in production.
- **Cache invalidation on `is_enabled` flip.** The 60-second in-process connection cache in the fanout consumer is invalidated synchronously on dashboard PATCH/DELETE — but if the API has multiple replicas, cross-replica invalidation depends on the existing pub/sub channel. Verify the existing pattern used by webhook-delivery / outbox-dispatcher reaches all replicas; otherwise enabled connections can lag by up to 60s on replicas that didn't serve the PATCH.
- **Backfill burst.** A project with high event volume that activates a connection enqueues up to 7d of events at once. Worker concurrency is 16 — this is normally fine, but it shares the BullMQ queue with realtime deliveries. Backfill jobs are enqueued at lower priority; verify BullMQ priority ordering on the production Redis settings before enabling backfill for the largest projects.
- **Deliverability monitoring is log-based until M2.** No dashboard tile aggregates dead-letter counts; on-call sees them through Sentry. If volume grows, plan the M2 ClickHouse mirror sooner.
- **Audit row for dead-letter.** `integration.delivery.dead_letter` audit rows are written per failure — for a misconfigured connection this can produce a burst of rows. Throttle by deduping within a 1-minute window per connection if observed in production.

## 13. Appendix — files to create/modify

### New files
- `packages/db/drizzle/migrations/0053_integrations_framework.sql`
- `packages/db/src/drizzle/schema/integration-connections.ts`
- `packages/db/src/drizzle/schema/integration-deliveries.ts`
- `packages/db/src/drizzle/repositories/integration-connections.ts`
- `packages/db/src/drizzle/repositories/integration-deliveries.ts`
- `apps/api/src/services/integrations/types.ts`
- `apps/api/src/services/integrations/registry.ts`
- `apps/api/src/services/integrations/hash.ts`
- `apps/api/src/services/integrations/event-mapping.ts`
- `apps/api/src/services/integrations/providers/meta-capi.ts`
- `apps/api/src/services/integrations/providers/tiktok-events.ts`
- `apps/api/src/services/integrations-fanout/consumer.ts`
- `apps/api/src/workers/integrations-deliver.ts`
- `apps/api/src/routes/dashboard/integrations.ts`
- `apps/dashboard/src/components/integrations/integration-drawer.tsx`
- Test files listed in §10.1 and §10.2.

### Modified files
- `apps/api/src/index.ts` — boot wiring for fanout consumer + deliver worker.
- `apps/api/src/routes/dashboard/index.ts` — mount integrations router.
- `apps/api/src/lib/audit.ts` — extend `AuditAction` + `AuditResource` unions.
- `packages/shared/src/dashboard.ts` — add `errorReason?: string` to `AppConnectionRow`; extend `readAppConnections()` derivation.
- `packages/db/src/drizzle/schema/index.ts` — barrel re-export for new tables.
- `packages/sdk-rn/src/events.ts` (or equivalent) — add `identityContext` to event payload type.
- `apps/docs/` — operator-facing page documenting credential setup + consent responsibility.
