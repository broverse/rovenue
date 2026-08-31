// =============================================================
// revenue_events partition provisioning — integration tests (task 8a)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance with
// pg_partman installed (the docker-compose dev stack on host port 5433
// satisfies this — same convention as tests/import-jobs.test.ts).
//
// This repo's only reachable Postgres is a FRESH INSTALL
// (packages/db/src/fresh-install.ts marks 0019_install_pg_partman
// applied WITHOUT EXECUTING on this image — verified live: querying
// `partman.part_config` for `public.revenue_events` returns zero rows).
// So the real `revenue_events` table exercises the hand-rolled branch
// of `ensureMonthlyPartitions`. The pg_partman branch is exercised
// against a SCRATCH parent this file registers with
// `partman.create_parent` itself, so both branches get real, non-mocked
// coverage rather than one of them being asserted from documentation.

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
// Hand-rolled branch — the real revenue_events table
// -------------------------------------------------------------

describe("ensureRevenueEventPartitions — hand-rolled branch (this repo's fresh-install revenue_events)", () => {
  // Cleanup: these tests add real (empty) child partitions to the
  // shared dev/test `revenue_events` table. None can ever hold a row
  // (FK constraints refuse any insert with a fabricated project /
  // subscriber / purchase id, which these tests never create), so
  // dropping them after the run leaves the table exactly as this suite
  // found it.
  const createdPartitions = [
    "revenue_events_2011_03",
    "revenue_events_2012_07",
    "revenue_events_2013_01",
    "revenue_events_2013_02",
    "revenue_events_2013_03",
  ];

  afterAll(async () => {
    for (const name of createdPartitions) {
      await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${name}"`)}`);
    }
  });

  it("confirms the premise: pg_partman does not manage revenue_events on this database", async () => {
    const result = await db.execute(
      sql`SELECT 1 AS present FROM "partman"."part_config" WHERE "parent_table" = 'public.revenue_events' LIMIT 1`,
    );
    const rows = (result as unknown as { rows: unknown[] }).rows;
    expect(rows.length).toBe(0);
  });

  it("creates a monthly partition for a pre-2024 range and makes it a real child of revenue_events", async () => {
    // A year far enough in the past that no other test/migration could
    // plausibly have created it already, so this test's own assertions
    // are unambiguous regardless of run order.
    const min = new Date("2011-03-10T00:00:00Z");
    const max = new Date("2011-03-20T00:00:00Z");

    expect(await tableExists("public.revenue_events_2011_03")).toBe(false);

    await ensureRevenueEventPartitions(db, { minEventDate: min, maxEventDate: max });

    expect(await tableExists("public.revenue_events_2011_03")).toBe(true);
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

    expect(await tableExists("public.revenue_events_2013_01")).toBe(true);
    expect(await tableExists("public.revenue_events_2013_02")).toBe(true);
    expect(await tableExists("public.revenue_events_2013_03")).toBe(true);
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
