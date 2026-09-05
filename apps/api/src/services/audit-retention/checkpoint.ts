import { and, eq, inArray } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, type Db } from "@rovenue/db";
import {
  AUDIT_PROOF_MAX_ENTRIES,
  assembleAuditProofBundle,
  type AuditProofBundle,
} from "@rovenue/shared/audit-chain";
import { audit, AUDIT_ACTION_RETENTION_CHECKPOINT } from "../../lib/audit";
import * as importStore from "../../lib/import-store";
import { logger } from "../../lib/logger";

// =============================================================
// CHECKPOINT_TRUNCATE — the audit chain (ROADMAP §9.2 Task 5)
// =============================================================
//
// `audit_logs` is an append-only, per-project SHA-256 hash chain:
// every row's `prevHash` references its predecessor, so deleting row N
// makes every later row unverifiable back to origin. A retention sweep
// built as a plain age-based DELETE would destroy exactly what the
// §9.3 proof export exists to provide.
//
// The fix: before a segment is deleted, it is exported as a §9.3
// proof bundle (reusing the SAME assembly the `/proof` dashboard
// endpoint uses — `assembleAuditProofBundle`, @rovenue/shared/audit-chain
// — so the two can never independently drift on what a "bundle" is),
// that bundle is written to object storage and the write is confirmed,
// THEN the segment's rows are deleted, and finally a checkpoint audit
// row is chained recording the last deleted row's hash and where the
// bundle went.
//
// This ordering is not negotiable, and is why each step below is a
// distinct `await` with nothing between it and the next:
//
//   1. Export the segment being deleted as a proof bundle.
//   2. Write the bundle to object storage and confirm the write
//      succeeded.
//   3. Delete the segment's rows, batched.
//   4. Write the checkpoint audit row.
//
// A bundle that was never stored is not a record, and once the rows
// are gone nothing can reconstruct it — so storage must succeed BEFORE
// any row is deleted, not after. If the storage write rejects, this
// function propagates that rejection and touches no row (the retention
// sweep's own per-(project, policy) try/catch — workers/retention-sweep.ts
// — is what isolates that failure from the rest of the run, exactly as
// it already does for a DELETE_ROWS or DROP_PARTITION unit that
// throws).
//
// After truncation, the surviving chain verifies as an ordinary
// mid-chain segment: its first row's `prevHash` is the last deleted
// row's `rowHash`, which the exported bundle's `tip` independently
// attests. No change to `verifyAuditBundle` (@rovenue/shared/audit-chain)
// or to the `/proof` endpoint's assembly is needed for this — see
// checkpoint.integration.test.ts, which proves it by running the real
// verifier over both the exported bundle and a fresh export of the
// surviving chain, rather than assuming it.

const log = logger.child("audit-retention-checkpoint");

// Batched delete shape, mirroring `retention-rows.ts`'s DELETE_ROWS
// convention (bounded batch, loop until every id is consumed) — but
// keyed by the EXACT ids this run's exported bundle contains, never a
// re-evaluated `createdAt < cutoff` predicate. That means what gets
// deleted is provably identical to what was just exported and stored,
// not merely "whatever the same WHERE clause happens to match a few
// moments later" (a window in which, in principle, a legacy backfill
// or a clock skew could insert a row that the export never saw).
const CHECKPOINT_DELETE_BATCH_SIZE = 1_000;

// retentionSweepSkippedTotal reason labels this strategy can produce,
// alongside the ones workers/retention-sweep.ts already defines
// (no-window, tier-limits-not-found, error). Both are genuinely
// different from those: they are per-RUN facts about THIS strategy,
// not about window resolution.
export const AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED =
  "storage-not-configured";
export const AUDIT_CHECKPOINT_SKIP_REASON_NOTHING_TO_CHECKPOINT =
  "nothing-to-checkpoint";

export type AuditCheckpointSkipReason =
  | typeof AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED
  | typeof AUDIT_CHECKPOINT_SKIP_REASON_NOTHING_TO_CHECKPOINT;

export type CheckpointTruncateOutcome =
  | { kind: "skipped"; reason: AuditCheckpointSkipReason }
  | {
      kind: "checkpointed";
      deleted: number;
      checkpointId: string;
      bundleKey: string;
      lastDeletedRowId: string;
      lastDeletedRowHash: string | null;
      truncated: boolean;
    };

/**
 * Deletes exactly the rows named by `ids`, scoped to `projectId`,
 * batched at `CHECKPOINT_DELETE_BATCH_SIZE`. Returns the number of
 * rows actually removed (via `.returning()`, not an assumed
 * `ids.length`) so a row some concurrent process already removed
 * doesn't get silently double-counted as reclaimed.
 */
async function deleteAuditLogRowsByIds(
  db: Db,
  projectId: string,
  ids: readonly string[],
): Promise<number> {
  const { auditLogs } = drizzle.schema;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHECKPOINT_DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + CHECKPOINT_DELETE_BATCH_SIZE);
    const rows = await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.projectId, projectId), inArray(auditLogs.id, batch)))
      .returning({ id: auditLogs.id });
    deleted += rows.length;
  }
  return deleted;
}

/**
 * CHECKPOINT_TRUNCATE for one (project, sweep run): export the
 * project's `audit_logs` rows at or before `cutoff` as a §9.3 proof
 * bundle, store it, delete those rows, then chain a checkpoint audit
 * row recording the boundary. See the module doc comment for the
 * ordering and why it is not negotiable.
 *
 * Fails closed: if object storage isn't configured, this returns a
 * `skipped` outcome and deletes nothing — deleting audit history with
 * nowhere to put the proof turns a compliance record into a hole, the
 * exact failure §9.3 exists to prevent (mirrors the named-refusal
 * shape at `apps/api/src/services/apple/apple-verify.ts`'s root-cert
 * check, not a silent fallback). Likewise returns `skipped` when there
 * is nothing in range to checkpoint — an empty bundle would be a
 * meaningless object in storage and a checkpoint row with no boundary
 * to record.
 *
 * A storage-write rejection is NOT caught here: it propagates to the
 * caller (the retention sweep's own per-(project, policy) isolation
 * handles it, same as a DELETE_ROWS or DROP_PARTITION unit that
 * throws), because at that point nothing has been deleted yet and
 * there is no partial state to reconcile.
 */
export async function checkpointAndTruncate(
  db: Db,
  projectId: string,
  cutoff: Date,
): Promise<CheckpointTruncateOutcome> {
  if (!importStore.isStorageConfigured()) {
    log.warn(
      "CHECKPOINT_TRUNCATE skipped: object storage is not configured — refusing to delete audit history with nowhere to store its proof bundle",
      { projectId },
    );
    return {
      kind: "skipped",
      reason: AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
    };
  }

  // Step 1: export the segment being deleted. `to: cutoff` is
  // inclusive (listAuditProofRows uses `lte`), matching what a human
  // calling `/proof?to=<cutoff>` would get for the same boundary.
  const entries = await drizzle.auditLogRepo.listAuditProofRows(db, {
    projectId,
    to: cutoff,
    limit: AUDIT_PROOF_MAX_ENTRIES,
  });

  if (entries.length === 0) {
    return {
      kind: "skipped",
      reason: AUDIT_CHECKPOINT_SKIP_REASON_NOTHING_TO_CHECKPOINT,
    };
  }

  const bundle: AuditProofBundle = assembleAuditProofBundle({
    projectId,
    entries,
    from: null,
    to: cutoff.toISOString(),
    maxEntries: AUDIT_PROOF_MAX_ENTRIES,
  });

  const lastEntry = entries[entries.length - 1]!;
  const checkpointId = createId();
  const bundleKey = importStore.buildAuditCheckpointStorageKey(
    projectId,
    checkpointId,
  );

  // Step 2: write the bundle to object storage and confirm the write
  // succeeded — awaited, not fired-and-forgotten, and nothing below
  // this line runs unless it resolves. This is the whole design: a
  // rejection here propagates straight out of this function, and
  // NOTHING has been deleted yet.
  await importStore.putObject(
    bundleKey,
    Buffer.from(JSON.stringify(bundle)),
    "application/json",
  );

  // Step 3: delete the segment's rows, batched, by the EXACT ids just
  // exported and stored.
  const ids = entries.map((entry) => entry.id);
  const deleted = await deleteAuditLogRowsByIds(db, projectId, ids);

  // Step 4: chain a checkpoint row. Written with the SAME `db` handle
  // this function was given (matching writeRetentionPartitionAuditRow's
  // convention in workers/retention-sweep.ts) rather than reaching for
  // audit()'s module-level default.
  await audit(
    {
      projectId,
      userId: "system",
      action: AUDIT_ACTION_RETENTION_CHECKPOINT,
      resource: "retention_checkpoint",
      resourceId: checkpointId,
      before: null,
      after: {
        table: "audit_logs",
        cutoff: cutoff.toISOString(),
        deletedCount: deleted,
        lastDeletedRowId: lastEntry.id,
        lastDeletedRowHash: lastEntry.rowHash,
        bundleKey,
        truncated: bundle.truncated,
      },
      ipAddress: null,
      userAgent: null,
    },
    undefined,
    db,
  );

  log.info("retention sweep checkpointed and truncated the audit chain", {
    projectId,
    deleted,
    bundleKey,
    truncated: bundle.truncated,
  });

  return {
    kind: "checkpointed",
    deleted,
    checkpointId,
    bundleKey,
    lastDeletedRowId: lastEntry.id,
    lastDeletedRowHash: lastEntry.rowHash,
    truncated: bundle.truncated,
  };
}
