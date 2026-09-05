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
//
// A partition affects every project sharing it, so ONE row is written
// into EACH affected project's own chain (never a single global row —
// see `PartitionDropAuditContext`'s doc comment in retention-sweep.ts
// for why: `auditLogs.projectId` is a real FK to `projects.id`, and a
// global row would sit outside every project's own chain, invisible to
// `verifyAuditChain` and the §9.3 `/proof` export). The
// "writes the audit row" case below seeds two real projects and proves
// both: a real row lands in EACH project's audit_logs with that
// project's OWN resolved window, AND `listAuditProofRows` — the exact
// read `/proof` uses — returns it for that project's bundle.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, drizzle, getDb, projects } from "@rovenue/db";
import {
  AUDIT_ACTION_RETENTION_PARTITION_DROPPED,
  verifyAuditChain,
} from "../lib/audit";
import {
  dropTablePartitionsOlderThan,
  writeRetentionPartitionAuditRow,
  type PartitionDropAuditContext,
} from "./retention-sweep";

const PARENT_TABLE = "retention_sweep_scratch_parent";
// Used only by the stub-writer tests below (mechanics of the drop
// itself), which never reach the real `audit()` call and so never
// touch the FK to `projects.id`.
const STUB_PROJECT_WINDOWS = new Map([["prj_stub_partition_sweep", 365]]);

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

let seededProjectIds: string[] = [];

async function seedProject(id: string): Promise<void> {
  await getDb().insert(projects).values({ id, name: `Retention sweep test ${id}` });
  seededProjectIds.push(id);
}

beforeEach(async () => {
  await resetScratchTable();
  seededProjectIds = [];
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${PARENT_TABLE}"`)} CASCADE`);
  for (const id of seededProjectIds) {
    // Cascades to audit_logs.projectId via ON DELETE SET NULL — fine,
    // the rows this test wrote are already asserted on by then.
    await db.delete(projects).where(eq(projects.id, id));
  }
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
      STUB_PROJECT_WINDOWS,
      async (ctx) => {
        writes.push(ctx);
      },
    );

    expect(result.partitionsDropped).toEqual([partition]);
    expect(result.rowsDropped).toBe(1);
    expect(await partitionExists(partition)).toBe(false);
    // One audit write per project in `projectWindows` — one project here.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.projectId).toBe("prj_stub_partition_sweep");
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
      STUB_PROJECT_WINDOWS,
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
      STUB_PROJECT_WINDOWS,
      async () => {
        throw new Error(
          "writeAuditRow must not be called for a not-yet-expired partition",
        );
      },
    );

    expect(result.partitionsDropped).toEqual([]);
    expect(await partitionExists(partition)).toBe(true);
  });

  it("writes one audit row per affected project before the drop, each carrying its own window and the shared row count, and each shows up in that project's own proof bundle", async () => {
    // Two REAL projects — a partition drop affects every project
    // sharing it, so this is what actually happens on a real sweep,
    // not a simplification. Deliberately different resolved windows
    // (200 vs 400) to prove each row carries ITS OWN project's window,
    // not the fleet-wide maximum the cutoff was computed from.
    await seedProject("prj_partsweep_a");
    await seedProject("prj_partsweep_b");
    const projectWindows = new Map([
      ["prj_partsweep_a", 200],
      ["prj_partsweep_b", 400],
    ]);

    const partition = "retention_sweep_scratch_2023_06";
    await createScratchPartition(partition, "2023-06-01", "2023-07-01");
    await insertScratchRow("2023-06-05T00:00:00.000Z");
    await insertScratchRow("2023-06-20T00:00:00.000Z");
    await insertScratchRow("2023-06-25T00:00:00.000Z");

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    // The REAL production writer — exercises the full path into
    // audit_logs, once per project.
    const result = await dropTablePartitionsOlderThan(
      getDb(),
      PARENT_TABLE,
      cutoff,
      projectWindows,
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
    // One row per project — never one global row.
    expect(rows).toHaveLength(2);

    const byProject = new Map(rows.map((r) => [r.projectId, r]));
    for (const [projectId, windowDays] of projectWindows) {
      const row = byProject.get(projectId);
      expect(row).toBeDefined();
      expect(row!.resource).toBe("retention_partition");
      expect(row!.userId).toBe("system");
      const after = row!.after as Record<string, unknown>;
      expect(after.table).toBe(PARENT_TABLE);
      expect(after.partition).toBe(partition);
      expect(after.rowCount).toBe(3);
      // THIS project's own window, not the other project's or the max.
      expect(after.windowDays).toBe(windowDays);
      expect(new Date(after.cutoff as string).toISOString()).toBe(
        cutoff.toISOString(),
      );

      // §9.3 proof: the exact read `/proof` uses for a project's
      // export. The row must be visible there — that's the entire
      // reason a per-project row was chosen over a single global one.
      const proofRows = await drizzle.auditLogRepo.listAuditProofRows(getDb(), {
        projectId,
        limit: 100,
      });
      expect(
        proofRows.some(
          (p) =>
            p.action === AUDIT_ACTION_RETENTION_PARTITION_DROPPED &&
            p.resourceId === partition,
        ),
      ).toBe(true);

      // And the chain verifies cleanly — the row's hash was computed
      // and linked exactly like any other project-scoped audit() call.
      const verification = await verifyAuditChain(projectId);
      expect(verification.errors).toEqual([]);
    }
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
        STUB_PROJECT_WINDOWS,
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

  it("stops mid-partition and leaves it undropped when ONE affected project's audit write fails, even if an earlier project's row already committed", async () => {
    // Two projects share this partition. The first project's audit
    // write succeeds and commits (audit() opens its own transaction
    // per call — see lib/audit.ts); the second's is made to reject.
    // The partition must still not be dropped, and no result should
    // claim it was.
    await seedProject("prj_partsweep_partial");
    const projectWindows = new Map([
      ["prj_partsweep_partial", 365],
      ["prj_stub_partition_sweep_2", 365],
    ]);

    const partition = "retention_sweep_scratch_2023_03";
    await createScratchPartition(partition, "2023-03-01", "2023-04-01");
    await insertScratchRow("2023-03-10T00:00:00.000Z");

    const cutoff = new Date("2024-06-01T00:00:00.000Z");
    let calls = 0;
    await expect(
      dropTablePartitionsOlderThan(
        getDb(),
        PARENT_TABLE,
        cutoff,
        projectWindows,
        async (ctx) => {
          calls += 1;
          if (calls === 1) {
            await writeRetentionPartitionAuditRow(ctx);
            return;
          }
          throw new Error("second project's audit write rejected");
        },
      ),
    ).rejects.toThrow("second project's audit write rejected");

    expect(await partitionExists(partition)).toBe(true);
    expect(await rowCountOf(partition)).toBe(1);

    // The first project's row survives — it already committed under
    // its own transaction — even though the overall drop was aborted.
    const firstProjectRows = await getDb()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, "prj_partsweep_partial"),
          eq(auditLogs.resourceId, partition),
        ),
      );
    expect(firstProjectRows).toHaveLength(1);
  });
});
