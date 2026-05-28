# Refund Shield Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the iOS refund-saver backend pipeline that responds to Apple `CONSUMPTION_REQUEST` notifications with rich consumption signals to fight unjustified refunds.

**Architecture:** Apple's `CONSUMPTION_REQUEST` webhook → new switch case in `apple-webhook.ts` enqueues a `refund_shield_responses` row → polling worker (`refund-shield-responder`) aggregates per-subscriber signals from ClickHouse + Postgres → maps to Apple's bucket scales → POSTs to Apple Server API within 12h SLA → subsequent `REFUND` / `REFUND_DECLINED_NOTIFICATION` / `REFUND_REVERSED` notifications update the row's `outcome` column for win-rate tracking.

**Tech Stack:** Hono + Drizzle + Postgres 16 + ClickHouse (Kafka Engine + MVs) + Kafka/Redpanda + Vitest + testcontainers. No new infrastructure dependencies.

**Spec:** `docs/superpowers/specs/2026-05-28-refund-shield-design.md`

**Out of scope for this plan:**
- RN SDK changes (`accountToken.ts`, `sessionTracker.ts`) — separate plan
- Dashboard UI pages — separate plan
- librovenue Rust core changes — separate repo

---

## File Inventory

**New files:**
- `packages/db/clickhouse/migrations/0009_sdk_session_events_kafka.sql`
- `packages/db/clickhouse/migrations/0010_sdk_sessions_daily.sql`
- `packages/db/clickhouse/migrations/0011_revenue_lifetime_subscriber.sql`
- `apps/api/src/services/apple/refund-shield-buckets.ts`
- `apps/api/src/services/apple/refund-shield-buckets.test.ts`
- `apps/api/src/services/apple/apple-server-api.ts`
- `apps/api/src/services/apple/apple-server-api.test.ts`
- `apps/api/src/services/refund-shield/aggregate-signals.ts`
- `apps/api/src/services/refund-shield/aggregate-signals.test.ts`
- `apps/api/src/services/refund-shield/process-response.ts`
- `apps/api/src/services/refund-shield/process-response.test.ts`
- `apps/api/src/workers/refund-shield-responder.ts`
- `apps/api/src/workers/refund-shield-responder.test.ts`
- `apps/api/src/routes/sdk/sessions.ts`
- `apps/api/src/routes/sdk/sessions.test.ts`
- `apps/api/src/routes/dashboard/refund-shield/settings.ts`
- `apps/api/src/routes/dashboard/refund-shield/responses.ts`
- `apps/api/src/routes/dashboard/refund-shield/metrics.ts`
- `apps/api/src/routes/dashboard/refund-shield/index.ts`
- `apps/api/src/routes/dashboard/refund-shield/refund-shield.test.ts`
- `apps/api/src/services/apple/apple-webhook.refund-shield.test.ts`
- `apps/api/tests/integration/refund-shield.integration.test.ts`

**Modified files:**
- `packages/db/src/drizzle/schema.ts` — add column to `subscribers`, 4 columns to `projects`, new `refundShieldResponses` table
- `apps/api/src/services/apple/apple-webhook.ts` — persist `appAccountToken` in receipt handler; add 4 new switch cases at line ~215
- `apps/api/src/routes/sdk/index.ts` (or equivalent SDK router barrel) — mount `/sessions` route
- `apps/api/src/routes/dashboard/index.ts` — mount `/refund-shield/*` routes
- `apps/api/src/app.ts` — start `refund-shield-responder` worker
- `apps/api/src/lib/metrics.ts` — add Refund Shield counters/histograms

---

## Task 1: Drizzle schema — `subscribers.apple_app_account_token`

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (subscribers table around line 362–391)
- Generated: `packages/db/drizzle/migrations/<timestamp>_subscribers_apple_app_account_token.sql`

- [ ] **Step 1.1: Add column to subscribers table definition**

Locate the `subscribers` table definition (around line 362) and add the column inside the column block:

```ts
  appleAppAccountToken: uuid("apple_app_account_token"),
```

Then add a partial unique index in the same table's index callback:

```ts
  appleTokenIdx: uniqueIndex("idx_subscribers_apple_app_account_token")
    .on(t.projectId, t.appleAppAccountToken)
    .where(sql`${t.appleAppAccountToken} IS NOT NULL`),
```

- [ ] **Step 1.2: Generate migration**

Run: `pnpm db:migrate:generate`
Expected: A new file `packages/db/drizzle/migrations/<timestamp>_*.sql` is created containing `ALTER TABLE "subscribers" ADD COLUMN "apple_app_account_token" uuid;` and the partial unique index.

Inspect the generated SQL to confirm correctness; if Drizzle's auto-naming doesn't match, rename the file but keep the SQL.

- [ ] **Step 1.3: Apply migration locally**

Run: `pnpm db:migrate`
Expected: Migration applied without error. Verify with `psql $DATABASE_URL -c "\d subscribers"` that the column exists.

- [ ] **Step 1.4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/
git commit -m "feat(db): add subscribers.apple_app_account_token for Refund Shield"
```

---

## Task 2: Drizzle schema — `projects` Refund Shield columns

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (projects table)
- Generated: `packages/db/drizzle/migrations/<timestamp>_projects_refund_shield.sql`

- [ ] **Step 2.1: Add columns to projects table**

Inside the `projects` table definition, add:

```ts
  refundShieldEnabled: boolean("refund_shield_enabled").notNull().default(false),
  refundShieldConsentAcknowledgedAt: timestamp("refund_shield_consent_acknowledged_at", { withTimezone: true }),
  refundShieldConsentAcknowledgedBy: uuid("refund_shield_consent_acknowledged_by").references(() => user.id),
  refundShieldResponseDelayMinutes: integer("refund_shield_response_delay_minutes").notNull().default(60),
```

- [ ] **Step 2.2: Generate migration**

Run: `pnpm db:migrate:generate`
Expected: New SQL file with four `ADD COLUMN` statements.

- [ ] **Step 2.3: Apply migration locally**

Run: `pnpm db:migrate`
Expected: Success. Verify with `psql $DATABASE_URL -c "\d projects"`.

- [ ] **Step 2.4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/
git commit -m "feat(db): add projects.refund_shield_* settings columns"
```

---

## Task 3: Drizzle schema — `refund_shield_responses` table

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Modify: `packages/db/src/drizzle/enums.ts` — add status + outcome enums
- Generated: `packages/db/drizzle/migrations/<timestamp>_refund_shield_responses.sql`

- [ ] **Step 3.1: Add enums**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const refundShieldStatusEnum = pgEnum("refund_shield_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED_NOT_FOUND",
  "SKIPPED_DISABLED",
]);

export const refundShieldOutcomeEnum = pgEnum("refund_shield_outcome", [
  "REFUND_APPROVED",
  "REFUND_DECLINED",
  "REFUND_REVERSED",
]);
```

- [ ] **Step 3.2: Add table definition**

Append to `packages/db/src/drizzle/schema.ts` (in a sensible place — alphabetical or grouped with webhook tables):

```ts
export const refundShieldResponses = pgTable(
  "refund_shield_responses",
  {
    id: uuid("id").primaryKey().$defaultFn(() => createId()),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id").references(() => subscribers.id, { onDelete: "set null" }),
    appleNotificationUuid: text("apple_notification_uuid").notNull(),
    appleOriginalTransactionId: text("apple_original_transaction_id").notNull(),
    appleTransactionId: text("apple_transaction_id").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    requestPayload: jsonb("request_payload"),
    appleHttpStatus: integer("apple_http_status"),
    appleResponseBody: text("apple_response_body"),
    status: refundShieldStatusEnum("status").notNull().default("PENDING"),
    outcome: refundShieldOutcomeEnum("outcome"),
    outcomeReceivedAt: timestamp("outcome_received_at", { withTimezone: true }),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    notificationUniq: uniqueIndex("idx_rss_notification_uniq").on(t.appleNotificationUuid),
    dueIdx: index("idx_rss_due")
      .on(t.status, t.scheduledFor)
      .where(sql`${t.status} = 'PENDING'`),
    outcomeLookupIdx: index("idx_rss_outcome_lookup").on(t.appleOriginalTransactionId),
    dashboardIdx: index("idx_rss_dashboard").on(t.projectId, t.detectedAt),
  }),
);
```

Use the same `createId` import the rest of the schema uses (cuid2 wrapper).

- [ ] **Step 3.3: Generate + apply migration**

Run: `pnpm db:migrate:generate && pnpm db:migrate`
Expected: Table created. Verify with `\d refund_shield_responses`.

- [ ] **Step 3.4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/enums.ts packages/db/drizzle/migrations/
git commit -m "feat(db): add refund_shield_responses queue+log table"
```

---

## Task 4: ClickHouse migration — Kafka raw table for SDK sessions

**Files:**
- Create: `packages/db/clickhouse/migrations/0009_sdk_session_events_kafka.sql`

- [ ] **Step 4.1: Write migration**

```sql
-- 0009_sdk_session_events_kafka.sql
CREATE TABLE IF NOT EXISTS sdk_session_events_raw
(
    project_id        UUID,
    subscriber_id     UUID,
    event_type        LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    duration_ms       UInt32,
    app_version       LowCardinality(String),
    sdk_version       LowCardinality(String)
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '{{KAFKA_BROKERS}}',
    kafka_topic_list = 'rovenue.sdk-sessions',
    kafka_group_name = 'clickhouse-sdk-sessions',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 1;
```

Follow the templating convention used by existing migrations (`packages/db/clickhouse/migrations/0001_*.sql` shows the substitution pattern for `{{KAFKA_BROKERS}}`).

- [ ] **Step 4.2: Apply migration locally**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate`
Expected: Success. Verify with `clickhouse-client --query "SHOW TABLES" | grep sdk_session_events_raw`.

- [ ] **Step 4.3: Verify with ClickHouse parity check**

Run: `pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: Pass.

- [ ] **Step 4.4: Commit**

```bash
git add packages/db/clickhouse/migrations/0009_sdk_session_events_kafka.sql
git commit -m "feat(ch): add sdk_session_events_raw Kafka Engine table"
```

---

## Task 5: ClickHouse migration — `sdk_sessions_daily` MV

**Files:**
- Create: `packages/db/clickhouse/migrations/0010_sdk_sessions_daily.sql`

- [ ] **Step 5.1: Write migration**

```sql
-- 0010_sdk_sessions_daily.sql

-- Target table receives aggregated state.
CREATE TABLE IF NOT EXISTS sdk_sessions_daily_tbl
(
    project_id           UUID,
    subscriber_id        UUID,
    day                  Date,
    session_ms_state     AggregateFunction(sum, UInt32),
    session_count_state  AggregateFunction(count)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, subscriber_id, day);

-- Materialized view streams from the Kafka raw table.
CREATE MATERIALIZED VIEW IF NOT EXISTS sdk_sessions_daily TO sdk_sessions_daily_tbl AS
SELECT
    project_id,
    subscriber_id,
    toDate(occurred_at) AS day,
    sumState(duration_ms)  AS session_ms_state,
    countState()           AS session_count_state
FROM sdk_session_events_raw
WHERE event_type IN ('background', 'close')
GROUP BY project_id, subscriber_id, day;
```

- [ ] **Step 5.2: Apply + verify**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate && pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: Success.

- [ ] **Step 5.3: Smoke test the MV**

Insert a fake event row via Kafka (use existing test helper in `packages/db/clickhouse/__tests__/` if present, else `kcat`):

```bash
echo '{"project_id":"00000000-0000-0000-0000-000000000001","subscriber_id":"00000000-0000-0000-0000-000000000002","event_type":"background","occurred_at":"2026-05-28T10:00:00.000Z","duration_ms":120000,"app_version":"1.0.0","sdk_version":"0.6.0"}' | kcat -P -b localhost:9092 -t rovenue.sdk-sessions
```

Then:
```sql
SELECT sumMerge(session_ms_state) FROM sdk_sessions_daily_tbl
WHERE subscriber_id = '00000000-0000-0000-0000-000000000002';
```
Expected: 120000.

- [ ] **Step 5.4: Commit**

```bash
git add packages/db/clickhouse/migrations/0010_sdk_sessions_daily.sql
git commit -m "feat(ch): add sdk_sessions_daily SummingMergeTree MV"
```

---

## Task 6: ClickHouse migration — `revenue_lifetime_subscriber` MV

**Files:**
- Create: `packages/db/clickhouse/migrations/0011_revenue_lifetime_subscriber.sql`

- [ ] **Step 6.1: Verify the source table exists**

Run: `clickhouse-client --query "DESCRIBE TABLE revenue_events_raw"` (or whatever the existing raw revenue table is named — check `packages/db/clickhouse/migrations/0001_*.sql` through `0005_*.sql` to find the correct name and column shapes).

You need columns: `project_id`, `subscriber_id`, `event_type`, `amount_cents`, `occurred_at`. If the column names differ, adjust the SELECT in Step 6.2 accordingly.

- [ ] **Step 6.2: Write migration**

```sql
-- 0011_revenue_lifetime_subscriber.sql

CREATE TABLE IF NOT EXISTS revenue_lifetime_subscriber_tbl
(
    project_id                          UUID,
    subscriber_id                       UUID,
    lifetime_dollars_purchased_cents    AggregateFunction(sum, Int64),
    lifetime_dollars_refunded_cents     AggregateFunction(sum, Int64)
)
ENGINE = SummingMergeTree
ORDER BY (project_id, subscriber_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS revenue_lifetime_subscriber_mv
TO revenue_lifetime_subscriber_tbl AS
SELECT
    project_id,
    subscriber_id,
    sumState(if(event_type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CREDIT_PURCHASE'), amount_cents, 0)) AS lifetime_dollars_purchased_cents,
    sumState(if(event_type = 'REFUND', amount_cents, 0))                                                       AS lifetime_dollars_refunded_cents
FROM revenue_events_raw
GROUP BY project_id, subscriber_id;
```

- [ ] **Step 6.3: Apply + verify**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate && pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: Success.

- [ ] **Step 6.4: Commit**

```bash
git add packages/db/clickhouse/migrations/0011_revenue_lifetime_subscriber.sql
git commit -m "feat(ch): add revenue_lifetime_subscriber per-subscriber MV"
```

---

## Task 7: Bucket-mapping pure function

This is the most important piece of business logic. Apple's `ConsumptionRequest` enum scales are fixed; we map our internal signals into them deterministically.

**Files:**
- Create: `apps/api/src/services/apple/refund-shield-buckets.ts`
- Create: `apps/api/src/services/apple/refund-shield-buckets.test.ts`

- [ ] **Step 7.1: Write the failing test file**

Create `apps/api/src/services/apple/refund-shield-buckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapToConsumptionRequest, type RefundShieldSignals } from "./refund-shield-buckets";

const baseSignals: RefundShieldSignals = {
  customerConsented: true,
  appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
  firstSeenAt: new Date("2026-01-01T00:00:00Z"),
  now: new Date("2026-05-28T00:00:00Z"),
  purchaseStartedAt: new Date("2026-05-01T00:00:00Z"),
  purchaseEndsAt: new Date("2026-06-01T00:00:00Z"),
  wasInTrial: false,
  hasActiveEntitlement: true,
  lifetimeSessionMs: 3_600_000,
  lifetimeDollarsPurchasedCents: 7500,
  lifetimeDollarsRefundedCents: 0,
};

describe("mapToConsumptionRequest", () => {
  it("maps a fully-formed signal set to all 12 Apple fields", () => {
    const out = mapToConsumptionRequest(baseSignals);
    expect(out).toEqual({
      customerConsented: true,
      consumptionStatus: 2, // 27/31 days = ~87% elapsed → PARTIAL
      platform: 1,
      sampleContentProvided: false,
      deliveryStatus: 0,
      appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
      accountTenure: 5, // 147 days → >90d bucket
      playTime: 3, // 60min → 1-6h bucket
      lifetimeDollarsPurchased: 2, // $75 → $50-100 tier
      lifetimeDollarsRefunded: 0,
      userStatus: 1,
      refundPreference: 2,
    });
  });

  describe("consumptionStatus", () => {
    it("returns 1 (NOT_CONSUMED) when <25% elapsed", () => {
      const out = mapToConsumptionRequest({
        ...baseSignals,
        purchaseStartedAt: new Date("2026-05-25T00:00:00Z"),
        purchaseEndsAt:   new Date("2026-06-25T00:00:00Z"),
      });
      expect(out.consumptionStatus).toBe(1);
    });

    it("returns 2 (PARTIAL) when 25-90% elapsed", () => {
      expect(mapToConsumptionRequest(baseSignals).consumptionStatus).toBe(2);
    });

    it("returns 3 (FULLY) when >90% elapsed", () => {
      const out = mapToConsumptionRequest({
        ...baseSignals,
        purchaseStartedAt: new Date("2026-04-01T00:00:00Z"),
        purchaseEndsAt:   new Date("2026-05-29T00:00:00Z"),
      });
      expect(out.consumptionStatus).toBe(3);
    });
  });

  describe("accountTenure", () => {
    const cases: [string, number][] = [
      ["2026-05-27T00:00:00Z", 1], // 1 day
      ["2026-05-22T00:00:00Z", 2], // 6 days
      ["2026-05-10T00:00:00Z", 3], // 18 days
      ["2026-04-10T00:00:00Z", 4], // 48 days
      ["2026-01-01T00:00:00Z", 5], // 147 days
    ];
    it.each(cases)("first_seen %s → bucket %d", (firstSeen, bucket) => {
      const out = mapToConsumptionRequest({ ...baseSignals, firstSeenAt: new Date(firstSeen) });
      expect(out.accountTenure).toBe(bucket);
    });
  });

  describe("playTime", () => {
    const cases: [number, number][] = [
      [0, 0],
      [60_000, 1],          // 1 min
      [10 * 60_000, 2],     // 10 min
      [2 * 60 * 60_000, 3], // 2 h
      [8 * 60 * 60_000, 4], // 8 h
      [20 * 60 * 60_000, 5],// 20 h
    ];
    it.each(cases)("ms=%d → bucket %d", (ms, bucket) => {
      const out = mapToConsumptionRequest({ ...baseSignals, lifetimeSessionMs: ms });
      expect(out.playTime).toBe(bucket);
    });
  });

  describe("lifetimeDollarsPurchased tiers", () => {
    const cases: [number, number][] = [
      [0, 0],
      [3000, 1],     // $30
      [7500, 2],     // $75
      [25000, 3],    // $250
      [70000, 4],    // $700
      [150000, 5],   // $1500
      [250000, 6],   // $2500
      [400000, 7],   // $4000
    ];
    it.each(cases)("cents=%d → tier %d", (cents, tier) => {
      const out = mapToConsumptionRequest({ ...baseSignals, lifetimeDollarsPurchasedCents: cents });
      expect(out.lifetimeDollarsPurchased).toBe(tier);
    });
  });

  it("omits appAccountToken when null", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, appAccountToken: null });
    expect(out.appAccountToken).toBeUndefined();
  });

  it("forces customerConsented=false when project not opted in", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, customerConsented: false });
    expect(out.customerConsented).toBe(false);
  });

  it("sampleContentProvided=true reflects free trial", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, wasInTrial: true });
    expect(out.sampleContentProvided).toBe(true);
  });

  it("userStatus=0 when no active entitlement", () => {
    const out = mapToConsumptionRequest({ ...baseSignals, hasActiveEntitlement: false });
    expect(out.userStatus).toBe(0);
  });
});
```

- [ ] **Step 7.2: Run the failing test**

Run: `pnpm --filter @rovenue/api test refund-shield-buckets`
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement `refund-shield-buckets.ts`**

Create `apps/api/src/services/apple/refund-shield-buckets.ts`:

```ts
export interface RefundShieldSignals {
  customerConsented: boolean;
  appAccountToken: string | null;
  firstSeenAt: Date;
  now: Date;
  purchaseStartedAt: Date;
  purchaseEndsAt: Date;
  wasInTrial: boolean;
  hasActiveEntitlement: boolean;
  lifetimeSessionMs: number;
  lifetimeDollarsPurchasedCents: number;
  lifetimeDollarsRefundedCents: number;
}

export interface ConsumptionRequest {
  customerConsented: boolean;
  consumptionStatus: 0 | 1 | 2 | 3;
  platform: 0 | 1 | 2;
  sampleContentProvided: boolean;
  deliveryStatus: 0 | 1 | 2 | 3 | 4 | 5;
  appAccountToken?: string;
  accountTenure: 0 | 1 | 2 | 3 | 4 | 5;
  playTime: 0 | 1 | 2 | 3 | 4 | 5;
  lifetimeDollarsRefunded: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  lifetimeDollarsPurchased: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  userStatus: 0 | 1 | 2 | 3 | 4;
  refundPreference: 0 | 1 | 2 | 3;
}

function consumptionStatusBucket(now: Date, started: Date, ends: Date): 0 | 1 | 2 | 3 {
  const total = ends.getTime() - started.getTime();
  if (total <= 0) return 3;
  const elapsed = now.getTime() - started.getTime();
  const pct = elapsed / total;
  if (pct > 0.9) return 3;
  if (pct >= 0.25) return 2;
  return 1;
}

function accountTenureBucket(now: Date, firstSeen: Date): 0 | 1 | 2 | 3 | 4 | 5 {
  const days = (now.getTime() - firstSeen.getTime()) / 86_400_000;
  if (days < 3) return 1;
  if (days < 10) return 2;
  if (days < 30) return 3;
  if (days < 90) return 4;
  return 5;
}

function playTimeBucket(ms: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (ms <= 0) return 0;
  const min = ms / 60_000;
  if (min < 5) return 1;
  if (min < 60) return 2;
  if (min < 360) return 3;
  if (min < 960) return 4;
  return 5;
}

function dollarsTier(cents: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (cents <= 0) return 0;
  if (cents < 5_000) return 1;
  if (cents < 10_000) return 2;
  if (cents < 50_000) return 3;
  if (cents < 100_000) return 4;
  if (cents < 200_000) return 5;
  if (cents < 300_000) return 6;
  return 7;
}

export function mapToConsumptionRequest(s: RefundShieldSignals): ConsumptionRequest {
  const out: ConsumptionRequest = {
    customerConsented: s.customerConsented,
    consumptionStatus: consumptionStatusBucket(s.now, s.purchaseStartedAt, s.purchaseEndsAt),
    platform: 1,
    sampleContentProvided: s.wasInTrial,
    deliveryStatus: 0,
    accountTenure: accountTenureBucket(s.now, s.firstSeenAt),
    playTime: playTimeBucket(s.lifetimeSessionMs),
    lifetimeDollarsPurchased: dollarsTier(s.lifetimeDollarsPurchasedCents),
    lifetimeDollarsRefunded: dollarsTier(s.lifetimeDollarsRefundedCents),
    userStatus: s.hasActiveEntitlement ? 1 : 0,
    refundPreference: 2,
  };
  if (s.appAccountToken) out.appAccountToken = s.appAccountToken;
  return out;
}
```

- [ ] **Step 7.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test refund-shield-buckets`
Expected: All tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/src/services/apple/refund-shield-buckets.ts apps/api/src/services/apple/refund-shield-buckets.test.ts
git commit -m "feat(api): add Refund Shield bucket-mapping pure function"
```

---

## Task 8: Apple Server API client — `sendConsumptionInfo`

**Files:**
- Create: `apps/api/src/services/apple/apple-server-api.ts`
- Create: `apps/api/src/services/apple/apple-server-api.test.ts`

- [ ] **Step 8.1: Write the failing test**

```ts
// apps/api/src/services/apple/apple-server-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendConsumptionInfo, AppleServerApiError } from "./apple-server-api";

const ctx = {
  bundleId: "com.example.app",
  environment: "PRODUCTION" as const,
  // ...rest of ProjectAppleContext shape per apple-auth.ts
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("./apple-auth", () => ({
  getAppleAuthToken: vi.fn().mockResolvedValue("test-jwt"),
}));

describe("sendConsumptionInfo", () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("PUTs to the production endpoint with bearer JWT and JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    const payload = {
      customerConsented: true, consumptionStatus: 3, platform: 1,
      sampleContentProvided: false, deliveryStatus: 0,
      accountTenure: 4, playTime: 3,
      lifetimeDollarsPurchased: 2, lifetimeDollarsRefunded: 0,
      userStatus: 1, refundPreference: 2,
    } as const;
    const res = await sendConsumptionInfo(ctx, "tx_123", payload);
    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.storekit.itunes.apple.com/inApps/v1/transactions/consumption/tx_123",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(payload),
      }),
    );
  });

  it("uses sandbox base URL when ctx.environment is SANDBOX", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await sendConsumptionInfo({ ...ctx, environment: "SANDBOX" }, "tx_123", {} as never);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.storekit-sandbox.itunes.apple.com"),
      expect.anything(),
    );
  });

  it("throws AppleServerApiError on non-202 status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request body", { status: 400 }));
    await expect(sendConsumptionInfo(ctx, "tx_123", {} as never)).rejects.toMatchObject({
      status: 400,
      bodyPreview: expect.stringContaining("bad request"),
    });
  });
});
```

- [ ] **Step 8.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test apple-server-api`
Expected: FAIL — module not found.

- [ ] **Step 8.3: Implement the client**

```ts
// apps/api/src/services/apple/apple-server-api.ts
import { getAppleAuthToken, type ProjectAppleContext } from "./apple-auth";
import type { ConsumptionRequest } from "./refund-shield-buckets";

const PROD_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

export class AppleServerApiError extends Error {
  constructor(public readonly status: number, public readonly bodyPreview: string) {
    super(`Apple Server API ${status}: ${bodyPreview.slice(0, 200)}`);
  }
}

export async function sendConsumptionInfo(
  ctx: ProjectAppleContext,
  transactionId: string,
  payload: ConsumptionRequest,
): Promise<{ status: 202 }> {
  const token = await getAppleAuthToken(ctx);
  const base = ctx.environment === "PRODUCTION" ? PROD_BASE : SANDBOX_BASE;
  const res = await fetch(`${base}/inApps/v1/transactions/consumption/${transactionId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 202) {
    const body = await res.text().catch(() => "");
    throw new AppleServerApiError(res.status, body);
  }
  return { status: 202 };
}
```

If `ProjectAppleContext` doesn't exist as a named export from `apple-auth.ts`, define a minimal local interface with `bundleId` and `environment: "PRODUCTION" | "SANDBOX"` and the credentials the existing `getAppleAuthToken` consumes; export `ProjectAppleContext` from `apple-auth.ts` for reuse.

- [ ] **Step 8.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test apple-server-api`
Expected: All pass.

- [ ] **Step 8.5: Commit**

```bash
git add apps/api/src/services/apple/apple-server-api.ts apps/api/src/services/apple/apple-server-api.test.ts
git commit -m "feat(api): add Apple Server API client with sendConsumptionInfo"
```

---

## Task 9: Persist `apple_app_account_token` on receipt processing

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (the JWS-receipt path that creates/updates subscribers)
- Create: `apps/api/src/services/apple/apple-webhook.app-account-token.test.ts`

- [ ] **Step 9.1: Locate the subscriber upsert in the receipt handler**

In `apple-webhook.ts`, find where a `subscribers` row is upserted after JWS decode (look for `db.insert(subscribers)` or `db.update(subscribers)` in the receipt-processing path — likely in `applyInitial` or shared helper). The JWS payload includes an optional `appAccountToken` field.

- [ ] **Step 9.2: Write the failing test**

```ts
// apple-webhook.app-account-token.test.ts
import { describe, expect, it } from "vitest";
import { processReceipt } from "./apple-webhook"; // or whichever helper invokes the upsert
import { setupTestDb } from "../../test-helpers/test-db"; // existing helper

describe("processReceipt — appAccountToken persistence", () => {
  it("persists subscribers.apple_app_account_token from JWS payload", async () => {
    const db = await setupTestDb();
    const jwsPayload = makeFakeJwsTransactionPayload({
      appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
      originalTransactionId: "1000000000",
      productId: "premium_monthly",
    });

    await processReceipt(db, projectId, jwsPayload);

    const subscriber = await db.query.subscribers.findFirst({
      where: (s, { and, eq }) => and(
        eq(s.projectId, projectId),
        eq(s.appleAppAccountToken, "550e8400-e29b-41d4-a716-446655440000"),
      ),
    });
    expect(subscriber).toBeDefined();
    expect(subscriber?.appleAppAccountToken).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("leaves apple_app_account_token NULL when JWS has none", async () => {
    const db = await setupTestDb();
    await processReceipt(db, projectId, makeFakeJwsTransactionPayload({
      appAccountToken: undefined,
      originalTransactionId: "1000000002",
      productId: "premium_monthly",
    }));
    // resolve subscriber by original_transaction_id → purchases JOIN
    const purchase = await db.query.purchases.findFirst({
      where: (p, { eq }) => eq(p.originalTransactionId, "1000000002"),
    });
    const subscriber = await db.query.subscribers.findFirst({
      where: (s, { eq }) => eq(s.id, purchase!.subscriberId),
    });
    expect(subscriber?.appleAppAccountToken).toBeNull();
  });
});
```

Adjust function names to match the actual receipt-processing API in the file (look for the existing test fixtures pattern).

- [ ] **Step 9.3: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test apple-webhook.app-account-token`
Expected: FAIL — column not being persisted.

- [ ] **Step 9.4: Implement persistence**

In the upsert call, add `appleAppAccountToken: jwsPayload.appAccountToken ?? null` to both the insert values and the update set (use `excluded.appleAppAccountToken` for the ON CONFLICT path).

- [ ] **Step 9.5: Run tests to confirm pass + run existing webhook tests**

Run: `pnpm --filter @rovenue/api test apple-webhook`
Expected: All pass (new + existing).

- [ ] **Step 9.6: Commit**

```bash
git add apps/api/src/services/apple/apple-webhook.ts apps/api/src/services/apple/apple-webhook.app-account-token.test.ts
git commit -m "feat(api): persist subscribers.apple_app_account_token from JWS"
```

---

## Task 10: Webhook handler — `CONSUMPTION_REQUEST` case

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (switch around line 215)
- Create: `apps/api/src/services/apple/apple-webhook.refund-shield.test.ts`

- [ ] **Step 10.1: Write the failing tests**

```ts
// apple-webhook.refund-shield.test.ts
import { describe, expect, it } from "vitest";
import { handleAppleNotification } from "./apple-webhook"; // existing entry point
import { setupTestDb, makeProject, makeSubscriber, makePurchase } from "../../test-helpers/test-db";
import { signFakeAppleNotification } from "../../test-helpers/apple-fixtures";

describe("CONSUMPTION_REQUEST", () => {
  it("inserts a PENDING refund_shield_responses row when project enabled", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true, refundShieldResponseDelayMinutes: 60 });
    const sub = await makeSubscriber(db, {
      projectId: project.id,
      appleAppAccountToken: "550e8400-e29b-41d4-a716-446655440000",
    });
    await makePurchase(db, { subscriberId: sub.id, originalTransactionId: "1000000001" });
    const jws = signFakeAppleNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-1",
      transactionInfo: {
        appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
        originalTransactionId: "1000000001",
        transactionId: "1000000099",
      },
    });

    await handleAppleNotification(db, project.id, jws);

    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-1"),
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.subscriberId).toBe(sub.id);
    expect(row?.scheduledFor.getTime() - row!.detectedAt.getTime()).toBe(60 * 60 * 1000);
  });

  it("inserts SKIPPED_DISABLED when project not enabled", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: false });
    const jws = signFakeAppleNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-2",
      transactionInfo: { originalTransactionId: "1000000002", transactionId: "1000000099" },
    });
    await handleAppleNotification(db, project.id, jws);
    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-2"),
    });
    expect(row?.status).toBe("SKIPPED_DISABLED");
  });

  it("inserts SKIPPED_NOT_FOUND when no subscriber resolves", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const jws = signFakeAppleNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-3",
      transactionInfo: { originalTransactionId: "9999999999", transactionId: "9999999999" },
    });
    await handleAppleNotification(db, project.id, jws);
    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-3"),
    });
    expect(row?.status).toBe("SKIPPED_NOT_FOUND");
    expect(row?.subscriberId).toBeNull();
  });

  it("falls back to original_transaction_id lookup when appAccountToken absent", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const sub = await makeSubscriber(db, { projectId: project.id, appleAppAccountToken: null });
    await makePurchase(db, { subscriberId: sub.id, originalTransactionId: "1000000004" });
    const jws = signFakeAppleNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-4",
      transactionInfo: { originalTransactionId: "1000000004", transactionId: "1000000099" },
      // no appAccountToken
    });
    await handleAppleNotification(db, project.id, jws);
    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-4"),
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.subscriberId).toBe(sub.id);
  });

  it("is idempotent on duplicate notification UUID", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const jws = signFakeAppleNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-5",
      transactionInfo: { originalTransactionId: "1000000005", transactionId: "1000000099" },
    });
    await handleAppleNotification(db, project.id, jws);
    await handleAppleNotification(db, project.id, jws); // second time
    const rows = await db.query.refundShieldResponses.findMany({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-5"),
    });
    expect(rows).toHaveLength(1);
  });
});
```

If `test-helpers/apple-fixtures` doesn't expose `signFakeAppleNotification`, follow the pattern of the existing Apple webhook test fixtures (search for `notificationType` in `apps/api/src/services/apple/**/*.test.ts` to find the helper).

- [ ] **Step 10.2: Run tests — expect failure**

Run: `pnpm --filter @rovenue/api test apple-webhook.refund-shield`
Expected: FAIL — case not handled.

- [ ] **Step 10.3: Add `applyConsumptionRequest`**

In `apple-webhook.ts`, add a new case to the switch at ~line 215:

```ts
case "CONSUMPTION_REQUEST":
  return applyConsumptionRequest(tx, project, notification);
```

Then implement the handler in the same file (or extract to `consumption-request-handler.ts` for clarity):

```ts
async function applyConsumptionRequest(
  tx: DrizzleTx,
  project: Project,
  notification: AppleNotificationDecoded,
): Promise<void> {
  const txInfo = notification.transactionInfo;
  const detectedAt = new Date();
  const scheduledFor = project.refundShieldEnabled
    ? new Date(detectedAt.getTime() + project.refundShieldResponseDelayMinutes * 60_000)
    : detectedAt;

  // Subscriber lookup: appAccountToken first, then original_transaction_id
  let subscriberId: string | null = null;
  if (txInfo.appAccountToken) {
    const byToken = await tx.query.subscribers.findFirst({
      where: (s, { and, eq }) => and(
        eq(s.projectId, project.id),
        eq(s.appleAppAccountToken, txInfo.appAccountToken),
      ),
    });
    subscriberId = byToken?.id ?? null;
  }
  if (!subscriberId) {
    const byPurchase = await tx.query.purchases.findFirst({
      where: (p, { and, eq }) => and(
        eq(p.projectId, project.id),
        eq(p.originalTransactionId, txInfo.originalTransactionId),
      ),
      with: { subscriber: true },
    });
    subscriberId = byPurchase?.subscriberId ?? null;
  }

  const status = !project.refundShieldEnabled
    ? "SKIPPED_DISABLED"
    : subscriberId === null
      ? "SKIPPED_NOT_FOUND"
      : "PENDING";

  await tx.insert(refundShieldResponses).values({
    projectId: project.id,
    subscriberId,
    appleNotificationUuid: notification.uuid,
    appleOriginalTransactionId: txInfo.originalTransactionId,
    appleTransactionId: txInfo.transactionId,
    detectedAt,
    scheduledFor,
    status,
  }).onConflictDoNothing({ target: refundShieldResponses.appleNotificationUuid });
}
```

- [ ] **Step 10.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test apple-webhook.refund-shield`
Expected: All pass.

- [ ] **Step 10.5: Commit**

```bash
git add apps/api/src/services/apple/
git commit -m "feat(api): handle Apple CONSUMPTION_REQUEST → refund_shield_responses"
```

---

## Task 11: Webhook handler — outcome cases (`REFUND`, `REFUND_DECLINED_NOTIFICATION`, `REFUND_REVERSED`)

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts`
- Modify: `apps/api/src/services/apple/apple-webhook.refund-shield.test.ts` — add tests

- [ ] **Step 11.1: Add outcome tests**

Append to the existing test file:

```ts
describe("REFUND outcome linking", () => {
  it("sets outcome=REFUND_APPROVED when REFUND notification arrives", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    // seed an existing PENDING response
    await db.insert(refundShieldResponses).values({
      projectId: project.id,
      appleNotificationUuid: "uuid-cr-1",
      appleOriginalTransactionId: "1000000010",
      appleTransactionId: "1000000099",
      detectedAt: new Date(),
      scheduledFor: new Date(),
      status: "SENT",
      sentAt: new Date(),
    });

    const jws = signFakeAppleNotification({
      notificationType: "REFUND",
      notificationUUID: "uuid-r-1",
      transactionInfo: { originalTransactionId: "1000000010", transactionId: "1000000099" },
    });
    await handleAppleNotification(db, project.id, jws);

    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-cr-1"),
    });
    expect(row?.outcome).toBe("REFUND_APPROVED");
    expect(row?.outcomeReceivedAt).toBeTruthy();
  });

  it("sets outcome=REFUND_DECLINED for REFUND_DECLINED_NOTIFICATION", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    await db.insert(refundShieldResponses).values({
      projectId: project.id,
      appleNotificationUuid: "uuid-cr-2",
      appleOriginalTransactionId: "1000000020",
      appleTransactionId: "1000000099",
      detectedAt: new Date(),
      scheduledFor: new Date(),
      status: "SENT",
      sentAt: new Date(),
    });

    const jws = signFakeAppleNotification({
      notificationType: "REFUND_DECLINED_NOTIFICATION",
      notificationUUID: "uuid-rd-1",
      transactionInfo: { originalTransactionId: "1000000020", transactionId: "1000000099" },
    });
    await handleAppleNotification(db, project.id, jws);

    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-cr-2"),
    });
    expect(row?.outcome).toBe("REFUND_DECLINED");
    expect(row?.outcomeReceivedAt).toBeTruthy();
  });

  it("sets outcome=REFUND_REVERSED for REFUND_REVERSED", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    await db.insert(refundShieldResponses).values({
      projectId: project.id,
      appleNotificationUuid: "uuid-cr-3",
      appleOriginalTransactionId: "1000000030",
      appleTransactionId: "1000000099",
      detectedAt: new Date(),
      scheduledFor: new Date(),
      status: "SENT",
      sentAt: new Date(),
      outcome: "REFUND_APPROVED",
      outcomeReceivedAt: new Date(),
    });

    const jws = signFakeAppleNotification({
      notificationType: "REFUND_REVERSED",
      notificationUUID: "uuid-rr-1",
      transactionInfo: { originalTransactionId: "1000000030", transactionId: "1000000099" },
    });
    await handleAppleNotification(db, project.id, jws);

    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-cr-3"),
    });
    expect(row?.outcome).toBe("REFUND_REVERSED");
  });

  it("ignores outcome update when no matching CONSUMPTION_REQUEST row exists", async () => {
    const db = await setupTestDb();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const jws = signFakeAppleNotification({
      notificationType: "REFUND",
      notificationUUID: "uuid-orphan",
      transactionInfo: { originalTransactionId: "9999999999", transactionId: "9999999999" },
    });
    // should not throw, and should still apply the existing refund-revenue-event logic
    await expect(handleAppleNotification(db, project.id, jws)).resolves.not.toThrow();
  });
});
```

Fill in the two skipped test bodies by copying the first and changing the notificationType + expected outcome.

- [ ] **Step 11.2: Run tests — expect failure**

Run: `pnpm --filter @rovenue/api test apple-webhook.refund-shield`
Expected: New outcome tests fail.

- [ ] **Step 11.3: Implement outcome updates**

Locate the existing `applyRefund` function in `apple-webhook.ts`. Append after the existing revenue-events insert and before commit:

```ts
await tx
  .update(refundShieldResponses)
  .set({ outcome: "REFUND_APPROVED", outcomeReceivedAt: new Date() })
  .where(and(
    eq(refundShieldResponses.projectId, project.id),
    eq(refundShieldResponses.appleOriginalTransactionId, txInfo.originalTransactionId),
    isNull(refundShieldResponses.outcome),
  ));
```

Add two new cases to the switch:

```ts
case "REFUND_DECLINED_NOTIFICATION":
  return applyRefundDeclined(tx, project, notification);
case "REFUND_REVERSED":
  return applyRefundReversed(tx, project, notification);
```

```ts
async function applyRefundDeclined(tx: DrizzleTx, project: Project, n: AppleNotificationDecoded) {
  await tx.update(refundShieldResponses)
    .set({ outcome: "REFUND_DECLINED", outcomeReceivedAt: new Date() })
    .where(and(
      eq(refundShieldResponses.projectId, project.id),
      eq(refundShieldResponses.appleOriginalTransactionId, n.transactionInfo.originalTransactionId),
      isNull(refundShieldResponses.outcome),
    ));
}

async function applyRefundReversed(tx: DrizzleTx, project: Project, n: AppleNotificationDecoded) {
  await tx.update(refundShieldResponses)
    .set({ outcome: "REFUND_REVERSED", outcomeReceivedAt: new Date() })
    .where(and(
      eq(refundShieldResponses.projectId, project.id),
      eq(refundShieldResponses.appleOriginalTransactionId, n.transactionInfo.originalTransactionId),
      isNull(refundShieldResponses.outcome),
    ));
  // also emit a compensating revenue_events row (refund reversal restores revenue)
  // ...follow the existing revenue_events emission pattern from applyRefund
}
```

- [ ] **Step 11.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test apple-webhook`
Expected: All pass.

- [ ] **Step 11.5: Commit**

```bash
git add apps/api/src/services/apple/apple-webhook.ts apps/api/src/services/apple/apple-webhook.refund-shield.test.ts
git commit -m "feat(api): link Apple refund outcomes to refund_shield_responses"
```

---

## Task 12: Signal aggregation service

**Files:**
- Create: `apps/api/src/services/refund-shield/aggregate-signals.ts`
- Create: `apps/api/src/services/refund-shield/aggregate-signals.test.ts`

- [ ] **Step 12.1: Write the failing test**

```ts
// aggregate-signals.test.ts
import { describe, expect, it } from "vitest";
import { aggregateRefundShieldSignals } from "./aggregate-signals";
import { setupTestDb, setupTestClickHouse, makeSubscriber, makePurchase, insertSession, insertRevenueEvent } from "../../test-helpers/test-db";

describe("aggregateRefundShieldSignals", () => {
  it("collects tenure + session + lifetime $ for a known subscriber", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const sub = await makeSubscriber(db, { firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    await makePurchase(db, {
      subscriberId: sub.id,
      originalTransactionId: "tx_1",
      purchasedAt: new Date("2026-05-01T00:00:00Z"),
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      wasInTrial: false,
    });
    await insertSession(ch, { subscriberId: sub.id, durationMs: 3_600_000 });
    await insertRevenueEvent(ch, { subscriberId: sub.id, eventType: "INITIAL", amountCents: 7500 });

    const signals = await aggregateRefundShieldSignals({
      db, ch,
      projectId: sub.projectId,
      subscriberId: sub.id,
      originalTransactionId: "tx_1",
      customerConsented: true,
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(signals).toMatchObject({
      customerConsented: true,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lifetimeSessionMs: 3_600_000,
      lifetimeDollarsPurchasedCents: 7500,
      lifetimeDollarsRefundedCents: 0,
      hasActiveEntitlement: false, // no subscriber_access row inserted
      wasInTrial: false,
      purchaseStartedAt: new Date("2026-05-01T00:00:00Z"),
      purchaseEndsAt: new Date("2026-06-01T00:00:00Z"),
    });
  });

  it("returns zero session_ms when subscriber has no telemetry yet", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const sub = await makeSubscriber(db, { firstSeenAt: new Date("2026-05-20T00:00:00Z") });
    await makePurchase(db, {
      subscriberId: sub.id,
      originalTransactionId: "tx_2",
      purchasedAt: new Date("2026-05-25T00:00:00Z"),
      expiresAt: new Date("2026-06-25T00:00:00Z"),
      wasInTrial: true,
    });
    const signals = await aggregateRefundShieldSignals({
      db, ch,
      projectId: sub.projectId,
      subscriberId: sub.id,
      originalTransactionId: "tx_2",
      customerConsented: true,
      now: new Date("2026-05-28T00:00:00Z"),
    });
    expect(signals.lifetimeSessionMs).toBe(0);
    expect(signals.lifetimeDollarsPurchasedCents).toBe(0);
    expect(signals.wasInTrial).toBe(true);
  });
});
```

- [ ] **Step 12.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test aggregate-signals`
Expected: FAIL — module not found.

- [ ] **Step 12.3: Implement aggregation**

```ts
// aggregate-signals.ts
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../lib/db";
import type { ClickHouseClient } from "@clickhouse/client";
import { subscribers, subscriberAccess, purchases } from "@rovenue/db";
import type { RefundShieldSignals } from "../apple/refund-shield-buckets";

export interface AggregateInput {
  db: Db;
  ch: ClickHouseClient;
  projectId: string;
  subscriberId: string;
  originalTransactionId: string;
  customerConsented: boolean;
  appAccountToken?: string | null;
  now: Date;
}

export async function aggregateRefundShieldSignals(input: AggregateInput): Promise<RefundShieldSignals> {
  const pgRow = await input.db.execute(sql`
    SELECT
      s.first_seen_at,
      exists(
        SELECT 1 FROM subscriber_access
        WHERE subscriber_id = ${input.subscriberId}
          AND revoked_at IS NULL
          AND expires_at > now()
      ) AS has_active_entitlement,
      (SELECT min(purchased_at) FROM purchases
        WHERE original_transaction_id = ${input.originalTransactionId}) AS purchase_started_at,
      (SELECT expires_at FROM purchases
        WHERE original_transaction_id = ${input.originalTransactionId}
        ORDER BY purchased_at DESC LIMIT 1) AS purchase_ends_at,
      (SELECT was_in_trial FROM purchases
        WHERE original_transaction_id = ${input.originalTransactionId}
        ORDER BY purchased_at DESC LIMIT 1) AS was_in_trial
    FROM subscribers s
    WHERE s.id = ${input.subscriberId}
  `);
  const pg = (pgRow as { rows: any[] }).rows[0];

  const chRow = await input.ch.query({
    query: `
      SELECT
        coalesce(sumMerge(session_ms_state), 0) AS lifetime_session_ms,
        coalesce(any(lifetime_dollars_purchased_cents), 0) AS lifetime_dollars_purchased_cents,
        coalesce(any(lifetime_dollars_refunded_cents), 0) AS lifetime_dollars_refunded_cents
      FROM sdk_sessions_daily_tbl s
      FULL JOIN revenue_lifetime_subscriber_tbl r USING (subscriber_id)
      WHERE subscriber_id = {sub:UUID}
    `,
    query_params: { sub: input.subscriberId },
    format: "JSONEachRow",
  });
  const [ch] = (await chRow.json<any>()) ?? [{}];

  return {
    customerConsented: input.customerConsented,
    appAccountToken: input.appAccountToken ?? null,
    firstSeenAt: new Date(pg.first_seen_at),
    now: input.now,
    purchaseStartedAt: new Date(pg.purchase_started_at),
    purchaseEndsAt: new Date(pg.purchase_ends_at),
    wasInTrial: !!pg.was_in_trial,
    hasActiveEntitlement: !!pg.has_active_entitlement,
    lifetimeSessionMs: Number(ch.lifetime_session_ms ?? 0),
    lifetimeDollarsPurchasedCents: Number(ch.lifetime_dollars_purchased_cents ?? 0),
    lifetimeDollarsRefundedCents: Number(ch.lifetime_dollars_refunded_cents ?? 0),
  };
}
```

- [ ] **Step 12.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test aggregate-signals`
Expected: All pass.

- [ ] **Step 12.5: Commit**

```bash
git add apps/api/src/services/refund-shield/aggregate-signals.ts apps/api/src/services/refund-shield/aggregate-signals.test.ts
git commit -m "feat(api): add Refund Shield signal aggregation (CH+PG)"
```

---

## Task 13: Per-row processor (signal aggregate → POST Apple → status update)

**Files:**
- Create: `apps/api/src/services/refund-shield/process-response.ts`
- Create: `apps/api/src/services/refund-shield/process-response.test.ts`

- [ ] **Step 13.1: Write the failing test**

```ts
// process-response.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { processRefundShieldResponse } from "./process-response";

const sendConsumptionInfoMock = vi.fn();
vi.mock("../apple/apple-server-api", () => ({
  sendConsumptionInfo: (...args: unknown[]) => sendConsumptionInfoMock(...args),
  AppleServerApiError: class extends Error {
    constructor(public status: number, public bodyPreview: string) { super(`apple ${status}`); }
  },
}));

const aggregateMock = vi.fn();
vi.mock("./aggregate-signals", () => ({
  aggregateRefundShieldSignals: (...args: unknown[]) => aggregateMock(...args),
}));

const FAKE_SIGNALS = {
  customerConsented: true,
  appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
  firstSeenAt: new Date("2026-01-01"),
  now: new Date("2026-05-28"),
  purchaseStartedAt: new Date("2026-05-01"),
  purchaseEndsAt: new Date("2026-06-01"),
  wasInTrial: false,
  hasActiveEntitlement: true,
  lifetimeSessionMs: 3_600_000,
  lifetimeDollarsPurchasedCents: 7500,
  lifetimeDollarsRefundedCents: 0,
};

function makeRow(overrides: Partial<any> = {}) {
  return {
    id: "row_1",
    projectId: "proj_1",
    subscriberId: "sub_1",
    appleNotificationUuid: "uuid-1",
    appleOriginalTransactionId: "tx_original",
    appleTransactionId: "tx_apple",
    detectedAt: new Date("2026-05-28T00:00:00Z"),
    scheduledFor: new Date("2026-05-28T01:00:00Z"),
    status: "PENDING",
    retryCount: 0,
    ...overrides,
  };
}

const FAKE_CTX = { bundleId: "com.example.app", environment: "PRODUCTION" as const };

function makeInput(overrides: Partial<any> = {}) {
  return {
    row: makeRow(),
    ctx: FAKE_CTX,
    customerConsented: true,
    db: {} as any,
    ch: {} as any,
    now: new Date("2026-05-28T02:00:00Z"),
    ...overrides,
  };
}

describe("processRefundShieldResponse", () => {
  beforeEach(() => {
    sendConsumptionInfoMock.mockReset();
    aggregateMock.mockReset();
  });

  it("sends to Apple and marks SENT on 202", async () => {
    sendConsumptionInfoMock.mockResolvedValue({ status: 202 });
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);

    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("SENT");
    if (out.status === "SENT") {
      expect(out.payload.refundPreference).toBe(2);
      expect(out.httpStatus).toBe(202);
    }
    expect(sendConsumptionInfoMock).toHaveBeenCalledWith(FAKE_CTX, "tx_apple", expect.objectContaining({ refundPreference: 2 }));
  });

  it("returns RETRY when Apple returns 5xx", async () => {
    sendConsumptionInfoMock.mockRejectedValue(Object.assign(new Error("apple 503"), { status: 503, bodyPreview: "" }));
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);
    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("RETRY");
    if (out.status === "RETRY") expect(out.retryDelayMs).toBeGreaterThan(0);
  });

  it("returns FAILED when Apple returns 4xx (no retry)", async () => {
    sendConsumptionInfoMock.mockRejectedValue(Object.assign(new Error("apple 400"), { status: 400, bodyPreview: "bad" }));
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);
    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("FAILED");
    if (out.status === "FAILED") expect(out.error).toContain("400");
  });

  it("returns FAILED when 12h SLA has elapsed", async () => {
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);
    const out = await processRefundShieldResponse(makeInput({
      row: makeRow({ detectedAt: new Date(Date.now() - 13 * 3600_000) }),
      now: new Date(),
    }));
    expect(out.status).toBe("FAILED");
    if (out.status === "FAILED") expect(out.error).toBe("SLA_EXCEEDED");
    expect(sendConsumptionInfoMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 13.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test process-response`
Expected: FAIL — module not found.

- [ ] **Step 13.3: Implement processor**

```ts
// process-response.ts
import type { Db } from "../../lib/db";
import type { ClickHouseClient } from "@clickhouse/client";
import type { RefundShieldResponseRow } from "@rovenue/db";
import { aggregateRefundShieldSignals } from "./aggregate-signals";
import { mapToConsumptionRequest } from "../apple/refund-shield-buckets";
import { sendConsumptionInfo, AppleServerApiError } from "../apple/apple-server-api";
import type { ProjectAppleContext } from "../apple/apple-auth";

const SLA_MS = 12 * 60 * 60 * 1000;
const BACKOFFS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]; // 1m, 5m, 30m, 2h, 6h

export type ProcessOutcome =
  | { status: "SENT"; payload: ReturnType<typeof mapToConsumptionRequest>; httpStatus: 202 }
  | { status: "FAILED"; error: string; httpStatus?: number; responseBody?: string }
  | { status: "RETRY"; retryDelayMs: number; error: string };

export interface ProcessInput {
  row: RefundShieldResponseRow;
  ctx: ProjectAppleContext;
  customerConsented: boolean;
  db: Db;
  ch: ClickHouseClient;
  now: Date;
}

export async function processRefundShieldResponse(input: ProcessInput): Promise<ProcessOutcome> {
  if (input.now.getTime() - input.row.detectedAt.getTime() > SLA_MS) {
    return { status: "FAILED", error: "SLA_EXCEEDED" };
  }

  const signals = await aggregateRefundShieldSignals({
    db: input.db,
    ch: input.ch,
    projectId: input.row.projectId,
    subscriberId: input.row.subscriberId!,
    originalTransactionId: input.row.appleOriginalTransactionId,
    customerConsented: input.customerConsented,
    now: input.now,
  });
  const payload = mapToConsumptionRequest(signals);

  try {
    const res = await sendConsumptionInfo(input.ctx, input.row.appleTransactionId, payload);
    return { status: "SENT", payload, httpStatus: res.status };
  } catch (e: any) {
    const isAppleErr = e instanceof AppleServerApiError;
    const statusCode = isAppleErr ? e.status : 0;
    if (statusCode >= 500 || statusCode === 0) {
      const idx = Math.min(input.row.retryCount, BACKOFFS_MS.length - 1);
      const jitter = Math.floor(Math.random() * 30_000);
      return { status: "RETRY", retryDelayMs: BACKOFFS_MS[idx] + jitter, error: e.message };
    }
    return {
      status: "FAILED",
      error: `apple_${statusCode}: ${e.message}`,
      httpStatus: statusCode,
      responseBody: isAppleErr ? e.bodyPreview : undefined,
    };
  }
}
```

- [ ] **Step 13.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test process-response`
Expected: All pass.

- [ ] **Step 13.5: Commit**

```bash
git add apps/api/src/services/refund-shield/process-response.ts apps/api/src/services/refund-shield/process-response.test.ts
git commit -m "feat(api): add Refund Shield per-row processor with retry/SLA"
```

---

## Task 14: Polling worker — `refund-shield-responder`

**Files:**
- Create: `apps/api/src/workers/refund-shield-responder.ts`
- Create: `apps/api/src/workers/refund-shield-responder.test.ts`
- Modify: `apps/api/src/app.ts` — start the worker

- [ ] **Step 14.1: Write the failing test**

```ts
// refund-shield-responder.test.ts
import { describe, expect, it, vi } from "vitest";
import { runRefundShieldResponderTick } from "./refund-shield-responder";

vi.mock("../services/refund-shield/process-response", () => ({
  processRefundShieldResponse: vi.fn(),
}));

describe("runRefundShieldResponderTick", () => {
  it("picks up PENDING rows past scheduled_for, marks SENT on success, writes audit", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const sub = await makeSubscriber(db, { projectId: project.id });
    const rowId = await db.insert(refundShieldResponses).values({
      projectId: project.id,
      subscriberId: sub.id,
      appleNotificationUuid: "uuid-w1",
      appleOriginalTransactionId: "1000",
      appleTransactionId: "1099",
      detectedAt: new Date(Date.now() - 60 * 60_000),
      scheduledFor: new Date(Date.now() - 1000),
      status: "PENDING",
    }).returning({ id: refundShieldResponses.id });

    (processRefundShieldResponse as any).mockResolvedValue({
      status: "SENT", payload: { /* ... */ }, httpStatus: 202,
    });

    await runRefundShieldResponderTick({ db, ch, now: new Date() });

    const updated = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.id, rowId[0].id),
    });
    expect(updated?.status).toBe("SENT");
    expect(updated?.sentAt).toBeTruthy();
    expect(updated?.appleHttpStatus).toBe(202);
  });

  it("on RETRY: bumps retry_count and reschedules forward", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const sub = await makeSubscriber(db, { projectId: project.id });
    const [{ id: rid }] = await db.insert(refundShieldResponses).values({
      projectId: project.id, subscriberId: sub.id,
      appleNotificationUuid: "uuid-w2",
      appleOriginalTransactionId: "1001",
      appleTransactionId: "1099",
      detectedAt: new Date(Date.now() - 60 * 60_000),
      scheduledFor: new Date(Date.now() - 1000),
      status: "PENDING", retryCount: 1,
    }).returning({ id: refundShieldResponses.id });

    (processRefundShieldResponse as any).mockResolvedValue({ status: "RETRY", retryDelayMs: 300_000, error: "5xx" });

    const before = new Date();
    await runRefundShieldResponderTick({ db, ch, now: before });

    const updated = await db.query.refundShieldResponses.findFirst({ where: (r, { eq }) => eq(r.id, rid) });
    expect(updated?.status).toBe("PENDING");
    expect(updated?.retryCount).toBe(2);
    expect(updated!.scheduledFor.getTime()).toBeGreaterThan(before.getTime());
  });

  it("on FAILED: marks FAILED and writes error", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const sub = await makeSubscriber(db, { projectId: project.id });
    const [{ id: rid }] = await db.insert(refundShieldResponses).values({
      projectId: project.id, subscriberId: sub.id,
      appleNotificationUuid: "uuid-w3",
      appleOriginalTransactionId: "1002",
      appleTransactionId: "1099",
      detectedAt: new Date(Date.now() - 60 * 60_000),
      scheduledFor: new Date(Date.now() - 1000),
      status: "PENDING",
    }).returning({ id: refundShieldResponses.id });

    (processRefundShieldResponse as any).mockResolvedValue({
      status: "FAILED", error: "apple_400: bad payload", httpStatus: 400, responseBody: "bad",
    });

    await runRefundShieldResponderTick({ db, ch, now: new Date() });

    const updated = await db.query.refundShieldResponses.findFirst({ where: (r, { eq }) => eq(r.id, rid) });
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error).toContain("400");
    expect(updated?.appleHttpStatus).toBe(400);
  });

  it("skips re-disabled projects", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const project = await makeProject(db, { refundShieldEnabled: false }); // disabled mid-flight
    const sub = await makeSubscriber(db, { projectId: project.id });
    const [{ id: rid }] = await db.insert(refundShieldResponses).values({
      projectId: project.id, subscriberId: sub.id,
      appleNotificationUuid: "uuid-w4",
      appleOriginalTransactionId: "1003",
      appleTransactionId: "1099",
      detectedAt: new Date(),
      scheduledFor: new Date(Date.now() - 1000),
      status: "PENDING",
    }).returning({ id: refundShieldResponses.id });

    await runRefundShieldResponderTick({ db, ch, now: new Date() });

    const updated = await db.query.refundShieldResponses.findFirst({ where: (r, { eq }) => eq(r.id, rid) });
    expect(updated?.status).toBe("SKIPPED_DISABLED");
    expect(processRefundShieldResponse).not.toHaveBeenCalled();
  });

  it("respects FOR UPDATE SKIP LOCKED across two workers", async () => {
    const db = await setupTestDb();
    const ch = await setupTestClickHouse();
    const project = await makeProject(db, { refundShieldEnabled: true });
    const sub = await makeSubscriber(db, { projectId: project.id });
    await db.insert(refundShieldResponses).values({
      projectId: project.id, subscriberId: sub.id,
      appleNotificationUuid: "uuid-w5",
      appleOriginalTransactionId: "1004",
      appleTransactionId: "1099",
      detectedAt: new Date(),
      scheduledFor: new Date(Date.now() - 1000),
      status: "PENDING",
    });

    (processRefundShieldResponse as any).mockResolvedValue({
      status: "SENT", payload: { refundPreference: 2 }, httpStatus: 202,
    });

    const now = new Date();
    await Promise.all([
      runRefundShieldResponderTick({ db, ch, now }),
      runRefundShieldResponderTick({ db, ch, now }),
    ]);

    // processor must have been invoked exactly once even though two workers ran
    expect((processRefundShieldResponse as any).mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 14.2: Run tests — expect failure**

Run: `pnpm --filter @rovenue/api test refund-shield-responder`
Expected: FAIL.

- [ ] **Step 14.3: Implement worker**

```ts
// refund-shield-responder.ts
import { and, eq, lte, lt, sql } from "drizzle-orm";
import { refundShieldResponses, projects } from "@rovenue/db";
import { processRefundShieldResponse } from "../services/refund-shield/process-response";
import { audit } from "../lib/audit";
import { logger } from "../lib/logger";
import { metrics } from "../lib/metrics";
import { getAppleContextForProject } from "../services/apple/apple-auth";
import type { Db } from "../lib/db";
import type { ClickHouseClient } from "@clickhouse/client";

const BATCH_SIZE = 50;
const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 30_000;

export async function runRefundShieldResponderTick(input: {
  db: Db; ch: ClickHouseClient; now: Date;
}) {
  const { db, ch, now } = input;

  await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(refundShieldResponses)
      .where(and(
        eq(refundShieldResponses.status, "PENDING"),
        lte(refundShieldResponses.scheduledFor, now),
        lt(refundShieldResponses.retryCount, MAX_RETRIES),
      ))
      .orderBy(refundShieldResponses.scheduledFor)
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });

    for (const row of due) {
      const project = await tx.query.projects.findFirst({
        where: (p, { eq }) => eq(p.id, row.projectId),
      });
      if (!project) continue;
      if (!project.refundShieldEnabled) {
        await tx.update(refundShieldResponses)
          .set({ status: "SKIPPED_DISABLED", updatedAt: new Date() })
          .where(eq(refundShieldResponses.id, row.id));
        metrics.counter("refund_shield.failed", { reason: "disabled" }).inc();
        continue;
      }
      if (row.subscriberId === null) {
        await tx.update(refundShieldResponses)
          .set({ status: "SKIPPED_NOT_FOUND", updatedAt: new Date() })
          .where(eq(refundShieldResponses.id, row.id));
        metrics.counter("refund_shield.failed", { reason: "not_found" }).inc();
        continue;
      }

      const ctx = await getAppleContextForProject(tx, project.id);
      const outcome = await processRefundShieldResponse({
        row,
        ctx,
        customerConsented: project.refundShieldConsentAcknowledgedAt !== null,
        db: tx,
        ch,
        now,
      });

      if (outcome.status === "SENT") {
        await tx.update(refundShieldResponses).set({
          status: "SENT",
          sentAt: now,
          requestPayload: outcome.payload as unknown as object,
          appleHttpStatus: outcome.httpStatus,
          updatedAt: now,
        }).where(eq(refundShieldResponses.id, row.id));
        await audit({
          tx, projectId: project.id,
          entityType: "refund_shield_response", entityId: row.id,
          action: "SENT", meta: { transactionId: row.appleTransactionId },
        });
        metrics.counter("refund_shield.sent", { project_id: project.id }).inc();
        metrics.histogram("refund_shield.sla_remaining_seconds")
          .observe(((row.detectedAt.getTime() + 12 * 3600_000) - now.getTime()) / 1000);
      } else if (outcome.status === "RETRY") {
        await tx.update(refundShieldResponses).set({
          retryCount: row.retryCount + 1,
          scheduledFor: new Date(now.getTime() + outcome.retryDelayMs),
          error: outcome.error,
          updatedAt: now,
        }).where(eq(refundShieldResponses.id, row.id));
        metrics.counter("refund_shield.failed", { reason: "apple_5xx" }).inc();
      } else {
        await tx.update(refundShieldResponses).set({
          status: "FAILED",
          error: outcome.error,
          appleHttpStatus: outcome.httpStatus ?? null,
          appleResponseBody: outcome.responseBody ?? null,
          updatedAt: now,
        }).where(eq(refundShieldResponses.id, row.id));
        await audit({
          tx, projectId: project.id,
          entityType: "refund_shield_response", entityId: row.id,
          action: "FAILED", meta: { error: outcome.error },
        });
        const reason = outcome.error === "SLA_EXCEEDED" ? "sla_exceeded"
          : outcome.httpStatus && outcome.httpStatus >= 400 ? "apple_4xx" : "unknown";
        metrics.counter("refund_shield.failed", { reason }).inc();
      }
    }
  });
}

export function startRefundShieldResponder(db: Db, ch: ClickHouseClient) {
  let running = true;
  const loop = async () => {
    while (running) {
      try { await runRefundShieldResponderTick({ db, ch, now: new Date() }); }
      catch (e) { logger.error({ err: e }, "refund-shield-responder tick failed"); }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };
  loop();
  return () => { running = false; };
}
```

- [ ] **Step 14.4: Wire worker start into `app.ts`**

In `apps/api/src/app.ts`, near where other workers are started, add:

```ts
import { startRefundShieldResponder } from "./workers/refund-shield-responder";
// ...
startRefundShieldResponder(db, clickhouse);
```

- [ ] **Step 14.5: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test refund-shield-responder`
Expected: All pass.

- [ ] **Step 14.6: Commit**

```bash
git add apps/api/src/workers/refund-shield-responder.ts apps/api/src/workers/refund-shield-responder.test.ts apps/api/src/app.ts
git commit -m "feat(api): add refund-shield-responder polling worker"
```

---

## Task 15: SDK ingest endpoint — `POST /v1/sdk/sessions`

**Files:**
- Create: `apps/api/src/routes/sdk/sessions.ts`
- Create: `apps/api/src/routes/sdk/sessions.test.ts`
- Modify: barrel/router file that mounts SDK routes (find via `grep -r "/v1/sdk" apps/api/src/routes/`)

- [ ] **Step 15.1: Write the failing test**

```ts
// sessions.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../test-helpers/test-app";

const produceMock = vi.fn();
vi.mock("../../lib/kafka", () => ({
  produce: (...args: unknown[]) => produceMock(...args),
}));

describe("POST /v1/sdk/sessions", () => {
  it("produces events to rovenue.sdk-sessions topic and returns 202", async () => {
    const { app, publicKey } = await createTestApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${publicKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriberId: "00000000-0000-0000-0000-000000000001",
        events: [{
          type: "background",
          occurredAt: "2026-05-28T10:00:00.000Z",
          durationMs: 60000,
          appVersion: "1.0.0",
          sdkVersion: "0.6.0",
        }],
      }),
    });
    expect(res.status).toBe(202);
    expect(produceMock).toHaveBeenCalledWith("rovenue.sdk-sessions", expect.arrayContaining([
      expect.objectContaining({ subscriber_id: "00000000-0000-0000-0000-000000000001", event_type: "background" }),
    ]));
  });

  it("rejects without bearer", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/v1/sdk/sessions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects malformed body (Zod 400)", async () => {
    const { app, publicKey } = await createTestApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${publicKey}` },
      body: JSON.stringify({ subscriberId: "not-a-uuid", events: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when Kafka produce fails", async () => {
    produceMock.mockRejectedValueOnce(new Error("kafka down"));
    const { app, publicKey } = await createTestApp();
    const res = await app.request("/v1/sdk/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${publicKey}` },
      body: JSON.stringify({ subscriberId: "00000000-0000-0000-0000-000000000001", events: [{ type: "open", occurredAt: "2026-05-28T10:00:00Z", appVersion: "1", sdkVersion: "1" }] }),
    });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 15.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test routes/sdk/sessions`
Expected: FAIL.

- [ ] **Step 15.3: Implement the route**

```ts
// sessions.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { publicApiKey } from "../../middleware/public-api-key";
import { produce } from "../../lib/kafka";

const sessionEvent = z.object({
  type: z.enum(["open", "background", "close"]),
  occurredAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(32),
  sdkVersion: z.string().max(32),
});

const body = z.object({
  subscriberId: z.string().uuid(),
  events: z.array(sessionEvent).min(1).max(200),
});

export const sdkSessions = new Hono()
  .use("*", publicApiKey)
  .post("/", zValidator("json", body), async (c) => {
    const { subscriberId, events } = c.req.valid("json");
    const projectId = c.get("projectId");
    const rows = events.map((e) => ({
      project_id: projectId,
      subscriber_id: subscriberId,
      event_type: e.type,
      occurred_at: e.occurredAt,
      duration_ms: e.durationMs ?? 0,
      app_version: e.appVersion,
      sdk_version: e.sdkVersion,
    }));
    try {
      await produce("rovenue.sdk-sessions", rows);
    } catch (e) {
      c.get("logger").error({ err: e }, "sdk-sessions kafka produce failed");
      return c.json({ error: { code: "TELEMETRY_UNAVAILABLE", message: "retry" } }, 503);
    }
    return c.body(null, 202);
  });
```

If the public-API-key middleware in this codebase has a different name, swap it; use the same middleware as `POST /v1/subscribers/identify` (find it via grep).

- [ ] **Step 15.4: Mount the route**

Add to the SDK route barrel/index (find via `grep "/v1/sdk" apps/api/src/routes`):

```ts
import { sdkSessions } from "./sessions";
// ...
app.route("/v1/sdk/sessions", sdkSessions);
```

- [ ] **Step 15.5: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test routes/sdk/sessions`
Expected: All pass.

- [ ] **Step 15.6: Commit**

```bash
git add apps/api/src/routes/sdk/
git commit -m "feat(api): add POST /v1/sdk/sessions telemetry ingest"
```

---

## Task 16: Dashboard endpoint — settings GET/PUT

**Files:**
- Create: `apps/api/src/routes/dashboard/refund-shield/settings.ts`
- Create: `apps/api/src/routes/dashboard/refund-shield/refund-shield.test.ts` (covers all dashboard endpoints in this and following tasks)
- Modify: `apps/api/src/routes/dashboard/refund-shield/index.ts`

- [ ] **Step 16.1: Write the failing test for GET settings**

```ts
// refund-shield.test.ts
import { describe, expect, it } from "vitest";
import { createTestApp } from "../../../test-helpers/test-app";

describe("GET /api/dashboard/projects/:id/refund-shield/settings", () => {
  it("returns current settings for the project", async () => {
    const { app, session, projectId } = await createTestApp({ projectOverrides: {
      refundShieldEnabled: true,
      refundShieldResponseDelayMinutes: 90,
    }});
    const res = await app.request(`/api/dashboard/projects/${projectId}/refund-shield/settings`, {
      headers: { Cookie: session },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      enabled: true,
      responseDelayMinutes: 90,
      consentAcknowledgedAt: null,
    });
  });

  it("403s for non-owner viewer role", async () => {
    const { app, session, projectId } = await createTestApp({ role: "viewer" });
    const res = await app.request(`/api/dashboard/projects/${projectId}/refund-shield/settings`, {
      method: "PUT",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, responseDelayMinutes: 60 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/dashboard/projects/:id/refund-shield/settings", () => {
  it("enables Refund Shield and stamps consent metadata", async () => {
    const { app, session, projectId, db, userId } = await createTestApp({ role: "owner" });
    const res = await app.request(`/api/dashboard/projects/${projectId}/refund-shield/settings`, {
      method: "PUT",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, responseDelayMinutes: 45, consentAcknowledged: true }),
    });
    expect(res.status).toBe(200);
    const proj = await db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, projectId) });
    expect(proj?.refundShieldEnabled).toBe(true);
    expect(proj?.refundShieldResponseDelayMinutes).toBe(45);
    expect(proj?.refundShieldConsentAcknowledgedAt).toBeTruthy();
    expect(proj?.refundShieldConsentAcknowledgedBy).toBe(userId);
  });

  it("requires consentAcknowledged=true when enabling", async () => {
    const { app, session, projectId } = await createTestApp({ role: "owner" });
    const res = await app.request(`/api/dashboard/projects/${projectId}/refund-shield/settings`, {
      method: "PUT",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, responseDelayMinutes: 60, consentAcknowledged: false }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 16.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: FAIL.

- [ ] **Step 16.3: Implement settings handlers**

```ts
// settings.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { projects } from "@rovenue/db";
import { requireProjectRole } from "../../../middleware/require-project-role";
import { audit } from "../../../lib/audit";

const putBody = z.object({
  enabled: z.boolean(),
  responseDelayMinutes: z.number().int().min(30).max(360),
  consentAcknowledged: z.boolean().optional(),
});

export const refundShieldSettings = new Hono()
  .get("/", requireProjectRole(["owner", "admin", "viewer"]), async (c) => {
    const project = c.get("project");
    return c.json({ data: {
      enabled: project.refundShieldEnabled,
      responseDelayMinutes: project.refundShieldResponseDelayMinutes,
      consentAcknowledgedAt: project.refundShieldConsentAcknowledgedAt,
      consentAcknowledgedBy: project.refundShieldConsentAcknowledgedBy,
    }});
  })
  .put("/", requireProjectRole(["owner"]), zValidator("json", putBody), async (c) => {
    const body = c.req.valid("json");
    const project = c.get("project");
    const user = c.get("user");

    if (body.enabled && !body.consentAcknowledged) {
      return c.json({ error: { code: "CONSENT_REQUIRED", message: "consentAcknowledged must be true when enabling" } }, 400);
    }

    const updates: Partial<typeof projects.$inferInsert> = {
      refundShieldEnabled: body.enabled,
      refundShieldResponseDelayMinutes: body.responseDelayMinutes,
    };
    if (body.enabled && !project.refundShieldConsentAcknowledgedAt) {
      updates.refundShieldConsentAcknowledgedAt = new Date();
      updates.refundShieldConsentAcknowledgedBy = user.id;
    }

    await c.get("db").transaction(async (tx) => {
      await tx.update(projects).set(updates).where(eq(projects.id, project.id));
      await audit({
        tx, projectId: project.id,
        entityType: "project", entityId: project.id, action: "REFUND_SHIELD_SETTINGS_UPDATE",
        meta: { enabled: body.enabled, delay: body.responseDelayMinutes },
      });
    });

    return c.json({ data: { ok: true } });
  });
```

- [ ] **Step 16.4: Mount routes**

Create `apps/api/src/routes/dashboard/refund-shield/index.ts`:

```ts
import { Hono } from "hono";
import { refundShieldSettings } from "./settings";
import { refundShieldResponses } from "./responses";   // implemented in Task 17
import { refundShieldMetrics } from "./metrics";       // implemented in Task 18

export const refundShield = new Hono()
  .route("/settings", refundShieldSettings)
  .route("/responses", refundShieldResponses)
  .route("/metrics", refundShieldMetrics);
```

In `apps/api/src/routes/dashboard/index.ts`, mount under the project scope (follow the pattern of an existing per-project router):

```ts
import { refundShield } from "./refund-shield";
// ...
project.route("/refund-shield", refundShield);
```

- [ ] **Step 16.5: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: settings tests pass; responses + metrics tests still fail (next tasks).

- [ ] **Step 16.6: Commit**

```bash
git add apps/api/src/routes/dashboard/refund-shield/
git commit -m "feat(api): add Refund Shield settings GET/PUT dashboard endpoints"
```

---

## Task 17: Dashboard endpoint — responses list + detail

**Files:**
- Create: `apps/api/src/routes/dashboard/refund-shield/responses.ts`
- Modify: `apps/api/src/routes/dashboard/refund-shield/refund-shield.test.ts` — add tests

- [ ] **Step 17.1: Write the failing test**

```ts
describe("GET /api/dashboard/projects/:id/refund-shield/responses", () => {
  it("returns paginated list with filters", async () => {
    const { app, session, projectId, db } = await createTestApp({ role: "admin" });
    // seed 3 responses (one SENT outcome=REFUND_DECLINED, one SENT outcome=null, one PENDING)
    await seedResponses(db, projectId, [
      { status: "SENT", outcome: "REFUND_DECLINED", detectedAt: new Date("2026-05-27T10:00:00Z") },
      { status: "SENT", outcome: null,              detectedAt: new Date("2026-05-26T10:00:00Z") },
      { status: "PENDING", outcome: null,           detectedAt: new Date("2026-05-28T10:00:00Z") },
    ]);
    const res = await app.request(
      `/api/dashboard/projects/${projectId}/refund-shield/responses?status=SENT&limit=10`,
      { headers: { Cookie: session } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.responses).toHaveLength(2);
    expect(body.data.responses[0].status).toBe("SENT");
  });
});

describe("GET /api/dashboard/projects/:id/refund-shield/responses/:rid", () => {
  it("returns row + Apple payload + subscriber snapshot", async () => {
    const { app, session, projectId, db } = await createTestApp({ role: "admin" });
    const rid = await seedSingleResponse(db, projectId, { status: "SENT", requestPayload: { customerConsented: true } });
    const res = await app.request(
      `/api/dashboard/projects/${projectId}/refund-shield/responses/${rid}`,
      { headers: { Cookie: session } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.response.id).toBe(rid);
    expect(body.data.response.requestPayload).toEqual({ customerConsented: true });
  });

  it("404 for unknown response id", async () => {
    const { app, session, projectId } = await createTestApp({ role: "admin" });
    const res = await app.request(
      `/api/dashboard/projects/${projectId}/refund-shield/responses/00000000-0000-0000-0000-000000000000`,
      { headers: { Cookie: session } }
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 17.2: Run tests — expect failure**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: New tests fail.

- [ ] **Step 17.3: Implement responses handlers**

```ts
// responses.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, desc, lt, gte, lte } from "drizzle-orm";
import { refundShieldResponses } from "@rovenue/db";
import { requireProjectRole } from "../../../middleware/require-project-role";

const listQuery = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "SKIPPED_NOT_FOUND", "SKIPPED_DISABLED"]).optional(),
  outcome: z.enum(["REFUND_APPROVED", "REFUND_DECLINED", "REFUND_REVERSED"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(100).optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const refundShieldResponsesRoute = new Hono()
  .get("/", requireProjectRole(["owner", "admin", "viewer"]), zValidator("query", listQuery), async (c) => {
    const project = c.get("project");
    const q = c.req.valid("query");
    const where = [eq(refundShieldResponses.projectId, project.id)];
    if (q.status) where.push(eq(refundShieldResponses.status, q.status));
    if (q.outcome) where.push(eq(refundShieldResponses.outcome, q.outcome));
    if (q.from) where.push(gte(refundShieldResponses.detectedAt, new Date(q.from)));
    if (q.to) where.push(lte(refundShieldResponses.detectedAt, new Date(q.to)));
    if (q.search) where.push(eq(refundShieldResponses.appleTransactionId, q.search));
    if (q.cursor) where.push(lt(refundShieldResponses.detectedAt, new Date(q.cursor)));

    const rows = await c.get("db")
      .select().from(refundShieldResponses)
      .where(and(...where))
      .orderBy(desc(refundShieldResponses.detectedAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const slice = hasMore ? rows.slice(0, q.limit) : rows;
    return c.json({
      data: {
        responses: slice,
        nextCursor: hasMore ? slice[slice.length - 1].detectedAt.toISOString() : null,
      },
    });
  })
  .get("/:rid", requireProjectRole(["owner", "admin", "viewer"]), async (c) => {
    const rid = c.req.param("rid");
    const row = await c.get("db").query.refundShieldResponses.findFirst({
      where: (r, { and, eq }) => and(eq(r.id, rid), eq(r.projectId, c.get("project").id)),
    });
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "response not found" } }, 404);
    return c.json({ data: { response: row } });
  });

export { refundShieldResponsesRoute as refundShieldResponses };
```

Update the import in `index.ts` to match the export name.

- [ ] **Step 17.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: All settings + responses tests pass.

- [ ] **Step 17.5: Commit**

```bash
git add apps/api/src/routes/dashboard/refund-shield/responses.ts apps/api/src/routes/dashboard/refund-shield/refund-shield.test.ts apps/api/src/routes/dashboard/refund-shield/index.ts
git commit -m "feat(api): add Refund Shield responses list + detail endpoints"
```

---

## Task 18: Dashboard endpoint — metrics

**Files:**
- Create: `apps/api/src/routes/dashboard/refund-shield/metrics.ts`
- Modify: `refund-shield.test.ts` — add metric tests

- [ ] **Step 18.1: Write the failing test**

```ts
describe("GET /api/dashboard/projects/:id/refund-shield/metrics", () => {
  it("returns win rate, sent count, and estimated revenue saved", async () => {
    const { app, session, projectId, db } = await createTestApp({ role: "admin" });
    await seedResponses(db, projectId, [
      { status: "SENT", outcome: "REFUND_DECLINED", purchaseValueCents: 5000 },
      { status: "SENT", outcome: "REFUND_DECLINED", purchaseValueCents: 3000 },
      { status: "SENT", outcome: "REFUND_APPROVED", purchaseValueCents: 4000 },
      { status: "PENDING", outcome: null,           purchaseValueCents: 2000 },
    ]);

    const res = await app.request(
      `/api/dashboard/projects/${projectId}/refund-shield/metrics?from=2026-04-28T00:00:00Z&to=2026-05-28T23:59:59Z`,
      { headers: { Cookie: session } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      sent: 3,
      declined: 2,
      approved: 1,
      winRate: 2 / 3,
      estimatedRevenueSavedCents: 8000, // sum of declined purchase values
    });
  });
});
```

You will need a `purchaseValueCents` join from `purchases.priceCents` (or whichever existing column tracks the order amount); the test helper `seedResponses` can seed both the `purchases` row and the response.

- [ ] **Step 18.2: Run test — expect failure**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: Metrics test fails.

- [ ] **Step 18.3: Implement metrics handler**

```ts
// metrics.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireProjectRole } from "../../../middleware/require-project-role";

const query = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export const refundShieldMetrics = new Hono()
  .get("/", requireProjectRole(["owner", "admin", "viewer"]), zValidator("query", query), async (c) => {
    const project = c.get("project");
    const q = c.req.valid("query");

    const result = await c.get("db").execute(sql`
      SELECT
        count(*) FILTER (WHERE r.status = 'SENT')                                        AS sent,
        count(*) FILTER (WHERE r.outcome = 'REFUND_DECLINED')                            AS declined,
        count(*) FILTER (WHERE r.outcome = 'REFUND_APPROVED')                            AS approved,
        coalesce(sum(p.price_cents) FILTER (WHERE r.outcome = 'REFUND_DECLINED'), 0)    AS estimated_revenue_saved_cents
      FROM refund_shield_responses r
      LEFT JOIN purchases p ON p.original_transaction_id = r.apple_original_transaction_id
      WHERE r.project_id = ${project.id}
        AND r.detected_at >= ${q.from}
        AND r.detected_at <= ${q.to}
    `);
    const row = (result as { rows: any[] }).rows[0];
    const decided = Number(row.declined) + Number(row.approved);
    const winRate = decided === 0 ? 0 : Number(row.declined) / decided;

    return c.json({
      data: {
        sent: Number(row.sent),
        declined: Number(row.declined),
        approved: Number(row.approved),
        winRate,
        estimatedRevenueSavedCents: Number(row.estimated_revenue_saved_cents),
      },
    });
  });
```

- [ ] **Step 18.4: Run tests to confirm pass**

Run: `pnpm --filter @rovenue/api test routes/dashboard/refund-shield`
Expected: All dashboard tests pass.

- [ ] **Step 18.5: Commit**

```bash
git add apps/api/src/routes/dashboard/refund-shield/metrics.ts apps/api/src/routes/dashboard/refund-shield/refund-shield.test.ts
git commit -m "feat(api): add Refund Shield metrics endpoint"
```

---

## Task 19: Observability — Prometheus metrics declaration

**Files:**
- Modify: `apps/api/src/lib/metrics.ts` (or wherever the metrics registry lives — grep `counter` definitions)

- [ ] **Step 19.1: Locate the metrics registry**

Run: `grep -rn "counter(" apps/api/src/lib/ apps/api/src/services/ | head -20`
Identify the metrics module pattern. Add new metric registrations.

- [ ] **Step 19.2: Register Refund Shield metrics**

Add to the metrics module:

```ts
metrics.registerCounter("refund_shield.received", ["project_id"]);
metrics.registerCounter("refund_shield.sent", ["project_id"]);
metrics.registerCounter("refund_shield.failed", ["project_id", "reason"]);
metrics.registerCounter("refund_shield.outcome.approved", ["project_id"]);
metrics.registerCounter("refund_shield.outcome.declined", ["project_id"]);
metrics.registerCounter("refund_shield.outcome.reversed", ["project_id"]);
metrics.registerHistogram("refund_shield.sla_remaining_seconds",
  [60, 300, 1800, 3600, 7200, 21600, 43200]);
```

If your metrics module uses a different API (e.g., `new Counter({...})` from prom-client), adapt accordingly.

- [ ] **Step 19.3: Wire `received` counter at webhook handler**

In `applyConsumptionRequest` (Task 10), after the insert, add:

```ts
metrics.counter("refund_shield.received", { project_id: project.id }).inc();
```

- [ ] **Step 19.4: Wire `outcome.*` counters at outcome cases**

In the three outcome handlers (Task 11), increment the matching counter (`refund_shield.outcome.approved`, `.declined`, `.reversed`) after the UPDATE.

- [ ] **Step 19.5: Commit**

```bash
git add apps/api/src/lib/metrics.ts apps/api/src/services/apple/apple-webhook.ts
git commit -m "feat(api): emit Refund Shield observability metrics"
```

---

## Task 20: End-to-end integration test

**Files:**
- Create: `apps/api/tests/integration/refund-shield.integration.test.ts`

- [ ] **Step 20.1: Write the integration test**

```ts
// refund-shield.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupIntegrationStack } from "../../src/test-helpers/integration-stack"; // existing helper for testcontainers
import { startMockAppleServer } from "../../src/test-helpers/mock-apple-server"; // new — WireMock-style stub server
import { runRefundShieldResponderTick } from "../../src/workers/refund-shield-responder";

describe("Refund Shield — end-to-end", () => {
  let stack: Awaited<ReturnType<typeof setupIntegrationStack>>;
  let appleStub: Awaited<ReturnType<typeof startMockAppleServer>>;

  beforeAll(async () => {
    stack = await setupIntegrationStack(); // brings up Postgres, ClickHouse, Kafka
    appleStub = await startMockAppleServer();
    vi.stubEnv("APPLE_SERVER_API_BASE", appleStub.baseUrl);
  });

  afterAll(async () => {
    await appleStub.stop();
    await stack.teardown();
  });

  it("CONSUMPTION_REQUEST → enqueue → worker → Apple POST → outcome update", async () => {
    const { db, ch } = stack;
    const project = await stack.makeProject({ refundShieldEnabled: true, refundShieldConsentAcknowledgedAt: new Date(), refundShieldResponseDelayMinutes: 0 });
    const sub = await stack.makeSubscriber({ projectId: project.id, appleAppAccountToken: "550e8400-e29b-41d4-a716-446655440000", firstSeenAt: new Date(Date.now() - 100 * 86_400_000) });
    await stack.makePurchase({ subscriberId: sub.id, originalTransactionId: "1000000999", priceCents: 9999 });
    // emit some session events to Kafka and wait for CH ingest
    await stack.emitSessionEvents([{
      project_id: project.id, subscriber_id: sub.id, event_type: "background",
      occurred_at: new Date().toISOString(), duration_ms: 60 * 60_000, app_version: "1.0.0", sdk_version: "0.6.0",
    }]);
    await stack.waitForCh("sdk_sessions_daily_tbl", 1);

    appleStub.expect("PUT", "/inApps/v1/transactions/consumption/1000000999").reply(202);

    // simulate Apple sending CONSUMPTION_REQUEST
    const jws = stack.signNotification({
      notificationType: "CONSUMPTION_REQUEST",
      notificationUUID: "uuid-int-1",
      transactionInfo: {
        appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
        originalTransactionId: "1000000999",
        transactionId: "1000000999",
      },
    });
    const webhookRes = await stack.app.request(`/api/webhooks/apple/${project.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedPayload: jws }),
    });
    expect(webhookRes.status).toBe(200);

    // run worker tick
    await runRefundShieldResponderTick({ db, ch, now: new Date() });

    // verify SENT
    const row = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-int-1"),
    });
    expect(row?.status).toBe("SENT");
    expect(row?.requestPayload).toMatchObject({ refundPreference: 2, accountTenure: 5 });

    // simulate Apple's eventual REFUND_DECLINED_NOTIFICATION
    const declinedJws = stack.signNotification({
      notificationType: "REFUND_DECLINED_NOTIFICATION",
      notificationUUID: "uuid-int-2",
      transactionInfo: { originalTransactionId: "1000000999", transactionId: "1000000999" },
    });
    await stack.app.request(`/api/webhooks/apple/${project.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedPayload: declinedJws }),
    });
    const after = await db.query.refundShieldResponses.findFirst({
      where: (r, { eq }) => eq(r.appleNotificationUuid, "uuid-int-1"),
    });
    expect(after?.outcome).toBe("REFUND_DECLINED");

    // verify metrics
    const m = await stack.app.request("/internal/metrics");
    const text = await m.text();
    expect(text).toContain('refund_shield_sent_total{project_id="' + project.id + '"} 1');
    expect(text).toContain('refund_shield_outcome_declined_total{project_id="' + project.id + '"} 1');
  });
});
```

If `startMockAppleServer` doesn't exist yet, build a minimal Hono-based mock with `expect/reply` API in `apps/api/src/test-helpers/mock-apple-server.ts`. Keep it under 60 lines — just enough to capture and assert PUTs.

- [ ] **Step 20.2: Run integration test**

Run: `pnpm --filter @rovenue/api test:integration -- refund-shield`
Expected: Pass (may take 60-90s for containers to start).

- [ ] **Step 20.3: Commit**

```bash
git add apps/api/tests/integration/refund-shield.integration.test.ts apps/api/src/test-helpers/mock-apple-server.ts
git commit -m "test(api): end-to-end Refund Shield integration test"
```

---

## Final verification

- [ ] **Step F.1: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass, no regressions.

- [ ] **Step F.2: Run type check**

Run: `pnpm build` (or `pnpm typecheck` if available)
Expected: No type errors.

- [ ] **Step F.3: Verify nothing broke at the API boot**

Run: `pnpm --filter @rovenue/api dev` and watch logs for ~30 seconds.
Expected: Refund Shield responder worker logs "tick" lines at the configured cadence; no crashes.

- [ ] **Step F.4: Stage manual sanity check**

Connect to staging (or local dev) Postgres and run:
```sql
SELECT count(*) FROM refund_shield_responses WHERE detected_at > now() - interval '1 day';
```
Expected: 0 (no real Apple traffic yet). Then `\d refund_shield_responses` to confirm schema.

This plan terminates here. Plans 2 (RN SDK) and 3 (Dashboard UI) cover the remaining feature surface and can be authored next.
