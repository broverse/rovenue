# Idempotent Revenue Aggregates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClickHouse revenue/credit money aggregates idempotent under at-least-once outbox delivery, so a duplicate `eventId` can never double-count MRR, lifetime revenue, or credit flow.

**Architecture:** Drop the four additive rollups (`mv_mrr_daily`, `mv_credit_consumption_daily`, `mv_credit_balance`, `revenue_lifetime_subscriber`) whose materialized views sum per-insert-block *before* `ReplacingMergeTree` dedup. Replace each with a query-time `VIEW` over the deduped raw tables: time-series + balance views use `FINAL`; the Refund Shield per-subscriber lifetime view dedups via `GROUP BY eventId` (no `FINAL`) so a new `(projectId, subscriberId)` projection on `raw_revenue_events` serves it as an index seek. Three read paths repoint to the new views.

**Tech Stack:** ClickHouse 24.3, `@clickhouse/client`, Vitest + testcontainers, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-29-idempotent-revenue-aggregates-design.md`

**Scope note (verified against the codebase):** Only three read paths touch the broken rollups — `apps/api/src/services/metrics/mrr.ts`, `apps/api/src/services/metrics/credits.ts` (one of two queries), and `apps/api/src/services/refund-shield/aggregate-signals.ts`. `overview.ts`, `digest-kpi.ts`, `leaderboards.ts`, and `routes/dashboard/metrics.ts` already query `raw_* FINAL` (or delegate to `mrr.ts`) and are already idempotent — they are NOT changed.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/db/clickhouse/migrations/0012_idempotent_revenue_aggregates.sql` | Drop 4 rollups, create 4 views, add projection | Create |
| `apps/api/tests/revenue-aggregates-idempotency.integration.test.ts` | Duplicate-`eventId` regression guard | Create |
| `apps/api/src/services/metrics/mrr.ts` | Daily MRR read | Modify query → `v_mrr_daily` |
| `apps/api/src/services/metrics/credits.ts` | Credit volume read | Modify query → `v_credit_consumption_daily` |
| `apps/api/src/services/refund-shield/aggregate-signals.ts` | Lifetime $ read | Modify query → `v_revenue_lifetime_subscriber` |
| `packages/db/scripts/verify-clickhouse.ts` | Schema parity list | Modify expected-objects list |
| `apps/api/tests/mrr-clickhouse-only.integration.test.ts` | Existing MRR e2e test | Modify rollup references |
| `apps/api/tests/outbox-revenue-credit-replay.integration.test.ts` | Existing replay test | Modify rollup references |
| `docs/architecture/outbox-dispatcher.md` | Risk doc | Modify: mark revenue idempotent |

---

## Task 1: Idempotency regression test + migration

This is the crux task: a duplicate-`eventId` regression test (RED because the views don't exist), then the migration that creates them (GREEN). The test uses a ClickHouse-only testcontainer (no Kafka) and inserts duplicate rows directly into the raw tables — `FINAL` / `GROUP BY eventId` dedup at query time, so no merge wait is needed.

**Files:**
- Create: `apps/api/tests/revenue-aggregates-idempotency.integration.test.ts`
- Create: `packages/db/clickhouse/migrations/0012_idempotent_revenue_aggregates.sql`

- [ ] **Step 1: Write the failing regression test**

Create `apps/api/tests/revenue-aggregates-idempotency.integration.test.ts`. The migration-runner block is copied verbatim from `apps/api/tests/mrr-clickhouse-only.integration.test.ts` (lines 163–261) — the same statement splitter and Kafka-table wait. Use a distinct host port (`8229`) to avoid colliding with the MRR test.

```typescript
// =============================================================
// Revenue/credit aggregate idempotency — duplicate eventId must
// not double-count. Inserts the SAME eventId twice directly into
// the raw ReplacingMergeTree tables and asserts each query-time
// view (0012) collapses it to one contribution.
//
// CH-only (no Kafka): FINAL / GROUP BY eventId dedup at query time,
// so no merge wait is required.
//
// Fixed host port: CH_HOST_PORT = 8229 (not parallel-safe).
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;
const CH_HOST_PORT = 8229;

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
}

beforeAll(async () => {
  clickhouse = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  let stable = 0;
  await waitFor(async () => {
    try {
      const c = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test" });
      const res = await c.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
      const rows = (await res.json()) as Array<{ ok: number }>;
      await c.close();
      if (rows[0]?.ok === 1) { stable++; return stable >= 3; }
      stable = 0; return false;
    } catch { stable = 0; return false; }
  }, 45_000);

  // --- migration runner (verbatim from mrr-clickhouse-only.integration.test.ts) ---
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "default", request_timeout: 60_000 });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (filename String, sha256 FixedString(64), applied_at DateTime64(3,'UTC') DEFAULT now64(3,'UTC')) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const chMig = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
  const migrationsDir = join(process.cwd(), "..", "..", "packages", "db", "clickhouse", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content.split(/;\s*$/m).map((s) => {
      const lines = s.split("\n");
      const i = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("--"));
      return i >= 0 ? lines.slice(i).join("\n").trim() : "";
    }).filter((s) => s.length > 0);
    for (const statement of statements) {
      await chMig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbN, tN] = m[1]!.includes(".") ? m[1]!.split(".") : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await chMig.query({ query: `SELECT count() AS c FROM system.tables WHERE database='${dbN}' AND name='${tN}'`, format: "JSONEachRow" });
            const rows = (await res.json()) as Array<{ c: string | number }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await chMig.insert({ table: "_migrations", values: [{ filename, sha256 }], format: "JSONEachRow" });
  }
  await chMig.close();

  ch = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
}, 300_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
});

describe("revenue/credit aggregate idempotency", () => {
  it("does not double-count a duplicate eventId", async () => {
    const RUN = Date.now();
    const projectId = `prj_idem_${RUN}`;
    const subscriberId = `sub_idem_${RUN}`;
    const revEventId = `evt_rev_${RUN}`;
    const credEventId = `evt_cred_${RUN}`;

    // Same revenue eventId inserted TWICE (duplicate delivery). _version differs
    // so ReplacingMergeTree keeps the newer; the dollar figure must count ONCE.
    const revRow = (version: number) => ({
      eventId: revEventId,
      revenueEventId: `rev_${RUN}`,
      projectId, subscriberId,
      purchaseId: `pur_${RUN}`, productId: `prod_${RUN}`,
      type: "INITIAL", store: "APP_STORE",
      amount: "5.0000", amountUsd: "5.0000", currency: "USD",
      eventDate: "2026-05-01 00:00:00.000",
      ingestedAt: "2026-05-01 00:00:00.000",
      _version: version,
    });
    await ch.insert({ table: "raw_revenue_events", values: [revRow(1)], format: "JSONEachRow" });
    await ch.insert({ table: "raw_revenue_events", values: [revRow(2)], format: "JSONEachRow" });

    const credRow = (version: number) => ({
      eventId: credEventId,
      creditLedgerId: `cl_${RUN}`,
      projectId, subscriberId,
      type: "PURCHASE", amount: 100, balance: 100,
      referenceType: "purchase", referenceId: `pur_${RUN}`,
      createdAt: "2026-05-01 00:00:00.000",
      ingestedAt: "2026-05-01 00:00:00.000",
      _version: version,
    });
    await ch.insert({ table: "raw_credit_ledger", values: [credRow(1)], format: "JSONEachRow" });
    await ch.insert({ table: "raw_credit_ledger", values: [credRow(2)], format: "JSONEachRow" });

    const one = async (sql: string): Promise<Record<string, string>> => {
      const res = await ch.query({ query: sql, query_params: { pid: projectId, sid: subscriberId }, format: "JSONEachRow" });
      const rows = (await res.json()) as Array<Record<string, string>>;
      return rows[0] ?? {};
    };

    // v_mrr_daily: gross_usd = 5 (counted once), event_count = 1, active_subscribers = 1
    const mrr = await one(`SELECT toString(gross_usd) AS gross_usd, toUInt64(event_count) AS event_count, toUInt64(active_subscribers) AS active_subscribers FROM rovenue.v_mrr_daily WHERE projectId = {pid:String}`);
    expect(Number(mrr.gross_usd)).toBeCloseTo(5, 2);
    expect(Number(mrr.event_count)).toBe(1);
    expect(Number(mrr.active_subscribers)).toBe(1);

    // v_revenue_lifetime_subscriber: purchased = 500 cents (once)
    const life = await one(`SELECT toString(lifetime_dollars_purchased_cents) AS purchased FROM rovenue.v_revenue_lifetime_subscriber WHERE projectId = {pid:String} AND subscriberId = {sid:String}`);
    expect(Number(life.purchased)).toBe(500);

    // v_credit_consumption_daily: granted = 100 (once)
    const cons = await one(`SELECT toString(granted_credits) AS granted, toUInt64(event_count) AS event_count FROM rovenue.v_credit_consumption_daily WHERE projectId = {pid:String}`);
    expect(Number(cons.granted)).toBe(100);
    expect(Number(cons.event_count)).toBe(1);

    // v_credit_balance: total_granted = 100, latest_balance = 100 (once)
    const bal = await one(`SELECT toString(total_granted) AS total_granted, toString(latest_balance) AS latest_balance FROM rovenue.v_credit_balance WHERE projectId = {pid:String} AND subscriberId = {sid:String}`);
    expect(Number(bal.total_granted)).toBe(100);
    expect(Number(bal.latest_balance)).toBe(100);
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- revenue-aggregates-idempotency`
Expected: FAIL — the migration applies cleanly through `0011`, but the queries error with `Table rovenue.v_mrr_daily doesn't exist` (the `0012` views don't exist yet).

- [ ] **Step 3: Write the migration**

Create `packages/db/clickhouse/migrations/0012_idempotent_revenue_aggregates.sql`:

```sql
-- 0012_idempotent_revenue_aggregates.sql
-- Replace the additive money rollups (SummingMergeTree / AggregatingMergeTree
-- sum-state) with query-time views over the deduped raw ReplacingMergeTree
-- tables, so an at-least-once duplicate delivery (same eventId) is collapsed
-- BEFORE it is ever summed. The Kafka->raw ingestion MVs (0004 mv_revenue_to_raw,
-- 0005 mv_credit_to_raw) are already idempotent and are left untouched.
-- See docs/superpowers/specs/2026-05-29-idempotent-revenue-aggregates-design.md

-- Drop the broken rollups (materialized view first, then its target table).
DROP VIEW IF EXISTS rovenue.mv_mrr_daily;
DROP TABLE IF EXISTS rovenue.mv_mrr_daily_target;

DROP VIEW IF EXISTS rovenue.mv_credit_consumption_daily;
DROP TABLE IF EXISTS rovenue.mv_credit_consumption_daily_target;

DROP VIEW IF EXISTS rovenue.mv_credit_balance;
DROP TABLE IF EXISTS rovenue.mv_credit_balance_target;

DROP VIEW IF EXISTS rovenue.revenue_lifetime_subscriber_mv;
DROP TABLE IF EXISTS rovenue.revenue_lifetime_subscriber_tbl;

-- Daily MRR — query-time over deduped raw. FINAL collapses duplicate eventIds
-- before summation; uniq() replaces the former uniqState/uniqMerge pair.
CREATE VIEW IF NOT EXISTS rovenue.v_mrr_daily AS
SELECT
  projectId,
  toDate(eventDate) AS day,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))                                AS gross_usd,
  sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))                                    AS refunds_usd,
  sumIf(amountUsd, type NOT IN ('REFUND', 'CHARGEBACK'))
    - sumIf(amountUsd, type IN ('REFUND', 'CHARGEBACK'))                                AS net_usd,
  count()                                                                              AS event_count,
  uniq(subscriberId)                                                                   AS active_subscribers
FROM rovenue.raw_revenue_events FINAL
GROUP BY projectId, day;

-- Daily credit flow — query-time over deduped raw.
CREATE VIEW IF NOT EXISTS rovenue.v_credit_consumption_daily AS
SELECT
  projectId,
  toDate(createdAt) AS day,
  sumIf(amount, amount > 0)   AS granted_credits,
  sumIf(-amount, amount < 0)  AS debited_credits,
  sum(amount)                 AS net_flow,
  count()                     AS event_count,
  uniq(subscriberId)          AS active_subscribers
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, day;

-- Per-subscriber credit balance snapshot — analytics read only (the
-- authoritative entitlement balance is served from Postgres, not this view).
CREATE VIEW IF NOT EXISTS rovenue.v_credit_balance AS
SELECT
  projectId,
  subscriberId,
  argMax(balance, createdAt)  AS latest_balance,
  sumIf(amount, amount > 0)   AS total_granted,
  sumIf(-amount, amount < 0)  AS total_debited,
  max(createdAt)              AS last_activity_at
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, subscriberId;

-- Per-subscriber lifetime revenue — Refund Shield hot path. Dedup via
-- GROUP BY eventId (NOT FINAL) so the proj_by_subscriber projection can serve
-- the per-(projectId, subscriberId) lookup as an index seek. Business fields
-- for a given eventId are immutable (Postgres revenue_events is append-only),
-- so any() of the deduped row is safe.
CREATE VIEW IF NOT EXISTS rovenue.v_revenue_lifetime_subscriber AS
SELECT
  projectId,
  subscriberId,
  sumIf(amt_cents, type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CREDIT_PURCHASE')) AS lifetime_dollars_purchased_cents,
  sumIf(amt_cents, type = 'REFUND')                                                       AS lifetime_dollars_refunded_cents
FROM
(
  SELECT
    eventId,
    any(projectId)                  AS projectId,
    any(subscriberId)               AS subscriberId,
    any(type)                       AS type,
    any(toUInt64(amountUsd * 100))  AS amt_cents
  FROM rovenue.raw_revenue_events
  GROUP BY eventId
)
GROUP BY projectId, subscriberId;

-- Projection so the lifetime per-subscriber lookup is an index seek rather than
-- a project-wide scan. Applies to all future inserts; no MATERIALIZE needed on
-- an empty table.
ALTER TABLE rovenue.raw_revenue_events
  ADD PROJECTION IF NOT EXISTS proj_by_subscriber
  (SELECT * ORDER BY (projectId, subscriberId));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- revenue-aggregates-idempotency`
Expected: PASS — every aggregate counts the duplicate `eventId` exactly once (gross_usd 5, lifetime 500, granted 100, event_count 1).

- [ ] **Step 5: Commit**

```bash
git add packages/db/clickhouse/migrations/0012_idempotent_revenue_aggregates.sql apps/api/tests/revenue-aggregates-idempotency.integration.test.ts
git commit -m "feat(db): idempotent query-time revenue/credit aggregates (CH)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Repoint `listDailyMrr` to `v_mrr_daily`

**Files:**
- Modify: `apps/api/src/services/metrics/mrr.ts:35-47`
- Modify: `apps/api/tests/mrr-clickhouse-only.integration.test.ts:320-328` (the `waitFor` query referencing the dropped table)

- [ ] **Step 1: Update the existing MRR e2e test's wait query**

In `apps/api/tests/mrr-clickhouse-only.integration.test.ts`, the `waitFor` block (lines 320–328) polls the dropped `mv_mrr_daily_target`. Replace its inner query so it polls the new view:

```typescript
      await waitFor(async () => {
        const rows = await queryAnalytics<{ c: string }>(
          projectId,
          `SELECT count() AS c
             FROM rovenue.v_mrr_daily
            WHERE projectId = {projectId:String}`,
        );
        return Number(rows[0]?.c ?? 0) >= 2;
      }, 90_000);
```

(The `listDailyMrr` assertions below it are unchanged — the response shape is identical.)

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- mrr-clickhouse-only`
Expected: FAIL — `listDailyMrr` still queries `mv_mrr_daily_target FINAL` (dropped by `0012`), so the query errors with `Table rovenue.mv_mrr_daily_target doesn't exist`.

- [ ] **Step 3: Update the query in `mrr.ts`**

Replace the `sql` template in `listDailyMrr` (lines 35–47) with a read of the pre-grouped view (no `FINAL`, no `uniqMerge`, no `GROUP BY` — the view already groups by `projectId, day`):

```typescript
  const sql = `
    SELECT
      toStartOfDay(day)               AS bucket,
      toString(gross_usd)             AS gross_usd,
      toUInt64(event_count)           AS event_count,
      toUInt64(active_subscribers)    AS active_subscribers
    FROM rovenue.v_mrr_daily
    WHERE projectId = {projectId:String}
      AND day >= {from:Date}
      AND day <= {to:Date}
    ORDER BY day ASC
  `;
```

(The `ChMrrRow` interface and the `rows.map(...)` projection are unchanged — `gross_usd`, `event_count`, `active_subscribers` aliases match the view's columns.)

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- mrr-clickhouse-only`
Expected: PASS — all three cases (shape, freshness, empty) pass against `v_mrr_daily`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/mrr.ts apps/api/tests/mrr-clickhouse-only.integration.test.ts
git commit -m "fix(api): read daily MRR from idempotent v_mrr_daily view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Repoint credit volume to `v_credit_consumption_daily`

**Files:**
- Modify: `apps/api/src/services/metrics/credits.ts:83-95`

- [ ] **Step 1: Update the query in `readVolume`**

In `apps/api/src/services/metrics/credits.ts`, the `readVolume` query (lines 83–95) reads the dropped `mv_credit_consumption_daily_target FINAL`. The new view is pre-grouped per `projectId, day`, so the outer `sum(...)` + `GROUP BY day` collapses to direct column reads:

```typescript
    `
      SELECT
        toString(day)                  AS day,
        toString(granted_credits)      AS issued,
        toString(debited_credits)      AS burned,
        toString(net_flow)             AS net
      FROM rovenue.v_credit_consumption_daily
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      ORDER BY day ASC
    `,
```

(The `ChVolumeRow` interface and the `byDay` map / windowing logic below are unchanged — aliases `day`, `issued`, `burned`, `net` are preserved.)

- [ ] **Step 2: Verify there is no compile error and the file's other CH query is untouched**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep credits.ts || echo "no credits.ts type errors"`
Expected: `no credits.ts type errors`. (The second query in this file, at the old line ~136, reads `raw_revenue_events FINAL` and is already idempotent — do NOT change it.)

- [ ] **Step 3: Run the credits metrics test if present, else the idempotency guard**

Run: `pnpm --filter @rovenue/api test -- credits`
Expected: PASS, or — if no dedicated `credits` CH test exists — no test matches; rely on Task 1's `v_credit_consumption_daily` assertion (which already proves the view is correct) plus the typecheck in Step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/metrics/credits.ts
git commit -m "fix(api): read credit volume from idempotent v_credit_consumption_daily view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Repoint Refund Shield lifetime read to `v_revenue_lifetime_subscriber`

**Files:**
- Modify: `apps/api/src/services/refund-shield/aggregate-signals.ts:166-176`

- [ ] **Step 1: Update the lifetime revenue query**

In `apps/api/src/services/refund-shield/aggregate-signals.ts`, the `revenueResult` query reads the dropped `revenue_lifetime_subscriber_tbl`. Point it at the new view — the column names and `sum(...)` wrappers stay identical (the view exposes the same two columns; `sum()` over the view's single per-subscriber row is a harmless no-op that preserves the exact result shape):

```typescript
  const revenueResult = await input.ch.query({
    query: `
      SELECT
        coalesce(sum(lifetime_dollars_purchased_cents), 0) AS lifetime_dollars_purchased_cents,
        coalesce(sum(lifetime_dollars_refunded_cents), 0)  AS lifetime_dollars_refunded_cents
      FROM v_revenue_lifetime_subscriber
      WHERE projectId = {pid:String} AND subscriberId = {sid:String}
    `,
    query_params: { pid: input.projectId, sid: input.subscriberId },
    format: "JSONEachRow",
  });
```

(`ChRevenueRow` and the `revenue` mapping below are unchanged.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep aggregate-signals.ts || echo "no aggregate-signals.ts type errors"`
Expected: `no aggregate-signals.ts type errors`.

- [ ] **Step 3: Run the refund-shield tests if present**

Run: `pnpm --filter @rovenue/api test -- aggregate-signals refund-shield`
Expected: PASS for any test that stubs/queries the lifetime read; if a test hard-codes the old table name in a fixture, update that reference to `v_revenue_lifetime_subscriber`. (Task 1 already proves the view's correctness end-to-end.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/refund-shield/aggregate-signals.ts
git commit -m "fix(api): read lifetime revenue from idempotent v_revenue_lifetime_subscriber view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update the ClickHouse schema parity list

**Files:**
- Modify: `packages/db/scripts/verify-clickhouse.ts:83-101`

- [ ] **Step 1: Replace the four rollup pairs with the four views**

In `packages/db/scripts/verify-clickhouse.ts`, the expected-objects array currently lists (lines 83–101) the dropped rollup MV+target pairs. Remove these eight entries:

```typescript
  // Plan 2 — MRR rollup
  { name: "mv_mrr_daily_target", engine: "SummingMergeTree" },
  { name: "mv_mrr_daily", engine: "MaterializedView" },
  // Plan 2 — credit balance rollup
  { name: "mv_credit_balance_target", engine: "AggregatingMergeTree" },
  { name: "mv_credit_balance", engine: "MaterializedView" },
  // Plan 2 — credit consumption rollup
  { name: "mv_credit_consumption_daily_target", engine: "SummingMergeTree" },
  { name: "mv_credit_consumption_daily", engine: "MaterializedView" },
```

and (further down, the lifetime pair):

```typescript
  // Plan 3 — Refund Shield per-subscriber lifetime revenue rollup
  { name: "revenue_lifetime_subscriber_tbl", engine: "SummingMergeTree" },
  { name: "revenue_lifetime_subscriber_mv", engine: "MaterializedView" },
```

Replace ALL of the above with these four view entries (a regular `VIEW` reports engine `View` in `system.tables`):

```typescript
  // 0012 — idempotent query-time revenue/credit aggregates (replace rollups)
  { name: "v_mrr_daily", engine: "View" },
  { name: "v_credit_consumption_daily", engine: "View" },
  { name: "v_credit_balance", engine: "View" },
  { name: "v_revenue_lifetime_subscriber", engine: "View" },
```

Leave the `raw_*`, `*_queue`, `mv_*_to_raw`, and `sdk_sessions_*` entries untouched.

- [ ] **Step 2: Typecheck the script**

Run: `pnpm --filter @rovenue/db exec tsc --noEmit -p tsconfig.json 2>&1 | grep verify-clickhouse.ts || echo "no verify-clickhouse.ts type errors"`
Expected: `no verify-clickhouse.ts type errors`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/scripts/verify-clickhouse.ts
git commit -m "chore(db): update CH parity list for idempotent aggregate views

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Fix the existing replay test's dropped-table references

**Files:**
- Modify: `apps/api/tests/outbox-revenue-credit-replay.integration.test.ts`

- [ ] **Step 1: Find every dropped-table reference**

Run: `grep -n "mv_mrr_daily_target\|mv_mrr_daily\|mv_credit_balance_target\|mv_credit_balance\|mv_credit_consumption_daily_target\|revenue_lifetime_subscriber_tbl\|uniqMerge\|argMaxMerge\|sumMerge" apps/api/tests/outbox-revenue-credit-replay.integration.test.ts`
Expected: one or more lines (the test asserts revenue/credit landed in the rollups).

- [ ] **Step 2: Repoint each reference to the new views, dropping `FINAL`/`*Merge`**

Read the file and rewrite each rollup query to its view equivalent, preserving the test's intent (that the value landed once):
- `FROM rovenue.mv_mrr_daily_target FINAL` + `uniqMerge(subscribersHll)` → `FROM rovenue.v_mrr_daily` + `active_subscribers` (drop `FINAL`, drop the `GROUP BY ... gross_usd, event_count` tail if it was only there for the SummingMergeTree merge).
- `FROM rovenue.mv_credit_balance_target ...` + `argMaxMerge(latestBalanceState)` / `sumMerge(totalGrantedState)` → `FROM rovenue.v_credit_balance` + `latest_balance` / `total_granted` (drop `FINAL`/`*Merge`).
- Any `mv_credit_consumption_daily_target` → `v_credit_consumption_daily` with `granted_credits`/`debited_credits`/`net_flow`.
- `revenue_lifetime_subscriber_tbl` → `v_revenue_lifetime_subscriber`.

Keep all numeric expectations the same — the views return the same values for non-duplicate data.

- [ ] **Step 3: Run the replay test**

Run: `pnpm --filter @rovenue/api test -- outbox-revenue-credit-replay`
Expected: PASS — the replay assertions now read the views; values are unchanged for single-delivery data, and a replayed duplicate (the test's scenario) no longer inflates them.

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/outbox-revenue-credit-replay.integration.test.ts
git commit -m "test(api): point replay test at idempotent aggregate views

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update the outbox risk doc

**Files:**
- Modify: `docs/architecture/outbox-dispatcher.md`

- [ ] **Step 1: Mark the revenue aggregates as fixed**

In `docs/architecture/outbox-dispatcher.md`, update the section that warns the summed CH aggregates double-count. Replace the ⚠️ "not safe" finding with: as of migration `0012` (2026-05-29), the four money aggregates are query-time views over the deduped raw `ReplacingMergeTree` tables (`v_mrr_daily`, `v_credit_consumption_daily`, `v_credit_balance`, `v_revenue_lifetime_subscriber`), so a duplicate `eventId` is collapsed before summation and the at-least-once dispatcher can no longer inflate revenue/credit totals. Keep the "single-leader dispatcher gate is still deferred (reduces duplicate *rate*, not correctness)" note, since the delivery layer is unchanged.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/outbox-dispatcher.md
git commit -m "docs(architecture): outbox revenue aggregates now idempotent (0012)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** single-source-of-truth raw tables → Task 1 views; `FINAL` for time-series/balance + `GROUP BY eventId` for lifetime → Task 1 migration; `(projectId, subscriberId)` projection → Task 1 migration; 3 read-path updates → Tasks 2/3/4; `verify-clickhouse.ts` → Task 5; duplicate-`eventId` regression test → Task 1; existing-test fixups → Tasks 2 & 6; doc update → Task 7. All spec sections covered.
- **Scope correction vs spec:** the spec listed 7 read paths; verified only 3 actually read the broken rollups (the other 4 already use `raw_* FINAL`). Tasks updated accordingly — no wasted edits.
- **Placeholder scan:** all SQL and TypeScript edits are shown in full. Task 6 reads the target file before editing because the exact current text of that test isn't reproduced here, but the rewrite rules per reference are explicit.
- **Type/name consistency:** view names (`v_mrr_daily`, `v_credit_consumption_daily`, `v_credit_balance`, `v_revenue_lifetime_subscriber`) and column aliases (`gross_usd`, `event_count`, `active_subscribers`, `granted_credits`, `debited_credits`, `net_flow`, `latest_balance`, `total_granted`, `lifetime_dollars_purchased_cents`, `lifetime_dollars_refunded_cents`) are identical across the migration, the regression test, and the read-path queries.
