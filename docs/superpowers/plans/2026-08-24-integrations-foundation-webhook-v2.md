# Integrations Foundation + Outbound Webhook v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the integrations framework provider-scalable, fix its 6 flaky tests, and ship Svix-parity outbound webhooks as a `CUSTOM_WEBHOOK` provider on the existing fanout → deliver pipeline.

**Architecture:** Webhook v2 is NOT a second webhook stack — it is one more `IntegrationProvider` in the registry, riding outbox → Kafka → `integrations-fanout` consumer → BullMQ `integrations-deliver` worker. The registry becomes declarative (topics, event catalog, retry policy, credentials schema) so Wave-1 providers need zero schema work. Subscription lifecycle events that today only reach v1 webhooks get bridged into the outbox on a new `rovenue.subscription` topic.

**Tech Stack:** Hono, Drizzle/Postgres (pg_partman partitioned deliveries), KafkaJS, BullMQ/Redis, undici, Zod, Vitest, React/TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-24-integrations-foundation-webhook-v2-design.md`

## Global Constraints

- **NEVER create or switch branches.** Commit on whatever HEAD is checked out. This applies to every subagent too — say it in every subagent brief.
- Conventional commits. TypeScript strict. API responses `{ data: T }` via `ok()` or `{ error: { code, message } }`. Zod for all input.
- **No magic values:** every threshold, timeout, byte length, cap → named exported constant.
- **No self-confirming tests:** integration claims run against real Postgres/Redis (ports 5433/6380 via docker-compose; run `docker ps` first — vitest HANGS if Docker is down). Never test a signature against the same code that produced it — verify against `verifySvixSignature` AND the `svix` npm verifier.
- Postgres via Drizzle repositories; raw `sql` only when necessary, with qualified `"table"."col"` columns.
- New migration ⇒ afterwards run `psql postgresql://rovenue:rovenue@localhost:5433/postgres -c 'DROP DATABASE IF EXISTS rovenue_test_tpl WITH (FORCE)'` so the test template rebuilds.
- The registry (`apps/api/src/services/integrations/registry.ts`) is the single source of truth for providers — routes/Zod/fanout derive from it, never hardcode provider lists elsewhere.
- `apps/api` tests: do NOT set `process.env` at top of file expecting it to beat imports — `tests/setup.ts` `??=` pattern only (import hoisting).
- Between tasks, re-check `git log`/`git status` — the user sometimes lands work in parallel.

---

### Task 1: Queue-name injection — fix the 6 flaky tests

The 3 real-infra files each boot a REAL BullMQ worker on the shared queue name `rovenue-integrations-deliver` against shared Redis :6380. Vitest runs them in parallel threads; each thread has its own per-worker Postgres clone (`tests/setup.ts` repoints `DATABASE_URL`) and its own undici `MockAgent`. Worker in thread A steals thread B's jobs → processes them against A's DB and A's mocks → B's poll times out or sees the wrong status. Fix: unique queue name per test file.

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts` (WorkerOptions + Worker ctor)
- Modify: `apps/api/src/workers/integrations-deliver.integration.test.ts`
- Modify: `apps/api/src/workers/integrations-deliver.e2e.integration.test.ts`
- Modify: `apps/api/src/services/integrations/backfill.integration.test.ts`

**Interfaces:**
- Produces: `ensureIntegrationsDeliverWorker(opts?: { autoStart?: boolean; queueName?: string })` — `queueName` defaults to `INTEGRATIONS_DELIVER_QUEUE_NAME`. Production callers (`integrations-boot.ts`) unchanged.

- [ ] **Step 1: Extend WorkerOptions**

In `apps/api/src/workers/integrations-deliver.ts`:

```ts
export interface WorkerOptions {
  autoStart?: boolean;
  /** Override the BullMQ queue name — tests use a per-file unique name so
   *  parallel vitest threads' workers cannot steal each other's jobs. */
  queueName?: string;
}
```

and in `ensureIntegrationsDeliverWorker`, replace the Worker ctor's first arg:

```ts
const queueName = opts.queueName ?? INTEGRATIONS_DELIVER_QUEUE_NAME;
const worker = new Worker<IntegrationsDeliverJob>(queueName, async (bullJob) => { ... }, { ... });
```

(also use `queueName` in the two `log.info` calls that currently log `INTEGRATIONS_DELIVER_QUEUE_NAME`).

- [ ] **Step 2: Give each of the 3 test files a unique queue name**

In each file, near the top (after imports):

```ts
const TEST_QUEUE_NAME = `rovenue-integrations-deliver-test-${createId()}`;
```

Then replace every use of `INTEGRATIONS_DELIVER_QUEUE_NAME` in the file (the `new Queue(...)` ctor, and any queue the backfill deps construct) with `TEST_QUEUE_NAME`, and boot the worker with `ensureIntegrationsDeliverWorker({ autoStart: true, queueName: TEST_QUEUE_NAME })`. In `backfill.integration.test.ts` the `Queue` passed into `enqueueBackfillForConnection` deps must also use `TEST_QUEUE_NAME`.

- [ ] **Step 3: Flake gate — 5 consecutive green runs**

```bash
cd apps/api && for i in 1 2 3 4 5; do npx vitest run src/workers/integrations-deliver.integration.test.ts src/workers/integrations-deliver.e2e.integration.test.ts src/services/integrations/backfill.integration.test.ts || break; done
```

Expected: all 5 iterations green (previously: different subsets of 6 tests failed run-to-run). If a failure survives, STOP and apply superpowers:systematic-debugging — do not paper over it with retries/timeouts.

- [ ] **Step 4: Commit**

```bash
git add -A apps/api/src && git commit -m "fix(integrations): per-file queue names end cross-thread job stealing in real-infra tests"
```

---

### Task 2: Migration 0104 — provider enum → text, partial unique index, SUBSCRIPTION aggregate

**Files:**
- Create: `packages/db/drizzle/migrations/0104_integrations_provider_text.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (append idx 104 — mirror how 0102's entry looks)
- Modify: `packages/db/src/drizzle/enums.ts` (delete `integrationProvider` pgEnum; add `"SUBSCRIPTION"` to `aggregateTypeEnum`)
- Modify: `packages/db/src/drizzle/schema.ts` (`provider_id` columns → `text(...)`, new partial uidx)
- Test: `packages/db/src/drizzle/integration-connections.schema.test.ts` (update), plus new assertions

**Interfaces:**
- Produces: `integrationConnections.providerId: text` / `integrationDeliveries.providerId: text`; `aggregate_type` enum value `SUBSCRIPTION`; index `integration_connections_project_provider_uidx` now partial.

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0104_integrations_provider_text.sql
--
-- provider_id becomes text: the provider registry (app code) is the single
-- source of truth, so adding a provider must not require a migration.
-- ALTER on the partitioned integration_deliveries parent cascades to its
-- pg_partman partitions.
ALTER TABLE "integration_connections" ALTER COLUMN "provider_id" TYPE text USING "provider_id"::text;
ALTER TABLE "integration_deliveries" ALTER COLUMN "provider_id" TYPE text USING "provider_id"::text;
DROP TYPE IF EXISTS "IntegrationProvider";

-- Multi-endpoint webhooks: uniqueness stays DB-enforced for single-connection
-- providers; CUSTOM_WEBHOOK rows are exempt. Excluding soft-deleted rows also
-- fixes recreate-after-delete for every provider.
DROP INDEX IF EXISTS "integration_connections_project_provider_uidx";
CREATE UNIQUE INDEX "integration_connections_project_provider_uidx"
  ON "integration_connections" ("project_id", "provider_id")
  WHERE "provider_id" <> 'CUSTOM_WEBHOOK' AND "deleted_at" IS NULL;

-- Subscription lifecycle events get their own outbox aggregate (Task 6).
-- PG16 allows ADD VALUE inside a transaction as long as the new value is not
-- used in the same transaction — nothing in this migration uses it.
ALTER TYPE "aggregate_type" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
```

- [ ] **Step 2: Update Drizzle schema + enums**

`enums.ts`: delete the `integrationProvider` pgEnum block entirely; add `"SUBSCRIPTION"` to the `aggregateTypeEnum` values array. `schema.ts`: replace `providerId: integrationProvider("provider_id").notNull()` with `providerId: text("provider_id").notNull()` in BOTH tables (drop the `integrationProvider` import), and change the index builder to:

```ts
projectProviderUidx: uniqueIndex("integration_connections_project_provider_uidx")
  .on(t.projectId, t.providerId)
  .where(sql`provider_id <> 'CUSTOM_WEBHOOK' AND deleted_at IS NULL`),
```

- [ ] **Step 3: Append the journal entry** (copy 0102's object shape, idx 104, tag `0104_integrations_provider_text`), then drop the test template DB (Global Constraints) and run `pnpm db:migrate` against the local dev DB. Expected: applies cleanly.

- [ ] **Step 4: Write an integration test proving the partitioned ALTER + partial index**

Add to the schema test (real-PG, per-worker DB): (a) insert an `integration_deliveries` row with `providerId: "CUSTOM_WEBHOOK"` (arbitrary text now legal) — succeeds; (b) two `integration_connections` rows same project + `CUSTOM_WEBHOOK` — succeeds; (c) two rows same project + `META_CAPI`, second insert rejects with `23505`; (d) soft-delete the first META_CAPI row (`deletedAt` set), insert again — succeeds.

- [ ] **Step 5: Run `pnpm --filter @rovenue/db test`, expect green, commit**

```bash
git add -A packages/db && git commit -m "feat(db): integrations provider_id to text, partial unique index, SUBSCRIPTION aggregate (0104)"
```

---

### Task 3: Registry generalization (declarative provider capabilities)

**Files:**
- Modify: `apps/api/src/services/integrations/types.ts`, `registry.ts`, `providers/meta-capi.ts`, `providers/tiktok-events.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.ts` (Zod derives provider ids from registry)
- Test: `apps/api/src/services/integrations/registry.test.ts` (create if absent)

**Interfaces:**
- Produces (in `types.ts`):

```ts
export type FanoutTopic =
  | "rovenue.revenue"
  | "rovenue.subscription"
  | "rovenue.paywall_events"
  | "rovenue.credit";

export interface RetryPolicy {
  attempts: number;
  /** backoffMs[i] = delay before attempt i+2; last entry repeats. */
  backoffMs: readonly number[];
}

export interface IntegrationProvider {
  id: ProviderId;
  topics: readonly FanoutTopic[];
  eventCatalog: readonly RovenueEventKey[];
  allowMultipleConnections: boolean;
  credentialsSchema: z.ZodType<Record<string, string>>;
  retryPolicy?: RetryPolicy;               // undefined → DEFAULT_RETRY_POLICY
  buildCredentialsHint?(creds: ProviderCredentials): string;
  defaultEventMapping: Partial<Record<RovenueEventKey, string>>;
  validateCredentials(creds, http): Promise<{ ok: true } | { ok: false; reason: string }>;
  mapEvent(envelope, config, creds): MapEventResult;
  deliver(payload, creds, http): Promise<DeliveryResult>;
}
```

- Produces (in `registry.ts`): `providerIds(): [string, ...string[]]` (for `z.enum`), `fanoutTopics(): FanoutTopic[]` (deduped union of all providers' `topics`).

- [ ] **Step 1: Failing test** — `registry.test.ts`: `providerIds()` contains `META_CAPI` and `TIKTOK_EVENTS`; `fanoutTopics()` equals `["rovenue.revenue"]` while only the two ad providers exist; every provider has a `credentialsSchema` that rejects `{}`.

- [ ] **Step 2: Implement.** Add the fields to both existing providers: `topics: ["rovenue.revenue"]`, `eventCatalog: [...ROVENUE_EVENT_KEYS existing 8 keys the provider maps — read each provider's defaultEventMapping keys and use exactly those]`, `allowMultipleConnections: false`. `credentialsSchema`: derive the required keys from each provider's `validateCredentials`/`mapEvent` usage (read the file — Meta uses a pixel id + access token pair; mirror the exact field ids the dashboard sends, visible in the provider file and `step-credentials.tsx`), e.g. for Meta:

```ts
credentialsSchema: z.object({ pixel_id: z.string().min(1), access_token: z.string().min(1) }).passthrough(),
```

(If the actual field ids differ in the file, use the file's ids — the schema must accept exactly what the existing drawer sends today; the existing drawer flow test must stay green.)

- [ ] **Step 3: Replace hardcoded provider enums in the route.** In `routes/dashboard/integrations.ts`, `createConnectionBody.providerId` and `validateBody.providerId` become `z.enum(providerIds())`, evaluated lazily (inside the schema factory or at module init after registry import). Add `provider.credentialsSchema.safeParse(body.credentials)` validation in POST `/` and PATCH `/:id` (on the merged creds) before calling `validateCredentials`, returning the standard `VALIDATION_ERROR` envelope on failure.

- [ ] **Step 4: Run `apps/api` unit tests for integrations + the dashboard drawer flow test, expect green. Commit** `feat(integrations): declarative provider registry (topics, catalog, credentials schema)`.

---

### Task 4: Shared event-key catalog + envelope extension

**Files:**
- Modify: `packages/shared/src/integrations.ts`
- Modify: `apps/api/src/services/integrations/types.ts` (envelope), `event-mapping.ts` (only if key-derivation helper lives there — read it first)
- Test: `packages/shared/src/integrations.test.ts`

**Interfaces:**
- Produces:

```ts
export const ROVENUE_EVENT_KEYS = [
  "revenue.INITIAL", "revenue.TRIAL_CONVERSION", "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE", "revenue.REFUND", "revenue.CANCELLATION",
  "subscription.trial.started", "subscriber.identified",
  // v2 additions ↓
  "subscription.cancel_requested", "subscription.expired",
  "paywall.view", "paywall.close",
  "credit.ledger.appended",
] as const;

export type IntegrationProviderId = "META_CAPI" | "TIKTOK_EVENTS" | "CUSTOM_WEBHOOK";

export const WEBHOOK_API_VERSION = "2026-08-24";
```

- `RovenueEventEnvelope` gains two optional fields (backward compatible — existing producers/tests untouched):

```ts
export interface RovenueEventEnvelope {
  /* ...existing fields unchanged... */
  /** Public event key; set by toFanoutEnvelope for non-revenue topics.
   *  Revenue events keep deriving `revenue.${revenueEventKind}` (existing path). */
  eventKey?: RovenueEventKey;
  /** Domain payload passthrough for the webhook provider's `data` field. */
  payload?: Record<string, unknown>;
}
```

- `RovenueEventType` union extends with: `"subscription.cancel_requested" | "subscription.expired" | "paywall_view" | "paywall_close" | "credit.ledger.appended"`.

- [ ] **Step 1: Failing tests** in `packages/shared`: `isRovenueEventKey("paywall.view") === true`, `isRovenueEventKey("billing.invoice.paid") === false` (internal billing events are NOT public keys), `WEBHOOK_API_VERSION` matches `/^\d{4}-\d{2}-\d{2}$/`.
- [ ] **Step 2: Implement; run `pnpm --filter @rovenue/shared test` and the `apps/api` integrations unit tests (Meta/TikTok mapping must be byte-identical — their tests are the regression net). Commit** `feat(shared): public event-key catalog v2 + envelope eventKey/payload`.

---

### Task 5: Fanout expansion — registry-driven topics, per-topic envelope mapping

**Files:**
- Modify: `apps/api/src/services/integrations-fanout/consumer.ts`
- Modify: `apps/api/src/integrations-boot.ts` (no change to call shape; verify)
- Test: `apps/api/src/services/integrations-fanout/consumer.test.ts` (extend existing unit tests)

**Interfaces:**
- `toFanoutEnvelope(parsed: unknown, topic: FanoutTopic): RovenueEventEnvelope | null` — signature gains the topic. `startIntegrationsFanout` subscribes to `fanoutTopics()` from the registry instead of the hardcoded const (keep exporting `FANOUT_TOPICS = fanoutTopics()` for logging/tests). `fromBeginning: false` stays (verify — protects deploys from replaying history into integrations).

- [ ] **Step 1: Failing unit tests** for the new mappings. Dispatcher wrapper shape is `{ eventId, eventType, aggregateId, createdAt, payload }`:
  - topic `rovenue.revenue`: existing behavior unchanged (regression assertions stay).
  - topic `rovenue.subscription`, `eventType: "subscription.cancel_requested"`, payload `{ projectId, purchaseId, subscriberId, store, requestedAt }` → envelope `{ outboxEventId: eventId, projectId, eventType: "subscription.cancel_requested", eventKey: "subscription.cancel_requested", occurredAt: requestedAt ?? createdAt, subscriberId, payload }`.
  - topic `rovenue.paywall_events`, `eventType: "paywall_view"` → `eventKey: "paywall.view"` (and `paywall_close` → `paywall.close`), `payload` passthrough, `projectId` read from the wrapper payload — **read the actual paywall outbox payload shape in `apps/api/src/routes/v1/events.ts` first and assert against its real field names.**
  - topic `rovenue.credit`, `eventType: "credit.ledger.appended"` → `eventKey: "credit.ledger.appended"`, payload passthrough (fields per `packages/db/src/drizzle/repositories/credit-ledger.ts:151`: creditLedgerId, projectId, subscriberId, currencyId, type, amount, balance, referenceType, referenceId).
  - any topic, unknown eventType → `null`.
- [ ] **Step 2: Implement.** Switch on `topic` first, then eventType. Revenue branch = current code verbatim. `rovenue.billing` must NOT be in any provider's topics (it carries Rovenue-cloud's own billing — `billing.invoice.paid`, `billing.usage_lock.*` — never forward it to customer integrations; leave a comment saying exactly that).
- [ ] **Step 3: Run the fanout unit tests, expect green. Commit** `feat(integrations): registry-driven fanout topics with per-topic envelope mapping`.

---

### Task 6: SUBSCRIPTION outbox bridge (lifecycle events reach v2)

Subscription lifecycle events today go straight into the v1 `outgoing_webhooks` table and never touch the outbox. Bridge them: wherever `enqueueOutgoingWebhook` is called, also insert an outbox row in the SAME transaction. v1 keeps working unchanged.

**Files:**
- Modify: `apps/api/src/workers/outbox-dispatcher.ts` (`AGGREGATE_TO_TOPIC` gains `SUBSCRIPTION: "rovenue.subscription"`)
- Modify: `apps/api/src/workers/scheduled-actions.ts`, `apps/api/src/workers/expiry-checker.ts`, `apps/api/src/services/webhook-processor.ts` — every `enqueueOutgoingWebhook(...)` call site
- Test: extend the nearest existing integration test of each site (they exist for all three files — find them by filename)

**Interfaces:**
- Consumes: `drizzle.outboxRepo.insert(tx, { aggregateType, aggregateId, eventType, payload })` (same helper `emitNotification` uses).

- [ ] **Step 1: Add the topic mapping** in `AGGREGATE_TO_TOPIC`: `SUBSCRIPTION: "rovenue.subscription"`. The dispatcher's `assertTopic()` startup provisioning covers the new topic automatically — verify by reading that function, don't assume.
- [ ] **Step 2: Bridge each site.** Pattern, shown for `scheduled-actions.ts:235` (repeat 1:1 at every `enqueueOutgoingWebhook` call in the three files, using THAT site's eventType and payload, inside the same `tx`):

```ts
await drizzle.outboxRepo.insert(tx, {
  aggregateType: "SUBSCRIPTION",
  aggregateId: purchase.subscriberId,
  eventType: "subscription.cancel_requested",
  payload: {
    projectId: purchase.projectId,
    purchaseId: purchase.id,
    subscriberId: purchase.subscriberId,
    store,
    requestedAt: now.toISOString(),
  },
});
```

The outbox insert is NOT conditional on `webhookUrl` (v1's guard) — v2 subscribers must receive the event even when no v1 URL is configured. `payload.projectId` is mandatory (fanout drops envelopes without it). If `webhook-processor.ts` emits event types beyond `subscription.*`, add each to `ROVENUE_EVENT_KEYS` (Task 4 file) and to the webhook provider catalog (Task 7) — the catalog must equal what actually flows.
- [ ] **Step 3: Extend the sites' existing integration tests**: after the action runs, assert an `outbox_events` row with `aggregateType = 'SUBSCRIPTION'` and the expected eventType/payload exists (query real PG — no mocked tx).
- [ ] **Step 4: Run those integration test files, expect green. Commit** `feat(outbox): bridge subscription lifecycle events onto rovenue.subscription`.

---

### Task 7: Svix signing + SSRF guard + CUSTOM_WEBHOOK provider

**Files:**
- Create: `apps/api/src/lib/svix-sign.ts` + `svix-sign.test.ts`
- Create: `apps/api/src/lib/ssrf-guard.ts` + `ssrf-guard.test.ts`
- Create: `apps/api/src/services/integrations/providers/custom-webhook.ts` + `custom-webhook.test.ts`
- Modify: `apps/api/src/services/integrations/registry.ts` (register), `apps/api/package.json` (devDependency `svix` — tests only)

**Interfaces:**
- Produces (`svix-sign.ts`):

```ts
export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SECRET_BYTES = 24;
export function generateWebhookSecret(): string; // whsec_ + base64(randomBytes(24))
export function signWebhook(input: {
  id: string; timestampSec: number; body: string; secretKeys: string[];
}): string; // "v1,<b64> v1,<b64>" — one per active secret, space-separated (Svix multi-sig)
```

- Produces (`ssrf-guard.ts`):

```ts
export class WebhookUrlError extends Error { constructor(public reason: string) { super(reason); } }
export function assertPublicWebhookUrl(raw: string): URL;      // sync: scheme/userinfo/IP-literal checks
export async function resolvePinnedAddress(url: URL): Promise<string>; // DNS → all addrs public → returns one
export function createPinnedHttpClient(pinnedIp: string): HttpClient;  // undici Agent, custom lookup → pinnedIp, maxRedirections: 0
```

- Produces (`custom-webhook.ts`): `customWebhookProvider: IntegrationProvider` with `id: "CUSTOM_WEBHOOK"`, `topics: ["rovenue.revenue", "rovenue.subscription", "rovenue.paywall_events", "rovenue.credit"]`, `eventCatalog: ROVENUE_EVENT_KEYS` (all public keys), `allowMultipleConnections: true`, `retryPolicy: WEBHOOK_RETRY_POLICY` (Task 9), and:

```ts
/** Stored (encrypted) credentials. ProviderCredentials is Record<string,string>,
 *  so the secrets array is a JSON-encoded string under the "secrets" key. */
export interface WebhookSecretEntry { id: string; key: string; createdAt: string }
export function parseWebhookCredentials(creds: ProviderCredentials): { url: string; secrets: WebhookSecretEntry[] };
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 15_000;
```

- [ ] **Step 1: svix-sign failing tests, THEN implement.** Golden tests: (a) round-trip — `signWebhook` output passes `verifySvixSignature` (import from `../lib/svix-signature`) for the same id/timestamp/body/secret; (b) cross-check against the independent implementation — `new (require("svix").Webhook)(secret).verify(body, { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sig })` does not throw (add `svix` as devDependency); (c) two active secrets → header contains two space-separated `v1,` parts and verifies under EITHER secret; (d) tampered body fails both verifiers. Implementation mirrors `svix-signature.ts`'s documented scheme: `base64(HMAC-SHA256(base64decode(key-without-prefix), "${id}.${timestampSec}.${body}"))`.

- [ ] **Step 2: ssrf-guard failing tests, THEN implement.** Matrix test for `assertPublicWebhookUrl`: rejects `http://` when `NODE_ENV === "production"` (accepts otherwise — local dev), rejects `ftp://`, credentials-in-URL (`https://u:p@host/`), and IP-literal hosts in: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, plus `localhost`. Accepts `https://example.com/hook`. `resolvePinnedAddress`: inject the resolver (`deps: { lookup }`) — a hostname resolving to `[203.0.113.7, 10.0.0.5]` REJECTS (any private addr poisons the set: DNS-rebinding defence), all-public resolves to the first address. Blocked ranges live in one named const table `BLOCKED_CIDRS`, not inline literals. `createPinnedHttpClient` builds an undici `Agent` whose `connect.lookup` callback always returns the pinned IP (TLS SNI/Host header still carry the original hostname because the URL is unchanged), sets `maxRedirections: 0`, `headersTimeout`/`bodyTimeout` = `WEBHOOK_DELIVERY_TIMEOUT_MS`.

- [ ] **Step 3: custom-webhook provider failing tests, THEN implement.**
  - `mapEvent`: derive the event key — revenue envelopes → `` `revenue.${envelope.revenueEventKind}` `` (reuse the existing derivation used by meta-capi — read `event-mapping.ts` and share the helper, don't duplicate), other envelopes → `envelope.eventKey`. Not in `config.enabledEvents` → `{ skip: true, reason: "filtered_by_event_scope" }`. Otherwise:

```ts
const body = JSON.stringify({
  id: envelope.outboxEventId,
  type: eventKey,
  created: envelope.occurredAt,
  apiVersion: WEBHOOK_API_VERSION,
  projectId: envelope.projectId,
  data: buildWebhookData(envelope), // envelope minus identityContext PII:
  // revenue events → { kind, amount, currency, subscriberId, productId,
  //                    externalId: identityContext?.externalId }
  // other events   → envelope.payload ?? {}
});
return { eventKey, providerEvent: eventKey, body };
```

  - `deliver`: `parseWebhookCredentials` → `assertPublicWebhookUrl(url)` → `resolvePinnedAddress` → POST via `createPinnedHttpClient(pinned)` with headers `content-type: application/json`, `webhook-id`, `webhook-timestamp`, `webhook-signature` AND the `svix-id`/`svix-timestamp`/`svix-signature` aliases (same values; Svix sends both families). Signature = `signWebhook({ id: payload.eventKey-carrying body's id — use envelope.outboxEventId, timestampSec: Math.floor(Date.now()/1000), body, secretKeys: secrets.map(s => s.key) })`. Classification (test each): 2xx → `{ ok: true, retriable: false }`; 3xx → `{ ok: false, retriable: false, errorMessage: "redirects are not followed" }`; 408/425/429 → retriable; other 4xx → non-retriable; 5xx and thrown network errors (incl. `WebhookUrlError` at send time → non-retriable with its reason) → retriable=true for 5xx/network. `responseBody` truncated to the existing 4096 cap (hoist the literal already used in the route into a shared named const `RESPONSE_BODY_MAX_BYTES` and use it in both places).
  - `validateCredentials`: no network call — `assertPublicWebhookUrl` + non-empty secrets; returns `{ ok: false, reason }` on `WebhookUrlError`.
  - `buildCredentialsHint`: `` `${new URL(url).host} · …${newestSecret.key.slice(-4)}` ``.
  - Register in `registry.ts`: `CUSTOM_WEBHOOK: customWebhookProvider`.

- [ ] **Step 4: Run the three new test files + registry test (fanoutTopics() now includes the 4 topics), expect green. Commit** `feat(integrations): CUSTOM_WEBHOOK provider with Svix-format signing and pinned-IP SSRF guard`.

---

### Task 8: Webhook connection routes — create/rotate/reveal, endpoint cap

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Test: `apps/api/src/routes/dashboard/integrations.webhook.integration.test.ts` (new, real-PG per-worker DB — follow an existing dashboard-route integration test's auth/seeding pattern)

**Interfaces:**
- Produces endpoints (all under the existing router):
  - `POST /` with `providerId: "CUSTOM_WEBHOOK"` — body credentials = `{ url }` only; response `{ data: { connection, secret } }` — `secret` returned ONLY here (create) and by rotate/reveal.
  - `POST /:id/rotate-secret` (ADMIN) → `{ data: { secret } }`
  - `GET /:id/secret` (ADMIN) → `{ data: { secret } }` — audited `integration.webhook.secret.revealed`
- Produces constants: `MAX_WEBHOOK_ENDPOINTS_PER_PROJECT = 10`, `WEBHOOK_SECRET_GRACE_MS = 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Failing integration tests**: (a) create webhook connection returns a `whsec_`-prefixed secret and the row's cipher decrypts to `{ url, secrets: "<json>" }`; (b) 11th webhook connection on one project → 409 `{ error: { code: "endpoint_limit_reached" } }`; (c) second META_CAPI connection → 409 (unique-violation mapped, not a 500); (d) rotate returns a NEW secret, old secret still present in stored `secrets` array; rotating again after faking the old entry's `createdAt` beyond `WEBHOOK_SECRET_GRACE_MS` prunes it; (e) reveal requires ADMIN (CUSTOMER_SUPPORT member gets 403) and writes an audit row.
- [ ] **Step 2: Implement create-path branching.** In POST `/`: after Zod + `credentialsSchema` parse, branch on `getProvider(id).allowMultipleConnections`:
  - multi (webhook): inside the tx — `SELECT "id" FROM "integration_connections" WHERE "project_id" = $1 AND "provider_id" = 'CUSTOM_WEBHOOK' AND "deleted_at" IS NULL FOR UPDATE`; count ≥ `MAX_WEBHOOK_ENDPOINTS_PER_PROJECT` → 409. Server generates `generateWebhookSecret()`, stores `credentials = { url: body.credentials.url, secrets: JSON.stringify([{ id: createId(), key, createdAt: now.toISOString() }]) }`, hint via provider's `buildCredentialsHint`.
  - single: current insert; catch Postgres `23505` on the partial uidx → 409 `{ error: { code: "connection_exists" } }`.
- [ ] **Step 3: Implement rotate + reveal.** Rotate: decrypt → `parseWebhookCredentials` → prepend `{ id: createId(), key: generateWebhookSecret(), createdAt: now }` → filter older entries to those within `WEBHOOK_SECRET_GRACE_MS` (always keep the new one) → re-encrypt, update hint + `lastValidatedAt`, audit `integration.webhook.secret.rotated` in the same tx, return the new key. Reveal: decrypt, return newest key, audit. Register both routes BEFORE `/:id` param routes if Hono matching requires it (mirror the existing `/validate`-before-`/:id` comment).
- [ ] **Step 4: Run the new test file, expect green. Commit** `feat(api): webhook endpoint create/rotate/reveal with per-project cap`.

---

### Task 9: Per-provider retry policy (and fix the dead backoff)

**Pre-existing bug to fix here:** jobs are enqueued (in `integrations-boot.ts` and `backfill.ts`) with `attempts: 5` but NO `backoff` option, and the worker defines `settings.backoffStrategy` — which BullMQ only consults when a job's `backoff.type === "custom"`. Net effect today: retries fire immediately; the 30s→6h schedule is dead code. Verify this by reading the enqueue sites, then fix.

**Files:**
- Modify: `apps/api/src/queues/integrations.ts`, `apps/api/src/workers/integrations-deliver.ts`, `apps/api/src/integrations-boot.ts`, `apps/api/src/services/integrations/backfill.ts`, `apps/api/src/routes/dashboard/integrations.ts` (backfill enqueue path)
- Test: `apps/api/src/queues/integrations.test.ts`, worker unit tests

**Interfaces:**
- Produces (in `queues/integrations.ts`):

```ts
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 5,
  backoffMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000],
}; // supersedes INTEGRATIONS_DELIVER_ATTEMPTS / INTEGRATIONS_DELIVER_BACKOFF_MS (delete both, fix all references)

export const WEBHOOK_RETRY_POLICY: RetryPolicy = {
  attempts: 8,
  backoffMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 43_200_000, 43_200_000],
}; // ≥24h wall-clock (Svix ~17h, RevenueCat ~1 day): 30s+2m+10m+1h+6h+12h+12h ≈ 31.7h

export function retryPolicyFor(providerId: string): RetryPolicy; // registry lookup, falls back to DEFAULT
export function deliverJobOptions(providerId: string, jobId: string): JobsOptions; // { jobId, attempts: policy.attempts, backoff: { type: "custom" }, removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } }
```

- [ ] **Step 1: Failing tests**: `retryPolicyFor("CUSTOM_WEBHOOK").attempts === 8`; `retryPolicyFor("META_CAPI")` equals DEFAULT; `deliverJobOptions(...)` includes `backoff: { type: "custom" }` (this is the assertion that pins the bug fix); sum of `WEBHOOK_RETRY_POLICY.backoffMs` ≥ `24 * 3_600_000`.
- [ ] **Step 2: Implement.** Every enqueue site (`integrations-boot.ts`, `backfill.ts`, the PATCH-route backfill queue, redeliver in Task 10) uses `deliverJobOptions(job.providerId, jobId)` — delete the inline `attempts: 5` literals. Worker: `backoffStrategy: (attempt, _type, _err, job) => { const ms = retryPolicyFor(job?.data.providerId ?? "").backoffMs; return ms[Math.min(attempt - 1, ms.length - 1)]!; }`. In `runDeliverStep`, replace both `INTEGRATIONS_DELIVER_ATTEMPTS` comparisons with a new `deps.maxAttempts: number` (wired as `retryPolicyFor(job.providerId).attempts` in the worker; update `DeliverStepDeps` and every unit test constructing it).
- [ ] **Step 3: Run integrations unit + the 3 real-infra files (their attempts semantics changed — dead-letter tests must still pass), expect green. Commit** `feat(integrations): per-provider retry policy; enqueue custom backoff (fixes immediate-retry bug)`.

---

### Task 10: Manual redeliver

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/services/integrations/backfill.ts` (export/reuse its outbox-row→envelope rebuild — read the file; it already queries `outbox_events` and builds `IntegrationsDeliverJob`s)
- Test: extend `integrations.webhook.integration.test.ts`

**Interfaces:**
- Produces: `POST /:id/deliveries/:deliveryId/redeliver` (DEVELOPER role, `endpointRateLimit({ name: "integrations-redeliver", max: 30, identify: user.id })`) → 202 `{ data: { enqueued: true } }`; 410 `{ error: { code: "event_expired" } }` when the outbox row is gone (outbox-cleanup prunes old rows — redelivery window = outbox retention, document in the route comment).
- Job id: `buildRedeliverJobId(connectionId, outboxEventId, nonce)` → `` `${connectionId}|${outboxEventId}|rd-${nonce}` `` (nonce = `createId()`), bypassing the realtime dedup id on purpose.

- [ ] **Step 1: Failing integration test**: seed a delivery row + its `outbox_events` row; POST redeliver → new `integration_deliveries` row appears (real worker or direct queue inspection — poll like the existing tests); deleting the outbox row first → 410; the deliveries query param from Task 12 not needed here.
- [ ] **Step 2: Implement** (load delivery via `drizzle.integrationDeliveryRepo`, verify `connectionId` + project ownership chain, rebuild envelope via the backfill helper, enqueue with `deliverJobOptions`). Audit `integration.delivery.redelivered` with `{ deliveryId, outboxEventId }`.
- [ ] **Step 3: Run, expect green. Commit** `feat(api): manual redeliver for integration deliveries`.

---

### Task 11: Dead-letter project notification

**Files:**
- Modify: `packages/shared/src/notifications/event-catalog.ts` (new entry; mirror `integration.webhook.failing` at line ~175)
- Modify: `apps/api/src/workers/integrations-deliver.ts` (emit in the dead-letter path)
- Test: extend the worker's dead-letter unit tests + one real-PG assertion in the M2.7 file

**Interfaces:**
- Produces catalog entry `"integration.delivery.dead_letter"`:

```ts
"integration.delivery.dead_letter": {
  key: "integration.delivery.dead_letter",
  category: "integration",
  defaultChannels: ["email", "inapp"],
  forcedChannels: [],
  defaultEnabled: true,
  recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "DEVELOPER"] },
  pushAllowed: false,
  contextSchema: z.object({
    projectId: z.string().min(1),
    projectName: z.string(),
    connectionId: z.string().min(1),
    providerId: z.string().min(1),
    displayName: z.string(),
    errorMessage: z.string().nullable(),
  }),
},
```

- [ ] **Step 1: Failing test**, **Step 2: implement** — in the worker's `auditDeadLetter` wiring (it already dedups per-connection per-minute via `recordDeadLetterAudit`), additionally call `emitNotification(db, { eventKey: "integration.delivery.dead_letter", eventId: \`dead_letter:${connectionId}:${dayBucket}\`, projectId, context })` where `dayBucket = new Date().toISOString().slice(0, 10)` — one notification per connection per day (consumer-side dedup on eventKey+eventId, same pattern as v1's `webhook.failing:` id at `webhook-delivery.ts:272`). Wrap in try/catch + `captureNotifierError` (best-effort; mirror v1's guard). Fetch `projectName`/`displayName` with one query, tolerate misses.
- [ ] **Step 3: Run worker tests + `pnpm --filter @rovenue/shared test` (catalog schema tests), expect green. Commit** `feat(integrations): dead-letter project notification`.

---

### Task 12: Dashboard — webhook card, drawer variant, redeliver UI

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts` (widen `providerId` to `"META_CAPI" | "TIKTOK_EVENTS" | "CUSTOM_WEBHOOK"` everywhere; new hooks)
- Modify: `apps/dashboard/src/components/apps/mock-data.ts` (catalog entry for the Custom Webhook card — follow the existing `RAIL_ENTRIES`/catalog descriptor shape in the file)
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-credentials-webhook.tsx` + test
- Modify: `integration-drawer.tsx` (provider-conditional steps), `step-deliveries.tsx` (redeliver button + status filter), `app-card.tsx`/`apps-section.tsx` (multi-connection list for webhook card)
- Test: extend `integration-drawer.flow.test.tsx` with a webhook-flow case; component tests per changed step

**Interfaces:**
- Produces hooks (same `api` + invalidation pattern as the file's existing mutations):

```ts
export function useRotateWebhookSecret(projectId: string) // POST .../integrations/${connectionId}/rotate-secret → { secret: string }
export function useRevealWebhookSecret(projectId: string) // GET  .../integrations/${connectionId}/secret → { secret: string }
export function useRedeliverDelivery(projectId: string, connectionId: string) // POST .../deliveries/${deliveryId}/redeliver; invalidates the deliveries infinite query
```

- Drawer: webhook flow steps = `["credentials", "events", "activate"]` (no mapping/test steps — mapping is meaningless for raw webhooks; the existing test-event endpoint still works from the card if wired later). Drive the step list from a `STEPS_BY_PROVIDER` const keyed by providerId with the current `STEPS` as default.
- `step-credentials-webhook`: URL input (client-side `https://` check mirrors server policy) → on create success, show the returned secret ONCE in a copy-to-clipboard block with the warning that it won't be shown again (reveal exists but is audited); rotate button lives on the card/drawer for existing connections.

- [ ] **Step 1: Failing component tests** (jsdom, follow the existing step tests' style): webhook drawer shows URL field not pixel fields; secret block renders after create resolves; deliveries step renders a Redeliver button per `dead_letter`/`failed` row and calls the hook; status filter select narrows the query (assert the hook is called with `status`).
- [ ] **Step 2: Implement.** Keep renderer/builder separation conventions of the codebase; no new pages. Multi-connection: when the catalog entry's providerId is `CUSTOM_WEBHOOK`, the card lists all connections for that provider (name + host hint + enabled badge) with per-row edit opening the drawer with that `existingConnection`, plus an "Add endpoint" action (disabled with a tooltip at `MAX_WEBHOOK_ENDPOINTS_PER_PROJECT` — import the constant's value via a shared const or duplicate as a named const with a comment pointing at the API one).
- [ ] **Step 3: Run `pnpm --filter @rovenue/dashboard test`, expect green. Commit** `feat(dashboard): custom webhook endpoints UI (create/rotate/redeliver/filter)`.

---

### Task 13: Docs — Outbound Webhooks page

**Files:**
- Create: `apps/docs/content/docs/integrations/outbound-webhooks.mdx` (+ register in the folder's `meta.json`)

- [ ] **Step 1: Write the page**: payload envelope (`id`, `type`, `created`, `apiVersion`, `projectId`, `data`), the full event-key catalog (hand-list the keys from `ROVENUE_EVENT_KEYS` with one-line descriptions — keep in sync note pointing at `packages/shared/src/integrations.ts`), header table (`webhook-id`/`webhook-timestamp`/`webhook-signature` + svix-\* aliases), retry schedule table from `WEBHOOK_RETRY_POLICY`, idempotency guidance (dedup on `webhook-id`; at-least-once), secret rotation semantics (24h grace, multi-signature header), and runnable verification snippets — Node (crypto HMAC, mirroring `svix-signature.ts`) and Python (hmac/hashlib). **MDX gotcha: never write bare `{{var}}` in prose — it breaks prerender; escape or use backticks.**
- [ ] **Step 2: `pnpm --filter docs build` (prerender is the test), expect green. Commit** `docs: outbound webhooks v2 guide`.

---

### Task 14: End-to-end integration tests (the money path)

**Files:**
- Create: `apps/api/src/workers/integrations-webhook.e2e.integration.test.ts` (real PG + Redis, unique queue name per Task 1, undici MockAgent is NOT used for the target — instead run a real local HTTP server on 127.0.0.1)

**Note:** the SSRF guard blocks loopback — in tests set `NODE_ENV` non-production AND add an env escape hatch ONLY if the guard blocks 127.0.0.1 outside production too; decide by reading `assertPublicWebhookUrl`: the spec allows http+private in non-prod, so implement the guard so that non-production allows loopback (that IS the dev/test story — a named const `ALLOW_PRIVATE_TARGETS = env.NODE_ENV !== "production"` gate), and assert in the ssrf-guard unit tests that production mode still blocks.

- [ ] **Step 1: Write the scenarios (failing first):**
  1. **Multi-endpoint fan-out with real signatures:** seed 2 CUSTOM_WEBHOOK connections (different local server ports, different secrets) + 1 META_CAPI connection; push one revenue envelope through `processFanoutMessage` with a real queue+worker; both local servers receive exactly one POST each; each request's headers pass `verifySvixSignature` with that endpoint's own secret; body parses to the envelope contract (`type: "revenue.RENEWAL"`, `apiVersion`, `data.amount`); 3 delivery rows total (2 webhook + 1 meta via its MockAgent), all `succeeded`.
  2. **Rotation grace:** rotate the secret via the route, deliver again — signature header carries 2 `v1,` parts; verification passes with BOTH old and new secret.
  3. **Retriable → dead_letter → notification:** local server returns 500 always; with `WEBHOOK_RETRY_POLICY` attempts exhausted (shrink via a test-only policy override? NO — use the real policy but assert the first attempt writes a `failed` row and the job is scheduled with `backoff.type === "custom"` by inspecting the BullMQ job object; full 8-attempt exhaustion is unit-tested in Task 9's `runDeliverStep` tests with injected `maxAttempts`) — then directly exercise the dead-letter path with a 401 responder and assert: `dead_letter` row + audit row + `outbox_events` NOTIFICATION row for `integration.delivery.dead_letter`.
  4. **Redeliver:** dead-lettered delivery + intact outbox row → POST redeliver → new `succeeded` row (server fixed to 200).
  5. **Paywall event end-to-end:** wrapper-shaped message on `rovenue.paywall_events` through `toFanoutEnvelope` → webhook body `type: "paywall.view"` with payload passthrough in `data`.
- [ ] **Step 2: Implement helpers, run the file 3× consecutively (it joins the flake-sensitive set), expect green. Commit** `test(integrations): webhook v2 end-to-end coverage`.

---

### Task 15: ROADMAP correction + full verification

**Files:**
- Modify: `ROADMAP.md` §6
- Modify: `docs/superpowers/specs/2026-08-24-integrations-foundation-webhook-v2-design.md` only if drift emerged during implementation (note deviations honestly)

- [ ] **Step 1: Rewrite ROADMAP §6** to reality: framework shipped (0060/0061, fanout, worker, drawer, Meta+TikTok); check off "finish the framework" and "outbound webhook v2" with a pointer to the spec; scope the remaining bullets to Wave 1/2 providers; delete the false "missing 0053" claim.
- [ ] **Step 2: Full verification (superpowers:verification-before-completion):**

```bash
docker ps   # compose stack must be up, else vitest hangs
pnpm build
cd apps/api && npx vitest run   # pass 1
VITEST_CONTAINER_PASS=1 npx vitest run   # pass 2 (container suites)
pnpm --filter @rovenue/db test && pnpm --filter @rovenue/shared test && pnpm --filter @rovenue/dashboard test
```

Expected: build green; api suite ≥ previous green count with 0 new reds AND the previously-flaky 6 green; other packages green. Paste actual counts into the commit body.
- [ ] **Step 3: Commit** `docs(roadmap): correct §6 to shipped reality; webhook v2 done` — include the verification numbers.

---

## Self-review notes (kept for executors)

- Task ordering is dependency-true: 1 (test bed) → 2 (schema) → 3/4 (types) → 5/6 (event flow) → 7 (provider) → 8/9/10/11 (API+delivery semantics) → 12/13 (UI/docs) → 14/15 (proof).
- `rovenue.billing` is deliberately NOT forwarded (Rovenue-cloud internal billing). The spec's §4.4 listed funnel/notifications topics too — descoped: funnel events are web-funnel internals, the notifications topic is notifier plumbing; neither is a RevenueCat-parity webhook event. Spec updated in Task 15 if anyone disagrees mid-flight.
- The `attempts: 5`-without-`backoff` immediate-retry bug (Task 9) is pre-existing and production-visible; do not "fix" it silently in another task — it lands with its pinning test.
