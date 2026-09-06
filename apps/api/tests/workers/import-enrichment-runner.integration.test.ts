import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, drizzle, purchases, subscribers } from "@rovenue/db";
import {
  IMPORT_ENRICHMENT_MAX_ROWS,
  REVENUECAT_GOOGLE_TOKEN_PRESET_ID,
  detectPreset,
  type CanonicalField,
} from "@rovenue/shared";

// =============================================================
// The Google purchase-token second pass — the run
// =============================================================
//
// Runs against the real per-worker Postgres (tests/global-setup.ts).
// Object storage is faked with an in-memory Map, the same shape
// import-runner.integration.test.ts uses — the subject here is what
// lands in `purchases`, not S3.
//
// Every purchase row is written by the REAL history importer through
// `seedHistoryImport` (see that helper's own comment for why nothing
// inserts into `purchases` directly): the resolver groups on
// `originalTransactionId`, a value write.ts MINTS, and the whole
// `enrichUngroupedChains` opt-in exists because of what write.ts's NOT
// NULL fallback does to a file with no original-transaction column. A
// hand-inserted fixture could satisfy this pass with a row shape
// production never emits.
//
// What each test is actually defending:
//
//   1. A dry run writes nothing. It is the operator's only chance to
//      see the plan before it is executed.
//   2. A commit writes the token to EVERY row of the chain — a Play
//      purchaseToken identifies a subscription across its renewals.
//   3. Re-running the same file writes nothing (idempotence).
//   4. `ungroupedChains` carries `purchaseIds` describing what the
//      opt-in WOULD enrich. A writer that treated that payload as a
//      write instruction would write exactly the set the option exists
//      to gate. THE OUTCOME NAME IS THE GATE.
//   5. The opt-in relaxes GROUPING, never OVERWRITING: a stored token
//      that disagrees with the file is never replaced under any setting.
//   6. A GDPR-erased subscriber's purchase rows are never written to.
//   7. The tokens the pass writes are handed to Phase B — otherwise
//      this whole feature writes a column nothing reads.

const fakeObjects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../../src/lib/import-store", () => ({
  isStorageConfigured: () => true,
  buildStorageKey: (projectId: string, jobId: string, fileName: string) =>
    `imports/${projectId}/${jobId}/${fileName}`,
  buildReportStorageKey: (projectId: string, jobId: string) =>
    `imports/${projectId}/${jobId}/report.ndjson`,
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

import { runEnrichmentJob } from "../../src/services/import/enrich-run";
import type { ImportVerifyDeps } from "../../src/services/import/verify";
import { seedHistoryImport, type SeededChain } from "../helpers/seed-history-import";

/** Phase B fake that gives a definitive "the store doesn't know it"
 *  answer for every anchor — a real, non-pending outcome, so the run
 *  settles COMPLETED without the test project needing Play credentials.
 *  Tests whose subject is the WRITE use this; the one test whose subject
 *  IS Phase B uses `VERIFIED_DEPS` below. */
const NOT_FOUND_DEPS: ImportVerifyDeps = {
  verifyAppleAnchor: async () => ({ kind: "notFound" }),
  verifyGoogleAnchor: async () => ({ kind: "notFound" }),
  verifyStripeAnchor: async () => ({ kind: "notFound" }),
};

const VERIFIED_EXPIRY = new Date("2027-06-01T00:00:00Z");

/** Records the anchors Phase B was actually asked about, so a test can
 *  prove the tokens this pass wrote are the ones that reached the store
 *  client — not merely that something was called. */
const googleAnchorCalls: { purchaseToken: string; productIdentifier: string }[] = [];

const VERIFIED_DEPS: ImportVerifyDeps = {
  verifyAppleAnchor: async () => ({ kind: "notFound" }),
  verifyGoogleAnchor: async (input) => {
    googleAnchorCalls.push({
      purchaseToken: input.purchaseToken,
      productIdentifier: input.productIdentifier,
    });
    return {
      kind: "verified",
      status: "ACTIVE",
      expiresDate: VERIFIED_EXPIRY,
      autoRenewStatus: true,
    };
  },
  verifyStripeAnchor: async () => ({ kind: "notFound" }),
};

/** Every Google anchor comes back THROTTLED — a non-answer, so the run
 *  ends VERIFICATION_INCOMPLETE with the anchor still pending, which is
 *  the state `POST /:id/resume` exists to recover. `sleep` is stubbed so
 *  the retry/backoff schedule costs no wall-clock time. */
const THROTTLED_DEPS: ImportVerifyDeps = {
  verifyAppleAnchor: async () => ({ kind: "notFound" }),
  verifyGoogleAnchor: async () => ({ kind: "throttled" }),
  verifyStripeAnchor: async () => ({ kind: "notFound" }),
  sleep: async () => undefined,
};

const TOKEN_FILE_HEADER = "user_id,google_purchase_token,google_product_id";

/** The mapping comes from the REAL preset detector, not a literal — the
 *  same path an uploaded token file takes. If the preset's column names
 *  ever change, these tests break rather than silently testing a mapping
 *  no real file produces. */
const ENRICHMENT_MAPPING: Record<string, CanonicalField> = (() => {
  const detection = detectPreset(TOKEN_FILE_HEADER.split(","));
  if (!detection || detection.presetId !== REVENUECAT_GOOGLE_TOKEN_PRESET_ID) {
    throw new Error("token-file header no longer matches the revenuecat_google_token preset");
  }
  return detection.mapping;
})();

type TokenFileRow = { userId: string; token: string; productId: string };

function tokenCsv(rows: TokenFileRow[]): string {
  const lines = rows.map((r) => [r.userId, r.token, r.productId].join(","));
  return `${TOKEN_FILE_HEADER}\n${lines.join("\n")}\n`;
}

async function createEnrichmentJob(args: {
  projectId: string;
  rows: TokenFileRow[];
  options?: Record<string, unknown>;
  /** Deliberately wrong kind, for the dispatcher guard test. */
  kind?: "HISTORY" | "GOOGLE_TOKEN_ENRICHMENT";
}): Promise<string> {
  const jobId = `job_enrich_${createId()}`;
  const csv = tokenCsv(args.rows);
  const storageKey = `imports/${args.projectId}/${jobId}/tokens.csv`;
  fakeObjects.set(storageKey, Buffer.from(csv, "utf8"));
  await drizzle.importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: args.projectId,
    sourceLabel: "google tokens",
    presetId: REVENUECAT_GOOGLE_TOKEN_PRESET_ID,
    kind: args.kind ?? "GOOGLE_TOKEN_ENRICHMENT",
    storageKey,
    fileName: "tokens.csv",
    fileBytes: Buffer.byteLength(csv),
    fileSha256: "deadbeef",
    mapping: ENRICHMENT_MAPPING,
    options: args.options ?? {},
  });
  return jobId;
}

async function tokensOf(purchaseIds: string[]): Promise<(string | null)[]> {
  const rows = await db
    .select({ id: purchases.id, token: purchases.googlePurchaseToken })
    .from(purchases)
    .where(inArray(purchases.id, purchaseIds))
    .orderBy(purchases.id);
  return rows.map((r) => r.token);
}

function rowFor(chain: SeededChain, token: string): TokenFileRow {
  return {
    userId: chain.subscriberExternalId,
    token,
    productId: chain.productIdentifier,
  };
}

let projectId: string;

beforeAll(async () => {
  ({ projectId } = await seedHistoryImport.freshProject());
});

// =============================================================
// Dry run vs commit
// =============================================================

describe("runEnrichmentJob — dry run", () => {
  it("classifies every pair and writes nothing at all", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 3 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_dryrun")],
    });

    const result = await runEnrichmentJob(jobId, { mode: "DRY_RUN" });

    expect(result.status).toBe("DRY_RUN_COMPLETE");
    expect(result.totalRows).toBe(1);
    expect(result.totalPairs).toBe(1);
    expect(result.counters.enriched).toBe(1);
    // Source rows in the buckets; purchase rows in the auxiliary counter
    // — one enrichment row covers a whole three-renewal chain, and an
    // operator approving a plan needs the second number.
    expect(result.enrichedPurchaseRows).toBe(3);

    expect(await tokensOf(chain.purchaseIds)).toEqual([null, null, null]);

    // The auxiliary counters ride in the SAME `dryRun_` namespace as the
    // buckets. Written plainly they would survive the DB but be dropped
    // by the route's pre-commit reconstruction, which rebuilds the
    // counters object from the kind's key list — so the dashboard's
    // opt-in callout would quote zero. This asserts the persisted key
    // NAMES, not just the numbers, because the name is the bug.
    const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
    expect(job?.counters.dryRun_enrichedPurchaseRows).toBe(3);
    expect(job?.counters.dryRun_ungroupedChainsPurchaseRows).toBe(0);
    expect(job?.counters.enrichedPurchaseRows).toBeUndefined();
  });
});

describe("runEnrichmentJob — commit", () => {
  it("writes the token to every row of the chain, then reports COMPLETED", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 3 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_commit")],
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.counters.enriched).toBe(1);
    expect(result.enrichedPurchaseRows).toBe(3);
    expect(await tokensOf(chain.purchaseIds)).toEqual([
      "tok_commit",
      "tok_commit",
      "tok_commit",
    ]);

    const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
    expect(job?.status).toBe("COMPLETED");
    expect(job?.counters.enriched).toBe(1);
    expect(job?.counters.enrichedPurchaseRows).toBe(3);
  });

  it("is idempotent — re-running the same file writes nothing", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    const rows = [rowFor(chain, "tok_idempotent")];

    const firstJob = await createEnrichmentJob({ projectId, rows });
    const first = await runEnrichmentJob(firstJob, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });
    expect(first.counters.enriched).toBeGreaterThan(0);

    const secondJob = await createEnrichmentJob({ projectId, rows });
    const second = await runEnrichmentJob(secondJob, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(second.counters.enriched).toBe(0);
    expect(second.counters.alreadyEnriched).toBe(first.counters.enriched);
    expect(second.enrichedPurchaseRows).toBe(0);
    expect(await tokensOf(chain.purchaseIds)).toEqual(["tok_idempotent", "tok_idempotent"]);
  });

  it("refuses a pair that spans two real subscription chains", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    await seedHistoryImport.additionalChain({
      projectId,
      subscriberExternalId: chain.subscriberExternalId,
      productIdentifier: chain.productIdentifier,
    });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_ambiguous")],
      // Even with the opt-in ON: it relaxes the MISSING-chain-id case,
      // never a genuine resubscribe.
      options: { enrichUngroupedChains: true },
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(result.counters.ambiguousMatch).toBe(1);
    expect(result.counters.enriched).toBe(0);
    expect(await tokensOf(chain.purchaseIds)).toEqual([null, null]);
  });
});

// =============================================================
// `purchaseIds` is not a write signal
// =============================================================

describe("runEnrichmentJob — ungroupedChains is reported, never written", () => {
  it("writes nothing by default, and reports what the opt-in would reach", async () => {
    // `shareChainId: false` feeds the writer a file with NO
    // original-transaction column — the RevenueCat shape — so write.ts's
    // own NOT NULL fallback turns three renewals into three one-row
    // chains. The ambiguity is produced by the real writer's real rule.
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 3,
      shareChainId: false,
    });
    expect(chain.chainKeys).toHaveLength(3);

    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_ungrouped")],
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(result.counters.ungroupedChains).toBe(1);
    expect(result.counters.enriched).toBe(0);
    // The resolution CARRIES all three purchase ids so the dry run can
    // quantify the offer. This is the assertion that fails if the writer
    // ever switches on the payload instead of the outcome name.
    expect(result.ungroupedChainsPurchaseRows).toBe(3);
    expect(result.enrichedPurchaseRows).toBe(0);
    expect(await tokensOf(chain.purchaseIds)).toEqual([null, null, null]);
  });

  it("writes them once enrichUngroupedChains is turned on", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 3,
      shareChainId: false,
    });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_opted_in")],
      options: { enrichUngroupedChains: true },
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(result.counters.enriched).toBe(1);
    expect(result.enrichedPurchaseRows).toBe(3);
    expect(await tokensOf(chain.purchaseIds)).toEqual([
      "tok_opted_in",
      "tok_opted_in",
      "tok_opted_in",
    ]);
  });
});

// =============================================================
// A stored token is never overwritten
// =============================================================

describe("runEnrichmentJob — conflicting tokens", () => {
  it("never overwrites a differing stored token, even with the opt-in on", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      shareChainId: false,
      existingToken: "tok_already_stored",
    });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_from_file")],
      options: { enrichUngroupedChains: true },
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
    });

    expect(result.counters.conflictingToken).toBe(1);
    expect(result.counters.enriched).toBe(0);
    expect(await tokensOf(chain.purchaseIds)).toEqual([
      "tok_already_stored",
      "tok_already_stored",
    ]);
  });
});

// =============================================================
// Invalid rows and unmatched pairs
// =============================================================

describe("runEnrichmentJob — rows it cannot act on", () => {
  it("buckets a row missing the token, and reports noMatch for an unknown subscriber", async () => {
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [
        { userId: "who_is_this", token: "tok_orphan", productId: "com.nope.product" },
        { userId: "missing_token_user", token: "", productId: "com.nope.product" },
      ],
    });

    const result = await runEnrichmentJob(jobId, { mode: "DRY_RUN" });

    expect(result.totalRows).toBe(2);
    expect(result.counters.invalidRow).toBe(1);
    expect(result.counters.noMatch).toBe(1);
    // The invalid row never became a pair, so it cannot have been
    // resolved into any other bucket.
    expect(result.totalPairs).toBe(1);
  });
});

// =============================================================
// Phase B — the reason the column exists
// =============================================================

describe("runEnrichmentJob — hands the new tokens to Phase B", () => {
  it("verifies each enriched chain against the store, by the token it just wrote", async () => {
    googleAnchorCalls.length = 0;
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_verify_me")],
    });

    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: VERIFIED_DEPS,
    });

    expect(result.status).toBe("COMPLETED");
    // The anchor is the token this run wrote — not the store
    // transaction id, and not something the history file carried.
    expect(googleAnchorCalls).toEqual([
      { purchaseToken: "tok_verify_me", productIdentifier: chain.productIdentifier },
    ]);

    // Before this task these rows were permanently unverifiable: written
    // by the history import as `androidNoToken`, `verifiedAt` null, and
    // skipped by that job's own Phase B forever because its file has no
    // token column.
    const rows = await db
      .select({
        verifiedAt: purchases.verifiedAt,
        status: purchases.status,
        expiresDate: purchases.expiresDate,
      })
      .from(purchases)
      .where(inArray(purchases.id, chain.purchaseIds));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.verifiedAt).not.toBeNull();
      expect(row.status).toBe("ACTIVE");
      expect(row.expiresDate?.toISOString()).toBe(VERIFIED_EXPIRY.toISOString());
    }
  });
});

// =============================================================
// Cancellation
// =============================================================

describe("runEnrichmentJob — cancellation", () => {
  it("stops between pairs, keeps what it already wrote, and never overwrites CANCELLED", async () => {
    // Without the check, the run would finish its loop and then write
    // VERIFYING/COMPLETED straight over the operator's CANCELLED — the
    // same clobber plan.ts had to fix for the history dry run.
    const first = await seedHistoryImport.playChain({ projectId, renewals: 1 });
    const second = await seedHistoryImport.playChain({ projectId, renewals: 1 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(first, "tok_before_cancel"), rowFor(second, "tok_after_cancel")],
    });

    // The operator cancels AFTER the first pair — modelled by doing
    // exactly what `POST /:id/cancel` does (write CANCELLED to the row)
    // from inside the seam. Setting the row up front would not work: the
    // run writes RUNNING on entry, which is the real production ordering
    // too, so a cancel only ever lands mid-run.
    let pairsSeen = 0;
    const result = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: NOT_FOUND_DEPS,
      isCancelled: async () => {
        pairsSeen += 1;
        if (pairsSeen <= 1) return false;
        await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
          status: "CANCELLED",
          finishedAt: new Date(),
        });
        return true;
      },
    });

    expect(result.status).toBe("CANCELLED");
    expect(result.counters.enriched).toBe(1);
    // Written before the cancel: real, idempotent, and left in place.
    expect(await tokensOf(first.purchaseIds)).toEqual(["tok_before_cancel"]);
    // Never reached.
    expect(await tokensOf(second.purchaseIds)).toEqual([null]);

    const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
    expect(job?.status).toBe("CANCELLED");
    // The counters still describe what the abandoned run did.
    expect(job?.counters.enrichedPurchaseRows).toBe(1);
    // And the report PART this attempt opened is recorded, so the next
    // commit claims part 2 instead of overwriting part 1 — which is the
    // whole reason parts are numbered and immutable.
    expect(job?.reportPartCount).toBe(1);
  });
});

// =============================================================
// Resume — the second commit must still verify
// =============================================================

describe("runEnrichmentJob — resume after VERIFICATION_INCOMPLETE", () => {
  it("re-offers already-enriched chains to Phase B instead of reporting a false all-clear", async () => {
    // `POST /:id/resume` re-enqueues the SAME job, which lands back here
    // as another COMMIT. By then the tokens are already stored, so every
    // pair resolves `alreadyEnriched` and NOTHING is written — and a
    // chain set built from writes alone would be empty, `verifyAnchorGroups`
    // would see nothing pending, and it would persist COMPLETED for a run
    // that verified nothing at all.
    googleAnchorCalls.length = 0;
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_resume")],
    });

    // First commit: tokens land, but the store gives no answer.
    const first = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: THROTTLED_DEPS,
    });
    expect(first.status).toBe("VERIFICATION_INCOMPLETE");
    expect(first.enrichedPurchaseRows).toBe(2);
    expect(await tokensOf(chain.purchaseIds)).toEqual(["tok_resume", "tok_resume"]);
    // Nothing verified — that is the whole premise of the resume.
    let rows = await db
      .select({ verifiedAt: purchases.verifiedAt })
      .from(purchases)
      .where(inArray(purchases.id, chain.purchaseIds));
    expect(rows.every((row) => row.verifiedAt === null)).toBe(true);

    // The resume. Nothing left to write.
    googleAnchorCalls.length = 0;
    const second = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: VERIFIED_DEPS,
    });

    expect(second.counters.enriched).toBe(0);
    expect(second.counters.alreadyEnriched).toBe(1);
    expect(second.enrichedPurchaseRows).toBe(0);

    // ...but the chain still reached the store, under the token the
    // FIRST run wrote. Asserting the status alone would pass with the
    // bug present: the false all-clear is also COMPLETED.
    expect(googleAnchorCalls).toEqual([
      { purchaseToken: "tok_resume", productIdentifier: chain.productIdentifier },
    ]);
    expect(second.status).toBe("COMPLETED");

    rows = await db
      .select({ verifiedAt: purchases.verifiedAt })
      .from(purchases)
      .where(inArray(purchases.id, chain.purchaseIds));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verifiedAt !== null)).toBe(true);
  });

  it("does not re-verify a chain an earlier run already resolved", async () => {
    // The other half of re-offering everything: `verifyEnrichedGoogleAnchors`
    // drops rows carrying `verifiedAt` before they can cost a store call,
    // so a third run over an already-settled file is free rather than
    // re-hammering Play.
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [rowFor(chain, "tok_settled")],
    });
    await runEnrichmentJob(jobId, { mode: "COMMIT", verifyDeps: VERIFIED_DEPS });

    googleAnchorCalls.length = 0;
    const again = await runEnrichmentJob(jobId, {
      mode: "COMMIT",
      verifyDeps: VERIFIED_DEPS,
    });

    expect(again.status).toBe("COMPLETED");
    expect(googleAnchorCalls).toEqual([]);
  });
});

// =============================================================
// The in-memory cap
// =============================================================

describe("runEnrichmentJob — row cap", () => {
  it("fails the run with an actionable message rather than enriching part of the file", async () => {
    // The pass cannot stream (the two-tokens-for-one-pair check is a
    // property of the whole file), and nothing else bounds it — the
    // upload cap is 2 GiB. Dropping pairs past a cap would report a
    // clean run over data that was never examined, so it fails instead.
    const rows = Array.from({ length: IMPORT_ENRICHMENT_MAX_ROWS + 1 }, (_, index) => ({
      userId: `cap_user_${index}`,
      token: `cap_tok_${index}`,
      productId: "com.example.cap",
    }));
    const jobId = await createEnrichmentJob({ projectId, rows });

    await expect(runEnrichmentJob(jobId, { mode: "DRY_RUN" })).rejects.toThrow(
      /more than [\d,]+ mappable rows/,
    );

    const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
    expect(job?.status).toBe("FAILED");
    expect(job?.errorMessage).toMatch(/Split the file/);
  });
});

// =============================================================
// The kind guard
// =============================================================

describe("runEnrichmentJob — kind guard", () => {
  it("refuses to run a HISTORY job, rather than reporting a confident wrong answer", async () => {
    // A history file through this pass has no googlePurchaseToken column
    // mapped, so every row would bucket as `invalidRow` — a clean,
    // plausible report of a run that should never have happened.
    const jobId = await createEnrichmentJob({
      projectId,
      rows: [{ userId: "u", token: "t", productId: "p" }],
      kind: "HISTORY",
    });

    await expect(runEnrichmentJob(jobId, { mode: "DRY_RUN" })).rejects.toThrow(
      /only GOOGLE_TOKEN_ENRICHMENT jobs run here/,
    );
  });
});

// =============================================================
// The write primitive's own guards
// =============================================================
//
// Two of the three refusals below cannot be reached through
// `runEnrichmentJob`, because the resolver declines the same cases one
// step earlier. They are still asserted here, directly against the
// repository, because the resolver's read and this write are not in one
// transaction: the guard at the write site is what holds when a row
// changes in between, and a guard nothing exercises is a guard nobody
// notices breaking.

describe("enrichGooglePurchaseTokens — refuses in SQL", () => {
  it("never writes onto a soft-deleted subscriber's purchases", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(db, {
      projectId,
      key: chain.subscriberExternalId,
    });
    expect(subscriber).not.toBeNull();
    await db
      .update(subscribers)
      .set({ deletedAt: new Date() })
      .where(eq(subscribers.id, subscriber!.id));

    const written = await drizzle.purchaseRepo.enrichGooglePurchaseTokens(db, {
      projectId,
      purchaseIds: chain.purchaseIds,
      googlePurchaseToken: "tok_gdpr",
    });

    expect(written).toEqual([]);
    expect(await tokensOf(chain.purchaseIds)).toEqual([null, null]);
  });

  it("never replaces a stored token that differs from the one supplied", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      existingToken: "tok_stored",
    });

    const written = await drizzle.purchaseRepo.enrichGooglePurchaseTokens(db, {
      projectId,
      purchaseIds: chain.purchaseIds,
      googlePurchaseToken: "tok_different",
    });

    expect(written).toEqual([]);
    expect(await tokensOf(chain.purchaseIds)).toEqual(["tok_stored", "tok_stored"]);
  });

  it("refuses ids belonging to another project", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 1 });
    const other = await seedHistoryImport.freshProject();

    const written = await drizzle.purchaseRepo.enrichGooglePurchaseTokens(db, {
      projectId: other.projectId,
      purchaseIds: chain.purchaseIds,
      googlePurchaseToken: "tok_cross_tenant",
    });

    expect(written).toEqual([]);
    expect(await tokensOf(chain.purchaseIds)).toEqual([null]);
  });
});
