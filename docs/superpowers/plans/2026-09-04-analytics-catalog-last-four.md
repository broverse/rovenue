# Analytics Catalog — Last Four Ids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all sixteen system chart-catalog ids return a real, measured series, closing ROADMAP §5.

**Architecture:** Three unrelated fixes. (1) `rev_per_install` gets an install denominator from a new `subscribers.sdkInstalledAt` column written only by the SDK create path. (2) `liability` gets history by walking today's authoritative outstanding balance backwards through `credit_ledger`'s signed deltas. (3) `retention_curve` and `ltv` get a period x-axis added to the series contract, then two cohort-curve readers in `cohorts.ts`. Every reader delegates to the service that owns the concept; `charts.ts` gains no SQL.

**Tech Stack:** Hono + TypeScript (strict), Drizzle ORM + PostgreSQL, ClickHouse, React (Vite) dashboard, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-analytics-catalog-last-four-design.md`

## Global Constraints

- **Stay on the current branch.** Never create, switch, or delete a branch or worktree.
- **Throttle test runs.** Use `nice -n 19 npx vitest run --maxWorkers=2 <paths>` from the package directory, never a bare full-suite run, and never two runs concurrently.
- **No magic values.** Every literal that carries meaning becomes a named constant near its use. Structured data tables (a lookup of granularity thresholds, a column list) are not magic values.
- **`charts.ts` contains no SQL.** Readers delegate to the owning service. Where a grain does not exist, add it *inside* the owning service.
- **After adding a migration, drop the test template DB** before running integration tests: `psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl'`. Stale templates silently run the old schema.
- **Integration tests need Docker up.** `docker ps` before running any `*.integration.test.ts`; vitest hangs rather than failing when Postgres is absent.
- **Migration numbering:** check `packages/db/drizzle/migrations/meta/_journal.json` immediately before generating — the working tree may already hold newer migrations from parallel work.
- **Postgres access via Drizzle only.** Raw `sql` template only where truly necessary, and qualify columns (`"subscribers"."id"`) — a bare `${table.col}` renders unqualified and breaks correlated subqueries.
- **Conventional commits.** Commit at the end of every task.

---

### Task 1: `subscribers.sdkInstalledAt` — the install marker

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (the `subscribers` table)
- Modify: `packages/db/src/drizzle/repositories/subscribers.ts` (`UpsertSubscriberInput`, `upsertSubscriber`)
- Modify: `apps/api/src/lib/resolve-or-create-subscriber.ts`
- Create: `packages/db/drizzle/migrations/<next>_subscriber_sdk_installed_at.sql`
- Test: `apps/api/src/lib/resolve-or-create-subscriber.install.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `subscribers.sdkInstalledAt: timestamptz | null`; `UpsertSubscriberInput.sdkInstalledAt?: Date | null` (insert-only); `resolveSubscriberForWrite(projectId, rovenueId, createAttributes?, markSdkInstall?: boolean)`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/lib/resolve-or-create-subscriber.install.integration.test.ts`:

```ts
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  resolveOrCreateSubscriber,
  resolveSubscriberForWrite,
} from "./resolve-or-create-subscriber";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_inst_${RUN_ID}`;

describe("sdkInstalledAt is SDK-create-path truth", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("sets up the project", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `INST ${RUN_ID}` });
  });

  it("stamps sdkInstalledAt when the SDK creates the subscriber", async () => {
    const s = await resolveOrCreateSubscriber(PROJECT_ID, `rv_sdk_${RUN_ID}`, "ios");
    expect(s.sdkInstalledAt).toBeInstanceOf(Date);
  });

  it("leaves sdkInstalledAt NULL on a non-SDK create path", async () => {
    const { subscriber } = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import_${RUN_ID}`,
    );
    expect(subscriber.sdkInstalledAt).toBeNull();
  });

  it("never re-stamps an existing row", async () => {
    const first = await resolveOrCreateSubscriber(
      PROJECT_ID,
      `rv_twice_${RUN_ID}`,
      "ios",
    );
    const again = await resolveOrCreateSubscriber(
      PROJECT_ID,
      `rv_twice_${RUN_ID}`,
      "android",
    );
    expect(again.sdkInstalledAt?.getTime()).toBe(first.sdkInstalledAt?.getTime());
  });

  it("does not stamp a row the importer resolves later", async () => {
    const { subscriber } = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import2_${RUN_ID}`,
    );
    expect(subscriber.sdkInstalledAt).toBeNull();
    const touched = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import2_${RUN_ID}`,
    );
    expect(touched.subscriber.sdkInstalledAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/lib/resolve-or-create-subscriber.install.integration.test.ts
```
Expected: FAIL — `sdkInstalledAt` does not exist on the row type.

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/db/src/drizzle/schema.ts`, inside `subscribers`, after `identifiedAt`:

```ts
    // Set ONCE, by the SDK's public-key create path only
    // (`resolveOrCreateSubscriber`) — never by the importer, a store
    // webhook, or any S2S route. NULL therefore means "this subscriber
    // row was not created by an SDK client".
    //
    // It duplicates `firstSeenAt`'s value at create time on purpose: it
    // is the ONLY install signal that survives GDPR erasure, which
    // clears `attributes` (and with it the `platform` marker this
    // generalises). An install count is an aggregate, not personal
    // data; erasing a person must not retroactively shrink it.
    sdkInstalledAt: timestamp("sdkInstalledAt", { withTimezone: true }),
```

And in the table's index block:

```ts
    // Sole access path for the `rev_per_install` install denominator
    // (services/metrics/installs.ts). Partial, so importer-heavy
    // projects contribute no index entries at all.
    sdkInstalledAtIdx: index("subscribers_projectId_sdkInstalledAt_idx")
      .on(t.projectId, t.sdkInstalledAt)
      .where(sql`${t.sdkInstalledAt} IS NOT NULL`),
```

- [ ] **Step 4: Thread it through the repository**

In `packages/db/src/drizzle/repositories/subscribers.ts`, add to `UpsertSubscriberInput`:

```ts
  /**
   * Applied ONLY on insert, like `createAttributes`. The conflict path
   * never touches it, so first-install truth is immutable.
   */
  sdkInstalledAt?: Date | null;
```

and in `upsertSubscriber`'s `.values({...})`:

```ts
      sdkInstalledAt: input.sdkInstalledAt ?? null,
```

Leave the `onConflictDoUpdate` `set` object untouched — that is what makes it insert-only.

- [ ] **Step 5: Mark the SDK create path**

In `apps/api/src/lib/resolve-or-create-subscriber.ts`:

```ts
export async function resolveSubscriberForWrite(
  projectId: string,
  rovenueId: string,
  createAttributes: unknown = {},
  markSdkInstall = false,
): Promise<ResolvedSubscriberForWrite> {
```

and pass it down at the `upsertSubscriber` call:

```ts
  const subscriber = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId,
    createAttributes,
    sdkInstalledAt: markSdkInstall ? new Date() : null,
  });
```

In `resolveOrCreateSubscriber`, pass `true`:

```ts
  const { subscriber } = await resolveSubscriberForWrite(
    projectId,
    key,
    createAttributes,
    true,
  );
```

Extend `resolveOrCreateSubscriber`'s doc comment with:

```
 * Because this wrapper is reachable ONLY from the SDK's public-key /v1
 * surface, creating here IS an install: it stamps `sdkInstalledAt`
 * (insert-only, see the column comment). `resolveSubscriberForWrite`
 * itself does not — the importer calls that one directly, and
 * services/import/write.ts's rule 6 ("NEVER set subscribers.platform,
 * it is SDK first-install truth") applies to this column for the same
 * reason.
```

- [ ] **Step 6: Generate the migration and add the backfill**

```bash
cat packages/db/drizzle/migrations/meta/_journal.json | tail -20
cd packages/db && pnpm db:migrate:generate
```

Open the generated file. It must contain ONLY the `ALTER TABLE ... ADD COLUMN` and the `CREATE INDEX`. Delete anything else drizzle-kit emitted (`DROP TYPE`, unrelated table churn) — that is the known generator footgun. Then append the backfill:

```sql
--> statement-breakpoint
-- Backfill from the pre-existing SDK-only marker: `attributes.platform`
-- is written by resolveOrCreateSubscriber on create only, and
-- services/import/write.ts rule 6 forbids the importer from ever
-- setting it. Rows anonymized before this migration have had their
-- attributes cleared and stay NULL — that data is not recoverable and
-- is deliberately not guessed.
UPDATE "subscribers"
   SET "sdkInstalledAt" = "firstSeenAt"
 WHERE "sdkInstalledAt" IS NULL
   AND "attributes" ? 'platform';
```

- [ ] **Step 7: Apply the migration and re-run the test**

```bash
psql "postgresql://rovenue:rovenue@localhost:5433/rovenue" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl'
pnpm db:migrate
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/lib/resolve-or-create-subscriber.install.integration.test.ts
```
Expected: PASS, all five.

- [ ] **Step 8: Commit**

```bash
git add packages/db apps/api/src/lib
git commit -m "feat(db): record SDK first-install on subscribers as sdkInstalledAt"
```

---

### Task 2: `rev_per_install`

**Files:**
- Create: `apps/api/src/services/metrics/installs.ts`
- Create: `apps/api/src/services/metrics/installs.integration.test.ts`
- Create: `apps/api/src/services/metrics/charts.installs.test.ts`
- Modify: `apps/api/src/services/metrics/charts.ts` (new `case "rev_per_install"`, header comment)

**Interfaces:**
- Consumes: `subscribers.sdkInstalledAt` (Task 1); `listDailyMrr({projectId, from, to})` → `MrrPoint[]` with `netUsd: string`; `buildMrrSeriesPoints(rows, from, to, extract)`.
- Produces: `getInstallsDaily({projectId, from, to}): Promise<DailyInstallCount[]>` where `DailyInstallCount = { day: string; n: number }` and `day` is `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing service integration test**

Create `apps/api/src/services/metrics/installs.integration.test.ts`:

```ts
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { getInstallsDaily } from "./installs";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_instd_${RUN_ID}`;
const DAY_ONE = new Date("2026-03-02T10:00:00.000Z");
const DAY_ONE_LATER = new Date("2026-03-02T23:30:00.000Z");
const DAY_TWO = new Date("2026-03-03T01:00:00.000Z");
const FROM = new Date("2026-03-01T00:00:00.000Z");
const TO = new Date("2026-03-04T23:59:59.999Z");

describe("getInstallsDaily", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("counts only SDK-created rows, grouped by install day", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `INSTD ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values([
      { projectId: PROJECT_ID, rovenueId: `a_${RUN_ID}`, sdkInstalledAt: DAY_ONE },
      { projectId: PROJECT_ID, rovenueId: `b_${RUN_ID}`, sdkInstalledAt: DAY_ONE_LATER },
      { projectId: PROJECT_ID, rovenueId: `c_${RUN_ID}`, sdkInstalledAt: DAY_TWO },
      // Importer-created: no sdkInstalledAt. Must NOT be counted.
      { projectId: PROJECT_ID, rovenueId: `d_${RUN_ID}` },
    ]);

    const rows = await getInstallsDaily({ projectId: PROJECT_ID, from: FROM, to: TO });
    expect(rows).toEqual([
      { day: "2026-03-02", n: 2 },
      { day: "2026-03-03", n: 1 },
    ]);
  });

  it("counts a soft-deleted (anonymized) subscriber's install", async () => {
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      projectId: PROJECT_ID,
      rovenueId: `e_${RUN_ID}`,
      sdkInstalledAt: DAY_TWO,
      deletedAt: new Date(),
      attributes: {},
    });
    const rows = await getInstallsDaily({ projectId: PROJECT_ID, from: FROM, to: TO });
    expect(rows.find((r) => r.day === "2026-03-03")?.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/installs.integration.test.ts
```
Expected: FAIL — cannot resolve `./installs`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/metrics/installs.ts`:

```ts
import { drizzle } from "@rovenue/db";
import { and, count, gte, isNotNull, lte, sql } from "drizzle-orm";

// =============================================================
// Installs — the denominator behind `rev_per_install`
// =============================================================
//
// This file is the ONLY definition of what an install is: a
// `subscribers` row created by the SDK's public-key /v1 surface, dated
// by `sdkInstalledAt` (set insert-only in
// lib/resolve-or-create-subscriber.ts). NULL means the row came from
// somewhere else — the CSV importer, a store webhook, an S2S call —
// and is not an install.
//
// What the number means, stated where it is produced rather than in a
// footnote: this counts SUBSCRIBER first contact, not device installs.
// A reinstall that clears the SDK's local cache mints a new anonymous
// subscriber and counts again; one that restores the cache does not.
// Two subscribers later merged by /v1/subscribers/transfer stay two
// installs — merging identities is not an un-install.
//
// Postgres, deliberately: `raw_revenue_events` only ever sees a
// subscriber who transacted, so ClickHouse cannot answer this at all.
// Like `trials_started` and `churn`, that puts this reader outside
// schema-contract.integration.test.ts's reach — installs.integration.test.ts
// is its guard.

export interface DailyInstallCount {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  n: number;
}

export interface GetInstallsDailyInput {
  projectId: string;
  from: Date;
  to: Date;
}

export async function getInstallsDaily(
  input: GetInstallsDailyInput,
): Promise<DailyInstallCount[]> {
  const s = drizzle.schema.subscribers;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${s.sdkInstalledAt}), 'YYYY-MM-DD')`,
      n: count(),
    })
    .from(s)
    .where(
      and(
        eq(s.projectId, input.projectId),
        isNotNull(s.sdkInstalledAt),
        gte(s.sdkInstalledAt, input.from),
        lte(s.sdkInstalledAt, input.to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${s.sdkInstalledAt})`)
    .orderBy(sql`date_trunc('day', ${s.sdkInstalledAt})`);

  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}
```

Add `eq` to the drizzle-orm import list. A soft-deleted row is counted on purpose — see the test.

- [ ] **Step 4: Run the service test**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/installs.integration.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing dispatcher test**

Create `apps/api/src/services/metrics/charts.installs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch test for `rev_per_install`. Mocks the two owning services
// (`listDailyMrr` for the numerator, `getInstallsDaily` for the
// denominator) so this file tests charts.ts's own division and
// null-handling, not their SQL — same pattern as
// charts.credits.test.ts.

const listDailyMrrMock = vi.fn();
vi.mock("./mrr", () => ({
  listDailyMrr: (...args: unknown[]) => listDailyMrrMock(...args),
}));

const getInstallsDailyMock = vi.fn();
vi.mock("./installs", () => ({
  getInstallsDaily: (...args: unknown[]) => getInstallsDailyMock(...args),
}));

const isClickHouseConfiguredMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: vi.fn(),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

describe("readChartSeries — rev_per_install", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    listDailyMrrMock.mockReset().mockResolvedValue([]);
    getInstallsDailyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("divides the day's net revenue by the day's installs", async () => {
    listDailyMrrMock.mockResolvedValueOnce([
      { bucket: "2026-07-02T00:00:00.000Z", netUsd: "120.00" },
    ]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 4 }]);
    const res = await readChartSeries("proj_1", "rev_per_install", 1);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("money");
    expect(res.points.at(-1)).toMatchObject({
      value: 30,
      numerator: 120,
      denominator: 4,
    });
  });

  it("reports null, not zero, on a day with no installs", async () => {
    listDailyMrrMock.mockResolvedValueOnce([
      { bucket: "2026-07-02T00:00:00.000Z", netUsd: "120.00" },
    ]);
    getInstallsDailyMock.mockResolvedValueOnce([]);
    const res = await readChartSeries("proj_1", "rev_per_install", 1);
    expect(res.points.at(-1)?.value).toBeNull();
    expect(res.points.at(-1)?.denominator).toBe(0);
  });

  it("reports a measured zero when there were installs but no revenue", async () => {
    listDailyMrrMock.mockResolvedValueOnce([]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 9 }]);
    const res = await readChartSeries("proj_1", "rev_per_install", 1);
    expect(res.points.at(-1)?.value).toBe(0);
  });

  it("requires ClickHouse configured — the numerator is a CH read", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(
      readChartSeries("proj_1", "rev_per_install", 1),
    ).rejects.toThrow();
  });
});
```

Check the real import path of `listDailyMrr` first (`grep -n "listDailyMrr" apps/api/src/services/metrics/charts.ts`) and point `vi.mock` at exactly that specifier.

- [ ] **Step 6: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/charts.installs.test.ts
```
Expected: FAIL — `supported` is false, `unit` is `count`.

- [ ] **Step 7: Wire the reader**

In `apps/api/src/services/metrics/charts.ts`, import `getInstallsDaily` from `./installs` and add a case beside `arpu`:

```ts
    case "rev_per_install": {
      // Net revenue ÷ installs, per day. The numerator is the same
      // `listDailyMrr` column `arpu` and `gross_vs_net` already read —
      // no second revenue query. The denominator is installs.ts, the
      // only definition of an install in the codebase.
      //
      // SAME-DAY over SAME-DAY, deliberately: this is a daily
      // efficiency ratio, not lifetime revenue attributed to an
      // install cohort. The cohort-attributed question is what the
      // `ltv` curve answers (see the cohort group below); the two are
      // complements, and neither needs an attribution model this
      // reader would have to invent.
      //
      // Zero installs is an UNDEFINED average, not a $0 one — null,
      // mirroring `arpu`. Zero revenue on a day with installs is a
      // measured 0.
      assertClickHouseReady();
      const [mrrRows, installRows] = await Promise.all([
        listDailyMrr({ projectId, from: w.from, to: w.to }),
        getInstallsDaily({ projectId, from: w.from, to: w.to }),
      ]);
      const installsByDay = new Map(installRows.map((r) => [r.day, r.n]));
      return {
        ...base,
        unit: "money",
        points: buildMrrSeriesPoints(mrrRows, w.from, w.to, () => null).map(
          (p) => {
            const installs = installsByDay.get(p.bucket.slice(0, 10)) ?? 0;
            const net = Number(
              mrrRows.find((r) => toDateOnly(r.bucket) === p.bucket.slice(0, 10))
                ?.netUsd ?? 0,
            );
            return {
              bucket: p.bucket,
              value: installs > 0 ? net / installs : null,
              numerator: net,
              denominator: installs,
            };
          },
        ),
        supported: true,
      };
    }
```

If the double lookup reads awkwardly once written, replace it with a small exported helper `buildPerInstallPoints(mrrRows, installRows, from, to)` in `charts.ts` next to `buildRatePoints`, unit-tested the same way — but do not push the arithmetic into SQL.

- [ ] **Step 8: Run both test files**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/charts.installs.test.ts \
  src/services/metrics/installs.integration.test.ts
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/metrics
git commit -m "feat(api): wire rev_per_install to SDK installs"
```

---

### Task 3: `liability`

**Files:**
- Modify: `apps/api/src/services/metrics/credits.ts` (export `getCreditLiabilityDaily`)
- Create: `apps/api/src/services/metrics/credits.liability-daily.integration.test.ts`
- Modify: `apps/api/src/services/metrics/charts.credits.test.ts`
- Modify: `apps/api/src/services/metrics/charts.ts` (new `case "liability"`)

**Interfaces:**
- Consumes: `readOutstandingBalance` (module-private in `credits.ts`), `credit_ledger`.
- Produces: `getCreditLiabilityDaily(projectId, window: { from: Date; to: Date }): Promise<DailyCountRow[]>` — one row per day in the window, `day` = `YYYY-MM-DD`, `n` = outstanding credit balance at end of that day.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/services/metrics/credits.liability-daily.integration.test.ts`. It builds a real ledger through the credit engine, then asserts the series against the gauge:

```ts
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { getCreditLiabilityDaily } from "./credits";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_liab_${RUN_ID}`;
const SUB_ID = `sub_liab_${RUN_ID}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT = 100;
const SPEND = -30;
const LATE_GRANT = 25;

describe("getCreditLiabilityDaily", () => {
  let currencyId: string;

  afterAll(async () => {
    await drizzle.creditLedgerRepo.withLedgerDeleteAuthorized(
      drizzle.db,
      async (tx) => {
        await tx
          .delete(drizzle.schema.projects)
          .where(eq(drizzle.schema.projects.id, PROJECT_ID));
      },
    );
  });

  it("walks today's balance backwards through the deltas", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `LIAB ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rv_${RUN_ID}`,
    });
    const [cur] = await drizzle.db
      .insert(drizzle.schema.virtualCurrencies)
      .values({ projectId: PROJECT_ID, code: "GLD", name: "Gold" })
      .returning();
    currencyId = cur!.id;

    const now = Date.now();
    // Three dated ledger rows: +100 (D-2), -30 (D-1), +25 (today).
    // Written directly so the dates are controlled; `balance` is the
    // running total the schema documents.
    await drizzle.db.insert(drizzle.schema.creditLedger).values([
      {
        projectId: PROJECT_ID, subscriberId: SUB_ID, currencyId,
        type: "PURCHASE", amount: GRANT, balance: GRANT,
        createdAt: new Date(now - 2 * DAY_MS),
      },
      {
        projectId: PROJECT_ID, subscriberId: SUB_ID, currencyId,
        type: "SPEND", amount: SPEND, balance: GRANT + SPEND,
        createdAt: new Date(now - 1 * DAY_MS),
      },
      {
        projectId: PROJECT_ID, subscriberId: SUB_ID, currencyId,
        type: "BONUS", amount: LATE_GRANT, balance: GRANT + SPEND + LATE_GRANT,
        createdAt: new Date(now),
      },
    ]);

    const to = new Date();
    to.setUTCHours(23, 59, 59, 999);
    const from = new Date(to.getTime() - 2 * DAY_MS);
    from.setUTCHours(0, 0, 0, 0);

    const rows = await getCreditLiabilityDaily(PROJECT_ID, { from, to });
    expect(rows.map((r) => r.n)).toEqual([
      GRANT,
      GRANT + SPEND,
      GRANT + SPEND + LATE_GRANT,
    ]);
  });

  it("ends on exactly the figure /credits reports", async () => {
    const to = new Date();
    to.setUTCHours(23, 59, 59, 999);
    const from = new Date(to.getTime() - 2 * DAY_MS);
    from.setUTCHours(0, 0, 0, 0);

    const rows = await getCreditLiabilityDaily(PROJECT_ID, { from, to });
    const rollup = await drizzle.db.execute<{ outstanding: string }>(
      // The gauge's own query shape: latest balance per wallet.
      // Asserting the series against it is what proves the ledger
      // invariant (balance === running sum of amount) still holds.
      sqlOutstanding(PROJECT_ID),
    );
    expect(rows.at(-1)?.n).toBe(Number(rollup.rows[0]?.outstanding ?? "0"));
  });
});
```

Import `sql` from `drizzle-orm` and define `sqlOutstanding` at the top of the file as the same `DISTINCT ON ("subscriberId","currencyId")` query `readOutstandingBalance` uses. If `creditLedgerType` has no `SPEND` member, use the enum's actual debit member — read `packages/db/src/drizzle/schema.ts`'s `creditLedgerType` before writing the test.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/credits.liability-daily.integration.test.ts
```
Expected: FAIL — `getCreditLiabilityDaily` is not exported.

- [ ] **Step 3: Implement it in `credits.ts`**

```ts
/**
 * Daily grain behind the chart-catalog `liability` id: the outstanding
 * credit balance at the end of each day in the window.
 *
 * Anchored on TODAY's authoritative figure and walked BACKWARDS through
 * the window's signed deltas:
 *
 *   liability(D) = outstanding_now − Σ { amount : createdAt > end_of_day(D) }
 *
 * Three reasons for that direction, none of them stylistic:
 *
 *  1. The last point equals `getCreditsRollup`'s gauge by construction
 *     — same query, no drift between the chart and the card.
 *  2. It reads no row outside the window. `credit_ledger` is monthly
 *     range-partitioned; a forward sum from zero would silently lose
 *     its opening balance the day an old partition is detached.
 *  3. It uses `amount` while the anchor uses `balance`. Those two
 *     agreeing is the ledger's own invariant, asserted for real in
 *     credits.liability-daily.integration.test.ts rather than assumed.
 *
 * Credits, not USD: the rollup's `paidReserveUsd` needs an average
 * credit price derived from a window's revenue, which has no meaning
 * "as of last March". All currencies summed, matching the gauge.
 */
export async function getCreditLiabilityDaily(
  projectId: string,
  window: { from: Date; to: Date },
): Promise<DailyLiabilityRow[]> {
  const [{ outstanding }, deltaRows] = await Promise.all([
    readOutstandingBalance(projectId),
    readDailyDeltas(projectId, window),
  ]);

  const deltaByDay = new Map(deltaRows.map((r) => [r.day, r.delta]));
  const days: string[] = [];
  const cursor = new Date(window.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(window.to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  // Right to left: the last day carries today's figure, each earlier
  // day undoes the deltas booked after it.
  const out: DailyLiabilityRow[] = new Array(days.length);
  let running = outstanding;
  for (let i = days.length - 1; i >= 0; i--) {
    out[i] = { day: days[i]!, n: running };
    running -= deltaByDay.get(days[i]!) ?? 0;
  }
  return out;
}
```

with the delta reader beside it:

```ts
async function readDailyDeltas(
  projectId: string,
  window: { from: Date; to: Date },
): Promise<Array<{ day: string; delta: number }>> {
  const cl = drizzle.schema.creditLedger;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${cl.createdAt}), 'YYYY-MM-DD')`,
      delta: sql<string>`COALESCE(SUM("amount"), 0)::text`,
    })
    .from(cl)
    .where(
      and(
        eq(cl.projectId, projectId),
        gte(cl.createdAt, window.from),
        lte(cl.createdAt, window.to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${cl.createdAt})`);
  return rows.map((r) => ({ day: r.day, delta: Number(r.delta) }));
}
```

Declare `DailyLiabilityRow` (`{ day: string; n: number }`) and reuse the file's existing `DAY_MS` constant, adding one if absent.

- [ ] **Step 4: Run the integration test**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/credits.liability-daily.integration.test.ts
```
Expected: PASS.

- [ ] **Step 5: Add the dispatcher test**

Append to `apps/api/src/services/metrics/charts.credits.test.ts` (and add `getCreditLiabilityDaily` to that file's `vi.mock("./credits", …)` factory, plus delete the header paragraph claiming `liability` has no case):

```ts
describe("readChartSeries — liability", () => {
  it("serves the ledger's daily outstanding balance as a count", async () => {
    getCreditLiabilityDailyMock.mockResolvedValueOnce([
      { day: "2026-07-02", n: 95 },
    ]);
    const res = await readChartSeries("proj_1", "liability", 1);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("count");
    expect(res.points.at(-1)?.value).toBe(95);
  });

  it("issues no ClickHouse query — the ledger is Postgres", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    getCreditLiabilityDailyMock.mockResolvedValueOnce([]);
    const res = await readChartSeries("proj_1", "liability", 1);
    expect(res.supported).toBe(true);
  });
});
```

- [ ] **Step 6: Run it and watch it fail, then wire the reader**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/charts.credits.test.ts
```
Expected: FAIL. Then add to `charts.ts`:

```ts
    case "liability": {
      // Outstanding credit balance per day, from credits.ts — the
      // service that owns the gauge this line ends on. Postgres only:
      // NO assertClickHouseReady() here, deliberately, same as
      // `trials_started`/`churn`. The ledger is the source of truth and
      // a blank ClickHouse must not blank this chart.
      const rows = await getCreditLiabilityDaily(projectId, {
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(rows, w.from, w.to),
        supported: true,
      };
    }
```

- [ ] **Step 7: Re-run**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/charts.credits.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/metrics
git commit -m "feat(api): wire liability to the credit ledger's daily balance"
```

---

### Task 4: a period axis in the series contract

**Files:**
- Modify: `packages/shared/src/dashboard.ts`
- Modify: `apps/api/src/services/metrics/charts.ts` (shared `base`)
- Modify: `apps/api/src/services/metrics/export.ts` (+ `period` column)
- Modify: `apps/api/src/services/metrics/export.test.ts`
- Modify: `apps/dashboard/src/components/charts/series-chart-panel.tsx`
- Modify: `apps/dashboard/src/components/charts/series-chart-panel.test.tsx`

**Interfaces:**
- Produces: `ChartSeriesAxis`, `ChartSeriesPeriodGranularity`, `ChartSeriesPeriodPoint`, and a `ChartSeriesResponse` discriminated on `axis`. `ChartSeriesPoint` keeps its current name and shape.

- [ ] **Step 1: Write the failing export test**

In `apps/api/src/services/metrics/export.test.ts`, add:

```ts
it("emits a period, not a bucket, for a period-axis series", () => {
  const row = formatMetricsExportRow({
    kind: "series",
    chartId: "retention_curve",
    store: null,
    bucket: null,
    period: 3,
    dow: null,
    hour: null,
    step: null,
    metric: "value",
    value: "41.2",
    unit: "percent",
  });
  const cells = row.trim().split(",");
  expect(cells[COLUMN_INDEX.chart_id]).toBe("retention_curve");
  expect(cells[COLUMN_INDEX.bucket]).toBe("");
  expect(cells[COLUMN_INDEX.period]).toBe("3");
});
```

Derive `COLUMN_INDEX` from the exported `COLUMNS` array rather than hard-coding positions (export `COLUMNS` if it is not already exported) — a positional literal would silently pass after a column is inserted.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 src/services/metrics/export.test.ts
```
Expected: FAIL — `period` is not a known property.

- [ ] **Step 3: Change the shared contract**

In `packages/shared/src/dashboard.ts`, replace `ChartSeriesResponse` with:

```ts
/**
 * What the x-axis of a chart series MEANS.
 *
 * `"date"` — one point per calendar day; `bucket` is an ISO start-of-day.
 * `"period"` — one point per period SINCE COHORT START; `period` is a
 * 0-based index and there is no date at all. Cohort-shaped metrics
 * (`retention_curve`, `ltv`) are lines, but not lines over dates;
 * before this discriminator existed they could only be served by
 * inventing dates for them, which is why they shipped unsupported.
 *
 * Required, never optional-with-a-default: a period-shaped reader that
 * forgot to declare itself would claim to be dated and be plotted as
 * dates, which is the exact bug this field exists to prevent.
 */
export type ChartSeriesAxis = "date" | "period";

export type ChartSeriesPeriodGranularity = "day" | "week" | "month";

export interface ChartSeriesPeriodPoint {
  /** 0-based periods since cohort start. Not a date. */
  period: number;
  value: number | null;
  numerator?: number;
  denominator?: number;
}

interface ChartSeriesBase {
  chartId: string;
  unit: "count" | "percent" | "money";
  from: string;
  to: string;
  supported: boolean;
}

export type ChartSeriesResponse =
  | (ChartSeriesBase & { axis: "date"; points: ChartSeriesPoint[] })
  | (ChartSeriesBase & {
      axis: "period";
      periodGranularity: ChartSeriesPeriodGranularity;
      points: ChartSeriesPeriodPoint[];
    });
```

Keep `ChartSeriesPoint` exactly as it is, including its doc comments, and keep the `unit` doc comment by moving it onto `ChartSeriesBase.unit`.

- [ ] **Step 4: Declare the axis once in the dispatcher**

In `charts.ts`'s `readChartSeries`, extend the shared `base`:

```ts
  const base = {
    chartId,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    // Every date-grain reader inherits this; the two cohort readers
    // below override it with `axis: "period"`.
    axis: "date" as const,
  };
```

Compile and fix every reader the compiler flags.

- [ ] **Step 5: Add the export column**

In `export.ts`: add `"period"` to `COLUMNS` immediately after `"bucket"`, add `period: number | null` to `MetricsExportRow`, default it to `null` in `baseRow`, emit `r.period ?? ""` in `formatMetricsExportRow` in the same position, and narrow `seriesToRows`:

```ts
function seriesToRows(r: ChartSeriesResponse): MetricsExportRow[] {
  if (!r.supported) return [];
  // The long/tidy row format was chosen precisely because the sections
  // have unrelated grains; a period-axis series fills `period` and
  // leaves `bucket` empty rather than being forced into a date column.
  if (r.axis === "period") {
    return r.points.map((p) =>
      baseRow({
        kind: "series",
        chartId: r.chartId,
        period: p.period,
        metric: "value",
        value: p.value === null ? "" : String(p.value),
        unit: SERIES_UNIT_TO_EXPORT_UNIT[r.unit],
      }),
    );
  }
  return r.points.map((p) => /* unchanged date branch */);
}
```

- [ ] **Step 6: Teach the panel about periods**

In `series-chart-panel.tsx`, add beside `formatDayLabel`:

```ts
const PERIOD_LABEL_PREFIX: Record<ChartSeriesPeriodGranularity, string> = {
  day: "D",
  week: "W",
  month: "M",
};

/** Label a cohort-period point, e.g. "W3" — periods since cohort start,
 *  never a date. */
function formatPeriodLabel(
  period: number,
  granularity: ChartSeriesPeriodGranularity,
): string {
  return `${PERIOD_LABEL_PREFIX[granularity]}${period}`;
}
```

Replace the x-label call site with a single `xLabelAt(i)` computed from `data?.axis`:

```ts
  const xLabelAt = (i: number): string =>
    data?.axis === "period"
      ? formatPeriodLabel(data.points[i]!.period, data.periodGranularity)
      : formatDayLabel((points[i] as ChartSeriesPoint).bucket);
```

The "window truncated / served N days" note is about calendar days — render it only when `data?.axis !== "period"`.

- [ ] **Step 7: Add the panel test**

In `series-chart-panel.test.tsx`, add a case that arranges a period-axis response with three points and asserts the first x label is `W0` and no label parses as a date.

- [ ] **Step 8: Run everything this task touched**

```bash
cd packages/shared && nice -n 19 npx vitest run --maxWorkers=2
cd ../../apps/api && nice -n 19 npx vitest run --maxWorkers=2 src/services/metrics
cd ../dashboard && nice -n 19 npx vitest run --maxWorkers=2 src/components/charts
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared apps/api/src/services/metrics apps/dashboard/src/components/charts
git commit -m "feat(shared): give chart series an explicit x-axis kind"
```

---

### Task 5: `retention_curve` and `ltv`

**Files:**
- Modify: `apps/api/src/services/cohorts.ts` (add `computeCohortLtvCurve`, export `catalogCohortWindowRule` + granularity constants)
- Create: `apps/api/src/services/metrics/charts.cohorts.test.ts`
- Modify: `apps/api/src/services/metrics/charts.ts`

**Interfaces:**
- Consumes: `computeRetention({projectId, rule, granularity, periods})` → `{ size, granularity, periods, points: [{period, active, pct}] }`.
- Produces:
  - `catalogCohortShape(windowDays): { granularity: ChartSeriesPeriodGranularity; periods: number }`
  - `catalogCohortRule(from: Date, to: Date): CohortRule`
  - `computeCohortLtvCurve(input: ComputeRetentionInput): Promise<{ size: number; points: Array<{ period: number; cumulativeNetUsd: number }> }>`

- [ ] **Step 1: Write the failing dispatcher test**

Create `apps/api/src/services/metrics/charts.cohorts.test.ts`, mocking `../cohorts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const computeRetentionMock = vi.fn();
const computeCohortLtvCurveMock = vi.fn();
vi.mock("../cohorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cohorts")>();
  return {
    ...actual,
    computeRetention: (...a: unknown[]) => computeRetentionMock(...a),
    computeCohortLtvCurve: (...a: unknown[]) => computeCohortLtvCurveMock(...a),
  };
});

const isClickHouseConfiguredMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...a: unknown[]) => isClickHouseConfiguredMock(...a),
  queryAnalytics: vi.fn(),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");
const SIX_MONTHS_DAYS = 180;

describe("readChartSeries — cohort curves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    computeRetentionMock.mockReset();
    computeCohortLtvCurveMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("serves retention_curve on a period axis, never a date one", async () => {
    computeRetentionMock.mockResolvedValueOnce({
      size: 200,
      granularity: "week",
      periods: 2,
      points: [
        { period: 0, active: 200, pct: 100 },
        { period: 1, active: 82, pct: 41 },
      ],
    });
    const res = await readChartSeries("proj_1", "retention_curve", SIX_MONTHS_DAYS);
    expect(res.supported).toBe(true);
    expect(res.axis).toBe("period");
    expect(res.unit).toBe("percent");
    if (res.axis !== "period") throw new Error("unreachable");
    expect(res.periodGranularity).toBe("week");
    expect(res.points[1]).toMatchObject({
      period: 1, value: 41, numerator: 82, denominator: 200,
    });
    expect(res.points[0]).not.toHaveProperty("bucket");
  });

  it("reports null, not zero, for an empty cohort", async () => {
    computeRetentionMock.mockResolvedValueOnce({
      size: 0,
      granularity: "week",
      periods: 2,
      points: [
        { period: 0, active: 0, pct: 0 },
        { period: 1, active: 0, pct: 0 },
      ],
    });
    const res = await readChartSeries("proj_1", "retention_curve", SIX_MONTHS_DAYS);
    expect(res.points.every((p) => p.value === null)).toBe(true);
  });

  it("serves ltv as cumulative net revenue per cohort member", async () => {
    computeCohortLtvCurveMock.mockResolvedValueOnce({
      size: 50,
      points: [
        { period: 0, cumulativeNetUsd: 500 },
        { period: 1, cumulativeNetUsd: 750 },
      ],
    });
    const res = await readChartSeries("proj_1", "ltv", SIX_MONTHS_DAYS);
    expect(res.axis).toBe("period");
    expect(res.unit).toBe("money");
    expect(res.points[1]).toMatchObject({ period: 1, value: 15, denominator: 50 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 src/services/metrics/charts.cohorts.test.ts
```
Expected: FAIL — both ids come back unsupported.

- [ ] **Step 3: Add the catalog cohort shape to `cohorts.ts`**

```ts
// The fixed cohort the /charts catalog uses for `retention_curve` and
// `ltv`: everyone whose first revenue event falls inside the selected
// window. Both ids use the SAME cohort on purpose, so the two panels
// can be read side by side. Arbitrary rules live on /cohorts; this is
// the one-question view of the same data.
const DAY_GRAIN_MAX_DAYS = 62;
const WEEK_GRAIN_MAX_DAYS = 186;
const CATALOG_COHORT_PERIODS = 12;

export function catalogCohortShape(windowDays: number): {
  granularity: "day" | "week" | "month";
  periods: number;
} {
  const granularity =
    windowDays <= DAY_GRAIN_MAX_DAYS
      ? "day"
      : windowDays <= WEEK_GRAIN_MAX_DAYS
        ? "week"
        : "month";
  return { granularity, periods: CATALOG_COHORT_PERIODS };
}

export function catalogCohortRule(from: Date, to: Date): CohortRule {
  return {
    match: "all",
    filters: [
      { field: "firstSeenAfter", op: "gte", value: from.toISOString() },
      { field: "firstSeenBefore", op: "lte", value: to.toISOString() },
    ],
  };
}
```

Check `compileFilter`'s expected `value` encoding for `firstSeenAfter`/`firstSeenBefore` before writing this (it maps to `eventDate` with a `Date`/`DateTime64(3)` param kind) and match it exactly; add the constants to `__cohortsConstants` so tests can reach them.

- [ ] **Step 4: Add `computeCohortLtvCurve` beside `computeRetention`**

Same two-step shape as `computeRetention` (membership CTE, then a period-bucketed aggregate), differing only in the aggregate:

```ts
export interface CohortLtvCurve {
  size: number;
  points: Array<{ period: number; cumulativeNetUsd: number }>;
}

/**
 * The cohort's cumulative NET revenue at each period since join — the
 * standard LTV curve, and the honest shape for the catalog's `ltv` id.
 *
 * `v_revenue_lifetime_subscriber` cannot answer this: it groups by
 * (projectId, subscriberId) with no day dimension at all, so it is a
 * lifetime-to-date snapshot with no "when". This reads
 * raw_revenue_events directly, exactly as computeRetention does, and
 * buckets by dateDiff from each member's join bucket.
 *
 * Net = purchases minus refunds/chargebacks, the same sign convention
 * as mv_mrr_daily (0006). FINAL retained for the same at-least-once
 * outbox reason as every other raw_revenue_events reader.
 */
export async function computeCohortLtvCurve(
  input: ComputeRetentionInput,
): Promise<CohortLtvCurve> { /* … */ }
```

The period aggregate mirrors `computeRetention`'s second query with
`sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK')) - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK')) AS net`, grouped by period; make it cumulative in TypeScript (a running total over the returned periods), not in SQL — the same "keep the arithmetic where it can be tested" rule `buildRatePoints` follows.

- [ ] **Step 5: Wire both readers**

In `charts.ts`, in a new "Cohort group" section:

```ts
    case "retention_curve": {
      // A cohort curve, not a daily line: `axis: "period"`. See
      // ChartSeriesAxis in @rovenue/shared for why the discriminator
      // exists. /cohorts still owns arbitrary-rule cohorts; this is
      // the catalog's fixed-question view.
      assertClickHouseReady();
      const shape = catalogCohortShape(w.days);
      const r = await computeRetention({
        projectId,
        rule: catalogCohortRule(w.from, w.to),
        granularity: shape.granularity,
        periods: shape.periods,
      });
      return {
        ...base,
        axis: "period",
        periodGranularity: shape.granularity,
        unit: "percent",
        // An empty cohort has an UNDEFINED retention, not a zero one.
        points: r.points.map((p) => ({
          period: p.period,
          value: r.size > 0 ? p.pct : null,
          numerator: p.active,
          denominator: r.size,
        })),
        supported: true,
      };
    }

    case "ltv": {
      assertClickHouseReady();
      const shape = catalogCohortShape(w.days);
      const curve = await computeCohortLtvCurve({
        projectId,
        rule: catalogCohortRule(w.from, w.to),
        granularity: shape.granularity,
        periods: shape.periods,
      });
      return {
        ...base,
        axis: "period",
        periodGranularity: shape.granularity,
        unit: "money",
        points: curve.points.map((p) => ({
          period: p.period,
          value: curve.size > 0 ? p.cumulativeNetUsd / curve.size : null,
          numerator: p.cumulativeNetUsd,
          denominator: curve.size,
        })),
        supported: true,
      };
    }
```

- [ ] **Step 6: Re-run the dispatcher test**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 src/services/metrics/charts.cohorts.test.ts
```
Expected: PASS.

- [ ] **Step 7: Register the new CH query with the schema-contract harness**

Open `apps/api/src/services/metrics/schema-contract.integration.test.ts`, follow its existing registration pattern, and add `computeCohortLtvCurve`'s SQL so a rename in `raw_revenue_events` fails CI. Run it if Docker/ClickHouse is up:

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 \
  src/services/metrics/schema-contract.integration.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(api): serve retention_curve and ltv as cohort-period curves"
```

---

### Task 6: close §5

**Files:**
- Modify: `apps/api/src/services/metrics/charts.ts` (header comment)
- Modify: `apps/api/src/services/metrics/chart-catalog.ts` (three entry comments)
- Modify: `apps/api/src/services/metrics/chart-catalog.test.ts`
- Modify: `ROADMAP.md` §5

- [ ] **Step 1: Write the coverage test**

In `chart-catalog.test.ts`:

```ts
// Every system id must have a reader. This is the guard that keeps a
// new catalog entry from shipping as a silent empty state: adding an
// id without a `case` in readChartSeries fails here, by name.
it("every system catalog id is served by the dispatcher", async () => {
  for (const id of SYSTEM_CHART_IDS) {
    const res = await readChartSeries(PROJECT_ID, id, WINDOW_DAYS);
    expect(res, `${id} has no reader`).toMatchObject({ supported: true });
  }
});

it("an unknown id is still honestly unsupported", async () => {
  const res = await readChartSeries(PROJECT_ID, "not_a_chart", WINDOW_DAYS);
  expect(res.supported).toBe(false);
  expect(res.axis).toBe("date");
});
```

Mock every owning service the dispatcher calls (the file already mocks ClickHouse; follow `charts.credits.test.ts`'s factory style) so this asserts *dispatch coverage*, not data.

- [ ] **Step 2: Run it and watch it fail if anything is unwired**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2 src/services/metrics/chart-catalog.test.ts
```
Expected: PASS (all four are wired by now). If any id fails, that id is the bug — fix it, do not relax the test.

- [ ] **Step 3: Rewrite the comments that now say the opposite**

- `charts.ts`'s dispatcher header: replace "TWO IDS DELIBERATELY STAY UNWIRED" and "A THIRD ID STAYS UNWIRED" with a statement that all sixteen are served, what each of the four late ones is measured from, and that `supported: false` remains the answer for unknown and custom ids.
- `chart-catalog.ts`: replace the `retention_curve`, `ltv`, and `liability` block comments with one line each describing the metric's shape (period axis, credit balance), plus a short note at `rev_per_install` naming `installs.ts` as the definition of an install.
- Do not delete the history silently: each rewritten comment says what changed the earlier ruling (the SDK-only create path, the ledger's signed deltas, the axis discriminator).

- [ ] **Step 4: Update ROADMAP §5**

Replace the open `- [ ] The four catalog ids that stay supported: false` item with a checked item recording, per id, what it is measured from now and which earlier ruling it overturns. Update the section heading's date and the "12 of 16" line to 16 of 16.

- [ ] **Step 5: Full verification**

```bash
docker ps
psql "postgresql://rovenue:rovenue@localhost:5433/rovenue" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl'
cd packages/shared && nice -n 19 npx vitest run --maxWorkers=2
cd ../db && nice -n 19 npx vitest run --maxWorkers=2
cd ../../apps/api && nice -n 19 npx vitest run --maxWorkers=2
cd ../dashboard && nice -n 19 npx vitest run --maxWorkers=2
cd ../.. && pnpm build --concurrency=2
```

Run these strictly one at a time. Record the actual pass/fail counts; do not report "green" without the numbers.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/metrics ROADMAP.md
git commit -m "docs: close ROADMAP §5 — all sixteen catalog ids served"
```

---

## Self-Review

- **Spec coverage:** §4.1 → Task 1; §4.2 → Task 2; §4.3 → Task 3; §4.4 → Task 4; §4.5 → Task 5; §4.6 → Tasks 4 (export, panel) and 6 (unsupported path); §4.7 → Task 6. §5 data changes → Task 1 Step 6. Acceptance criteria 1–2 → Task 6 Step 1; 3 → Task 2; 4 → Task 3; 5 → Tasks 4–5; 6 → Task 4; 7 → Task 6 Step 5; 8 → Task 6 Step 4.
- **Type consistency:** `getInstallsDaily` / `getCreditLiabilityDaily` / `computeCohortLtvCurve` / `catalogCohortShape` / `catalogCohortRule` are named identically in their producing and consuming tasks. `DailyInstallCount` and `DailyLiabilityRow` are both `{day, n}`, which is what `buildCountSeriesPoints` consumes.
- **Known unknowns the implementer must read before writing** (flagged inline, not guessed): the exact import specifier for `listDailyMrr`; `creditLedgerType`'s debit member name; `compileFilter`'s encoding for `firstSeenAfter`/`firstSeenBefore`; `schema-contract.integration.test.ts`'s registration pattern.
