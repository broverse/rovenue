import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, drizzle, projects } from "@rovenue/db";

// Reaching into packages/db/src by relative path (as this file previously
// did) resolves fine at runtime via vitest, but pulls those files outside
// this package's tsconfig rootDir under static typecheck (TS6059) — go
// through the published @rovenue/db barrel instead, same as the rest of
// this suite.
const importJobRepo = drizzle.importJobRepo;
import * as importStore from "../../src/lib/import-store";
import { runImportRetention } from "../../src/workers/import-retention";
import { IMPORT_FILE_RETENTION_DAYS } from "@rovenue/shared";

// =============================================================
// import file retention sweep (Task 8, controller Ruling 7)
// =============================================================
//
// Real Postgres (tests/global-setup.ts's per-worker DB), same convention
// as the other import-* integration tests. Object storage is NOT
// mocked wholesale here — only `deleteObject` is spied on, so the
// assertion is "was this exact key ever handed to deleteObject",
// observed via the spy's call log, not a log line or a return value.
// =============================================================

const PROJECT_ID = `proj_import_retention_${createId()}`;
const NOW = new Date("2026-08-31T00:00:00.000Z");
const RETENTION_MS = IMPORT_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

async function seedJob(args: {
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "RUNNING" | "VERIFICATION_INCOMPLETE";
  finishedAt: Date | null;
  reportStorageKey?: string | null;
}): Promise<{ jobId: string; storageKey: string; reportStorageKey: string | null }> {
  const jobId = `job_${createId()}`;
  const storageKey = `imports/${PROJECT_ID}/${jobId}/source.csv`;
  const reportStorageKey = args.reportStorageKey ?? `imports/${PROJECT_ID}/${jobId}/report.ndjson`;

  await importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: PROJECT_ID,
    sourceLabel: "retention test",
    presetId: null,
    storageKey,
    fileName: "source.csv",
    fileBytes: 0,
    fileSha256: "deadbeef",
    mapping: {},
  });
  await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
    status: args.status,
    finishedAt: args.finishedAt,
    reportStorageKey: reportStorageKey,
  });

  return { jobId, storageKey, reportStorageKey };
}

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: "Import Retention Test Project" });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("runImportRetention", () => {
  it("deletes a terminal job's files once it is past the retention window", async () => {
    const oldFinishedAt = new Date(NOW.getTime() - RETENTION_MS - 24 * 60 * 60 * 1000); // 1 day past the window
    const { storageKey, reportStorageKey } = await seedJob({
      status: "COMPLETED",
      finishedAt: oldFinishedAt,
    });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);

    const result = await runImportRetention(NOW);

    expect(deleteSpy).toHaveBeenCalledWith(storageKey);
    expect(deleteSpy).toHaveBeenCalledWith(reportStorageKey);
    expect(result.deletedJobs).toBeGreaterThanOrEqual(1);

    deleteSpy.mockRestore();
  });

  it("does NOT delete a terminal job's files while still inside the retention window", async () => {
    const recentFinishedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 1 day ago, well inside the window
    const { storageKey, reportStorageKey } = await seedJob({
      status: "COMPLETED",
      finishedAt: recentFinishedAt,
    });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);

    await runImportRetention(NOW);

    expect(deleteSpy).not.toHaveBeenCalledWith(storageKey);
    expect(deleteSpy).not.toHaveBeenCalledWith(reportStorageKey);

    deleteSpy.mockRestore();
  });

  it("does NOT delete a job's files while it is still RUNNING, regardless of age", async () => {
    // A job with no finishedAt is exactly what "still running" looks
    // like — even though it was created long ago, it must never be
    // swept: this worker is the only writer of finishedAt, so a job
    // that legitimately crashed without ever reaching a terminal status
    // would otherwise have its (needed-for-a-future-resume) source file
    // deleted out from under it.
    const { storageKey, reportStorageKey } = await seedJob({
      status: "RUNNING",
      finishedAt: null,
    });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);

    await runImportRetention(NOW);

    expect(deleteSpy).not.toHaveBeenCalledWith(storageKey);
    expect(deleteSpy).not.toHaveBeenCalledWith(reportStorageKey);

    deleteSpy.mockRestore();
  });

  it("does NOT delete a VERIFICATION_INCOMPLETE job's files, regardless of age (Task 9 fix round 1, FIX 7)", async () => {
    // Phase A sets `finishedAt` before Phase B ever runs, so a job Phase B
    // later left VERIFICATION_INCOMPLETE can have an OLD finishedAt from
    // day one — age alone must not make it eligible. The job's source
    // file is the ONLY place a Google purchase token lives; sweeping it
    // would strand this job unable to ever finish Phase B.
    const oldFinishedAt = new Date(NOW.getTime() - RETENTION_MS - 24 * 60 * 60 * 1000);
    const { storageKey, reportStorageKey } = await seedJob({
      status: "VERIFICATION_INCOMPLETE",
      finishedAt: oldFinishedAt,
    });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);

    await runImportRetention(NOW);

    expect(deleteSpy).not.toHaveBeenCalledWith(storageKey);
    expect(deleteSpy).not.toHaveBeenCalledWith(reportStorageKey);

    deleteSpy.mockRestore();
  });

  // Final-fix-wave minor fix: pinned as a DELIBERATE decision, not an
  // oversight — both statuses are also re-runnable from the
  // mapping-editor step without re-uploading, but that recovery is a
  // manual operator action available any time before the window
  // elapses, unlike VERIFICATION_INCOMPLETE/VERIFYING's unattended
  // resume which genuinely cannot survive losing the file. See
  // packages/db's `TERMINAL_IMPORT_JOB_STATUSES` for the full reasoning.
  it("deletes both FAILED and CANCELLED terminal jobs' files past the window", async () => {
    const oldFinishedAt = new Date(NOW.getTime() - RETENTION_MS - 24 * 60 * 60 * 1000);
    const failedJob = await seedJob({ status: "FAILED", finishedAt: oldFinishedAt });
    const cancelledJob = await seedJob({ status: "CANCELLED", finishedAt: oldFinishedAt });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);

    await runImportRetention(NOW);

    expect(deleteSpy).toHaveBeenCalledWith(failedJob.storageKey);
    expect(deleteSpy).toHaveBeenCalledWith(cancelledJob.storageKey);

    deleteSpy.mockRestore();
  });

  // ===========================================================
  // FIX 3 (fix round 1) — the eligible set must not grow forever
  // ===========================================================

  it("marks filesDeletedAt after sweeping, and never re-sweeps the same job on a later run", async () => {
    const oldFinishedAt = new Date(NOW.getTime() - RETENTION_MS - 24 * 60 * 60 * 1000);
    const { jobId, storageKey } = await seedJob({ status: "COMPLETED", finishedAt: oldFinishedAt });

    const firstSweep = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);
    await runImportRetention(NOW);
    expect(firstSweep).toHaveBeenCalledWith(storageKey);
    firstSweep.mockRestore();

    const swept = await importJobRepo.getImportJobById(db, jobId);
    expect(swept?.filesDeletedAt).not.toBeNull();

    // A second nightly run, well after the first, must not touch this
    // job's (now-nonexistent) files again — without the filesDeletedAt
    // exclusion, this terminal-and-past-window job would match the
    // eligibility query forever.
    const laterNow = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    const secondSweep = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);
    await runImportRetention(laterNow);
    expect(secondSweep).not.toHaveBeenCalledWith(storageKey);
    secondSweep.mockRestore();
  });

  it("deletes every numbered report part, not just reportStorageKey", async () => {
    const oldFinishedAt = new Date(NOW.getTime() - RETENTION_MS - 24 * 60 * 60 * 1000);
    const jobId = `job_${createId()}`;
    const storageKey = `imports/${PROJECT_ID}/${jobId}/source.csv`;

    await importJobRepo.createImportJob(db, {
      id: jobId,
      projectId: PROJECT_ID,
      sourceLabel: "retention parts test",
      presetId: null,
      storageKey,
      fileName: "source.csv",
      fileBytes: 0,
      fileSha256: "deadbeef",
      mapping: {},
    });
    await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
      status: "COMPLETED",
      finishedAt: oldFinishedAt,
      reportPartCount: 2,
    });

    const deleteSpy = vi.spyOn(importStore, "deleteObject").mockResolvedValue(undefined);
    await runImportRetention(NOW);

    expect(deleteSpy).toHaveBeenCalledWith(storageKey);
    expect(deleteSpy).toHaveBeenCalledWith(
      importStore.buildReportPartStorageKey(PROJECT_ID, jobId, 1),
    );
    expect(deleteSpy).toHaveBeenCalledWith(
      importStore.buildReportPartStorageKey(PROJECT_ID, jobId, 2),
    );
    // Only 2 parts existed — must not guess at a 3rd.
    expect(deleteSpy).not.toHaveBeenCalledWith(
      importStore.buildReportPartStorageKey(PROJECT_ID, jobId, 3),
    );

    deleteSpy.mockRestore();
  });

  it("the eligibility query is backed by a real index, not a full table scan", async () => {
    const result = await db.execute(
      sql`SELECT to_regclass('public.import_jobs_status_finished_at_idx') IS NOT NULL AS present`,
    );
    const rows = (result as unknown as { rows: Array<{ present: boolean }> }).rows;
    expect(rows[0]?.present).toBe(true);
  });
});
