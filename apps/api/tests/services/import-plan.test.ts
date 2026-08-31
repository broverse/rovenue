import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../../../../packages/db/src/drizzle/client";
import {
  projects,
  products,
  purchases,
  subscribers,
  revenueEvents,
} from "../../../../packages/db/src/drizzle/schema";
import * as importJobRepo from "../../../../packages/db/src/drizzle/repositories/import-jobs";

// =============================================================
// planImport — dry-run planner (Task 6)
//
// Exercises the REAL planner (`src/services/import/plan.ts`) against a
// real Postgres project/catalog (matching this repo's convention for
// repository-adjacent service tests, e.g. billing-subscriptions-repo.test.ts
// — not testcontainers, the ambient per-worker DB `tests/global-setup.ts`
// already provides). Only object storage is faked: an in-memory Map
// standing in for the private import bucket, mirroring
// tests/routes/imports-upload.test.ts's module-level mock of the same
// file, so no MinIO/S3 round trip is needed to prove the planner's own
// logic (row classification, catalog resolution, "writes nothing").
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

import { planImport } from "../../src/services/import/plan";

const PROJECT_ID = `proj_import_plan_${createId()}`;

const CANONICAL_MAPPING = {
  subscriber_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  store_txn_id: "storeTransactionId",
  purchase_date: "purchaseDate",
  is_sandbox: "isSandbox",
  google_token: "googlePurchaseToken",
  entitlements: "entitlementIdentifiers",
} as const;

const CSV_HEADER =
  "subscriber_id,store,product_id,store_txn_id,purchase_date,is_sandbox,google_token,entitlements";

function csvOf(rows: string[]): string {
  return `${CSV_HEADER}\n${rows.join("\n")}\n`;
}

async function seedProduct(identifier: string, storeIds: Record<string, string>) {
  await db.insert(products).values({
    id: `prod_${identifier}`,
    projectId: PROJECT_ID,
    identifier,
    type: "SUBSCRIPTION",
    storeIds,
    displayName: identifier,
  });
}

/** Creates an import_jobs row pointing at a CSV already placed in
 *  `fakeObjects`, and returns its id. */
async function seedJob(args: {
  csv: string;
  options?: { skipSandbox?: boolean };
}): Promise<string> {
  const jobId = `job_${createId()}`;
  const storageKey = `imports/${PROJECT_ID}/${jobId}/source.csv`;
  fakeObjects.set(storageKey, Buffer.from(args.csv, "utf8"));

  await importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: PROJECT_ID,
    sourceLabel: "test import",
    presetId: null,
    storageKey,
    fileName: "source.csv",
    fileBytes: Buffer.byteLength(args.csv, "utf8"),
    fileSha256: "deadbeef",
    mapping: CANONICAL_MAPPING,
    options: args.options ?? {},
  });

  return jobId;
}

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: "Import Plan Test Project" });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("planImport", () => {
  it("classifies a row whose productIdentifier is absent from the catalog as unresolvedProduct, and creates no product", async () => {
    const beforeCount = (
      await db.select().from(products).where(eq(products.projectId, PROJECT_ID))
    ).length;

    const jobId = await seedJob({
      csv: csvOf(["user_unresolved,app_store,does_not_exist,txn_unresolved,2026-01-01 00:00:00,false,,"]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.unresolvedProduct).toBe(1);
    expect(summary.totalRows).toBe(1);

    const afterCount = (
      await db.select().from(products).where(eq(products.projectId, PROJECT_ID))
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("classifies a promotional row as anchorless", async () => {
    await seedProduct("promo_product", { apple: "promo_product" });

    const jobId = await seedJob({
      csv: csvOf(["user_promo,promotional,promo_product,,2026-01-01 00:00:00,false,,"]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.anchorless).toBe(1);
  });

  it("classifies PLAY_STORE rows with no mapped googlePurchaseToken as androidNoToken, counted not booleaned", async () => {
    await seedProduct("google_product", { google: "google_product" });

    const jobId = await seedJob({
      csv: csvOf([
        "user_android_1,play_store,google_product,txn_android_1,2026-01-01 00:00:00,false,,",
        "user_android_2,play_store,google_product,txn_android_2,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.androidNoToken).toBe(2);
    expect(typeof summary.outcomes.androidNoToken).toBe("number");
  });

  it("skips sandbox rows by default (skippedSandbox), and moves them to willCreate when options.skipSandbox=false", async () => {
    await seedProduct("sandbox_product", { apple: "sandbox_product" });
    const csv = csvOf([
      "user_sandbox,app_store,sandbox_product,txn_sandbox_a,2026-01-01 00:00:00,true,,",
    ]);

    const defaultJobId = await seedJob({ csv });
    const defaultSummary = await planImport(defaultJobId);
    expect(defaultSummary.outcomes.skippedSandbox).toBe(1);
    expect(defaultSummary.outcomes.willCreate).toBe(0);

    const csv2 = csvOf([
      "user_sandbox2,app_store,sandbox_product,txn_sandbox_b,2026-01-01 00:00:00,true,,",
    ]);
    const includeJobId = await seedJob({ csv: csv2, options: { skipSandbox: false } });
    const includeSummary = await planImport(includeJobId);
    expect(includeSummary.outcomes.skippedSandbox).toBe(0);
    expect(includeSummary.outcomes.willCreate).toBe(1);
  });

  it("flags the second of two rows sharing (store, storeTransactionId) as duplicateInFile", async () => {
    await seedProduct("dup_product", { apple: "dup_product" });

    const jobId = await seedJob({
      csv: csvOf([
        "user_dup_1,app_store,dup_product,txn_dup,2026-01-01 00:00:00,false,,",
        "user_dup_2,app_store,dup_product,txn_dup,2026-01-02 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.willCreate).toBe(1);
    expect(summary.outcomes.duplicateInFile).toBe(1);
  });

  it("classifies a row with an existing purchase for (store, storeTransactionId) as willUpdate", async () => {
    await seedProduct("update_product", { apple: "update_product" });

    const subscriberId = `sub_${createId()}`;
    await db.insert(subscribers).values({
      id: subscriberId,
      projectId: PROJECT_ID,
      rovenueId: "user_update_existing",
    });
    await db.insert(purchases).values({
      id: `purch_${createId()}`,
      projectId: PROJECT_ID,
      subscriberId,
      productId: `prod_update_product`,
      store: "APP_STORE",
      storeTransactionId: "txn_update_existing",
      originalTransactionId: "txn_update_existing",
      status: "ACTIVE",
      purchaseDate: new Date("2026-01-01T00:00:00Z"),
      originalPurchaseDate: new Date("2026-01-01T00:00:00Z"),
      environment: "PRODUCTION",
    });

    const jobId = await seedJob({
      csv: csvOf([
        "user_update_existing,app_store,update_product,txn_update_existing,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.willUpdate).toBe(1);
    expect(summary.outcomes.willCreate).toBe(0);
  });

  it("writes NOTHING to subscribers/purchases/revenue_events — a dry run only reads and reports", async () => {
    await seedProduct("noop_product", { apple: "noop_product" });

    const countAll = async () => ({
      subscribers: (
        await db.select().from(subscribers).where(eq(subscribers.projectId, PROJECT_ID))
      ).length,
      purchases: (
        await db.select().from(purchases).where(eq(purchases.projectId, PROJECT_ID))
      ).length,
      revenueEvents: (
        await db.select().from(revenueEvents).where(eq(revenueEvents.projectId, PROJECT_ID))
      ).length,
    });

    const before = await countAll();

    const jobId = await seedJob({
      csv: csvOf([
        "user_noop,app_store,noop_product,txn_noop,2026-01-01 00:00:00,false,,",
      ]),
    });
    const summary = await planImport(jobId);
    expect(summary.outcomes.willCreate).toBe(1);

    const after = await countAll();
    expect(after).toEqual(before);
  });

  it("observes distinct raw entitlement_identifiers shapes across the file (counted, not re-parsed)", async () => {
    await seedProduct("entitlement_product", { apple: "entitlement_product" });

    const jobId = await seedJob({
      csv: csvOf([
        'user_ent_1,app_store,entitlement_product,txn_ent_1,2026-01-01 00:00:00,false,,"[""pro"",""gold""]"',
        'user_ent_2,app_store,entitlement_product,txn_ent_2,2026-01-01 00:00:00,false,,"{pro,gold}"',
        "user_ent_3,app_store,entitlement_product,txn_ent_3,2026-01-01 00:00:00,false,,pro;gold",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.entitlementShapeCounts).toEqual({
      json_array: 1,
      curly_braces: 1,
      semicolon_delimited: 1,
    });
  });
});
