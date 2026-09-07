import { afterAll, describe, expect, it } from "vitest";
import type { Gauge } from "prom-client";
import { sql } from "drizzle-orm";
import { getDb } from "@rovenue/db";
import { runPartitionMaintenance } from "./partition-maintenance";
import {
  partitionDefaultRows,
  partitionMaintenancePartmanRan,
  partitionPremakeMonthsRemaining,
} from "../lib/metrics";

// =============================================================
// Partition maintenance — integration
// =============================================================
//
// This file is referenced by partition-maintenance.ts's own header as
// the load-bearing proof of its behaviour. It did not exist, which is
// how two independent breaks shipped and stayed invisible:
//
//   1. The partition bounds were interpolated through drizzle's `sql`
//      tag, binding them as $1/$2. Postgres rejects parameters in a
//      partition bound at PARSE time — before `IF NOT EXISTS` can
//      short-circuit — so `createOutgoingWebhooksPartition` threw on
//      its first loop iteration on every run, whether or not the
//      partition already existed. `runPartitionMaintenance()` had
//      therefore never once completed since it was written.
//
//   2. `partman.run_maintenance_proc()` was called unconditionally,
//      but migration 0019 never executes on a fresh-install database
//      (fresh-install.ts marks the TimescaleDB-era migrations
//      applied-without-running). So on self-hosted installs, CI and
//      these very test databases there is no `partman` schema, and
//      the worker died there before ever reaching step 1.
//
// The masking effect is worth stating: migration 0017 bulk-created
// outgoing_webhooks partitions through 2028-12, so nothing surfaced
// in production — the failure only becomes visible when inserts pass
// that boundary.

const OUTGOING_WEBHOOKS_TABLE = "outgoing_webhooks";
const MONTHS_AHEAD = 13;

async function partitionNamesFor(months: number): Promise<string[]> {
  const now = new Date();
  const names: string[] = [];
  for (let i = 0; i < months; i++) {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1),
    );
    const yyyy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
    names.push(`${OUTGOING_WEBHOOKS_TABLE}_${yyyy}_${mm}`);
  }
  return names;
}

async function existingPartitions(names: string[]): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.execute<{ relname: string }>(sql`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY(${sql.raw(
         `ARRAY[${names.map((n) => `'${n}'`).join(",")}]`,
       )})
  `);
  return new Set(rows.rows.map((r) => r.relname));
}

describe("runPartitionMaintenance", () => {
  it("completes, and creates the outgoing_webhooks partitions it promises", async () => {
    const expected = await partitionNamesFor(MONTHS_AHEAD);

    // Before the fix this call threw — either on the missing `partman`
    // schema or on the bound partition parameters — so simply reaching
    // the assertions below is the regression proof.
    const result = await runPartitionMaintenance();

    expect(result.manualPartitionsCreated).toBe(MONTHS_AHEAD);

    const present = await existingPartitions(expected);
    for (const name of expected) {
      expect(present.has(name), `expected partition ${name}`).toBe(true);
    }
  });

  it("is idempotent — a second run neither throws nor changes the partition set", async () => {
    const expected = await partitionNamesFor(MONTHS_AHEAD);

    await runPartitionMaintenance();
    const afterFirst = await existingPartitions(expected);

    const second = await runPartitionMaintenance();
    const afterSecond = await existingPartitions(expected);

    expect(second.manualPartitionsCreated).toBe(MONTHS_AHEAD);
    expect([...afterSecond].sort()).toEqual([...afterFirst].sort());
  });

  it("reports whether partman actually ran rather than always claiming it did", async () => {
    const db = getDb();
    const installed = await db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = 'partman'
      ) AS present
    `);

    const result = await runPartitionMaintenance();

    // The old code hardcoded `partmanRan: true` regardless. The value
    // must now describe this database: fresh-install databases (these
    // test databases included) have no partman and must report false
    // while still doing the hand-rolled work.
    expect(result.partmanRan).toBe(installed.rows[0]?.present ?? false);
  });

  it("accepts a row dated past migration 0017's bulk-created window", async () => {
    const db = getDb();
    // 0017 bulk-created partitions through 2028-12. The whole point of
    // this worker is that inserts keep working past that boundary; if
    // the maintenance run is broken, this insert fails with "no
    // partition of relation found for row".
    const beyond = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 12, 15),
    );

    await runPartitionMaintenance();

    const inserted = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = ${sql.raw(
             `'${OUTGOING_WEBHOOKS_TABLE}_${beyond.getUTCFullYear()}_${String(
               beyond.getUTCMonth() + 1,
             ).padStart(2, "0")}'`,
           )}
      ) AS ok
    `);

    expect(inserted.rows[0]?.ok).toBe(true);
  });
});

// =============================================================
// The gauges (fix round 1, item 3)
// =============================================================
//
// Migration 0130 creates ONE forward partition and hands the rest to
// `partman.run_maintenance_proc()` running daily. Before these gauges
// nothing observed whether that happened. These tests exist to keep
// them able to FIRE: a gauge that is never set reads exactly like a
// healthy one, which is how the 2029 cliff stayed invisible.

/** Purpose-built parent so the DEFAULT-partition assertion never has to
 *  strand a row in a real table (which would permanently block attaching
 *  that month's partition — the very failure the gauge warns about). */
const PROBE_PARENT = "partition_metrics_probe";
const PROBE_CONTROL = "eventDate";
/** Far enough past any premake window that the row can only land in the
 *  DEFAULT partition. */
const PROBE_STRANDED_ROW_DATE = "2099-06-15T00:00:00.000Z";
const PROBE_FIRST_CHILD_FROM = "2026-01-01T00:00:00.000Z";
const PROBE_FIRST_CHILD_TO = "2026-02-01T00:00:00.000Z";

async function partmanInstalled(): Promise<boolean> {
  const db = getDb();
  const res = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = 'partman'
    ) AS present
  `);
  return res.rows[0]?.present ?? false;
}

async function gaugeValue(
  gauge: Gauge<string>,
  table?: string,
): Promise<number | undefined> {
  const snapshot = await gauge.get();
  const match = snapshot.values.find((v) =>
    table === undefined ? true : v.labels.table === table,
  );
  return match?.value;
}

describe("partition maintenance gauges", () => {
  afterAll(async () => {
    const db = getDb();
    await db.execute(
      sql.raw(`DROP TABLE IF EXISTS "${PROBE_PARENT}" CASCADE`),
    );
    if (await partmanInstalled()) {
      await db.execute(
        sql.raw(
          `DELETE FROM partman.part_config WHERE parent_table = 'public.${PROBE_PARENT}'`,
        ),
      );
    }
  });

  it("reports premake headroom for every table this worker keeps ahead", async () => {
    await runPartitionMaintenance();

    for (const table of [
      "revenue_events",
      "credit_ledger",
      OUTGOING_WEBHOOKS_TABLE,
    ]) {
      const months = await gaugeValue(partitionPremakeMonthsRemaining, table);
      expect(months, `no headroom gauge for ${table}`).toBeDefined();
      // The alert threshold is < 3. A freshly-migrated database has a
      // full premake window, so anything at or below the threshold here
      // means the premake is not being maintained at all — which is the
      // exact condition the alert exists to catch.
      expect(months, `${table} headroom`).toBeGreaterThan(3);
    }
  });

  it("records whether partman actually ran, rather than leaving it in a log line", async () => {
    const installed = await partmanInstalled();

    // The claim the worker's header now makes: 0051_funnel_partitions
    // installs pg_partman UNGUARDED on both install paths, so a
    // fully-migrated database — this one included — has it. The old
    // comment said the opposite ("CI and the test databases have no
    // partman schema at all") and nothing ever checked.
    expect(installed).toBe(true);

    await runPartitionMaintenance();

    expect(await gaugeValue(partitionMaintenancePartmanRan)).toBe(1);
  });

  it("counts rows stranded in a DEFAULT partition instead of reporting nothing", async () => {
    const db = getDb();
    expect(await partmanInstalled()).toBe(true);

    await db.execute(
      sql.raw(`
        CREATE TABLE "${PROBE_PARENT}" (
          "id" bigserial NOT NULL,
          "${PROBE_CONTROL}" timestamptz NOT NULL,
          PRIMARY KEY ("id", "${PROBE_CONTROL}")
        ) PARTITION BY RANGE ("${PROBE_CONTROL}")
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE "${PROBE_PARENT}_2026_01"
          PARTITION OF "${PROBE_PARENT}"
          FOR VALUES FROM ('${PROBE_FIRST_CHILD_FROM}')
                       TO ('${PROBE_FIRST_CHILD_TO}')
      `),
    );
    await db.execute(
      sql.raw(`
        SELECT partman.create_parent(
          p_parent_table    => 'public.${PROBE_PARENT}',
          p_control         => '${PROBE_CONTROL}',
          p_interval        => '1 month',
          p_premake         => 2,
          p_start_partition => '${PROBE_FIRST_CHILD_TO}')
      `),
    );

    // Healthy first: check_default() returns NOTHING for a clean set, so
    // the gauge must still publish a zero. Otherwise "no series" and
    // "not measured" are indistinguishable.
    await runPartitionMaintenance();
    expect(await gaugeValue(partitionDefaultRows, "revenue_events")).toBe(0);
    expect(await gaugeValue(partitionDefaultRows, PROBE_PARENT)).toBeUndefined();

    // Now strand a row. This is the state the alert pages on: Postgres
    // will refuse to attach the real partition for that month for as
    // long as this row sits in the default.
    await db.execute(
      sql.raw(`
        INSERT INTO "${PROBE_PARENT}" ("${PROBE_CONTROL}")
        VALUES ('${PROBE_STRANDED_ROW_DATE}')
      `),
    );

    await runPartitionMaintenance();

    // Attributed to the PARENT, not to `<parent>_default` which is what
    // partman.check_default() actually reports — so the label lines up
    // with the headroom gauge and one alert can name one table.
    expect(await gaugeValue(partitionDefaultRows, PROBE_PARENT)).toBe(1);
  });
});
