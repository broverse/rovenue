import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import { PurchaseStatus } from "@rovenue/db";
import { db } from "../../../../packages/db/src/drizzle/client";
import {
  access,
  products,
  projects,
  purchases,
  subscribers,
} from "../../../../packages/db/src/drizzle/schema";
import * as importJobRepo from "../../../../packages/db/src/drizzle/repositories/import-jobs";
import { buildCanonicalRow } from "../../src/services/import/plan";
import { writeImportBatch, type ImportWriteRow } from "../../src/services/import/write";

// =============================================================
// verifyImportedAnchors — Phase B store re-validation (Task 9)
// =============================================================
//
// Runs against the real per-worker Postgres (tests/global-setup.ts), same
// convention as import-write.integration.test.ts and
// import-runner.integration.test.ts. Object storage is faked with an
// in-memory Map (import-runner.integration.test.ts's own pattern) — Phase
// B re-parses the source file exactly the way Phase A's worker does, but
// this file never needs a real S3/MinIO round trip to prove that.
//
// The STORE NETWORK CLIENTS (Apple/Google/Stripe) are the one thing that
// is deliberately faked per test, injected as `deps` — a test against a
// real store would prove nothing here and cannot be run (task-9 brief).
// Every assertion reads DATABASE STATE (purchases.verifiedAt/status,
// import_jobs.status/counters) or the fake client's own call count —
// never a mocked return value standing in for what actually happened.
// =============================================================

const fakeObjects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../../src/lib/import-store", () => ({
  isStorageConfigured: () => true,
  buildStorageKey: (projectId: string, jobId: string, fileName: string) =>
    `imports/${projectId}/${jobId}/${fileName}`,
  getObject: async (key: string) => {
    const buf = fakeObjects.get(key);
    if (!buf) throw new Error(`fake import-store: no object stored for key ${key}`);
    return Readable.from([buf]);
  },
  putObject: async () => undefined,
  deleteObject: async () => undefined,
}));

import { verifyImportedAnchors, type ImportVerifyDeps } from "../../src/services/import/verify";

const PROJECT_ID = `proj_import_verify_${createId()}`;
const ACCESS_ID = `acc_import_verify_${createId()}`;
const PRODUCT_ID = `prod_import_verify_${createId()}`;
const PRODUCT_IDENTIFIER = "pro_monthly";
const APPLE_STORE_PRODUCT_ID = "com.example.pro.monthly";

const PURCHASE_DATE = "2026-01-15 10:00:00";
const FUTURE_EXPIRY = "2028-12-01 00:00:00";

const SOURCE_COLUMNS = [
  "subscriber_id",
  "store",
  "product_id",
  "store_txn_id",
  "original_transaction_id",
  "google_purchase_token",
  "stripe_subscription_id",
  "purchase_date",
  "expires_date",
  "price_in_usd",
] as const;

const CANONICAL_MAPPING: Record<string, CanonicalField> = {
  subscriber_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  store_txn_id: "storeTransactionId",
  original_transaction_id: "originalTransactionId",
  google_purchase_token: "googlePurchaseToken",
  stripe_subscription_id: "stripeSubscriptionId",
  purchase_date: "purchaseDate",
  expires_date: "expiresDate",
  price_in_usd: "priceUsd",
};

const CSV_HEADER = SOURCE_COLUMNS.join(",");

type SourceRow = {
  subscriberId: string;
  store?: string;
  productId?: string;
  storeTxnId?: string;
  originalTransactionId?: string;
  googlePurchaseToken?: string;
  stripeSubscriptionId?: string;
  purchaseDate?: string;
  expiresDate?: string;
  priceUsd?: string;
};

function csvOf(rows: SourceRow[]): string {
  const lines = rows.map((r) =>
    [
      r.subscriberId,
      r.store ?? "app_store",
      r.productId ?? PRODUCT_IDENTIFIER,
      r.storeTxnId ?? "",
      r.originalTransactionId ?? "",
      r.googlePurchaseToken ?? "",
      r.stripeSubscriptionId ?? "",
      r.purchaseDate ?? PURCHASE_DATE,
      r.expiresDate ?? FUTURE_EXPIRY,
      r.priceUsd ?? "",
    ].join(","),
  );
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

async function parseFile(csv: string): Promise<ImportWriteRow[]> {
  const rows: ImportWriteRow[] = [];
  let header: string[] = [];
  for await (const event of parseCsvStream(Readable.from([Buffer.from(csv, "utf8")]))) {
    if ("header" in event) {
      header = event.header;
      continue;
    }
    rows.push({
      lineNumber: event.lineNumber,
      row: buildCanonicalRow(header, event.row, CANONICAL_MAPPING),
    });
  }
  return rows;
}

/** Seeds an import_jobs row AND puts the same CSV into the faked object
 *  store under its storageKey, then runs Phase A (writeImportBatch)
 *  against it — exactly what workers/import-runner.ts would have already
 *  done by the time Phase B is invoked. Returns the jobId. */
async function seedCompletedPhaseA(csv: string): Promise<string> {
  const jobId = `job_${createId()}`;
  const storageKey = `imports/${PROJECT_ID}/${jobId}/source.csv`;
  fakeObjects.set(storageKey, Buffer.from(csv, "utf8"));
  await importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: PROJECT_ID,
    sourceLabel: "verify test import",
    presetId: null,
    storageKey,
    fileName: "source.csv",
    fileBytes: csv.length,
    fileSha256: "deadbeef",
    mapping: CANONICAL_MAPPING,
    options: {},
  });
  await writeImportBatch(jobId, await parseFile(csv));
  await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
    status: "COMPLETED",
    finishedAt: new Date(),
  });
  return jobId;
}

function fakeDeps(overrides: Partial<ImportVerifyDeps> = {}): ImportVerifyDeps {
  return {
    verifyAppleAnchor: vi.fn(async () => {
      throw new Error("verifyAppleAnchor: unexpected call in this test");
    }),
    verifyGoogleAnchor: vi.fn(async () => {
      throw new Error("verifyGoogleAnchor: unexpected call in this test");
    }),
    verifyStripeAnchor: vi.fn(async () => {
      throw new Error("verifyStripeAnchor: unexpected call in this test");
    }),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function findPurchases() {
  return db.select().from(purchases).where(eq(purchases.projectId, PROJECT_ID));
}

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: "Import Verify Test Project" });
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
  fakeObjects.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("verifyImportedAnchors — anchor dedup", () => {
  it("40 rows sharing one Apple originalTransactionId produce ONE verification call, not 40", async () => {
    const subscriberId = `rc_verify_dedup_${createId()}`;
    const anchor = `apple_orig_${createId()}`;
    const rows: SourceRow[] = Array.from({ length: 40 }, (_, i) => ({
      subscriberId,
      storeTxnId: `${anchor}_txn_${i}`,
      originalTransactionId: anchor,
      priceUsd: "9.99",
    }));
    const csv = csvOf(rows);
    const jobId = await seedCompletedPhaseA(csv);
    expect(await findPurchases()).toHaveLength(40);

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(deps.verifyAppleAnchor).toHaveBeenCalledTimes(1);
    expect(summary.anchorsTotal).toBe(1);
    expect(summary.status).toBe("COMPLETED");

    const verified = await findPurchases();
    expect(verified).toHaveLength(40);
    for (const purchase of verified) {
      expect(purchase.verifiedAt).not.toBeNull();
      expect(purchase.status).toBe(PurchaseStatus.ACTIVE);
    }
  });
});

describe("verifyImportedAnchors — throttling pauses and resumes", () => {
  it("retries a throttled anchor instead of failing the row, and the run reports verification incomplete", async () => {
    const subscriberId = `rc_verify_throttle_${createId()}`;
    const anchor = `apple_orig_throttle_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [before] = await findPurchases();
    expect(before!.verifiedAt).toBeNull();
    const statusBefore = before!.status;

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({ kind: "throttled" as const })),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.status).toBe("VERIFICATION_INCOMPLETE");
    expect(summary.anchorsPending).toBe(1);
    // Retried, not given up after one try — and never treated as a row failure.
    expect((deps.verifyAppleAnchor as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(deps.sleep).toHaveBeenCalled();

    const [after] = await findPurchases();
    expect(after!.verifiedAt).toBeNull();
    expect(after!.status).toBe(statusBefore);

    const jobRow = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(jobRow!.status).toBe("VERIFICATION_INCOMPLETE");
  });

  it("resumes on a later call: an anchor that eventually succeeds needs no re-verification of already-verified anchors", async () => {
    const subscriberId = `rc_verify_resume_${createId()}`;
    const anchor = `apple_orig_resume_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);

    // First attempt: permanently throttled — leaves the job incomplete.
    const firstDeps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({ kind: "throttled" as const })),
    });
    const first = await verifyImportedAnchors(jobId, firstDeps);
    expect(first.status).toBe("VERIFICATION_INCOMPLETE");

    // Second attempt (simulating quota freed up): succeeds immediately.
    const secondDeps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
    });
    const second = await verifyImportedAnchors(jobId, secondDeps);
    expect(second.status).toBe("COMPLETED");
    expect(secondDeps.verifyAppleAnchor).toHaveBeenCalledTimes(1);

    const [purchase] = await findPurchases();
    expect(purchase!.verifiedAt).not.toBeNull();
    expect(purchase!.status).toBe(PurchaseStatus.ACTIVE);

    // A THIRD call must not re-call the store at all: the purchase already
    // carries verifiedAt, which is the resume checkpoint.
    const thirdDeps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
    });
    const third = await verifyImportedAnchors(jobId, thirdDeps);
    expect(third.status).toBe("COMPLETED");
    expect(thirdDeps.verifyAppleAnchor).not.toHaveBeenCalled();
  });
});

describe("verifyImportedAnchors — supersedes the imported snapshot", () => {
  it("a verified row gets verifiedAt set and its live status from the store", async () => {
    const subscriberId = `rc_verify_supersede_${createId()}`;
    const anchor = `apple_orig_supersede_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [before] = await findPurchases();
    expect(before!.status).toBe(PurchaseStatus.ACTIVE); // Phase A's imported snapshot (future expiry).

    const liveExpiry = new Date("2026-02-01T00:00:00Z");
    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.EXPIRED, // store says it's actually over — supersedes ACTIVE.
        expiresDate: liveExpiry,
        autoRenewStatus: false,
      })),
    });

    await verifyImportedAnchors(jobId, deps);

    const [after] = await findPurchases();
    expect(after!.verifiedAt).not.toBeNull();
    expect(after!.status).toBe(PurchaseStatus.EXPIRED);
    expect(after!.expiresDate?.toISOString()).toBe(liveExpiry.toISOString());
    expect(after!.autoRenewStatus).toBe(false);
  });
});

describe("verifyImportedAnchors — anchorless rows", () => {
  it("never sends an anchorless (MANUAL) row to verification", async () => {
    const subscriberId = `rc_verify_anchorless_${createId()}`;
    const csv = csvOf([
      { subscriberId, store: "promotional", storeTxnId: "" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    expect(await findPurchases()).toHaveLength(1);

    const deps = fakeDeps();
    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.rowsSkippedAnchorless).toBe(1);
    expect(summary.anchorsTotal).toBe(0);
    expect(deps.verifyAppleAnchor).not.toHaveBeenCalled();
    expect(deps.verifyGoogleAnchor).not.toHaveBeenCalled();
    expect(deps.verifyStripeAnchor).not.toHaveBeenCalled();
  });
});

describe("verifyImportedAnchors — the store no longer recognises the row", () => {
  it("leaves the row as history: not deleted, not marked verified", async () => {
    const subscriberId = `rc_verify_notfound_${createId()}`;
    const anchor = `apple_orig_notfound_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [before] = await findPurchases();

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({ kind: "notFound" as const })),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.anchorsNotFound).toBe(1);
    expect(summary.status).toBe("COMPLETED"); // a definitive answer, not a pending one.

    const after = await findPurchases();
    expect(after).toHaveLength(1); // still there — never deleted.
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.verifiedAt).toBeNull();
    expect(after[0]!.status).toBe(before!.status);
  });
});
