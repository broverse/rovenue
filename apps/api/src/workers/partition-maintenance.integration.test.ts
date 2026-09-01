import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@rovenue/db";
import { runPartitionMaintenance } from "./partition-maintenance";

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
