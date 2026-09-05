import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  db,
  drizzle,
  projects,
  products,
  purchases,
  subscribers,
  revenueEvents,
  monthStartsUtc,
} from "@rovenue/db";

// Reaching into packages/db/src by relative path (as this file previously
// did) resolves fine at runtime via vitest, but pulls those files outside
// this package's tsconfig rootDir under static typecheck (TS6059) — go
// through the published @rovenue/db barrel instead, same as the rest of
// this suite.
const importJobRepo = drizzle.importJobRepo;

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

import { planImport, createDuplicateTracker, isDuplicateAndTrack } from "../../src/services/import/plan";

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

/** Reads a report artefact back out of the fake object store and parses
 *  its NDJSON lines, for tests that need to check the actual `reason`
 *  text a row was reported with (fix round 1: "product not found" and
 *  "product ambiguous" must stay distinguishable). */
function readReportRows(storageKey: string | null): Array<Record<string, unknown>> {
  // planImport's real return type carries `reportStorageKey: string | null`
  // (null on the early-exit paths that never open a report writer) — every
  // caller here passes a summary from a run expected to have written one,
  // so a null is itself the failure worth surfacing, same as the missing-
  // object guard just below.
  if (storageKey === null) {
    throw new Error("summary.reportStorageKey is null; no report was written");
  }
  const buf = fakeObjects.get(storageKey);
  if (!buf) throw new Error(`no report object stored for key ${storageKey}`);
  return buf
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  it("classifies a row missing a required field (productIdentifier) as invalidRow", async () => {
    const jobId = await seedJob({
      csv: csvOf([
        "user_invalid,app_store,,txn_invalid,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.invalidRow).toBe(1);
    const reportRows = readReportRows(summary.reportStorageKey);
    expect(reportRows[0]?.outcome).toBe("invalidRow");
    expect(reportRows[0]?.reason).toMatch(/Product identifier/);
  });

  // ===========================================================
  // Fix round 1, FIX 1 — product resolution fails closed
  // ===========================================================

  it("reports unresolvedProduct with an AMBIGUOUS reason when two catalog products share a Stripe parent id", async () => {
    // Two distinct plans built on the same underlying Stripe Product,
    // misconfigured so BOTH hold the coarser prod_ id under storeIds.stripe
    // (a real operator mistake this design must never silently pick a
    // side on).
    await seedProduct("stripe_monthly_ambiguous", { stripe: "prod_shared_ambiguous" });
    await seedProduct("stripe_annual_ambiguous", { stripe: "prod_shared_ambiguous" });

    const beforeCount = (
      await db.select().from(purchases).where(eq(purchases.projectId, PROJECT_ID))
    ).length;

    const jobId = await seedJob({
      csv: csvOf([
        "user_ambiguous,stripe,prod_shared_ambiguous,txn_ambiguous,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.unresolvedProduct).toBe(1);
    expect(summary.outcomes.willCreate).toBe(0);
    const reportRows = readReportRows(summary.reportStorageKey);
    expect(reportRows[0]?.reason).toMatch(/ambiguous/i);
    expect(reportRows[0]?.reason).toContain("2 catalog products");

    const afterCount = (
      await db.select().from(purchases).where(eq(purchases.projectId, PROJECT_ID))
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("does NOT let a store-shaped identifier (price_.../prod_...) resolve through the products.identifier fallback", async () => {
    // A catalog product whose CANONICAL identifier happens to be a string
    // shaped like a Stripe id — no storeIds.stripe mapping at all, so a
    // pre-fix resolver would only reach it via the identifier fallback.
    await seedProduct("price_coincidental_shape", {});

    const jobId = await seedJob({
      csv: csvOf([
        "user_gate,stripe,price_coincidental_shape,txn_gate,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.unresolvedProduct).toBe(1);
    expect(summary.outcomes.willCreate).toBe(0);
    const reportRows = readReportRows(summary.reportStorageKey);
    expect(reportRows[0]?.reason).toMatch(/product not found/i);
    expect(reportRows[0]?.reason).not.toMatch(/ambiguous/i);
  });

  it("still resolves a genuinely custom (non-store-shaped) Stripe product_identifier through the identifier fallback", async () => {
    // Regression guard: the fallback gate must only block STORE-SHAPED
    // values, not the legitimate custom-string case the two-step design
    // exists for.
    await seedProduct("custom_slug_pro", {});

    const jobId = await seedJob({
      csv: csvOf([
        "user_custom_slug,stripe,custom_slug_pro,txn_custom_slug,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.willCreate).toBe(1);
    expect(summary.outcomes.unresolvedProduct).toBe(0);
  });

  it("reports duplicateTrackingDisabledAfterKeys as null for an ordinary run under the cap", async () => {
    await seedProduct("tracking_ok_product", { apple: "tracking_ok_product" });

    const jobId = await seedJob({
      csv: csvOf([
        "user_tracking_ok,app_store,tracking_ok_product,txn_tracking_ok,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.duplicateTrackingDisabledAfterKeys).toBeNull();
  });

  // ===========================================================
  // Task 8a — the dry run surfaces the partition-provisioning span
  // ===========================================================

  it("reports the observed event date range and the partition span provisioning would need", async () => {
    await seedProduct("span_product", { apple: "span_product" });

    const jobId = await seedJob({
      csv: csvOf([
        // Deliberately predates revenue_events' existing partition floor
        // (2024-01, migration 0015) — this is the exact case task 8a's
        // ruling exists for: the operator must see this BEFORE committing.
        "user_span_1,app_store,span_product,txn_span_1,2019-06-15 00:00:00,false,,",
        "user_span_2,app_store,span_product,txn_span_2,2026-01-10 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.observedEventDateRange).toEqual({
      min: new Date("2019-06-15T00:00:00Z").toISOString(),
      max: new Date("2026-01-10T00:00:00Z").toISOString(),
    });
    expect(summary.requiredPartitionSpan).not.toBeNull();
    expect(summary.requiredPartitionSpan?.fromMonth).toBe("2019-06");
    expect(summary.requiredPartitionSpan?.toMonth).toBe("2026-01");
    // Cross-checked against the same month-math helper
    // ensureRevenueEventPartitions itself uses (independently unit-tested
    // in packages/db/tests/revenue-event-partitions.test.ts) — this test's
    // own job is proving plan.ts tracks min/max from the file and wires
    // them through, not re-proving the month arithmetic.
    expect(summary.requiredPartitionSpan?.monthCount).toBe(
      monthStartsUtc(
        new Date("2019-06-15T00:00:00Z"),
        new Date("2026-01-10T00:00:00Z"),
      ).length,
    );
  });

  it("reports a null observed range and null partition span when no row has a normalizable date", async () => {
    const jobId = await seedJob({
      // Missing productIdentifier -> invalidRow before a date is ever
      // parsed, so this file has zero rows with a usable eventDate.
      csv: csvOf([
        "user_no_date,app_store,,txn_no_date,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);

    expect(summary.outcomes.invalidRow).toBe(1);
    expect(summary.observedEventDateRange).toBeNull();
    expect(summary.requiredPartitionSpan).toBeNull();
  });

  // ===========================================================
  // Final-fix-wave FIX 3 — dry-run counters never accumulate, and never
  // collide with the commit run's own counter keys
  // ===========================================================
  //
  // Before this fix, `planImport` persisted its outcome counts through
  // `incrementImportJobCounters` — additive — into the SAME
  // `import_jobs.counters` keys the commit run (workers/import-runner.ts)
  // also increments. A re-run of the dry run (e.g. after fixing the
  // mapping) doubled its own previous count; a dry-run-then-commit on N
  // rows left `willCreate` reading ≈2N.

  it("does not accumulate on a second dry-run attempt for the same job", async () => {
    await seedProduct("refresh_product", { apple: "refresh_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_refresh,app_store,refresh_product,txn_refresh,2026-01-01 00:00:00,false,,",
      ]),
    });

    const first = await planImport(jobId);
    expect(first.outcomes.willCreate).toBe(1);

    const second = await planImport(jobId);
    expect(second.outcomes.willCreate).toBe(1); // NOT 2 — overwritten, not added.

    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect((persisted!.counters as Record<string, number>).dryRun_willCreate).toBe(1);
  });

  it("persists under a dryRun_-prefixed key, never the commit run's plain outcome key", async () => {
    await seedProduct("namespace_product", { apple: "namespace_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_namespace,app_store,namespace_product,txn_namespace,2026-01-01 00:00:00,false,,",
      ]),
    });

    await planImport(jobId);

    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    const counters = persisted!.counters as Record<string, number>;
    expect(counters.dryRun_willCreate).toBe(1);
    // The plain key is the commit run's own namespace (import-runner.ts)
    // — a dry run that never committed anything must leave it untouched,
    // so a later commit starts its additive count from zero, not from
    // whatever the dry run happened to see.
    expect(counters.willCreate).toBeUndefined();
  });
});

// =================================================================
// Final-fix-wave minor fix — planImport notices an operator's /cancel
// =================================================================
//
// Before this fix, planImport never checked cancellation at all: /cancel
// on a DRY_RUN_RUNNING job wrote CANCELLED immediately, but the
// still-running scan clobbered it moments later with its own
// unconditional DRY_RUN_COMPLETE write. `isCancelled` is a test-only seam
// (mirrors verify.ts's own `deps.isCancelled`) so this doesn't need a
// real 2-second wall-clock wait to prove.

describe("planImport — notices cancellation mid-scan (final-fix-wave minor fix)", () => {
  it("stops scanning and never reaches DRY_RUN_COMPLETE or touches counters/summary once cancellation is noticed", async () => {
    await seedProduct("cancel_product", { apple: "cancel_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_cancel_1,app_store,cancel_product,txn_cancel_1,2026-01-01 00:00:00,false,,",
        "user_cancel_2,app_store,cancel_product,txn_cancel_2,2026-01-01 00:00:00,false,,",
      ]),
    });

    // Simulates an operator's /cancel landing on the DB while this scan
    // is mid-flight — that write is the real route's job, not this
    // test's; here it's stood in for by the injected predicate so the
    // scenario doesn't need a real, concurrent /cancel request.
    const summary = await planImport(jobId, { isCancelled: async () => true });

    expect(summary.cancelled).toBe(true);
    expect(summary.reportStorageKey).toBeNull();
    expect(summary.totalRows).toBe(0); // stopped before ever counting the first row

    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    // The bug this fixes: an unconditional DRY_RUN_COMPLETE write here
    // would have clobbered whatever a real /cancel had just set.
    expect(persisted!.status).not.toBe("DRY_RUN_COMPLETE");
    expect(persisted!.counters).toEqual({});
    expect(persisted!.dryRunSummary).toBeNull();
  });

  it("does not cancel when isCancelled reports false — a normal run still completes", async () => {
    await seedProduct("nocancel_product", { apple: "nocancel_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_nocancel_1,app_store,nocancel_product,txn_nocancel_1,2026-01-01 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId, { isCancelled: async () => false });

    expect(summary.cancelled).toBe(false);
    expect(summary.outcomes.willCreate).toBe(1);

    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(persisted!.status).toBe("DRY_RUN_COMPLETE");
  });
});

// =================================================================
// Final-fix-wave FIX 7 — the dry run's disclosures are persisted
// =================================================================
//
// entitlementShapeCounts/duplicateTrackingDisabledAfterKeys/
// observedEventDateRange/requiredPartitionSpan were all computed and
// returned by planImport, but that return value's only consumer was
// BullMQ's returnvalue, which nothing reads. This proves they now land
// on the job row itself, not just in the (still correct, still tested
// above) in-memory return value.

describe("planImport — persists its disclosures (final-fix-wave FIX 7)", () => {
  it("persists observedEventDateRange/requiredPartitionSpan/entitlementShapeCounts onto the job row", async () => {
    await seedProduct("disclosed_product", { apple: "disclosed_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_disclosed_1,app_store,disclosed_product,txn_disclosed_1,2019-06-15 00:00:00,false,,[a]",
        "user_disclosed_2,app_store,disclosed_product,txn_disclosed_2,2026-01-10 00:00:00,false,,",
      ]),
    });

    const summary = await planImport(jobId);
    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    const dryRunSummary = persisted!.dryRunSummary as {
      entitlementShapeCounts: Record<string, number>;
      duplicateTrackingDisabledAfterKeys: number | null;
      observedEventDateRange: { min: string; max: string } | null;
      requiredPartitionSpan: { fromMonth: string; toMonth: string; monthCount: number } | null;
    };

    expect(dryRunSummary.observedEventDateRange).toEqual(summary.observedEventDateRange);
    expect(dryRunSummary.requiredPartitionSpan).toEqual(summary.requiredPartitionSpan);
    expect(dryRunSummary.entitlementShapeCounts).toEqual(summary.entitlementShapeCounts);
    expect(dryRunSummary.duplicateTrackingDisabledAfterKeys).toBe(
      summary.duplicateTrackingDisabledAfterKeys,
    );
  });

  it("overwrites (never merges) a previous attempt's disclosures on a re-run", async () => {
    await seedProduct("redisclosed_product", { apple: "redisclosed_product" });
    const jobId = await seedJob({
      csv: csvOf([
        "user_redisclosed_1,app_store,redisclosed_product,txn_redisclosed_1,2019-06-15 00:00:00,false,,[a]",
      ]),
    });

    await planImport(jobId);

    // A mapping fix that removes the entitlements column entirely for a
    // re-run — the second attempt's disclosures must fully replace the
    // first's, not merge stale shape counts into empty new ones.
    const jobId2 = await seedJob({
      csv: csvOf(["user_redisclosed_2,app_store,redisclosed_product,txn_redisclosed_2,2026-01-10 00:00:00,false,,"]),
    });
    await planImport(jobId2);

    const persisted = await importJobRepo.getImportJob(db, PROJECT_ID, jobId2);
    const dryRunSummary = persisted!.dryRunSummary as {
      entitlementShapeCounts: Record<string, number>;
    };
    expect(dryRunSummary.entitlementShapeCounts).toEqual({});
  });
});

// =================================================================
// Fix round 1, FIX 2 — bounded duplicate-key tracking
// =================================================================
//
// Unit-level, not planImport-level: proving the real cap
// (IMPORT_DUPLICATE_TRACKING_MAX_KEYS, ~2,000,000) via a real CSV/DB run
// would mean generating millions of rows, which the throttle rule this
// task operates under rules out. The cap is injected into
// `isDuplicateAndTrack` as a plain parameter specifically so its
// bounding behavior is exercised here, fast and deterministically, with
// a tiny cap standing in for the real one — planImport always calls it
// with the real named constant (see plan.ts).
describe("isDuplicateAndTrack / createDuplicateTracker", () => {
  it("flags an exact repeat of an already-tracked key", () => {
    const tracker = createDuplicateTracker();
    expect(isDuplicateAndTrack(tracker, "a", 10)).toBe(false);
    expect(isDuplicateAndTrack(tracker, "a", 10)).toBe(true);
    expect(tracker.disabledAfterKeys).toBeNull();
  });

  it("stops tracking new keys past the cap without ever falsely flagging one as a duplicate", () => {
    const tracker = createDuplicateTracker();
    const cap = 2;

    expect(isDuplicateAndTrack(tracker, "k1", cap)).toBe(false);
    expect(isDuplicateAndTrack(tracker, "k2", cap)).toBe(false);
    expect(tracker.disabledAfterKeys).toBeNull();

    // Cap reached (2 keys tracked). A brand-new third key is left
    // untracked — and, critically, NOT flagged as a duplicate.
    expect(isDuplicateAndTrack(tracker, "k3", cap)).toBe(false);
    expect(tracker.disabledAfterKeys).toBe(cap);

    // Repeating that untracked key still never produces a false positive.
    expect(isDuplicateAndTrack(tracker, "k3", cap)).toBe(false);

    // A key captured BEFORE the cap was hit is still correctly detected.
    expect(isDuplicateAndTrack(tracker, "k1", cap)).toBe(true);
  });
});
