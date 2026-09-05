// =============================================================
// dropTablePartitionsOlderThan — real Postgres integration test
// =============================================================
//
// ROADMAP §9.2 Task 4. Everything here runs against a SCRATCH
// partitioned table, never `credit_ledger` or `revenue_events`: the
// assertions are about partition-boundary arithmetic and the
// audit-before-drop ordering, and a test that drops real ledger
// partitions is one nobody could safely run twice.
//
// The rule this task exists to honour: dropping a partition bypasses
// `credit_ledger`'s append-only trigger completely (row triggers fire
// on row DML, not DDL — probed directly against this repo's Postgres),
// so the audit row this suite asserts on is the ONLY durable record a
// drop happened at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, getDb } from "@rovenue/db";
import { AUDIT_ACTION_RETENTION_PARTITION_DROPPED } from "../lib/audit";
import {
  dropTablePartitionsOlderThan,
  writeRetentionPartitionAuditRow,
  type PartitionDropAuditContext,
} from "./retention-sweep";

const PARENT_TABLE = "retention_sweep_scratch_parent";
const WINDOW_DAYS = 365; // arbitrary — only recorded on the audit row here

async function resetScratchTable(): Promise<void> {
  const db = getDb();
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${PARENT_TABLE}"`)} CASCADE`);
  await db.execute(sql`
    CREATE TABLE ${sql.raw(`"${PARENT_TABLE}"`)} (
      id text NOT NULL,
      ts timestamptz NOT NULL
    ) PARTITION BY RANGE (ts)
  `);
}

async function createScratchPartition(
  name: string,
  fromIso: string,
  toIso: string,
): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE ${sql.raw(`"${name}"`)}
      PARTITION OF ${sql.raw(`"${PARENT_TABLE}"`)}
      FOR VALUES FROM (${sql.raw(`'${fromIso}'`)}) TO (${sql.raw(`'${toIso}'`)})
  `);
}

async function insertScratchRow(ts: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    INSERT INTO ${sql.raw(`"${PARENT_TABLE}"`)} (id, ts)
    VALUES (${`row-${Math.random().toString(36).slice(2)}`}, ${ts}::timestamptz)
  `);
}

async function partitionExists(name: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute<{ present: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${name}) AS present`,
  );
  return Boolean(result.rows[0]?.present);
}

async function rowCountOf(name: string): Promise<number> {
  const db = getDb();
  const result = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${sql.raw(`"${name}"`)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeEach(async () => {
  await resetScratchTable();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${PARENT_TABLE}"`)} CASCADE`);
});

describe("DROP_PARTITION strategy", () => {
  it("drops a partition whose whole range predates the cutoff", async () => {
    const partition = "retention_sweep_scratch_2024_01";
    await createScratchPartition(partition, "2024-01-01", "2024-02-01");
    await insertScratchRow("2024-01-15T00:00:00.000Z");

    // The partition's entire range (Jan) is well before the cutoff (Jun).
    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    const writes: PartitionDropAuditContext[] = [];
    const result = await dropTablePartitionsOlderThan(
      getDb(),
      PARENT_TABLE,
      cutoff,
      WINDOW_DAYS,
      async (ctx) => {
        writes.push(ctx);
      },
    );

    expect(result.partitionsDropped).toEqual([partition]);
    expect(result.rowsDropped).toBe(1);
    expect(await partitionExists(partition)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("leaves a partition alone when the cutoff falls INSIDE its range", async () => {
    // The boundary case. Dropping here destroys rows still inside the
    // retention window — the data loss the window exists to prevent.
    // This is the most important assertion in the file.
    const partition = "retention_sweep_scratch_2024_02";
    await createScratchPartition(partition, "2024-02-01", "2024-03-01");
    await insertScratchRow("2024-02-10T00:00:00.000Z");

    // Cutoff lands mid-February: inside [2024-02-01, 2024-03-01).
    const cutoff = new Date("2024-02-15T00:00:00.000Z");
    const result = await dropTablePartitionsOlderThan(
      getDb(),
      PARENT_TABLE,
      cutoff,
      WINDOW_DAYS,
      async () => {
        throw new Error(
          "writeAuditRow must not be called for an in-window partition",
        );
      },
    );

    expect(result.partitionsDropped).toEqual([]);
    expect(result.rowsDropped).toBe(0);
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowCountOf(partition)).toBe(1);
  });

  it("leaves a partition newer than the cutoff alone", async () => {
    const partition = "retention_sweep_scratch_2024_12";
    await createScratchPartition(partition, "2024-12-01", "2025-01-01");
    await insertScratchRow("2024-12-15T00:00:00.000Z");

    // Cutoff (Jun 2024) predates the partition's entire range (Dec 2024).
    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    const result = await dropTablePartitionsOlderThan(
      getDb(),
      PARENT_TABLE,
      cutoff,
      WINDOW_DAYS,
      async () => {
        throw new Error(
          "writeAuditRow must not be called for a not-yet-expired partition",
        );
      },
    );

    expect(result.partitionsDropped).toEqual([]);
    expect(await partitionExists(partition)).toBe(true);
  });

  it("writes the audit row before the drop, carrying the row count", async () => {
    // Assert the audit row exists AND that its `after` carries the
    // count observed pre-drop. Once the partition is gone that count
    // cannot be recovered from anywhere else.
    const partition = "retention_sweep_scratch_2023_06";
    await createScratchPartition(partition, "2023-06-01", "2023-07-01");
    await insertScratchRow("2023-06-05T00:00:00.000Z");
    await insertScratchRow("2023-06-20T00:00:00.000Z");
    await insertScratchRow("2023-06-25T00:00:00.000Z");

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    // The REAL production writer — exercises the full path into
    // audit_logs, including the projectId: null branch this task
    // requires (a real table's own credit_ledger/revenue_events row
    // would fail its FK to `projects.id`; the sweep is a global,
    // cross-project action, so `writeRetentionPartitionAuditRow` uses
    // `projectId: null` rather than a fabricated project id).
    const result = await dropTablePartitionsOlderThan(
      getDb(),
      PARENT_TABLE,
      cutoff,
      WINDOW_DAYS,
      writeRetentionPartitionAuditRow,
    );

    expect(result.partitionsDropped).toEqual([partition]);
    expect(result.rowsDropped).toBe(3);
    expect(await partitionExists(partition)).toBe(false);

    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AUDIT_ACTION_RETENTION_PARTITION_DROPPED),
          eq(auditLogs.resourceId, partition),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.resource).toBe("retention_partition");
    expect(row.userId).toBe("system");
    // Genuinely cross-project: no single project owns a dropped
    // partition's rows, so projectId is null rather than a fabricated
    // "system" id that would fail the real FK to projects.id.
    expect(row.projectId).toBeNull();
    const after = row.after as Record<string, unknown>;
    expect(after.table).toBe(PARENT_TABLE);
    expect(after.partition).toBe(partition);
    expect(after.rowCount).toBe(3);
    expect(after.windowDays).toBe(WINDOW_DAYS);
    expect(new Date(after.cutoff as string).toISOString()).toBe(
      cutoff.toISOString(),
    );
  });

  it("does not drop anything when the audit write fails", async () => {
    // Make the audit call reject; assert the partition still exists.
    // The ordering rule is only real if the drop is conditional on it.
    const partition = "retention_sweep_scratch_2023_09";
    await createScratchPartition(partition, "2023-09-01", "2023-10-01");
    await insertScratchRow("2023-09-10T00:00:00.000Z");

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    await expect(
      dropTablePartitionsOlderThan(
        getDb(),
        PARENT_TABLE,
        cutoff,
        WINDOW_DAYS,
        async () => {
          throw new Error("audit write rejected");
        },
      ),
    ).rejects.toThrow("audit write rejected");

    expect(await partitionExists(partition)).toBe(true);
    expect(await rowCountOf(partition)).toBe(1);

    // And no orphaned audit row was left behind either — the rejection
    // means writeChained's own insert never committed.
    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, partition));
    expect(rows).toHaveLength(0);
  });
});
