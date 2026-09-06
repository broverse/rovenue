// =============================================================
// dsar-export worker — real-infra integration tests (ROADMAP §9.1, Task 4)
// =============================================================
//
// Real Postgres for everything DB-shaped: `claimDsarRequest`,
// `completeDsarRequest`, `failDsarRequest`, `audit()` (a real hash-chained
// row), and `exportSubscriber` (a real multi-table read) all run against
// the ambient docker-compose Postgres via `getDb()`/`drizzle.db` — nothing
// about the request record's lifecycle, the export contents, or the audit
// trail is mocked. Only the object-storage primitives
// (`putObject`/`deleteObject`/`isStorageConfigured`) are injected via
// `DsarExportDeps`, because this file has no real MinIO to write to.
//
// The one exception: "marks FAILED when storage is unconfigured" passes
// the REAL `importStore.isStorageConfigured` — never a mock that merely
// returns false — because this environment sets no ASSET_STORAGE_*/
// IMPORT_STORAGE_BUCKET env vars (see .env.example: they're commented out
// by default), so the real function genuinely returns false here. A test
// that instead injected `vi.fn(() => false)` would pass even if the
// worker never called `isStorageConfigured` at all; this one only passes
// if the worker's fail-closed check is wired to the real thing.
//
// "cannot be claimed twice" fires two REAL, concurrent `claimDsarRequest`
// UPDATE ... WHERE status = 'PENDING' statements at Postgres itself —
// the guarantee under test is a database-level conditional update, which
// only a real database can prove holds under concurrency (per this repo's
// standing rule: "concurrency without real Postgres proves nothing").
//
// "marks FAILED and stores nothing when the export throws" forces a REAL
// throw out of the real `exportSubscriber` — no throw is injected — by
// pointing the job's `subscriberId` at a subscriber seeded under a
// DIFFERENT project than the job's own `projectId`. `exportSubscriber`'s
// own cross-project check (see export-subscriber.ts) throws a real
// HTTPException for exactly this case.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, getDb } from "@rovenue/db";
import {
  runDsarExport,
  DSAR_ARTIFACT_TTL_DAYS,
  type DsarExportDeps,
} from "./dsar-export";
import * as importStore from "../lib/import-store";
import { audit } from "../lib/audit";
import { exportSubscriber } from "../services/gdpr/export-subscriber";
import { anonymizeSubscriber } from "../services/gdpr/anonymize-subscriber";

const schema = drizzle.schema;

const RUN_ID = Date.now();
let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

const NOW = new Date("2026-09-06T12:00:00.000Z");

let seededProjectIds: string[] = [];

async function seedProject(): Promise<string> {
  const id = `prj_dsar_export_${nextSuffix()}`;
  await getDb().insert(schema.projects).values({ id, name: `dsar-export-${id}` });
  seededProjectIds.push(id);
  return id;
}

async function seedSubscriber(projectId: string): Promise<string> {
  const [row] = await getDb()
    .insert(schema.subscribers)
    .values({ projectId, rovenueId: `rov_${nextSuffix()}` })
    .returning();
  if (!row) throw new Error("seed: subscriber insert returned no row");
  return row.id;
}

async function seedPendingExportRequest(
  projectId: string,
  subscriberId: string,
): Promise<string> {
  const row = await drizzle.dsarRequestRepo.createDsarRequest(getDb(), {
    projectId,
    subscriberId,
    type: "EXPORT",
    requestedBy: "support@customer.example",
  });
  return row.id;
}

async function fetchRequest(id: string) {
  const row = await drizzle.dsarRequestRepo.findDsarRequestById(getDb(), id);
  if (!row) throw new Error(`request ${id} vanished`);
  return row;
}

async function fetchAuditActionsFor(resourceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ action: schema.auditLogs.action, createdAt: schema.auditLogs.createdAt })
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.resourceId, resourceId));
  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => r.action);
}

/**
 * Builds a DsarExportDeps where the DB-shaped operations (claim,
 * complete, fail, audit, transaction) and `exportSubscriber` are the
 * REAL implementations, and only the storage primitives are test
 * doubles. `putObject`/`deleteObject` default to a resolving/succeeding
 * stub; `isStorageConfigured` defaults to true (storage "working") so
 * every test other than the dedicated storage-unconfigured one can reach
 * the write path deterministically regardless of whether a real MinIO
 * happens to be reachable from this environment.
 */
function realDeps(overrides: Partial<DsarExportDeps> = {}): DsarExportDeps {
  return {
    claimDsarRequest: vi.fn(drizzle.dsarRequestRepo.claimDsarRequest),
    completeDsarRequest: vi.fn(drizzle.dsarRequestRepo.completeDsarRequest),
    failDsarRequest: vi.fn(drizzle.dsarRequestRepo.failDsarRequest),
    lockSubscriberDeletionState: vi.fn(
      drizzle.dsarRequestRepo.lockSubscriberDeletionState,
    ),
    exportSubscriber: vi.fn(exportSubscriber),
    putObject: vi.fn(async () => {}),
    deleteObject: vi.fn(async () => {}),
    isStorageConfigured: vi.fn(() => true),
    audit: vi.fn(audit),
    transaction: (fn) => getDb().transaction((tx) => fn(tx as never)),
    now: () => NOW,
    ...overrides,
  };
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.projectId, id));
    await db.delete(schema.dsarRequests).where(eq(schema.dsarRequests.projectId, id));
    await db.delete(schema.subscribers).where(eq(schema.subscribers.projectId, id));
    await db.delete(schema.projects).where(eq(schema.projects.id, id));
  }
});

describe("runDsarExport", () => {
  it("writes the artifact before marking the request COMPLETED", async () => {
    // Assert call ORDER, not merely that both happened — a test that
    // only checked "both were called" would still pass against a worker
    // that marks COMPLETED first and writes the artifact after, which is
    // exactly the bug this ordering exists to prevent.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const deps = realDeps();

    const outcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    expect(outcome).toEqual({ outcome: "completed", artifactKey: expect.any(String) });

    const putOrder = vi.mocked(deps.putObject).mock.invocationCallOrder[0]!;
    const completeOrder = vi.mocked(deps.completeDsarRequest).mock.invocationCallOrder[0]!;
    expect(putOrder).toBeLessThan(completeOrder);

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("COMPLETED");
    expect(finalRow.artifactKey).toMatch(/^dsar-exports\//);
    expect(finalRow.expiresAt?.getTime()).toBe(
      NOW.getTime() + DSAR_ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("marks FAILED and stores nothing when the export throws", async () => {
    const projectId = await seedProject();
    const otherProjectId = await seedProject();
    // A subscriber belonging to a DIFFERENT project than the job's own
    // projectId — exportSubscriber's real cross-project check throws for
    // exactly this, with no throw injected by this test.
    const foreignSubscriberId = await seedSubscriber(otherProjectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, foreignSubscriberId);

    const deps = realDeps();

    const outcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId: foreignSubscriberId, type: "EXPORT" },
      deps,
    );

    expect(outcome.outcome).toBe("failed");
    expect(vi.mocked(deps.putObject)).not.toHaveBeenCalled();

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("FAILED");
    expect(finalRow.artifactKey).toBeNull();
    expect(finalRow.error).toBeTruthy();
  });

  it("marks FAILED when storage is unconfigured", async () => {
    // Real isStorageConfigured — this environment sets no
    // ASSET_STORAGE_*/IMPORT_STORAGE_BUCKET env vars, so it genuinely
    // returns false here; nothing about this test fakes that.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    expect(importStore.isStorageConfigured()).toBe(false);

    const deps = realDeps({ isStorageConfigured: importStore.isStorageConfigured });

    const outcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    expect(outcome.outcome).toBe("failed");
    expect(vi.mocked(deps.exportSubscriber)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.putObject)).not.toHaveBeenCalled();

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("FAILED");
    expect(finalRow.error).toMatch(/storage/i);
  });

  it("cannot be claimed twice", async () => {
    // Two concurrent runs, one claim, against a REAL Postgres conditional
    // UPDATE ... WHERE status = 'PENDING'. The loser must no-op rather
    // than producing a second artifact.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const depsA = realDeps();
    const depsB = realDeps();

    const [outcomeA, outcomeB] = await Promise.all([
      runDsarExport({ dsarRequestId, projectId, subscriberId, type: "EXPORT" }, depsA),
      runDsarExport({ dsarRequestId, projectId, subscriberId, type: "EXPORT" }, depsB),
    ]);

    const outcomes = [outcomeA.outcome, outcomeB.outcome].sort();
    expect(outcomes).toEqual(["completed", "skipped_race"]);

    const totalPutObjectCalls =
      vi.mocked(depsA.putObject).mock.calls.length +
      vi.mocked(depsB.putObject).mock.calls.length;
    expect(totalPutObjectCalls).toBe(1);

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("COMPLETED");
  });

  it("writes an audit row for each state change", async () => {
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const deps = realDeps();
    await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    const actions = await fetchAuditActionsFor(dsarRequestId);
    expect(actions).toEqual(["dsar_request.claimed", "dsar_request.export_completed"]);
  });

  it("writes claimed + failed audit rows on a failed run", async () => {
    // The failure path's own state change (RUNNING -> FAILED) must be
    // audited too, not just the happy path's COMPLETED transition.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const deps = realDeps({
      exportSubscriber: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    const actions = await fetchAuditActionsFor(dsarRequestId);
    expect(actions).toEqual(["dsar_request.claimed", "dsar_request.export_failed"]);
  });

  it("does not stay wedged RUNNING when the FAILED transition itself throws (double fault)", async () => {
    // Reproduces the exact bug this test guards against: the work throws
    // (storage unconfigured, same REAL path as "marks FAILED when storage
    // is unconfigured" above) AND the catch block's own FAILED-transition
    // transaction ALSO throws — a transient DB fault, injected here via
    // `failDsarRequest` since nothing in this file can make a real
    // Postgres transaction fail on demand. Before the dsar-requests.ts
    // `claimDsarRequest` fix, that second throw escaped runDsarExport
    // entirely (uncaught, no try/catch around the FAILED-path
    // transaction), BullMQ would retry, and the retry's claim saw
    // `status <> 'PENDING'` and no-op'd — leaving the row RUNNING forever
    // with no reaper anywhere to revisit it.
    //
    // This test does NOT merely check the ordinary failure path still
    // marks FAILED (that already works, see "marks FAILED when storage is
    // unconfigured"). It reproduces the double fault, asserts the row is
    // left RUNNING (the symptom), then simulates a later BullMQ retry —
    // by backdating `updatedAt` past DSAR_CLAIM_STALE_RUNNING_MS and
    // calling runDsarExport again with WORKING deps — and asserts the row
    // reaches a terminal state instead of staying wedged.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const doubleFaultDeps = realDeps({
      isStorageConfigured: importStore.isStorageConfigured, // real: false here
      failDsarRequest: vi.fn(async () => {
        throw new Error("transient db fault while marking FAILED");
      }),
    });

    await expect(
      runDsarExport(
        { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
        doubleFaultDeps,
      ),
    ).rejects.toThrow(/transient db fault/);

    // The symptom: the double fault leaves the row RUNNING.
    const wedged = await fetchRequest(dsarRequestId);
    expect(wedged.status).toBe("RUNNING");

    // Simulate a BullMQ retry long after the claim lease has gone stale.
    await getDb()
      .update(schema.dsarRequests)
      .set({
        updatedAt: new Date(
          Date.now() - drizzle.dsarRequestRepo.DSAR_CLAIM_STALE_RUNNING_MS - 60_000,
        ),
      })
      .where(eq(schema.dsarRequests.id, dsarRequestId));

    const retryOutcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      realDeps({ isStorageConfigured: importStore.isStorageConfigured }),
    );

    // The row is NOT wedged: the reclaimed retry ran the (still failing,
    // storage is still unconfigured) work through to a clean terminal
    // FAILED, not a permanent RUNNING.
    expect(retryOutcome.outcome).toBe("failed");
    const healed = await fetchRequest(dsarRequestId);
    expect(healed.status).toBe("FAILED");
  });

  it("produces no artifact when the subject was erased before the export could run (Finding 2)", async () => {
    // Reproduces the exact roadmap-9a final-fix-wave Finding 2 scenario
    // END TO END, not merely a guard function returning false in
    // isolation: an EXPORT job whose subscriberId points at a subscriber
    // that a REAL erasure (the same `anonymizeSubscriber` production
    // service the erasure worker calls, not a hand-crafted UPDATE) has
    // already anonymised — modelling "erasure completes at T1, the
    // export job (claimed earlier, or reclaimed as stale-RUNNING) then
    // runs `exportSubscriber` at T1+n". Before the Finding-2 fix,
    // `exportSubscriber` had no `deletedAt` check at all and would have
    // read `purchases`/`subscriberAccess`/`creditLedger` straight
    // through (`anonymizeSubscriber` never touches those tables) and
    // written a brand-new artifact containing the subject's full
    // history — this test's `putObject` assertion is what catches that
    // regression coming back.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    await anonymizeSubscriber({
      subscriberId,
      projectId,
      actorUserId: "system",
      reason: "dsar_request",
    });

    const deps = realDeps();

    const outcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.error).toMatch(/erased/i);
    }
    // The crux of Finding 2: no PII artifact was ever written, not even
    // one that gets cleaned up afterward.
    expect(vi.mocked(deps.putObject)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.deleteObject)).not.toHaveBeenCalled();

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("FAILED");
    expect(finalRow.artifactKey).toBeNull();
    expect(finalRow.error).toMatch(/erased/i);
  });
  it("deletes the artifact when the subject is erased AFTER the data was read (Finding 2 residual race)", async () => {
    // The window Finding 2's own fix left open, reproduced in the only
    // order that opens it: `exportSubscriber` reads the subject while
    // they are still live, the erasure commits, and only THEN does the
    // artifact get written and the row completed. The deletedAt check
    // inside `exportSubscriber` cannot see this — it already ran and
    // correctly passed.
    //
    // Erasure is landed from inside the exportSubscriber stub, which is
    // exactly the interleaving described: after the read, before the
    // write. Without the FOR UPDATE re-check in the completion
    // transaction, this run marks COMPLETED and leaves a full-history
    // artifact for an erased subject with an artifactKey pointing at it
    // — erasure's own purge pass has already been and gone.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    const deps = realDeps({
      exportSubscriber: vi.fn(async (input) => {
        const data = await exportSubscriber(input);
        await anonymizeSubscriber({
          subscriberId,
          projectId,
          actorUserId: "system",
          reason: "dsar_request",
        });
        return data;
      }),
    });

    const outcome = await runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    );

    // The artifact WAS written here — unlike the test above, the read
    // succeeded — so the guarantee is that it does not survive.
    expect(vi.mocked(deps.putObject)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.deleteObject)).toHaveBeenCalledTimes(1);

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.error).toMatch(/erased/i);
    }

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("FAILED");
    // The row must not reference an artifact that no longer exists, and
    // must not be COMPLETED — a COMPLETED row here is the bug.
    expect(finalRow.artifactKey).toBeNull();
  });
  it("waits on an in-flight erasure instead of racing it (the FOR UPDATE itself)", async () => {
    // The test above proves the RE-CHECK: it lets the erasure commit
    // first, so a plain `SELECT deletedAt` with no FOR UPDATE would pass
    // it identically. This one proves the LOCK, which is what the fix
    // actually rests on.
    //
    // A transaction stamps deletedAt and then HOLDS the row lock,
    // uncommitted, while the export runs. Under MVCC the export's own
    // reads cannot see that uncommitted write at all — so without
    // FOR UPDATE the completion check reads "not erased", completes, and
    // publishes a full-history artifact for a subject who is, moments
    // later, erased. The lock is the only thing that makes the export
    // wait for the erasure's outcome rather than read around it.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingExportRequest(projectId, subscriberId);

    let releaseErasure!: () => void;
    const erasureCommitted = new Promise<void>((resolve) => {
      releaseErasure = resolve;
    });

    const holdingErasure = getDb().transaction(async (tx) => {
      await tx
        .update(schema.subscribers)
        .set({ deletedAt: new Date() })
        .where(eq(schema.subscribers.id, subscriberId));
      await erasureCommitted;
    });

    const deps = realDeps();
    let settled = false;
    const exportRun = runDsarExport(
      { dsarRequestId, projectId, subscriberId, type: "EXPORT" },
      deps,
    ).then((result) => {
      settled = true;
      return result;
    });

    // Long enough that an unblocked export would have finished — every
    // other run in this file completes in single-digit milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      settled,
      "the export completed while an erasure held the subscriber row — the FOR UPDATE is not contending",
    ).toBe(false);

    releaseErasure();
    await holdingErasure;

    const outcome = await exportRun;
    expect(outcome.outcome).toBe("failed");
    expect(vi.mocked(deps.deleteObject)).toHaveBeenCalledTimes(1);

    const finalRow = await fetchRequest(dsarRequestId);
    expect(finalRow.status).toBe("FAILED");
    expect(finalRow.artifactKey).toBeNull();
  });
});
