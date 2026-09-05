import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { CanonicalField } from "@rovenue/shared";
import {
  drizzle,
  db,
  access,
  auditLogs,
  products,
  projects,
  purchases,
  revenueEvents,
  subscribers,
} from "@rovenue/db";

// revenueEventDedupe and importJobRepo aren't re-exported at @rovenue/db's
// top level (only individual schema tables and repos with their own
// top-level convenience export are) — reach them off the `drizzle`
// namespace instead of the relative path into packages/db/src this file
// previously used, which pulled those files outside this package's
// tsconfig rootDir under static typecheck (TS6059).
const revenueEventDedupe = drizzle.revenueEventDedupe;
const importJobRepo = drizzle.importJobRepo;

// =============================================================
// import-runner (Task 8) — worker, batching, checkpointed resume,
// cancellation, per-project serialisation
// =============================================================
//
// Runs against the real per-worker Postgres (tests/global-setup.ts),
// same convention as services/import-write.integration.test.ts and
// services/import-plan.test.ts. Object storage is faked with an
// in-memory Map (same shape those two files use) — `runImportJob` never
// needs a real S3/MinIO round trip to prove ITS logic (batching,
// checkpointing, cancellation, the per-project lock); write.ts's own
// tests already cover the writer's row-level behaviour.
//
// Every assertion below reads DATABASE STATE (row counts, the
// `import_jobs` row itself, audit rows) — never a log line, never a
// mocked call's return value standing in for what actually happened.
// =============================================================

const fakeObjects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../../src/lib/import-store", () => ({
  isStorageConfigured: () => true,
  buildStorageKey: (projectId: string, jobId: string, fileName: string) =>
    `imports/${projectId}/${jobId}/${fileName}`,
  buildReportStorageKey: (projectId: string, jobId: string) =>
    `imports/${projectId}/${jobId}/report.ndjson`,
  // Mirrors lib/import-store.ts's real implementation exactly — the
  // Phase-A writer (workers/import-runner.ts) always calls this, never
  // buildReportStorageKey above (see report.ts's createReportWriter).
  buildReportPartStorageKey: (projectId: string, jobId: string, partNumber: number) =>
    `imports/${projectId}/${jobId}/report.part-${String(partNumber).padStart(4, "0")}.ndjson`,
  putObject: async (key: string, body: AsyncIterable<Buffer | Uint8Array>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    fakeObjects.set(key, Buffer.concat(chunks));
  },
  getObject: async (key: string) => {
    const buf = fakeObjects.get(key);
    if (!buf) throw new Error(`fake import-store: no object stored for key ${key}`);
    return Readable.from([buf]);
  },
  deleteObject: async () => undefined,
}));

import { runImportJob } from "../../src/workers/import-runner";
import type { ImportVerifyDeps } from "../../src/services/import/verify";
import { buildCanonicalRow } from "../../src/services/import/plan";
import { writeImportBatch } from "../../src/services/import/write";

// This file's subject is Phase A (batching/checkpoint/cancel/the
// per-project lock) — Task 9's Phase B has its own dedicated test file
// (import-verify.integration.test.ts). The test project here has no real
// store credentials configured, so the PRODUCTION verify deps would
// throw and leave every job `VERIFICATION_INCOMPLETE` instead of
// `COMPLETED`, which is not what any test below is about. This fake
// always reports "the store doesn't recognise it" — a real, definitive
// (non-pending) outcome — so Phase B finishes instantly without
// affecting the status assertions that are this file's actual point.
const NOOP_VERIFY_DEPS: ImportVerifyDeps = {
  verifyAppleAnchor: async () => ({ kind: "notFound" }),
  verifyGoogleAnchor: async () => ({ kind: "notFound" }),
  verifyStripeAnchor: async () => ({ kind: "notFound" }),
};

const PROJECT_ID = `proj_import_runner_${createId()}`;
const ACCESS_ID = `acc_import_runner_${createId()}`;
const PRODUCT_ID = `prod_import_runner_${createId()}`;
const PRODUCT_IDENTIFIER = "pro_monthly";
const APPLE_STORE_PRODUCT_ID = "com.example.pro.monthly";

/** Inside the 2024-01..2028-12 revenue_events partition range (migration
 *  0015) so nothing here exercises partition provisioning — that is
 *  services/import-write.integration.test.ts's job. */
const PURCHASE_DATE = "2026-03-10 10:00:00";
const FUTURE_EXPIRY = "2028-12-01 00:00:00";

const SOURCE_COLUMNS = [
  "subscriber_id",
  "store",
  "product_id",
  "store_txn_id",
  "purchase_date",
  "expires_date",
  "price_in_usd",
] as const;

const CANONICAL_MAPPING: Record<string, CanonicalField> = {
  subscriber_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  store_txn_id: "storeTransactionId",
  purchase_date: "purchaseDate",
  expires_date: "expiresDate",
  price_in_usd: "priceUsd",
};

const CSV_HEADER = SOURCE_COLUMNS.join(",");

/** One row's raw field VALUES, in `SOURCE_COLUMNS` order — factored out
 *  of `csvOf` so fix round 2's crash test (below) can build the exact
 *  same row shape without going through a real CSV parse. */
function rowValuesFor(subId: string): string[] {
  return [subId, "app_store", PRODUCT_IDENTIFIER, `txn_${subId}`, PURCHASE_DATE, FUTURE_EXPIRY, "9.99"];
}

/** One row per subscriber, ACTIVE, non-sandbox, revenue-eligible — the
 *  "everything succeeds" shape every scenario below builds on. */
function csvOf(subscriberIds: string[]): string {
  const lines = subscriberIds.map((subId) => rowValuesFor(subId).join(","));
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

async function seedJob(csv: string): Promise<string> {
  const jobId = `job_${createId()}`;
  const storageKey = `imports/${PROJECT_ID}/${jobId}/source.csv`;
  fakeObjects.set(storageKey, Buffer.from(csv, "utf8"));
  await importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: PROJECT_ID,
    sourceLabel: "import-runner test",
    presetId: null,
    storageKey,
    fileName: "source.csv",
    fileBytes: Buffer.byteLength(csv, "utf8"),
    fileSha256: "deadbeef",
    mapping: CANONICAL_MAPPING,
  });
  return jobId;
}

// -------------------------------------------------------------
// State observation helpers
// -------------------------------------------------------------

async function countSubscribers(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(eq(subscribers.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function countPurchases(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(eq(purchases.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function countRevenueEvents(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(revenueEvents)
    .where(eq(revenueEvents.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

/** Fix round 1, FIX 2: the branch's acceptance criterion is that SUMMED
 *  REVENUE is unchanged across a re-run — the number a customer would
 *  actually notice being wrong — not just row-count equality. */
async function sumRevenueUsd(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM("revenue_events"."amountUsd"), 0)::text`,
    })
    .from(revenueEvents)
    .where(eq(revenueEvents.projectId, PROJECT_ID));
  return Number(row?.total ?? "0");
}

/** Fix round 1, FIX 5: reads a report PART back out of the fake object
 *  store and returns its parsed NDJSON rows — used to prove a
 *  crash-and-resume across two invocations leaves BOTH attempts'
 *  reports intact as separate, readable parts, instead of the second
 *  attempt silently destroying the first's. */
function readReportPartRows(
  jobId: string,
  partNumber: number,
): Array<Record<string, unknown>> {
  const key = `imports/${PROJECT_ID}/${jobId}/report.part-${String(partNumber).padStart(4, "0")}.ndjson`;
  const buf = fakeObjects.get(key);
  if (!buf) throw new Error(`no report part object stored for key ${key}`);
  return buf
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function countImportCompletedAudits(jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, PROJECT_ID),
        eq(auditLogs.action, "import.completed"),
        eq(auditLogs.resourceId, jobId),
      ),
    );
  return row?.n ?? 0;
}

/** The `import.completed` audit row's `after` payload — the actual bug
 *  surface for FIX 1: this is the append-only, hash-chained record a
 *  wrong count would corrupt permanently. */
// Fix round 1, FIX 3: the payload now also carries a `status` STRING
// (the run's true final status) alongside the numeric outcome buckets —
// `number | string` reflects that honestly rather than lying via a
// same-as-before `Record<string, number>` cast.
async function getImportCompletedAuditPayload(
  jobId: string,
): Promise<Record<string, number | string>> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, PROJECT_ID),
        eq(auditLogs.action, "import.completed"),
        eq(auditLogs.resourceId, jobId),
      ),
    )
    .limit(1);
  return (rows[0]?.after ?? {}) as Record<string, number | string>;
}

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: "Import Runner Test Project" });
  await db.insert(access).values({
    id: ACCESS_ID,
    projectId: PROJECT_ID,
    identifier: "pro",
    displayName: "Pro",
  });
  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: PRODUCT_IDENTIFIER,
    type: "SUBSCRIPTION",
    storeIds: { apple: APPLE_STORE_PRODUCT_ID },
    accessIds: [ACCESS_ID],
    displayName: "Pro Monthly",
  });
});

beforeEach(async () => {
  await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
  await db.delete(revenueEventDedupe).where(eq(revenueEventDedupe.projectId, PROJECT_ID));
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

// =============================================================
// Scenario 1 — kill mid-file, restart: no row written twice
// =============================================================

describe("runImportJob — crash mid-batch and resume", () => {
  it("replays the whole interrupted batch and ends with exactly one row per subscriber", async () => {
    const subs = ["kill_a", "kill_b", "kill_c", "kill_d", "kill_e", "kill_f"];
    const jobId = await seedJob(csvOf(subs));

    // Simulate the worker process dying partway through the batch: the
    // 3rd purchase upsert throws, so rows 4-6 in this attempt never even
    // reach the DB. Everything else about writeImportBatch runs for
    // real — only this one call is intercepted.
    const originalUpsert = drizzle.purchaseRepo.upsertPurchase.bind(
      drizzle.purchaseRepo,
    );
    let calls = 0;
    const upsertSpy = vi
      .spyOn(drizzle.purchaseRepo, "upsertPurchase")
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 3) {
          throw new Error("simulated worker kill mid-batch");
        }
        return originalUpsert(...args);
      });

    await expect(runImportJob(jobId, { verifyDeps: NOOP_VERIFY_DEPS })).rejects.toThrow(
      "simulated worker kill mid-batch",
    );

    // The batch never completed, so the checkpoint must NOT have moved —
    // this is the invariant that makes "replay the whole batch" safe.
    const afterCrash = await importJobRepo.getImportJobById(db, jobId);
    expect(afterCrash?.checkpointLine).toBe(0);
    expect(afterCrash?.status).toBe("FAILED");
    // Rows 1 and 2 really did write during the interrupted attempt —
    // proving the resume below has to cope with partial prior writes,
    // not just re-run a batch that touched nothing.
    expect(await countPurchases()).toBe(2);

    upsertSpy.mockRestore();

    // "Restart the worker": call runImportJob again for the same job.
    const result = await runImportJob(jobId, { verifyDeps: NOOP_VERIFY_DEPS });

    // Line numbers are 1-based over the WHOLE file (the header occupies
    // line 1), so the last data row's line number is subs.length + 1 —
    // not the row count itself.
    const lastLineNumber = subs.length + 1;

    expect(result.status).toBe("COMPLETED");
    expect(result.checkpointLine).toBe(lastLineNumber);

    // No row written twice: exactly one purchase / subscriber / revenue
    // event per source row, never more.
    expect(await countSubscribers()).toBe(subs.length);
    expect(await countPurchases()).toBe(subs.length);
    expect(await countRevenueEvents()).toBe(subs.length);
    // FIX 2: summed revenue, not just row counts — the number a
    // customer would actually notice being wrong.
    expect(await sumRevenueUsd()).toBeCloseTo(9.99 * subs.length, 2);

    const finalJob = await importJobRepo.getImportJobById(db, jobId);
    expect(finalJob?.status).toBe("COMPLETED");
    expect(finalJob?.checkpointLine).toBe(lastLineNumber);
    // Rows 1-2 already existed on this run (willUpdate); 3-6 were fresh
    // (willCreate) — either way every row landed in exactly one bucket.
    const counters = finalJob?.counters as Record<string, number>;
    expect((counters.willCreate ?? 0) + (counters.willUpdate ?? 0)).toBe(subs.length);

    // auditImportRunCompleted fires exactly once for the whole job, on
    // the run that actually finished — never on the interrupted attempt.
    expect(await countImportCompletedAudits(jobId)).toBe(1);
  });

  // ===========================================================
  // FIX 1 (fix round 1) — the audit must reflect the FULL job, not
  // just the last invocation's contribution.
  // ===========================================================
  //
  // The test above is NOT sufficient to catch FIX 1's bug: its whole
  // file fits in one batch that is ENTIRELY re-run on resume, so a
  // call-scoped accumulator and the persisted cumulative counters
  // coincidentally agree. This test forces two invocations that do
  // GENUINELY DIFFERENT work — batch 1 commits for real (checkpoint +
  // counters persisted) before the crash, so the resume only processes
  // batch 2's rows. A call-scoped `totals` would then audit only
  // batch 2's 3 rows; the fix must audit all 6.
  it("audits the FULL persisted counters across two invocations, not just the last leg", async () => {
    const subs = ["span_a", "span_b", "span_c", "span_d", "span_e", "span_f"];
    const jobId = await seedJob(csvOf(subs));

    // Crash AFTER batch 1's checkpoint genuinely commits, BEFORE batch 2
    // starts — unlike Scenario 1's mid-batch throw, nothing here gets
    // replayed; batch 2 is entirely new work.
    const originalSaveCheckpoint = importJobRepo.saveImportJobCheckpoint;
    let calls = 0;
    const checkpointSpy = vi
      .spyOn(importJobRepo, "saveImportJobCheckpoint")
      .mockImplementation(async (...args) => {
        calls += 1;
        const row = await originalSaveCheckpoint(...args);
        if (calls === 1) {
          throw new Error("simulated crash right after batch 1's checkpoint committed");
        }
        return row;
      });

    await expect(runImportJob(jobId, { batchSize: 3, verifyDeps: NOOP_VERIFY_DEPS })).rejects.toThrow(
      "simulated crash right after batch 1's checkpoint committed",
    );
    checkpointSpy.mockRestore();

    // Batch 1 (3 rows) genuinely landed before the crash.
    const firstBatchLastLine = 4; // header(1) + 3 rows
    const afterCrash = await importJobRepo.getImportJobById(db, jobId);
    expect(afterCrash?.checkpointLine).toBe(firstBatchLastLine);
    expect(await countPurchases()).toBe(3);
    // FIX 5 side effect, verified properly below: the crashed attempt
    // still closed its own report part rather than losing it.
    expect(afterCrash?.reportPartCount).toBe(1);

    const result = await runImportJob(jobId, { batchSize: 3, verifyDeps: NOOP_VERIFY_DEPS });
    expect(result.status).toBe("COMPLETED");
    expect(await countPurchases()).toBe(subs.length);

    // The bug: a call-scoped accumulator would report only batch 2's 3
    // rows here. The fix: the FULL 6-row file.
    const totalFromResult = Object.values(result.outcomes).reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalFromResult).toBe(subs.length);

    // The actual bug surface: the append-only, hash-chained audit row
    // itself must carry the full count.
    const auditPayload = await getImportCompletedAuditPayload(jobId);
    const auditedTotal = Object.values(auditPayload).reduce(
      (a, b) => a + (typeof b === "number" ? b : 0),
      0,
    );
    expect(auditedTotal).toBe(subs.length);
    expect(await countImportCompletedAudits(jobId)).toBe(1);

    // FIX 5: both attempts' reports survive as separate, readable parts
    // — the crash did not destroy batch 1's report when batch 2 wrote
    // its own.
    const finalJob = await importJobRepo.getImportJobById(db, jobId);
    expect(finalJob?.reportPartCount).toBe(2);
    expect(readReportPartRows(jobId, 1)).toHaveLength(3);
    expect(readReportPartRows(jobId, 2)).toHaveLength(3);
  });
});

// =============================================================
// Scenario 2 — cancellation stops the run; re-running completes it
// =============================================================

describe("runImportJob — cancellation", () => {
  it("stops between batches, leaves prior writes intact, and a re-run completes the file", async () => {
    const subs = ["cancel_a", "cancel_b", "cancel_c", "cancel_d", "cancel_e", "cancel_f"];
    const jobId = await seedJob(csvOf(subs));

    // Flip the job to CANCELLED right after the FIRST batch's checkpoint
    // commits — simulating an operator cancelling mid-run. Only fires
    // once; the resume run below must not re-trigger it.
    const originalSaveCheckpoint = importJobRepo.saveImportJobCheckpoint;
    let triggered = false;
    const checkpointSpy = vi
      .spyOn(importJobRepo, "saveImportJobCheckpoint")
      .mockImplementation(async (...args) => {
        const row = await originalSaveCheckpoint(...args);
        if (!triggered) {
          triggered = true;
          await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
            status: "CANCELLED",
          });
        }
        return row;
      });

    const result = await runImportJob(jobId, { batchSize: 2, verifyDeps: NOOP_VERIFY_DEPS });
    checkpointSpy.mockRestore();

    // The header occupies line 1, so the first 2-row batch's rows are on
    // lines 2 and 3 — its checkpoint is 3, not the row count 2.
    const firstBatchLastLine = 3;
    const lastLineNumber = subs.length + 1;

    expect(result.status).toBe("CANCELLED");
    expect(result.checkpointLine).toBe(firstBatchLastLine);

    // Only the first (2-row) batch wrote anything — prior writes intact,
    // nothing beyond the cancellation point touched.
    expect(await countPurchases()).toBe(2);

    const cancelledJob = await importJobRepo.getImportJobById(db, jobId);
    expect(cancelledJob?.status).toBe("CANCELLED");
    expect(cancelledJob?.checkpointLine).toBe(firstBatchLastLine);
    expect(await countImportCompletedAudits(jobId)).toBe(0);

    // Re-running the same file (e.g. the operator resumes it) picks up
    // from the checkpoint and finishes.
    const resumed = await runImportJob(jobId, { batchSize: 2, verifyDeps: NOOP_VERIFY_DEPS });

    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.checkpointLine).toBe(lastLineNumber);
    expect(await countPurchases()).toBe(subs.length);
    expect(await countSubscribers()).toBe(subs.length);
    // FIX 2: summed revenue, not just row counts.
    expect(await sumRevenueUsd()).toBeCloseTo(9.99 * subs.length, 2);

    const finalJob = await importJobRepo.getImportJobById(db, jobId);
    expect(finalJob?.status).toBe("COMPLETED");
    expect(await countImportCompletedAudits(jobId)).toBe(1);
  });
});

// =============================================================
// Scenario 3 — two jobs, same project, never run concurrently
// =============================================================

describe("runImportJob — per-project serialisation", () => {
  it("never overlaps two runs for the same project, and both still complete", async () => {
    const jobA = await seedJob(csvOf(["conc_a1", "conc_a2", "conc_a3", "conc_a4"]));
    const jobB = await seedJob(csvOf(["conc_b1", "conc_b2", "conc_b3", "conc_b4"]));

    let activeCount = 0;
    let maxActive = 0;
    const originalIncrement = importJobRepo.incrementImportJobCounters;
    const incrementSpy = vi
      .spyOn(importJobRepo, "incrementImportJobCounters")
      .mockImplementation(async (...args) => {
        activeCount += 1;
        maxActive = Math.max(maxActive, activeCount);
        // Widen the race window: if the per-project lock did NOT hold,
        // this delay gives the other job's call every chance to land
        // while this one is still "inside" its critical section.
        await new Promise((resolve) => setTimeout(resolve, 60));
        try {
          return await originalIncrement(...args);
        } finally {
          activeCount -= 1;
        }
      });

    const [resultA, resultB] = await Promise.all([
      runImportJob(jobA, { verifyDeps: NOOP_VERIFY_DEPS }),
      runImportJob(jobB, { verifyDeps: NOOP_VERIFY_DEPS }),
    ]);

    // Read the call count BEFORE mockRestore() — restoring also resets
    // the spy's recorded calls.
    const incrementCallCount = incrementSpy.mock.calls.length;
    incrementSpy.mockRestore();

    expect(resultA.status).toBe("COMPLETED");
    expect(resultB.status).toBe("COMPLETED");
    expect(maxActive).toBe(1);
    // 2 calls per job (4 total): Phase A's own batch increment, plus
    // Task 9's Phase B (`verifyImportedAnchors`) incrementing its own
    // verify-outcome counters through the SAME primitive once each job
    // reaches COMPLETED. The real point of this test — that the two jobs
    // never overlap — is `maxActive` above, unaffected by Phase B running.
    expect(incrementCallCount).toBe(4);

    // Both jobs actually ran to completion despite being serialised.
    expect(await countPurchases()).toBe(8);
    expect(await countSubscribers()).toBe(8);
  });
});

// =============================================================
// Scenario 4 (fix round 1, FIX 3) — the completion audit must reflect
// the run's TRUE final status, not unconditionally COMPLETED
// =============================================================
//
// Before this fix, `auditImportRunCompleted` fired right after Phase A's
// own COMPLETED write and BEFORE Phase B ever ran, so a run that Phase B
// went on to downgrade to VERIFICATION_INCOMPLETE still permanently
// audited `import.completed` with no hint anything was incomplete. The
// fix moves the call to AFTER Phase B resolves and threads the run's
// real final status into the audited payload.
describe("runImportJob — completion audit reflects the true final status (fix round 1, FIX 3)", () => {
  it("audits VERIFICATION_INCOMPLETE, not COMPLETED, when Phase B never resolves every anchor", async () => {
    const jobId = await seedJob(csvOf(["audit_incomplete_a"]));

    // Every anchor is definitively throttled, forever — with `sleep`
    // faked to skip the real backoff wait, this exhausts
    // THROTTLE_RETRY_MAX_ATTEMPTS almost instantly and leaves the one
    // anchor "pending", landing the run at VERIFICATION_INCOMPLETE
    // without needing real wall-clock time or a real store.
    const throttledForever: ImportVerifyDeps = {
      verifyAppleAnchor: async () => ({ kind: "throttled" }),
      verifyGoogleAnchor: async () => ({ kind: "throttled" }),
      verifyStripeAnchor: async () => ({ kind: "throttled" }),
      sleep: async () => undefined,
    };

    const result = await runImportJob(jobId, { verifyDeps: throttledForever });

    expect(result.status).toBe("VERIFICATION_INCOMPLETE");

    // The audit fires exactly once (same invariant as every other
    // scenario in this file) — the bug was never about the COUNT, only
    // about what status it claimed.
    expect(await countImportCompletedAudits(jobId)).toBe(1);

    const payload = await getImportCompletedAuditPayload(jobId);
    expect(payload.status).toBe("VERIFICATION_INCOMPLETE");

    // The persisted row itself must agree — belt-and-suspenders, proving
    // the audited status isn't just coincidentally right while the row
    // disagrees.
    const finalJob = await importJobRepo.getImportJobById(db, jobId);
    expect(finalJob?.status).toBe("VERIFICATION_INCOMPLETE");
  });

  it("still audits COMPLETED for an ordinary run where Phase B resolves everything", async () => {
    const jobId = await seedJob(csvOf(["audit_complete_a"]));

    const result = await runImportJob(jobId, { verifyDeps: NOOP_VERIFY_DEPS });

    expect(result.status).toBe("COMPLETED");
    expect(await countImportCompletedAudits(jobId)).toBe(1);
    const payload = await getImportCompletedAuditPayload(jobId);
    expect(payload.status).toBe("COMPLETED");
  });
});

// =============================================================
// Scenario 5 (fix round 2, FIX A) — a HARD crash during Phase B leaves
// the row at VERIFYING, and a later run resumes it correctly
// =============================================================
//
// "Hard crash" (OOM, a deploy restart, `kill -9`) means NEITHER of
// `processImportJob`'s try/catch blocks ever runs — the whole point of
// FIX A is that this used to leave the row stuck at COMPLETED (Phase A's
// old write), permanently unrecoverable. Simulating that live, inside
// this ONE Node test process, is not tractable: `runImportJob` holds the
// per-project Postgres advisory lock (`withProjectImportLock`) for its
// ENTIRE call, released only in a `finally` that — by construction —
// never runs if the awaited call never settles. Abandoning a live,
// never-resolving `runImportJob` call to "simulate" the crash would
// therefore leave that lock held for the rest of THIS TEST PROCESS'S
// life (a real crash instead kills the OS connection, which is what
// actually frees a session-level advisory lock — Postgres has no other
// way to revoke one), and a second `runImportJob` call for the SAME
// project (needed for the "resume" half of this test) would hang
// forever waiting for a lock nothing will ever release.
//
// So instead of a live abandoned call, this test constructs the EXACT
// row state a crash leaves behind, using the same primitives
// `processImportJob` itself calls: `writeImportBatch` (Task 8's real
// Phase-A writer — the same purchase/subscriber/revenue-event write path
// a real run uses, not a stand-in) for the one row, then the identical
// `setImportJobStatus({ status: "VERIFYING" })` write `processImportJob`
// performs immediately before calling Phase B. That write IS the
// boundary FIX A added; constructing the state on its far side is a
// faithful proxy for "the process died right there," not a shortcut
// around what the fix changed.
describe("runImportJob — a hard crash during Phase B leaves VERIFYING, resumable (fix round 2, FIX A)", () => {
  it("resumes from VERIFYING: Phase B completes, the audit fires exactly once, and Phase A is not re-written", async () => {
    const subId = "hard_crash_a";
    const jobId = await seedJob(csvOf([subId]));

    // ---- Simulate "Phase A finished for real, then the process died
    // ---- before Phase B ever ran" ----
    const canonicalRow = buildCanonicalRow([...SOURCE_COLUMNS], rowValuesFor(subId), CANONICAL_MAPPING);
    const lineNumber = 2; // header occupies line 1
    const outcome = await writeImportBatch(jobId, [{ lineNumber, row: canonicalRow }]);
    await importJobRepo.incrementImportJobCounters(db, PROJECT_ID, jobId, outcome.outcomes);
    await importJobRepo.saveImportJobCheckpoint(db, PROJECT_ID, jobId, outcome.lastLineNumber);
    await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
      status: "VERIFYING",
      reportPartCount: 0,
    });

    // Prove the "crash" actually happened where this test claims: real
    // Phase-A writes landed, but NOTHING was ever audited — the exact
    // gap FIX A closes (before it, this state was UNREACHABLE for a
    // resume because Phase A used to write COMPLETED here instead).
    expect(await countPurchases()).toBe(1);
    expect(await countSubscribers()).toBe(1);
    const crashedJob = await importJobRepo.getImportJobById(db, jobId);
    expect(crashedJob?.status).toBe("VERIFYING");
    expect(await countImportCompletedAudits(jobId)).toBe(0);

    // ---- "Restart the worker": a fresh runImportJob call for the same
    // ---- job, exactly what a retry or an operator's /resume triggers.
    const result = await runImportJob(jobId, { verifyDeps: NOOP_VERIFY_DEPS });

    expect(result.status).toBe("COMPLETED");

    // Phase A fast-forwarded from its checkpoint as a genuine no-op —
    // the one purchase/subscriber from the "crash" setup is not doubled.
    expect(await countPurchases()).toBe(1);
    expect(await countSubscribers()).toBe(1);

    // Phase B actually ran this time and resolved the anchor for real.
    const finalJob = await importJobRepo.getImportJobById(db, jobId);
    expect(finalJob?.status).toBe("COMPLETED");
    expect(finalJob?.finishedAt).not.toBeNull();
    expect((finalJob?.counters as Record<string, number>).verifyAnchorNotFound).toBe(1);

    // The audit fires EXACTLY once — never during the crashed attempt
    // (proven above), exactly once now that the run truly finished — and
    // with the run's true final status.
    expect(await countImportCompletedAudits(jobId)).toBe(1);
    const payload = await getImportCompletedAuditPayload(jobId);
    expect(payload.status).toBe("COMPLETED");
  });
});
