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
import { monthStartsUtc } from "../../../../packages/db/src/drizzle/repositories/revenue-event-partitions";

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
function readReportRows(storageKey: string): Array<Record<string, unknown>> {
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
