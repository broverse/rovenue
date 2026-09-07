// =============================================================
// revenue_events partition provisioning — integration tests (task 8a)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance with
// pg_partman installed (the docker-compose dev stack on host port 5433
// satisfies this — same convention as tests/import-jobs.test.ts).
//
// WHICH BRANCH THE REAL TABLE TAKES — this changed with migration 0130
//
// `ensureMonthlyPartitions` picks its strategy per call: pg_partman's
// `create_partition_time` when the parent is in `partman.part_config`,
// a hand-rolled `CREATE TABLE ... PARTITION OF` when it is not.
//
// This file used to assert that `revenue_events` took the HAND-ROLLED
// branch, because `0019_install_pg_partman` is skipped on a fresh
// install (packages/db/src/fresh-install.ts) and nothing else ever
// registered the parent. Migration 0130 registers it on BOTH install
// paths, so on any migrated database `revenue_events` is partman-managed
// and takes the partman branch — child partitions are now named
// `revenue_events_pYYYYMMDD`, not `revenue_events_YYYY_MM`.
//
// So the real table now exercises the PARTMAN branch, and the
// hand-rolled branch — still reachable for any partitioned parent
// nobody registered — is exercised against a SCRATCH parent this file
// creates and deliberately leaves out of `part_config`. Both branches
// keep real, non-mocked coverage; only which table stands for which
// branch has swapped.

import { createId } from "@paralleldrive/cuid2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../src/drizzle/schema";
import {
  describeRequiredPartitionSpan,
  ensureMonthlyPartitions,
  ensureRevenueEventPartitions,
  monthStartsUtc,
} from "../src/drizzle/repositories/revenue-event-partitions";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

async function tableExists(qualifiedName: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT to_regclass(${qualifiedName}) IS NOT NULL AS present`,
  );
  const rows = (result as unknown as { rows: Array<{ present: boolean }> })
    .rows;
  return rows[0]?.present === true;
}

async function childPartitionCount(parentQualified: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = ${parentQualified}::regclass`,
  );
  const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
  return rows[0]?.n ?? 0;
}

// -------------------------------------------------------------
// Pure month-range helpers — no DB
// -------------------------------------------------------------

describe("monthStartsUtc", () => {
  it("returns a single month when min and max fall in the same UTC month", () => {
    const months = monthStartsUtc(
      new Date("2019-06-01T00:00:00Z"),
      new Date("2019-06-28T23:59:59Z"),
    );
    expect(months).toEqual([new Date(Date.UTC(2019, 5, 1))]);
  });

  it("returns every month boundary inclusive of both ends", () => {
    const months = monthStartsUtc(
      new Date("2019-11-15T00:00:00Z"),
      new Date("2020-02-01T00:00:00Z"),
    );
    expect(months).toEqual([
      new Date(Date.UTC(2019, 10, 1)),
      new Date(Date.UTC(2019, 11, 1)),
      new Date(Date.UTC(2020, 0, 1)),
      new Date(Date.UTC(2020, 1, 1)),
    ]);
  });

  it("rejects a min after max", () => {
    expect(() =>
      monthStartsUtc(new Date("2026-01-01T00:00:00Z"), new Date("2019-01-01T00:00:00Z")),
    ).toThrow(/after/);
  });
});

describe("describeRequiredPartitionSpan", () => {
  it("reports the inclusive month span and count without touching the DB", () => {
    const span = describeRequiredPartitionSpan(
      new Date("2019-06-15T00:00:00Z"),
      new Date("2019-08-02T00:00:00Z"),
    );
    expect(span).toEqual({ fromMonth: "2019-06", toMonth: "2019-08", monthCount: 3 });
  });
});

// -------------------------------------------------------------
// The real revenue_events table — partman-managed since migration 0130
// -------------------------------------------------------------

describe("ensureRevenueEventPartitions — the real revenue_events (partman-managed since 0130)", () => {
  // Cleanup: these tests add real (empty) child partitions to the
  // shared dev/test `revenue_events` table. None can ever hold a row
  // (FK constraints refuse any insert with a fabricated project /
  // subscriber / purchase id, which these tests never create), so
  // dropping them after the run leaves the table exactly as this suite
  // found it. Named the partman way (`_pYYYYMMDD`) because that is what
  // the partman branch creates — dropping the old `_YYYY_MM` names would
  // silently leak a child per run.
  const createdPartitions = [
    "revenue_events_p20110301",
    "revenue_events_p20120701",
    "revenue_events_p20130101",
    "revenue_events_p20130201",
    "revenue_events_p20130301",
  ];

  afterAll(async () => {
    for (const name of createdPartitions) {
      await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${name}"`)}`);
    }
  });

  it("confirms the premise: migration 0130 registered revenue_events with pg_partman", async () => {
    // Fails loudly on a database that predates 0130 rather than quietly
    // agreeing with whatever it finds — the branch under test depends on
    // this being true, so it has to be asserted, not detected.
    const result = await db.execute(
      sql`SELECT 1 AS present FROM "partman"."part_config" WHERE "parent_table" = 'public.revenue_events' LIMIT 1`,
    );
    const rows = (result as unknown as { rows: unknown[] }).rows;
    expect(rows.length).toBe(1);
  });

  it("creates a monthly partition for a pre-2024 range and makes it a real child of revenue_events", async () => {
    // A year far enough in the past that no other test/migration could
    // plausibly have created it already, so this test's own assertions
    // are unambiguous regardless of run order. It is also far below
    // 0130's `p_start_partition`, which is the interesting case: partman
    // will happily create a month behind its own registered window.
    const min = new Date("2011-03-10T00:00:00Z");
    const max = new Date("2011-03-20T00:00:00Z");

    expect(await tableExists("public.revenue_events_p20110301")).toBe(false);

    await ensureRevenueEventPartitions(db, { minEventDate: min, maxEventDate: max });

    expect(await tableExists("public.revenue_events_p20110301")).toBe(true);
  });

  it("is idempotent: provisioning the same range twice does not error and creates nothing new the second time", async () => {
    const min = new Date("2012-07-01T00:00:00Z");
    const max = new Date("2012-07-15T00:00:00Z");

    await ensureRevenueEventPartitions(db, { minEventDate: min, maxEventDate: max });
    const countAfterFirst = await childPartitionCount("public.revenue_events");

    await expect(
      ensureRevenueEventPartitions(db, { minEventDate: min, maxEventDate: max }),
    ).resolves.toBeUndefined();
    const countAfterSecond = await childPartitionCount("public.revenue_events");

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("provisions every month across a multi-month range", async () => {
    const min = new Date("2013-01-15T00:00:00Z");
    const max = new Date("2013-03-05T00:00:00Z");

    await ensureRevenueEventPartitions(db, { minEventDate: min, maxEventDate: max });

    expect(await tableExists("public.revenue_events_p20130101")).toBe(true);
    expect(await tableExists("public.revenue_events_p20130201")).toBe(true);
    expect(await tableExists("public.revenue_events_p20130301")).toBe(true);
  });
});

// -------------------------------------------------------------
// Hand-rolled branch — a scratch parent nobody registered
// -------------------------------------------------------------

describe("ensureMonthlyPartitions — hand-rolled branch (unregistered scratch parent)", () => {
  const scratchTable = `scratch_unmanaged_${createId().toLowerCase()}`;
  const qualified = `public.${scratchTable}`;

  beforeAll(async () => {
    await db.execute(
      sql`CREATE TABLE ${sql.raw(`"${scratchTable}"`)} (
        id text NOT NULL,
        d timestamptz NOT NULL,
        PRIMARY KEY (id, d)
      ) PARTITION BY RANGE (d)`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${scratchTable}"`)} CASCADE`);
  });

  it("confirms the premise: the scratch parent is NOT registered with pg_partman", async () => {
    const result = await db.execute(
      sql`SELECT 1 AS present FROM "partman"."part_config" WHERE "parent_table" = ${qualified} LIMIT 1`,
    );
    const rows = (result as unknown as { rows: unknown[] }).rows;
    expect(rows.length).toBe(0);
  });

  it("creates `<table>_<yyyy>_<mm>` children directly, without pg_partman", async () => {
    expect(await tableExists(`public.${scratchTable}_2011_03`)).toBe(false);

    await ensureMonthlyPartitions(db, {
      qualifiedParentTable: qualified,
      unqualifiedParentTable: scratchTable,
      minEventDate: new Date("2011-03-10T00:00:00Z"),
      maxEventDate: new Date("2011-03-20T00:00:00Z"),
    });

    expect(await tableExists(`public.${scratchTable}_2011_03`)).toBe(true);
  });

  it("provisions every month across a multi-month range and stays idempotent", async () => {
    const range = {
      minEventDate: new Date("2013-01-15T00:00:00Z"),
      maxEventDate: new Date("2013-03-05T00:00:00Z"),
    };

    await ensureMonthlyPartitions(db, {
      qualifiedParentTable: qualified,
      unqualifiedParentTable: scratchTable,
      ...range,
    });
    const countAfterFirst = await childPartitionCount(qualified);

    expect(await tableExists(`public.${scratchTable}_2013_01`)).toBe(true);
    expect(await tableExists(`public.${scratchTable}_2013_02`)).toBe(true);
    expect(await tableExists(`public.${scratchTable}_2013_03`)).toBe(true);

    await expect(
      ensureMonthlyPartitions(db, {
        qualifiedParentTable: qualified,
        unqualifiedParentTable: scratchTable,
        ...range,
      }),
    ).resolves.toBeUndefined();
    expect(await childPartitionCount(qualified)).toBe(countAfterFirst);
  });
});

// -------------------------------------------------------------
// pg_partman-managed branch — a scratch parent this file owns
// -------------------------------------------------------------

describe("ensureMonthlyPartitions — pg_partman-managed branch (scratch parent)", () => {
  const scratchTable = `scratch_partman_${createId().toLowerCase()}`;
  const qualified = `public.${scratchTable}`;

  beforeAll(async () => {
    await db.execute(
      sql`CREATE TABLE ${sql.raw(`"${scratchTable}"`)} (
        id text NOT NULL,
        d timestamptz NOT NULL,
        PRIMARY KEY (id, d)
      ) PARTITION BY RANGE (d)`,
    );
    await db.execute(
      sql`SELECT "partman"."create_parent"(
        p_parent_table    => ${qualified},
        p_control         => 'd',
        p_interval        => '1 month',
        p_premake         => 1,
        p_start_partition => '2024-01-01'
      )`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${scratchTable}"`)} CASCADE`);
    await db.execute(
      sql`DELETE FROM "partman"."part_config" WHERE "parent_table" = ${qualified}`,
    );
  });

  it("confirms the premise: the scratch parent IS registered with pg_partman", async () => {
    const result = await db.execute(
      sql`SELECT 1 AS present FROM "partman"."part_config" WHERE "parent_table" = ${qualified} LIMIT 1`,
    );
    const rows = (result as unknown as { rows: unknown[] }).rows;
    expect(rows.length).toBe(1);
  });

  it("delegates to partman.create_partition_time for a month outside the registered window", async () => {
    const min = new Date("2019-06-01T00:00:00Z");
    const max = new Date("2019-06-01T00:00:00Z");

    expect(await tableExists(`public.${scratchTable}_p20190601`)).toBe(false);

    await ensureMonthlyPartitions(db, {
      qualifiedParentTable: qualified,
      unqualifiedParentTable: scratchTable,
      minEventDate: min,
      maxEventDate: max,
    });

    expect(await tableExists(`public.${scratchTable}_p20190601`)).toBe(true);
  });

  it("is idempotent through the pg_partman API too", async () => {
    const min = new Date("2018-02-01T00:00:00Z");
    const max = new Date("2018-02-01T00:00:00Z");

    await ensureMonthlyPartitions(db, {
      qualifiedParentTable: qualified,
      unqualifiedParentTable: scratchTable,
      minEventDate: min,
      maxEventDate: max,
    });
    const countAfterFirst = await childPartitionCount(qualified);

    await expect(
      ensureMonthlyPartitions(db, {
        qualifiedParentTable: qualified,
        unqualifiedParentTable: scratchTable,
        minEventDate: min,
        maxEventDate: max,
      }),
    ).resolves.toBeUndefined();
    const countAfterSecond = await childPartitionCount(qualified);

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("a row inside the newly-created partition's range is actually insertable", async () => {
    const min = new Date("2015-09-01T00:00:00Z");
    const max = new Date("2015-09-01T00:00:00Z");
    await ensureMonthlyPartitions(db, {
      qualifiedParentTable: qualified,
      unqualifiedParentTable: scratchTable,
      minEventDate: min,
      maxEventDate: max,
    });

    await db.execute(
      sql`INSERT INTO ${sql.raw(`"${scratchTable}"`)} (id, d) VALUES ('row1', '2015-09-15'::timestamptz)`,
    );
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${scratchTable}"`)} WHERE d = '2015-09-15'::timestamptz`,
    );
    const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
    expect(rows[0]?.n).toBe(1);
  });
});
