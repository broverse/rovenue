import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { CanonicalField } from "@rovenue/shared";
import { drizzle } from "@rovenue/db";
import { db } from "../../../../packages/db/src/drizzle/client";
import {
  access,
  auditLogs,
  products,
  projects,
  purchases,
  revenueEventDedupe,
  revenueEvents,
  subscribers,
} from "../../../../packages/db/src/drizzle/schema";
import * as importJobRepo from "../../../../packages/db/src/drizzle/repositories/import-jobs";

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

/** One row per subscriber, ACTIVE, non-sandbox, revenue-eligible — the
 *  "everything succeeds" shape every scenario below builds on. */
function csvOf(subscriberIds: string[]): string {
  const lines = subscriberIds.map((subId) =>
    [
      subId,
      "app_store",
      PRODUCT_IDENTIFIER,
      `txn_${subId}`,
      PURCHASE_DATE,
      FUTURE_EXPIRY,
      "9.99",
    ].join(","),
  );
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

    await expect(runImportJob(jobId)).rejects.toThrow("simulated worker kill mid-batch");

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
    const result = await runImportJob(jobId);

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

    const result = await runImportJob(jobId, { batchSize: 2 });
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
    const resumed = await runImportJob(jobId, { batchSize: 2 });

    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.checkpointLine).toBe(lastLineNumber);
    expect(await countPurchases()).toBe(subs.length);
    expect(await countSubscribers()).toBe(subs.length);

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
      runImportJob(jobA),
      runImportJob(jobB),
    ]);

    // Read the call count BEFORE mockRestore() — restoring also resets
    // the spy's recorded calls.
    const incrementCallCount = incrementSpy.mock.calls.length;
    incrementSpy.mockRestore();

    expect(resultA.status).toBe("COMPLETED");
    expect(resultB.status).toBe("COMPLETED");
    expect(maxActive).toBe(1);
    expect(incrementCallCount).toBe(2);

    // Both jobs actually ran to completion despite being serialised.
    expect(await countPurchases()).toBe(8);
    expect(await countSubscribers()).toBe(8);
  });
});
