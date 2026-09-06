import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { auditLogs, drizzle, getDb, projects } from "@rovenue/db";
import {
  assembleAuditProofBundle,
  AUDIT_PROOF_MAX_ENTRIES,
  hashAuditRow,
  verifyAuditBundle,
  type AuditChainPayload,
  type AuditProofBundle,
  type AuditProofBundleEntry,
} from "@rovenue/shared/audit-chain";
import { AUDIT_ACTION_RETENTION_CHECKPOINT } from "../../lib/audit";

// =============================================================
// checkpointAndTruncate — real Postgres integration test
// =============================================================
//
// ROADMAP §9.2 Task 5. `audit_logs` is an append-only, per-project
// SHA-256 hash chain: deleting a row makes every later row
// unverifiable back to origin unless the deleted segment survives as
// an independently verifiable artifact FIRST. These tests exercise
// the real ordering against real Postgres (export -> store -> delete
// -> checkpoint) and run the REAL offline verifier
// (`verifyAuditBundle`, @rovenue/shared/audit-chain — the same
// function `scripts/verify-audit-bundle.ts` wraps as a CLI) over both
// halves of the cut, rather than asserting on hand-built expectations
// that could drift from what the verifier actually checks.
//
// Object storage itself is mocked (`isStorageConfigured`/`putObject`
// from `../../lib/import-store`) — nothing here needs a real MinIO/S3
// endpoint — but every row, every hash, and every delete is real.

const { isStorageConfiguredMock, putObjectMock } = vi.hoisted(() => ({
  isStorageConfiguredMock: vi.fn(() => true),
  putObjectMock: vi.fn(async (_key: string, _body: unknown, _contentType: string) => {}),
}));

vi.mock("../../lib/import-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/import-store")>();
  return {
    ...actual,
    isStorageConfigured: isStorageConfiguredMock,
    putObject: putObjectMock,
  };
});

const {
  checkpointAndTruncate,
  AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
  AUDIT_CHECKPOINT_SKIP_REASON_NOTHING_TO_CHECKPOINT,
} = await import("./checkpoint");

let seededProjectIds: string[] = [];

async function seedTestProject(): Promise<string> {
  const id = `prj_checkpoint_${createId()}`;
  await getDb().insert(projects).values({ id, name: `Checkpoint test ${id}` });
  seededProjectIds.push(id);
  return id;
}

/**
 * Inserts a real, correctly-hashed audit_logs row directly (bypassing
 * `audit()`, which always stamps `createdAt` at call time) so tests can
 * control exactly which rows fall on which side of a cutoff.
 */
async function insertChainRow(args: {
  projectId: string;
  createdAt: string;
  prevHash: string | null;
}): Promise<AuditProofBundleEntry> {
  const payload: AuditChainPayload = {
    projectId: args.projectId,
    userId: "usr_test",
    action: "product.update",
    resource: "product",
    resourceId: "prd_test",
    before: null,
    after: { n: 1 },
    ipAddress: null,
    userAgent: null,
    createdAt: args.createdAt,
    prevHash: args.prevHash,
  };
  const rowHash = hashAuditRow(payload);
  const id = createId();
  await getDb()
    .insert(auditLogs)
    .values({ id, ...payload, createdAt: new Date(args.createdAt), rowHash });
  return { id, rowHash, ...payload };
}

async function countAuditRows(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.projectId, projectId));
  return rows.length;
}

async function findCheckpointRow(projectId: string) {
  const rows = await getDb()
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, projectId),
        eq(auditLogs.action, AUDIT_ACTION_RETENTION_CHECKPOINT),
      ),
    );
  return rows[0] ?? null;
}

async function freshSurvivingChainBundle(
  projectId: string,
): Promise<AuditProofBundle> {
  const entries = await drizzle.auditLogRepo.listAuditProofRows(getDb(), {
    projectId,
    limit: AUDIT_PROOF_MAX_ENTRIES,
  });
  return assembleAuditProofBundle({
    projectId,
    entries,
    from: null,
    to: null,
    maxEntries: AUDIT_PROOF_MAX_ENTRIES,
  });
}

beforeEach(() => {
  seededProjectIds = [];
  isStorageConfiguredMock.mockReset().mockReturnValue(true);
  putObjectMock.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    // Explicit cleanup rather than relying on projects' ON DELETE
    // behaviour: auditLogs.projectId is `ON DELETE SET NULL`, not
    // CASCADE (deleting a project preserves its audit history as
    // orphan rows), so a test's own rows would otherwise survive as
    // orphans and could pollute a later run's counts.
    await db.delete(auditLogs).where(eq(auditLogs.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// Old enough to be on the deleted side of every cutoff used below.
const ROW1_CREATED_AT = "2020-01-01T00:00:00.000Z";
const ROW2_CREATED_AT = "2020-01-02T00:00:00.000Z";
// New enough to survive every cutoff used below.
const ROW3_CREATED_AT = "2020-06-01T00:00:00.000Z";
const CUTOFF = new Date("2020-02-01T00:00:00.000Z");

async function seedThreeRowChain(projectId: string) {
  const row1 = await insertChainRow({
    projectId,
    createdAt: ROW1_CREATED_AT,
    prevHash: null,
  });
  const row2 = await insertChainRow({
    projectId,
    createdAt: ROW2_CREATED_AT,
    prevHash: row1.rowHash,
  });
  const row3 = await insertChainRow({
    projectId,
    createdAt: ROW3_CREATED_AT,
    prevHash: row2.rowHash,
  });
  return { row1, row2, row3 };
}

describe("checkpointAndTruncate", () => {
  it("exports, stores, deletes, then chains a checkpoint — in that order", async () => {
    const projectId = await seedTestProject();
    await seedThreeRowChain(projectId);

    // Captured from INSIDE the storage-write mock: if the delete ran
    // before the store, this would already read 1 (row3 only), not 3.
    let rowCountAtStorageWriteTime: number | null = null;
    putObjectMock.mockImplementationOnce(async () => {
      rowCountAtStorageWriteTime = await countAuditRows(projectId);
    });

    const outcome = await checkpointAndTruncate(getDb(), projectId, CUTOFF);

    expect(rowCountAtStorageWriteTime).toBe(3);
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("checkpointed");
    if (outcome.kind !== "checkpointed") throw new Error("unreachable");
    expect(outcome.deleted).toBe(2);

    // Final state: row3 (survivor) + the new checkpoint row.
    expect(await countAuditRows(projectId)).toBe(2);
  });

  it("leaves every row in place when storage is not configured", async () => {
    const projectId = await seedTestProject();
    await seedThreeRowChain(projectId);
    isStorageConfiguredMock.mockReturnValue(false);

    const outcome = await checkpointAndTruncate(getDb(), projectId, CUTOFF);

    expect(outcome).toEqual({
      kind: "skipped",
      reason: AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
    });
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(await countAuditRows(projectId)).toBe(3);
    expect(await findCheckpointRow(projectId)).toBeNull();
  });

  it("leaves every row in place when the storage write rejects", async () => {
    const projectId = await seedTestProject();
    await seedThreeRowChain(projectId);
    putObjectMock.mockRejectedValueOnce(new Error("storage is down"));

    await expect(
      checkpointAndTruncate(getDb(), projectId, CUTOFF),
    ).rejects.toThrow("storage is down");

    expect(await countAuditRows(projectId)).toBe(3);
    expect(await findCheckpointRow(projectId)).toBeNull();
  });

  it("produces a bundle that verifies, and a surviving chain that verifies", async () => {
    const projectId = await seedTestProject();
    await seedThreeRowChain(projectId);

    let storedBundle: unknown = null;
    putObjectMock.mockImplementationOnce(async (_key: string, body: unknown) => {
      storedBundle = JSON.parse((body as Buffer).toString("utf8"));
    });

    const outcome = await checkpointAndTruncate(getDb(), projectId, CUTOFF);
    expect(outcome.kind).toBe("checkpointed");

    // The exported (now-deleted) segment, verified entirely offline.
    const exportedResult = verifyAuditBundle(storedBundle);
    expect(exportedResult.ok).toBe(true);
    expect(exportedResult.entriesChecked).toBe(2);

    // A FRESH export of what's left, through the exact same assembler
    // the `/proof` endpoint uses — this is the assertion the whole
    // strategy exists to satisfy: retention must not cost verifiability
    // on either side of the cut. No change to `verifyAuditBundle` is
    // needed for this to hold: the surviving chain's first row's
    // `prevHash` is the last deleted row's `rowHash`, which
    // `assembleAuditProofBundle` surfaces as this bundle's own
    // `origin` (derived from `entries[0].prevHash`, not assumed null).
    const survivingBundle = await freshSurvivingChainBundle(projectId);
    const survivingResult = verifyAuditBundle(survivingBundle);
    expect(survivingResult.ok).toBe(true);
    // row3 (the original survivor) + the checkpoint row this run wrote.
    expect(survivingResult.entriesChecked).toBe(2);
    expect(survivingBundle.origin).not.toBeNull();
  });

  it("records the last deleted rowHash and the bundle key in the checkpoint", async () => {
    const projectId = await seedTestProject();
    const { row2 } = await seedThreeRowChain(projectId);

    const outcome = await checkpointAndTruncate(getDb(), projectId, CUTOFF);
    expect(outcome.kind).toBe("checkpointed");
    if (outcome.kind !== "checkpointed") throw new Error("unreachable");

    expect(outcome.lastDeletedRowHash).toBe(row2.rowHash);

    const checkpointRow = await findCheckpointRow(projectId);
    expect(checkpointRow).not.toBeNull();
    const after = checkpointRow!.after as Record<string, unknown>;
    expect(after.lastDeletedRowHash).toBe(row2.rowHash);
    expect(after.bundleKey).toBe(outcome.bundleKey);
    expect(outcome.bundleKey).toContain(projectId);
  });

  it("never deletes the checkpoint row it just wrote", async () => {
    const projectId = await seedTestProject();
    await seedThreeRowChain(projectId);

    const first = await checkpointAndTruncate(getDb(), projectId, CUTOFF);
    expect(first.kind).toBe("checkpointed");
    const checkpointAfterFirstRun = await findCheckpointRow(projectId);
    expect(checkpointAfterFirstRun).not.toBeNull();

    // Second run, SAME cutoff. Nothing new has aged into range (the
    // checkpoint row itself was stamped at real wall-clock "now", far
    // newer than CUTOFF, and row3 already survived the first run) — an
    // off-by-one here (e.g. an inclusive-vs-exclusive slip that let the
    // checkpoint's own boundary re-match) would erase the very marker
    // that explains the gap.
    const second = await checkpointAndTruncate(getDb(), projectId, CUTOFF);
    expect(second).toEqual({
      kind: "skipped",
      reason: AUDIT_CHECKPOINT_SKIP_REASON_NOTHING_TO_CHECKPOINT,
    });

    const checkpointAfterSecondRun = await findCheckpointRow(projectId);
    expect(checkpointAfterSecondRun).not.toBeNull();
    expect(checkpointAfterSecondRun!.id).toBe(checkpointAfterFirstRun!.id);
    // Only one checkpoint row was ever written across both runs.
    expect(putObjectMock).toHaveBeenCalledTimes(1);
  });
});
