# Virtual Currencies — Plan 2: Analytics (ClickHouse + rollup)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the credit analytics a per-currency dimension: the ClickHouse credit pipeline carries `currencyId`, and the dashboard credits rollup accepts an optional `currencyCode` filter so each currency's flow/balance can be read independently.

**Architecture:** The ClickHouse credit read path is already query-time views (`v_credit_consumption_daily`, `v_credit_balance`) over `raw_credit_ledger FINAL` (migration 0012 replaced the double-counting SummingMergeTree rollups). This plan adds a `currencyId` column to `raw_credit_ledger`, extracts it in the Kafka→raw materialized view (`mv_credit_to_raw`), and recreates the two views with `currencyId` in their GROUP BY. The rollup service (`metrics/credits.ts`) gains an optional `currencyId` that scopes every credit query (Postgres + the ClickHouse volume query); the rollup route resolves an optional `?currencyCode=` to that id.

**Tech Stack:** ClickHouse (ReplacingMergeTree raw + query-time `View`s, Kafka Engine ingestion), TypeScript, Hono, Drizzle/Postgres, Vitest (+ testcontainers ClickHouse for `*.integration.test.ts`).

## Global Constraints

- The outbox `credit.ledger.appended` payload ALREADY emits `currencyId` (Plan 1, `insertCreditLedger`) — no producer change needed; this plan only consumes it downstream.
- ClickHouse migrations live in `packages/db/clickhouse/migrations/`, applied by `packages/db/src/clickhouse-migrate.ts`. Next number is **0015**. The runner splits on `/;\s*$/m` and strips leading comment lines per statement — every statement must end with `;` at line-end and contain NO mid-statement `;`.
- Credit read path is QUERY-TIME views over `raw_credit_ledger FINAL` (idempotent against at-least-once duplicate deliveries) — do NOT reintroduce incremental SummingMergeTree/AggregatingMergeTree rollups.
- `currencyCode` on the rollup is **OPTIONAL and backward-compatible**: when omitted, the rollup returns project-wide aggregates exactly as today; when provided, every credit metric is scoped to that one currency. Summing flow across different currencies is not meaningful — the dashboard passes `currencyCode` to get meaningful per-currency data.
- CH client reads a frozen `env` parsed at import; integration tests MUST mutate the shared `env` object (not just `process.env`) and call `__resetClickHouseForTests()` (see `apps/api/tests/analytics-clickhouse.integration.test.ts`). Use `FROM table FINAL` (never `FINAL AS alias`).
- Full per-currency BREAKDOWN in one response (multiple currencies at once) is OUT OF SCOPE — the chosen contract is a single-currency filter param.
- Stay on the current branch (`main`) — do not create or switch branches. Conventional commits.

---

## File Structure

**Create:**
- `packages/db/clickhouse/migrations/0015_credit_currency_dimension.sql` — adds `currencyId` to `raw_credit_ledger`, recreates `mv_credit_to_raw`, `v_credit_consumption_daily`, `v_credit_balance` with the dimension.
- A ClickHouse integration test asserting per-currency view output (extend the existing `apps/api/tests/analytics-clickhouse.integration.test.ts` or a sibling CH test — see Task 1).

**Modify:**
- `packages/db/scripts/verify-clickhouse.ts` — assert `raw_credit_ledger.currencyId` exists.
- `apps/api/src/services/metrics/credits.ts` — optional `currencyId` scoping across all credit queries; `DISTINCT ON (subscriberId, currencyId)` correctness fix.
- `apps/api/src/routes/dashboard/credits.ts` — `?currencyCode=` query param on GET `/rollup`, resolved to `currencyId`.
- (test) the credits-rollup integration/unit test for per-currency scoping.

---

## Task 1: ClickHouse migration — currency dimension

**Files:**
- Create: `packages/db/clickhouse/migrations/0015_credit_currency_dimension.sql`
- Test: extend `apps/api/tests/analytics-clickhouse.integration.test.ts` (or create `apps/api/tests/credit-currency-ch.integration.test.ts` following the same setup)

**Interfaces:**
- Consumes: existing `raw_credit_ledger`, `mv_credit_to_raw`, `credit_queue`, `v_credit_consumption_daily`, `v_credit_balance` (migrations 0005/0012).
- Produces: `raw_credit_ledger.currencyId` (String); `v_credit_consumption_daily` columns `(projectId, currencyId, day, granted_credits, debited_credits, net_flow, event_count, active_subscribers)`; `v_credit_balance` columns `(projectId, subscriberId, currencyId, latest_balance, total_granted, total_debited, last_activity_at)`.

- [ ] **Step 1: Write the migration SQL**

`packages/db/clickhouse/migrations/0015_credit_currency_dimension.sql`:

```sql
-- 0015_credit_currency_dimension.sql
-- Add a per-currency dimension to the credit analytics pipeline.
-- The outbox payload (credit.ledger.appended) already carries currencyId
-- (Plan 1). Here we: add currencyId to the raw ReplacingMergeTree table,
-- recreate the Kafka->raw MV to extract it, and recreate the query-time
-- views with currencyId in their GROUP BY. The views still read
-- raw_credit_ledger FINAL so at-least-once duplicate deliveries (same eventId)
-- collapse before aggregation — no incremental rollup is reintroduced.

ALTER TABLE rovenue.raw_credit_ledger
  ADD COLUMN IF NOT EXISTS currencyId String AFTER subscriberId;

-- An MV's SELECT cannot be ALTERed; drop and recreate to add the extraction.
DROP VIEW IF EXISTS rovenue.mv_credit_to_raw;

CREATE MATERIALIZED VIEW IF NOT EXISTS rovenue.mv_credit_to_raw
TO rovenue.raw_credit_ledger AS
SELECT
  eventId,
  JSONExtractString(payload, 'creditLedgerId')                              AS creditLedgerId,
  JSONExtractString(payload, 'projectId')                                   AS projectId,
  JSONExtractString(payload, 'subscriberId')                                AS subscriberId,
  JSONExtractString(payload, 'currencyId')                                  AS currencyId,
  JSONExtractString(payload, 'type')                                        AS type,
  JSONExtractInt(payload, 'amount')                                         AS amount,
  JSONExtractInt(payload, 'balance')                                        AS balance,
  nullIf(JSONExtractString(payload, 'referenceType'), '')                   AS referenceType,
  nullIf(JSONExtractString(payload, 'referenceId'),   '')                   AS referenceId,
  parseDateTime64BestEffort(
    JSONExtractString(payload, 'createdAt'), 3
  )                                                                         AS createdAt,
  now64(3, 'UTC')                                                           AS ingestedAt,
  toUnixTimestamp64Milli(now64(3, 'UTC'))                                   AS _version
FROM rovenue.credit_queue;

-- Daily per-currency credit flow — query-time over deduped raw.
DROP VIEW IF EXISTS rovenue.v_credit_consumption_daily;

CREATE VIEW IF NOT EXISTS rovenue.v_credit_consumption_daily AS
SELECT
  projectId,
  currencyId,
  toDate(createdAt) AS day,
  sumIf(amount, amount > 0)   AS granted_credits,
  sumIf(-amount, amount < 0)  AS debited_credits,
  sum(amount)                 AS net_flow,
  count()                     AS event_count,
  uniq(subscriberId)          AS active_subscribers
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, currencyId, day;

-- Per-(subscriber, currency) balance snapshot — analytics read only.
DROP VIEW IF EXISTS rovenue.v_credit_balance;

CREATE VIEW IF NOT EXISTS rovenue.v_credit_balance AS
SELECT
  projectId,
  subscriberId,
  currencyId,
  argMax(balance, createdAt)  AS latest_balance,
  sumIf(amount, amount > 0)   AS total_granted,
  sumIf(-amount, amount < 0)  AS total_debited,
  max(createdAt)              AS last_activity_at
FROM rovenue.raw_credit_ledger FINAL
GROUP BY projectId, subscriberId, currencyId;
```

- [ ] **Step 2: Write the failing integration test**

Extend `apps/api/tests/analytics-clickhouse.integration.test.ts` (reuse its container + env-mutation + migration-applying setup) with a new test. Insert raw rows for two currencies and assert the views split by currency. Follow the file's existing insert helper / `queryAnalytics`-style direct CH query. Skeleton (adapt to the file's actual helpers):

```typescript
it("v_credit_consumption_daily and v_credit_balance split by currencyId", async () => {
  const projectId = `prj_ccdim_${Date.now()}`;
  const sub = `sub_${Date.now()}`;
  // Insert directly into raw_credit_ledger (bypassing Kafka) with two currencies.
  await chInsertRawCredit(projectId, sub, "cur_gold", +100, 100);
  await chInsertRawCredit(projectId, sub, "cur_gold", -40, 60);
  await chInsertRawCredit(projectId, sub, "cur_gem", +5, 5);

  const flow = await chSelect(
    `SELECT currencyId, granted_credits, debited_credits, net_flow
     FROM rovenue.v_credit_consumption_daily
     WHERE projectId = '${projectId}' ORDER BY currencyId`,
  );
  expect(flow).toEqual([
    expect.objectContaining({ currencyId: "cur_gem", granted_credits: "5", debited_credits: "0" }),
    expect.objectContaining({ currencyId: "cur_gold", granted_credits: "100", debited_credits: "40" }),
  ]);

  const bal = await chSelect(
    `SELECT currencyId, latest_balance FROM rovenue.v_credit_balance
     WHERE projectId = '${projectId}' AND subscriberId = '${sub}' ORDER BY currencyId`,
  );
  expect(bal).toEqual([
    expect.objectContaining({ currencyId: "cur_gem", latest_balance: "5" }),
    expect.objectContaining({ currencyId: "cur_gold", latest_balance: "60" }),
  ]);
});
```

> Use the file's real raw-insert mechanism. `raw_credit_ledger` columns now are: `eventId, creditLedgerId, projectId, subscriberId, currencyId, type, amount, balance, referenceType, referenceId, createdAt, ingestedAt, _version`. Give each row a unique `eventId` and a distinct `createdAt` so `argMax` picks the true latest. If the existing test inserts raw credit rows anywhere, update those inserts to include `currencyId` (the new NOT-defaulted column accepts `''` but tests should pass an explicit value).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- analytics-clickhouse`
Expected: FAIL — before the migration is applied in the test's migration loop, `v_credit_consumption_daily` has no `currencyId` column → query errors / assertion fails. (If the test harness applies all migration files from the directory, the new test fails on the assertion until Step 1's file exists; ensure Step 1 is saved so the harness picks it up.)

- [ ] **Step 4: Apply the migration locally and confirm the views**

Run: `pnpm --filter @rovenue/db db:clickhouse:migrate`
Expected: `0015_credit_currency_dimension` applies with no error. Then confirm the column/views exist:
Run: `pnpm --filter @rovenue/api test -- analytics-clickhouse`
Expected: PASS (the new test plus the existing ones).

> If a local ClickHouse has a poisoned `_migrations` row from a partial apply (project memory: CH splitter divergence), `DROP DATABASE rovenue` and re-migrate.

- [ ] **Step 5: Commit**

```bash
git add packages/db/clickhouse/migrations/0015_credit_currency_dimension.sql apps/api/tests/analytics-clickhouse.integration.test.ts
git commit -m "feat(db/clickhouse): add currencyId dimension to credit raw table + views"
```

---

## Task 2: Parity verification — assert the currency column

**Files:**
- Modify: `packages/db/scripts/verify-clickhouse.ts`

**Interfaces:**
- Consumes: migration 0015 (Task 1).
- Produces: `verify-clickhouse` fails if `raw_credit_ledger.currencyId` is absent.

- [ ] **Step 1: Add a column-presence assertion**

`verify-clickhouse.ts` already verifies `EXPECTED_TABLES` (including `raw_credit_ledger`, `v_credit_consumption_daily`, `v_credit_balance` — all still present, recreated in place, so the table list needs no change). Add a focused check that the new dimension column exists. After the `EXPECTED_TABLES` verification block, add:

```typescript
// Per-currency dimension (migration 0015): raw_credit_ledger must carry currencyId.
const colRows = await client.query({
  query: `
    SELECT name FROM system.columns
    WHERE database = 'rovenue' AND table = 'raw_credit_ledger' AND name = 'currencyId'
  `,
  format: "JSONEachRow",
});
const cols = (await colRows.json()) as Array<{ name: string }>;
if (cols.length === 0) {
  throw new Error(
    "verify-clickhouse: raw_credit_ledger.currencyId missing — migration 0015 not applied",
  );
}
```

> Match the file's existing `client`/error-reporting style (it already constructs a CH client and throws on mismatch). If the script accumulates failures into a list rather than throwing, push to that list instead.

- [ ] **Step 2: Run the verifier against the migrated DB**

Run: `pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: passes (all expected tables + the currencyId column present). If it fails on `currencyId missing`, re-run Task 1 Step 4.

- [ ] **Step 3: Commit**

```bash
git add packages/db/scripts/verify-clickhouse.ts
git commit -m "chore(db): verify-clickhouse asserts raw_credit_ledger.currencyId"
```

---

## Task 3: Rollup `currencyCode` contract + ClickHouse volume scoping

**Files:**
- Modify: `apps/api/src/routes/dashboard/credits.ts`
- Modify: `apps/api/src/services/metrics/credits.ts`
- Test: `apps/api/src/routes/dashboard/credits.integration.test.ts` (or the file already covering the rollup route)

**Interfaces:**
- Consumes: `drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(db, projectId, code): Promise<VirtualCurrencyRow | null>`; `getCreditsRollup` (this task changes its input).
- Produces:
  - `GetCreditsRollupInput` gains `currencyId?: string`.
  - `getCreditsRollup({ projectId, windowDays, currencyId })` — when `currencyId` is set, scopes the ClickHouse volume query to it; when unset, project-wide (unchanged).
  - `rollupQuerySchema` gains `currencyCode: z.string().trim().min(1).optional()`; the route resolves it (404 if provided + unknown) and passes `currency.id` as `currencyId`.

- [ ] **Step 1: Write the failing test**

In the rollup route's integration test, add a case asserting an unknown `currencyCode` yields 404 and that the ClickHouse volume query is scoped (verify via the response shape — volume reflects only the seeded currency). Minimal route-level assertion (mirror the file's existing rollup test setup/auth):

```typescript
it("rollup with unknown currencyCode returns 404", async () => {
  const res = await app.request(
    `/projects/${projectId}/credits/rollup?currencyCode=NOPE`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(404);
});

it("rollup scoped to a currencyCode only counts that currency's flow", async () => {
  // seed two currencies + ledger rows (GLD +1000, GEM +5) for the project,
  // then request ?currencyCode=GEM and assert volume issued reflects 5, not 1005.
  const res = await app.request(
    `/projects/${projectId}/credits/rollup?currencyCode=GEM`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  const issued = body.data.volume.reduce((s: number, p: { issued: number }) => s + p.issued, 0);
  expect(issued).toBe(5);
});
```

> The volume series is ClickHouse-backed. If the test environment has no ClickHouse, assert the Postgres-backed KPIs scoping instead (Task 4 covers those) and gate the CH assertion behind the same skip the sibling CH tests use. Prefer the real CH assertion when the container is available.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- credits.integration`
Expected: FAIL — `currencyCode` is rejected/ignored by the schema; unknown code does not 404.

- [ ] **Step 3: Add the route param + resolution**

In `apps/api/src/routes/dashboard/credits.ts`, extend `rollupQuerySchema` and the GET `/rollup` handler:

```typescript
const rollupQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROLLUP_WINDOW_MAX_DAYS)
    .default(ROLLUP_WINDOW_DEFAULT_DAYS),
  currencyCode: z.string().trim().min(1).optional(),
});
```

```typescript
  .get("/rollup", zValidator("query", rollupQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const { windowDays, currencyCode } = c.req.valid("query");

    let currencyId: string | undefined;
    if (currencyCode) {
      const currency = await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        currencyCode,
      );
      if (!currency) {
        throw new HTTPException(404, { message: "currency not found" });
      }
      currencyId = currency.id;
    }

    const payload = await getCreditsRollup({ projectId, windowDays, currencyId });
    return c.json(ok(payload));
  })
```

(Ensure `drizzle` is imported in this file — it already imports from `@rovenue/db`.)

- [ ] **Step 4: Thread `currencyId` into the service + scope the ClickHouse volume query**

In `apps/api/src/services/metrics/credits.ts`:

Extend the input interface:

```typescript
export interface GetCreditsRollupInput {
  projectId: string;
  windowDays: number;
  currencyId?: string;
}
```

In `getCreditsRollup`, pass `input.currencyId` down to each reader (Task 4 wires the Postgres readers; here, wire the ClickHouse `readVolume`). Change `readVolume` to accept and apply the currency filter:

```typescript
async function readVolume(
  projectId: string,
  window: Window,
  currencyId?: string,
): Promise<CreditsVolumePoint[]> {
  const currencyFilter = currencyId ? "AND currencyId = {currencyId:String}" : "";
  const rows = await queryAnalytics<ChVolumeRow>(
    projectId,
    `
      SELECT
        toString(day)                  AS bucket,
        toString(sum(granted_credits)) AS issued,
        toString(sum(debited_credits)) AS burned,
        toString(sum(net_flow))        AS net
      FROM rovenue.v_credit_consumption_daily
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
        ${currencyFilter}
      GROUP BY day
      ORDER BY day ASC
    `,
    {
      from: toDateOnly(window.from),
      to: toDateOnly(window.to),
      ...(currencyId ? { currencyId } : {}),
    },
  );
  // ...existing row mapping unchanged...
}
```

> Why the added `sum(...) GROUP BY day`: `v_credit_consumption_daily` is now keyed by `(projectId, currencyId, day)`. With NO `currencyCode` filter the view returns one row per (currency, day); summing per day collapses currencies back to the project-wide series (preserving the pre-existing project-wide behavior). With a `currencyId` filter only that currency's rows remain, so the sum is that currency's daily flow. Keep the existing `ChVolumeRow`→`CreditsVolumePoint` mapping.

Update the `getCreditsRollup` call site to pass `currencyId` to `readVolume(projectId, window, input.currencyId)`.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/api test -- credits.integration`
Expected: PASS (404 on unknown code; scoped volume when CH available).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/credits.ts apps/api/src/services/metrics/credits.ts apps/api/src/routes/dashboard/credits.integration.test.ts
git commit -m "feat(api): credits rollup accepts optional currencyCode; scope CH volume"
```

---

## Task 4: Scope the Postgres credit queries by currency

**Files:**
- Modify: `apps/api/src/services/metrics/credits.ts`
- Test: extend `apps/api/src/routes/dashboard/credits.integration.test.ts`

**Interfaces:**
- Consumes: `GetCreditsRollupInput.currencyId` (Task 3).
- Produces: when `currencyId` is set, all Postgres credit-ledger reads (outstanding, KPI issued/burned/granted/expired, flow-by-type, lifetime inflow split, average age, window issued, top burners, recent ledger) are filtered to that currency. The outstanding query uses `DISTINCT ON ("subscriberId", "currencyId")` so multi-currency wallets are each counted once.

- [ ] **Step 1: Write the failing test**

Add to the rollup integration test (Postgres-backed KPIs do not need ClickHouse):

```typescript
it("rollup KPIs are scoped to the requested currencyCode", async () => {
  // Seed: subscriber has GLD balance 1000 and GEM balance 5 (two ledger rows
  // with distinct currencyId), via drizzle.virtualCurrencyRepo + credit_ledger insert.
  const res = await app.request(
    `/projects/${projectId}/credits/rollup?currencyCode=GEM`,
    { headers: authHeaders },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  // Outstanding reflects only GEM (5), not GLD+GEM (1005).
  expect(body.data.kpis.outstanding).toBe(5);
  expect(body.data.kpis.issued28d).toBe(5);
});

it("rollup without currencyCode counts each (subscriber,currency) wallet once", async () => {
  // Same seed as above; no currencyCode → outstanding sums both wallets = 1005.
  const res = await app.request(
    `/projects/${projectId}/credits/rollup`,
    { headers: authHeaders },
  );
  const body = await res.json();
  expect(body.data.kpis.outstanding).toBe(1005);
  expect(body.data.kpis.outstandingWalletCount).toBe(2);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rovenue/api test -- credits.integration`
Expected: FAIL — without scoping, `?currencyCode=GEM` returns outstanding 1005 (not 5); and the no-filter outstanding uses `DISTINCT ON ("subscriberId")` which counts only one wallet per subscriber (returns wrong wallet count / mixes currencies).

- [ ] **Step 3: Add a reusable currency filter + scope each query**

In `apps/api/src/services/metrics/credits.ts`, thread `currencyId?: string` into each Postgres reader and build a conditional Drizzle fragment. Use this pattern (Drizzle `sql` supports nested fragments; an empty `sql\`\`` injects nothing):

```typescript
import { sql } from "drizzle-orm"; // (already imported in this file)

function currencyClause(currencyId?: string) {
  return currencyId ? sql` AND "currencyId" = ${currencyId}` : sql``;
}
```

Apply it to every credit-ledger query. Examples (apply the same `${currencyClause(currencyId)}` insertion to each):

`readOutstandingBalance(projectId, currencyId?)` — also fix the DISTINCT ON to include currencyId:

```typescript
  const rows = await db.execute(sql`
    SELECT
      COALESCE(SUM(balance), 0)::text                AS outstanding,
      COUNT(*) FILTER (WHERE balance > 0)::text      AS wallet_count
    FROM (
      SELECT DISTINCT ON ("subscriberId", "currencyId") balance
      FROM credit_ledger
      WHERE "projectId" = ${projectId}${currencyClause(currencyId)}
      ORDER BY "subscriberId", "currencyId", "createdAt" DESC
    ) latest
  `);
```

`readKpis` window aggregation, `readFlowByType`, `readLifetimeInflowSplit`, `readAverageAgeDays`, `readWindowCreditPurchaseUsd` (this hits `revenue_events`, which has NO currencyId — LEAVE it project-wide; see note), `readWindowIssued`, `readTopBurners`, `readRecentLedger`: insert `${currencyClause(currencyId)}` right after the existing `"projectId" = ${projectId}` predicate (and for queries whose only predicate is `projectId`, after it). For example `readTopBurners`:

```typescript
    WHERE "projectId" = ${projectId}
      AND "amount" < 0
      AND "createdAt" >= ${window.from}
      AND "createdAt" <= ${window.to}${currencyClause(currencyId)}
```

and `readRecentLedger`:

```typescript
    SELECT * FROM credit_ledger
    WHERE "projectId" = ${projectId}${currencyClause(currencyId)}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ${LEDGER_LIMIT}
```

> **Leave the revenue-backed queries project-wide and document why:** `readPackages` (ClickHouse `raw_revenue_events`) and `readWindowCreditPurchaseUsd` / the `readKpis` CREDIT_PURCHASE USD lookup (`revenue_events`) measure REAL-MONEY credit-pack revenue. `revenue_events`/`raw_revenue_events` carry no `currencyId` (a purchase is dollars, not a virtual-currency unit), so `revenue28dUsd` and `packages` stay project-wide even when `currencyCode` is set. Add a one-line code comment at each of these stating this is intentional. (A future plan could map products→granted-currency to attribute pack revenue per currency; out of scope here.)

Thread `input.currencyId` from `getCreditsRollup` into every reader call.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rovenue/api test -- credits.integration`
Expected: PASS — scoped outstanding/issued reflect only the requested currency; the no-filter path counts each (subscriber, currency) wallet once (outstanding 1005, walletCount 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metrics/credits.ts apps/api/src/routes/dashboard/credits.integration.test.ts
git commit -m "feat(api): scope credit rollup Postgres queries by currency; per-wallet outstanding"
```

---

## Task 5: Verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + build**

Run: `pnpm --filter @rovenue/shared --filter @rovenue/db --filter @rovenue/api build`
Expected: green. Fix any caller the `GetCreditsRollupInput`/reader signature changes broke until clean.

- [ ] **Step 2: Targeted test suites**

Run: `pnpm --filter @rovenue/api test -- credits analytics-clickhouse` and `pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: the new per-currency tests pass; parity verifier passes. Pre-existing environment-only failures (ClickHouse/Kafka/testcontainer availability) and unrelated reds noted in the project ledger are out of scope — confirm no NEW failures vs. a clean baseline.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "fix(api): align rollup callers with currency-scoped signature"
```

---

## Self-Review Notes (coverage map)

- Spec §Analytics "add `currencyId` to `mv_credit_balance` / `mv_credit_consumption_daily`" → Task 1 (the live read path is the query-time views `v_credit_balance` / `v_credit_consumption_daily`, recreated with the dimension; the old MV names were dropped by migration 0012). Outbox `currencyId` → already emitted (Plan 1), consumed in `mv_credit_to_raw` (Task 1). Parity verify extended → Task 2. Per-currency rollup contract (`currencyCode` filter) → Tasks 3 (route + CH volume) and 4 (Postgres queries). 
- Deliberately project-wide (documented): real-money credit-pack revenue (`packages`, `revenue28dUsd`) — `revenue_events` carries no currency. Full multi-currency-at-once breakdown: out of scope (single-currency filter chosen). Dashboard currency selector that passes `currencyCode`: Plan 3 (user-owned).
- Idempotency preserved: views read `raw_credit_ledger FINAL`; no incremental rollup reintroduced.
