import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../../../../packages/db/src/drizzle/client";
import { projects } from "../../../../packages/db/src/drizzle/schema";
import * as importJobRepo from "../../../../packages/db/src/drizzle/repositories/import-jobs";
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
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "RUNNING";
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
});
