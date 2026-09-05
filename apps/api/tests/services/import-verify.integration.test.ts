import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import {
  PurchaseStatus,
  db,
  drizzle,
  access,
  products,
  projects,
  purchases,
  subscriberAccess,
  subscribers,
} from "@rovenue/db";
import { buildCanonicalRow } from "../../src/services/import/plan";

// Reaching into packages/db/src by relative path (as this file previously
// did) resolves fine at runtime via vitest, but pulls those files outside
// this package's tsconfig rootDir under static typecheck (TS6059) — go
// through the published @rovenue/db barrel instead, same as the rest of
// this suite.
const importJobRepo = drizzle.importJobRepo;
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
/** Before "now" (this session's clock is 2026-08-31) but still a normal
 *  post-purchase date — Phase A derives EXPIRED from this, the same way
 *  a real historical, already-lapsed subscription would import. */
const PAST_EXPIRY = "2026-02-01 00:00:00";

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

/** FIX 1: subscriber_access is the table that actually decides whether a
 *  customer gets access — never written directly, only by syncAccess. */
async function findAccessRow(subscriberId: string) {
  const rows = await db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.accessId, ACCESS_ID),
      ),
    );
  return rows[0] ?? null;
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

// =============================================================
// Final-fix-wave FIX 4 — a per-anchor store failure never aborts the
// whole run
// =============================================================
//
// verify-store-clients.ts's per-store clients throw synchronously for a
// condition this module never modelled as notFound/throttled — most
// commonly, `requireConnectedStripe`/the Apple/Google credential loaders
// throwing because the project has no credentials connected for that
// store yet, a very likely mid-migration state. Before this fix, that
// throw escaped straight out of `verifyWithPacing`'s `Promise.all` and
// aborted verification for EVERY anchor in the call — including anchors
// for stores that ARE fully configured.

describe("verifyImportedAnchors — a per-anchor store failure degrades only that anchor (final-fix-wave FIX 4)", () => {
  it("a Stripe anchor with no credentials connected does not stop an Apple anchor in the SAME run from verifying", async () => {
    const appleSubscriberId = `rc_verify_unverifiable_apple_${createId()}`;
    const appleAnchor = `apple_orig_unverifiable_${createId()}`;
    const stripeSubscriberId = `rc_verify_unverifiable_stripe_${createId()}`;
    const csv = csvOf([
      {
        subscriberId: appleSubscriberId,
        storeTxnId: `${appleAnchor}_txn_1`,
        originalTransactionId: appleAnchor,
        priceUsd: "9.99",
      },
      {
        subscriberId: stripeSubscriberId,
        store: "stripe",
        storeTxnId: `stripe_txn_unverifiable_1`,
        stripeSubscriptionId: "sub_unverifiable_1",
        priceUsd: "19.99",
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    expect(await findPurchases()).toHaveLength(2);

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
      // Mirrors requireConnectedStripe's real behaviour for a project
      // with no Stripe credentials configured: throws, rather than
      // returning a modelled notFound/throttled result.
      verifyStripeAnchor: vi.fn(async () => {
        throw new Error("requireConnectedStripe: project has no connected Stripe account");
      }),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    // The run did not throw, and it inspected BOTH anchors.
    expect(summary.anchorsTotal).toBe(2);
    expect(summary.anchorsVerified).toBe(1);
    expect(summary.anchorsUnverifiable).toBe(1);
    // Not a definitive answer from the store — must not claim COMPLETED.
    expect(summary.status).toBe("VERIFICATION_INCOMPLETE");

    const purchases = await findPurchases();
    const applePurchase = purchases.find((p) => p.storeTransactionId === `${appleAnchor}_txn_1`);
    const stripePurchase = purchases.find((p) => p.storeTransactionId === "stripe_txn_unverifiable_1");

    // The configured store's anchor verified normally.
    expect(applePurchase!.verifiedAt).not.toBeNull();
    expect(applePurchase!.status).toBe(PurchaseStatus.ACTIVE);

    // The unconfigured store's row stays exactly as Phase A left it:
    // history, never deleted, never marked verified.
    expect(stripePurchase).toBeDefined();
    expect(stripePurchase!.verifiedAt).toBeNull();
  });
});

// =============================================================
// Final-fix-wave FIX 5 — a Stripe anchor that isn't a subscription id
// is never sent to the store
// =============================================================
//
// The RevenueCat Transactions preset has no stripe_subscription_id
// column, so the anchor falls back to storeTransactionId — for Stripe,
// an invoice/charge id (in_…/ch_…), never a sub_… id.
// `subscriptions.retrieve()` would 404 on it every time; that 404 gets
// mapped to `notFound`, silently claiming Stripe gave a definitive
// answer it never had the chance to give. This must be recognised BEFORE
// any store call is made.

describe("verifyImportedAnchors — a Stripe row with no recognisable subscription id (final-fix-wave FIX 5)", () => {
  it("never calls verifyStripeAnchor, and reports the row unverifiable", async () => {
    const subscriberId = `rc_verify_stripe_bad_anchor_${createId()}`;
    const csv = csvOf([
      {
        subscriberId,
        store: "stripe",
        // Shaped like a Stripe INVOICE id, never a subscription id —
        // exactly what storeTransactionId looks like on the RC preset.
        storeTxnId: "in_1AbCdEfGhIjKlMnO",
        priceUsd: "19.99",
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [before] = await findPurchases();

    const deps = fakeDeps();
    const summary = await verifyImportedAnchors(jobId, deps);

    expect(deps.verifyStripeAnchor).not.toHaveBeenCalled();
    expect(summary.anchorsTotal).toBe(0); // never entered the anchor map at all
    expect(summary.anchorsUnverifiable).toBe(1);
    expect(summary.status).toBe("VERIFICATION_INCOMPLETE");

    const [after] = await findPurchases();
    expect(after!.id).toBe(before!.id);
    expect(after!.verifiedAt).toBeNull();
  });

  it("a well-formed sub_… anchor IS sent to the store normally", async () => {
    const subscriberId = `rc_verify_stripe_good_anchor_${createId()}`;
    const csv = csvOf([
      {
        subscriberId,
        store: "stripe",
        storeTxnId: "in_good_1",
        stripeSubscriptionId: "sub_good_1",
        priceUsd: "19.99",
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);

    const deps = fakeDeps({
      verifyStripeAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
    });
    const summary = await verifyImportedAnchors(jobId, deps);

    expect(deps.verifyStripeAnchor).toHaveBeenCalledTimes(1);
    expect(summary.anchorsUnverifiable).toBe(0);
    expect(summary.status).toBe("COMPLETED");
  });
});

// =============================================================
// Fix round 1, FIX 1 (Critical) — subscriber_access actually moves
// =============================================================
//
// applyVerifiedResult only ever touched `purchases`; subscriber_access is
// pure derived state that only `syncAccess` recomputes (write.ts's own
// rule 5). Both directions matter: the store upgrading an expired-looking
// row to ACTIVE must actually grant access, and the store downgrading an
// active-looking row must actually revoke it — access-engine.ts flips
// `isActive`, it never deletes the row.

describe("verifyImportedAnchors — subscriber_access moves in both directions", () => {
  it("store says ACTIVE, file said expired: an access row appears", async () => {
    const subscriberId = `rc_verify_access_up_${createId()}`;
    const anchor = `apple_orig_access_up_${createId()}`;
    const csv = csvOf([
      {
        subscriberId,
        storeTxnId: `${anchor}_txn_1`,
        originalTransactionId: anchor,
        priceUsd: "9.99",
        expiresDate: PAST_EXPIRY,
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [purchaseBefore] = await findPurchases();
    expect(purchaseBefore!.status).toBe(PurchaseStatus.EXPIRED);
    expect(await findAccessRow(purchaseBefore!.subscriberId)).toBeNull();

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
    });
    await verifyImportedAnchors(jobId, deps);

    const [purchaseAfter] = await findPurchases();
    expect(purchaseAfter!.status).toBe(PurchaseStatus.ACTIVE);
    const accessRow = await findAccessRow(purchaseAfter!.subscriberId);
    expect(accessRow).not.toBeNull();
    expect(accessRow!.isActive).toBe(true);
  });

  it("store says EXPIRED, file said active: the access row is deactivated", async () => {
    const subscriberId = `rc_verify_access_down_${createId()}`;
    const anchor = `apple_orig_access_down_${createId()}`;
    const csv = csvOf([
      {
        subscriberId,
        storeTxnId: `${anchor}_txn_1`,
        originalTransactionId: anchor,
        priceUsd: "9.99",
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [purchaseBefore] = await findPurchases();
    expect(purchaseBefore!.status).toBe(PurchaseStatus.ACTIVE);
    const accessBefore = await findAccessRow(purchaseBefore!.subscriberId);
    expect(accessBefore).not.toBeNull();
    expect(accessBefore!.isActive).toBe(true);

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.EXPIRED,
        expiresDate: new Date(PAST_EXPIRY),
        autoRenewStatus: false,
      })),
    });
    await verifyImportedAnchors(jobId, deps);

    // This is the failure that does NOT self-heal: expiry-checker only
    // sweeps ACTIVE|TRIAL|GRACE_PERIOD, and this purchase just left that
    // set — if syncAccess weren't called here, the access row would keep
    // granting paid access forever.
    const accessAfter = await findAccessRow(purchaseBefore!.subscriberId);
    expect(accessAfter).not.toBeNull(); // deactivated, never deleted.
    expect(accessAfter!.id).toBe(accessBefore!.id);
    expect(accessAfter!.isActive).toBe(false);
  });
});

// =============================================================
// Fix round 1, FIX 4 — run-level give-up and cancellation
// =============================================================

describe("verifyImportedAnchors — run-level give-up on sustained throttling", () => {
  it("stops dispatching new store calls once the run-level throttle budget is exhausted", async () => {
    const ANCHOR_COUNT = 12; // > RUN_GIVE_UP_CONSECUTIVE_THROTTLES (10)
    const rows: SourceRow[] = Array.from({ length: ANCHOR_COUNT }, (_, i) => ({
      subscriberId: `rc_verify_giveup_${i}_${createId()}`,
      storeTxnId: `apple_giveup_${i}_${createId()}`,
      originalTransactionId: `apple_giveup_orig_${i}_${createId()}`,
      priceUsd: "9.99",
    }));
    const jobId = await seedCompletedPhaseA(csvOf(rows));
    expect(await findPurchases()).toHaveLength(ANCHOR_COUNT);

    let callCount = 0;
    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => {
        callCount++;
        return { kind: "throttled" as const };
      }),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.status).toBe("VERIFICATION_INCOMPLETE");
    expect(summary.anchorsPending).toBe(ANCHOR_COUNT);
    // Without a run-level give-up, every one of the 12 anchors would burn
    // its own full 5-attempt budget (60 calls). The give-up fires after
    // 10 consecutive throttles, well short of that.
    expect(callCount).toBeLessThan(ANCHOR_COUNT * 5);
  });
});

describe("verifyImportedAnchors — respects an operator's Cancel", () => {
  it("makes no store calls and leaves the job CANCELLED when it is already cancelled", async () => {
    const subscriberId = `rc_verify_cancel_${createId()}`;
    const anchor = `apple_orig_cancel_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, { status: "CANCELLED" });

    const deps = fakeDeps(); // every verify*Anchor throws if called at all.

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.status).toBe("CANCELLED");
    expect(deps.verifyAppleAnchor).not.toHaveBeenCalled();
    const jobRow = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(jobRow!.status).toBe("CANCELLED");
  });
});

// =============================================================
// Fix round 1, FIX 6 — notFound/pending counters do not inflate
// =============================================================

describe("verifyImportedAnchors — counters reflect current state, not an accumulating total", () => {
  it("re-running against a still-not-found anchor does not double the notFound counter", async () => {
    const subscriberId = `rc_verify_counter_${createId()}`;
    const anchor = `apple_orig_counter_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);

    const notFoundDeps = () =>
      fakeDeps({ verifyAppleAnchor: vi.fn(async () => ({ kind: "notFound" as const })) });

    await verifyImportedAnchors(jobId, notFoundDeps());
    const jobAfterFirst = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(jobAfterFirst!.counters.verifyAnchorNotFound).toBe(1);

    await verifyImportedAnchors(jobId, notFoundDeps());
    const jobAfterSecond = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    // Not 2: notFound is never checkpointed, so every call re-discovers
    // the SAME anchor — the counter reports current state, not a running
    // total across resumed attempts.
    expect(jobAfterSecond!.counters.verifyAnchorNotFound).toBe(1);
  });
});

// =============================================================
// Fix round 2, FIX B — the anchor cap, and genuine resume progress
// =============================================================

describe("verifyImportedAnchors — bounded anchor map (maxAnchorsPerRun)", () => {
  it("reports verification incomplete when the cap is reached, even though the capped subset itself resolved cleanly", async () => {
    const anchors = Array.from({ length: 3 }, () => `apple_orig_cap_${createId()}`);
    const rows: SourceRow[] = anchors.map((anchor, i) => ({
      subscriberId: `rc_verify_cap_${i}_${createId()}`,
      storeTxnId: `${anchor}_txn`,
      originalTransactionId: anchor,
      priceUsd: "9.99",
    }));
    const jobId = await seedCompletedPhaseA(csvOf(rows));
    expect(await findPurchases()).toHaveLength(3);

    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
      maxAnchorsPerRun: 2, // strictly less than the 3 distinct anchors in the file.
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.anchorCapReached).toBe(true);
    expect(summary.anchorsTotal).toBe(2); // only the capped subset was inspected.
    expect(summary.anchorsPending).toBe(0); // the two it DID inspect both verified fine...
    expect(summary.status).toBe("VERIFICATION_INCOMPLETE"); // ...but the cap still forces incomplete.
    expect(deps.verifyAppleAnchor).toHaveBeenCalledTimes(2);

    const jobRow = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(jobRow!.status).toBe("VERIFICATION_INCOMPLETE");
  });

  it("a resumed call makes genuine progress: it does NOT re-discover the same capped anchors forever", async () => {
    const anchors = Array.from({ length: 4 }, () => `apple_orig_progress_${createId()}`);
    const rows: SourceRow[] = anchors.map((anchor, i) => ({
      subscriberId: `rc_verify_progress_${i}_${createId()}`,
      storeTxnId: `${anchor}_txn`,
      originalTransactionId: anchor,
      priceUsd: "9.99",
    }));
    const jobId = await seedCompletedPhaseA(csvOf(rows));

    const verifiedResult = {
      kind: "verified" as const,
      status: PurchaseStatus.ACTIVE,
      expiresDate: new Date(FUTURE_EXPIRY),
      autoRenewStatus: true,
    };

    // First call: cap of 2 out of 4 distinct anchors.
    const firstCalledAnchors: string[] = [];
    const firstDeps = fakeDeps({
      verifyAppleAnchor: vi.fn(async (input) => {
        firstCalledAnchors.push(input.originalTransactionId);
        return verifiedResult;
      }),
      maxAnchorsPerRun: 2,
    });
    const first = await verifyImportedAnchors(jobId, firstDeps);
    expect(first.anchorCapReached).toBe(true);
    expect(first.status).toBe("VERIFICATION_INCOMPLETE");
    expect(firstCalledAnchors).toHaveLength(2);
    expect(new Set(firstCalledAnchors).size).toBe(2); // two DISTINCT anchors, not one twice.

    // Second call, same cap: must process the OTHER two anchors, not
    // re-verify (or even re-inspect) the first two — genuine progress,
    // not "the same first N anchors forever".
    const secondCalledAnchors: string[] = [];
    const secondDeps = fakeDeps({
      verifyAppleAnchor: vi.fn(async (input) => {
        secondCalledAnchors.push(input.originalTransactionId);
        return verifiedResult;
      }),
      maxAnchorsPerRun: 2,
    });
    const second = await verifyImportedAnchors(jobId, secondDeps);

    expect(secondCalledAnchors).toHaveLength(2);
    expect(new Set(secondCalledAnchors).size).toBe(2);
    // No overlap with the first call's anchors — real forward progress.
    for (const anchor of secondCalledAnchors) {
      expect(firstCalledAnchors).not.toContain(anchor);
    }
    // All 4 anchors are now covered, so this call is NOT capped anymore.
    expect(second.anchorCapReached).toBe(false);
    expect(second.status).toBe("COMPLETED");

    const verifiedRows = await findPurchases();
    expect(verifiedRows.every((p) => p.verifiedAt !== null)).toBe(true);
    expect(verifiedRows).toHaveLength(4);
  });
});

// =============================================================
// Fix round 2, FIX C — a deterministic mid-run cancellation seam
// =============================================================

describe("verifyImportedAnchors — cancellation discovered mid-run (deps.isCancelled seam)", () => {
  it("stops calling the store once cancellation is discovered between anchors, and reports cancelled", async () => {
    const anchor1 = `apple_orig_midcancel_1_${createId()}`;
    const anchor2 = `apple_orig_midcancel_2_${createId()}`;
    const csv = csvOf([
      {
        subscriberId: `rc_midcancel_a_${createId()}`,
        storeTxnId: `${anchor1}_txn`,
        originalTransactionId: anchor1,
        priceUsd: "9.99",
      },
      {
        subscriberId: `rc_midcancel_b_${createId()}`,
        storeTxnId: `${anchor2}_txn`,
        originalTransactionId: anchor2,
        priceUsd: "9.99",
      },
    ]);
    const jobId = await seedCompletedPhaseA(csv);

    let checkCount = 0;
    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE,
        expiresDate: new Date(FUTURE_EXPIRY),
        autoRenewStatus: true,
      })),
      // Deterministic seam (fix round 2, FIX C): the FIRST anchor's check
      // sees "not cancelled yet"; every check after that sees the
      // operator's Cancel having landed in the meantime — and actually
      // performs it, so the persisted job status is genuinely CANCELLED,
      // not just an in-memory flag this test invented.
      isCancelled: vi.fn(async () => {
        checkCount++;
        if (checkCount === 1) return false;
        await importJobRepo.setImportJobStatus(db, PROJECT_ID, jobId, {
          status: "CANCELLED",
        });
        return true;
      }),
    });

    const summary = await verifyImportedAnchors(jobId, deps);

    expect(summary.status).toBe("CANCELLED");
    // Exactly one anchor got through before cancellation was discovered.
    expect(deps.verifyAppleAnchor).toHaveBeenCalledTimes(1);

    const jobRow = await importJobRepo.getImportJob(db, PROJECT_ID, jobId);
    expect(jobRow!.status).toBe("CANCELLED");
  });
});

// =============================================================
// Fix round 2, FIX D — the quiet ACTIVE→ACTIVE later-expiry case
// =============================================================

describe("verifyImportedAnchors — ACTIVE stays ACTIVE but the live expiry is later", () => {
  it("moves the access row's expiry forward even though status never changed", async () => {
    const subscriberId = `rc_verify_later_expiry_${createId()}`;
    const anchor = `apple_orig_later_expiry_${createId()}`;
    const csv = csvOf([
      { subscriberId, storeTxnId: `${anchor}_txn_1`, originalTransactionId: anchor, priceUsd: "9.99" },
    ]);
    const jobId = await seedCompletedPhaseA(csv);
    const [purchaseBefore] = await findPurchases();
    expect(purchaseBefore!.status).toBe(PurchaseStatus.ACTIVE);
    const accessBefore = await findAccessRow(purchaseBefore!.subscriberId);
    expect(accessBefore).not.toBeNull();
    // Compare against the purchase's OWN persisted expiresDate (not a
    // re-parse of the source string) — avoids a timezone-parsing mismatch
    // between this test's Date construction and the app's CSV parser.
    expect(accessBefore!.expiresDate?.toISOString()).toBe(
      purchaseBefore!.expiresDate?.toISOString(),
    );

    const laterExpiry = new Date("2030-06-01T00:00:00.000Z");
    const deps = fakeDeps({
      verifyAppleAnchor: vi.fn(async () => ({
        kind: "verified" as const,
        status: PurchaseStatus.ACTIVE, // same status both sides — the quiet case.
        expiresDate: laterExpiry,
        autoRenewStatus: true,
      })),
    });

    await verifyImportedAnchors(jobId, deps);

    const [purchaseAfter] = await findPurchases();
    expect(purchaseAfter!.status).toBe(PurchaseStatus.ACTIVE);
    expect(purchaseAfter!.expiresDate?.toISOString()).toBe(laterExpiry.toISOString());

    // The quiet failure mode this test exists for: both sides "look"
    // active, so nothing SIGNALS a problem if the access row is never
    // actually moved off the stale imported date.
    const accessAfter = await findAccessRow(purchaseAfter!.subscriberId);
    expect(accessAfter).not.toBeNull();
    expect(accessAfter!.id).toBe(accessBefore!.id); // same row, updated in place.
    expect(accessAfter!.expiresDate?.toISOString()).toBe(laterExpiry.toISOString());
  });
});
