// Phase B: store re-validation for the data-import tool (Task 9).
//
// Phase A (write.ts) imports everything the file carried, as history — it
// never contacts a store. This module is the second phase of the SAME
// import job (wired in by workers/import-runner.ts, right after Phase A
// completes): it re-parses the job's source file, groups every row that
// carries a REAL store anchor by that anchor, asks the store what is true
// TODAY (once per anchor, never once per row), and supersedes the
// imported snapshot with the live status.
//
// Two rules with teeth (task-9 controller context):
//
//   1. A row the store no longer recognises stays as history and is NEVER
//      deleted. This is the explicit divergence from Adapty's importer,
//      which drops such rows — losing it would forfeit the feature's
//      whole differentiator. A "not found" anchor is simply left alone:
//      `verifiedAt` stays null, the imported snapshot stands.
//   2. Anchorless rows (`isAnchorless` — RC `promotional`, MANUAL grants
//      with a deterministic synthetic id) are NEVER sent to verification.
//      There is nothing to verify.
//
// Pacing is a correctness requirement, not an optimisation: re-verifying a
// large import means one call per anchor against the CUSTOMER's own
// Apple/Google/Stripe credentials, and large Android imports are a
// documented quota hazard (Adapty's own docs warn of it). So:
//
//   - Deduplicate by store anchor FIRST. A subscription chain of 40
//     renewals sharing one Apple originalTransactionId is verified once.
//   - Bounded concurrency + a paced request rate (IMPORT_VERIFY_CONCURRENCY /
//     IMPORT_VERIFY_RATE_PER_SECOND).
//   - Store-side throttling is retryable, NOT a row failure: it pauses
//     (backoff) and resumes the SAME anchor, up to a bounded number of
//     attempts. An anchor that still can't be resolved is left pending —
//     never marked verified, never marked not-found — and the whole run's
//     outcome is `VERIFICATION_INCOMPLETE`, never `COMPLETED`. Resuming
//     later (a fresh `verifyImportedAnchors` call for the same job) is
//     safe and cheap: any anchor whose purchases already carry a
//     `verifiedAt` is skipped without a store call — that column IS the
//     resume checkpoint, no separate one is needed.
import {
  drizzle,
  type Db,
  type Purchase,
  type PurchaseStatus,
} from "@rovenue/db";
import {
  normalizeRow,
  parseCsvStream,
  type CanonicalField,
  type StoreValue,
} from "@rovenue/shared";
import * as importStore from "../../lib/import-store";
import { buildCanonicalRow } from "./plan";
import { resolveStoreTransactionId } from "./write";

// =============================================================
// Pacing constants (this module's "Produces" contract)
// =============================================================

/** How many anchors this run verifies against the store at once. Small on
 *  purpose — this is a per-project background job, not a request path,
 *  and the whole point of this file is to not hammer a customer's own
 *  Apple/Google/Stripe quota. */
export const IMPORT_VERIFY_CONCURRENCY = 4;

/** How many NEW store calls this run starts per rolling second, across
 *  every in-flight anchor. Conservative default: Adapty's own docs warn a
 *  large Android import needs a Play Developer API quota increase, so
 *  this is a documented hazard, not a hypothetical one. */
export const IMPORT_VERIFY_RATE_PER_SECOND = 5;

/** A throttled anchor is retried, not failed — up to this many attempts
 *  per anchor per `verifyImportedAnchors` call, with exponential backoff
 *  between attempts. Exhausting this budget leaves the anchor PENDING
 *  (never notFound, never verified) and the run's outcome becomes
 *  `VERIFICATION_INCOMPLETE` — a later call resumes it. */
const THROTTLE_RETRY_MAX_ATTEMPTS = 5;
const THROTTLE_RETRY_BASE_DELAY_MS = 2_000;
const THROTTLE_RETRY_MAX_DELAY_MS = 30_000;

/** Keys this module increments under `import_jobs.counters` (the same
 *  jsonb column report.ts's IMPORT_OUTCOMES bucket list lives in, via the
 *  same additive `incrementImportJobCounters` primitive) — deliberately
 *  namespaced so they can never collide with a Phase-A outcome bucket. */
const VERIFY_COUNTER_KEYS = {
  ANCHOR_VERIFIED: "verifyAnchorVerified",
  ANCHOR_NOT_FOUND: "verifyAnchorNotFound",
  ANCHOR_PENDING: "verifyAnchorPending",
} as const;

// =============================================================
// Injected store clients (so tests can fake them)
// =============================================================

/**
 * One store anchor's live status, or the two ways a lookup can fail to
 * produce one. `notFound` and `throttled` are NOT the same thing: a
 * not-found anchor got a definitive answer (the store doesn't know it —
 * rule 1 above governs what happens next); a throttled anchor got NO
 * answer at all and must be retried.
 */
export type StoreAnchorVerificationResult =
  | {
      kind: "verified";
      status: PurchaseStatus;
      expiresDate: Date | null;
      autoRenewStatus: boolean | null;
    }
  | { kind: "notFound" }
  | { kind: "throttled" };

export interface VerifyAppleAnchorInput {
  projectId: string;
  originalTransactionId: string;
  isSandbox: boolean;
}

export interface VerifyGoogleAnchorInput {
  projectId: string;
  purchaseToken: string;
  productIdentifier: string;
}

export interface VerifyStripeAnchorInput {
  projectId: string;
  subscriptionId: string;
}

export interface ImportVerifyDeps {
  verifyAppleAnchor(
    input: VerifyAppleAnchorInput,
  ): Promise<StoreAnchorVerificationResult>;
  verifyGoogleAnchor(
    input: VerifyGoogleAnchorInput,
  ): Promise<StoreAnchorVerificationResult>;
  verifyStripeAnchor(
    input: VerifyStripeAnchorInput,
  ): Promise<StoreAnchorVerificationResult>;
  /** Overridable for tests (so a throttle-retry test doesn't actually
   *  wait seconds of real backoff). Production default is a real
   *  timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

// =============================================================
// Public shape
// =============================================================

export interface VerifySummary {
  jobId: string;
  /** `VERIFICATION_INCOMPLETE` the moment even one anchor is still
   *  pending after this call's retry budget — never `COMPLETED` in that
   *  case, per the pacing rule above. */
  status: "COMPLETED" | "VERIFICATION_INCOMPLETE";
  /** Distinct (store, anchor) pairs found in the file this call. */
  anchorsTotal: number;
  /** Anchors now confirmed live (this call's work plus anything an
   *  earlier call already resolved). */
  anchorsVerified: number;
  /** Anchors the store said it no longer recognises — left as history,
   *  never deleted (rule 1). */
  anchorsNotFound: number;
  /** Anchors still unresolved after this call's throttle-retry budget. */
  anchorsPending: number;
  /** Rows skipped because they carried no store anchor at all (rule 2). */
  rowsSkippedAnchorless: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================
// Anchor grouping
// =============================================================

type AnchorGroup = {
  store: StoreValue;
  /** The store-specific identifier this whole group is verified by:
   *  Apple's originalTransactionId, Google's purchaseToken, or Stripe's
   *  subscription id. */
  anchor: string;
  productIdentifier: string;
  isSandbox: boolean;
  /** Every distinct storeTransactionId (write.ts's natural purchase key)
   *  this anchor's rows resolved to, in file order. APP_STORE never needs
   *  this (the whole chain is updated by originalTransactionId in one DB
   *  call); PLAY_STORE/STRIPE have no such chain column, so each known
   *  storeTransactionId is updated individually. */
  storeTransactionIds: string[];
};

async function buildAnchorGroups(
  db: Db,
  projectId: string,
  storageKey: string,
  mapping: Record<string, CanonicalField>,
): Promise<{ groups: Map<string, AnchorGroup>; rowsSkippedAnchorless: number }> {
  const groups = new Map<string, AnchorGroup>();
  let rowsSkippedAnchorless = 0;
  const now = new Date();

  const objectStream = await importStore.getObject(storageKey);
  let header: string[] = [];
  for await (const event of parseCsvStream(objectStream)) {
    if ("header" in event) {
      header = event.header;
      continue;
    }
    const canonicalRow = buildCanonicalRow(header, event.row, mapping);
    const normalized = normalizeRow(canonicalRow, { now });
    if ("error" in normalized) continue; // Phase A never persisted this row.

    if (normalized.isAnchorless) {
      rowsSkippedAnchorless++;
      continue; // rule 2 — never sent to verification.
    }
    if (normalized.store === "PLAY_STORE" && !normalized.googlePurchaseToken) {
      // Phase A itself refused this row (androidNoToken) — never persisted.
      continue;
    }

    const storeTransactionId = resolveStoreTransactionId(projectId, normalized);

    let anchor: string | null;
    switch (normalized.store) {
      case "APP_STORE":
        anchor = normalized.originalTransactionId ?? storeTransactionId;
        break;
      case "PLAY_STORE":
        anchor = normalized.googlePurchaseToken;
        break;
      case "STRIPE":
        anchor = normalized.stripeSubscriptionId ?? storeTransactionId;
        break;
      default:
        anchor = null;
    }
    if (!anchor) continue;

    const key = `${normalized.store}:${anchor}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        store: normalized.store,
        anchor,
        productIdentifier: normalized.productIdentifier,
        isSandbox: normalized.isSandbox,
        storeTransactionIds: [],
      };
      groups.set(key, group);
    }
    if (!group.storeTransactionIds.includes(storeTransactionId)) {
      group.storeTransactionIds.push(storeTransactionId);
    }
  }

  return { groups, rowsSkippedAnchorless };
}

// =============================================================
// Pacing: bounded concurrency + a paced request rate
// =============================================================

async function verifyWithPacing(
  groups: AnchorGroup[],
  concurrency: number,
  ratePerSecond: number,
  sleep: (ms: number) => Promise<void>,
  worker: (group: AnchorGroup) => Promise<void>,
): Promise<void> {
  const RATE_WINDOW_MS = 1_000;
  let index = 0;
  let windowStart = Date.now();
  let dispatchedThisWindow = 0;

  async function runOne(): Promise<void> {
    while (index < groups.length) {
      const now = Date.now();
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now;
        dispatchedThisWindow = 0;
      }
      if (dispatchedThisWindow >= ratePerSecond) {
        await sleep(Math.max(RATE_WINDOW_MS - (now - windowStart), 0));
        windowStart = Date.now();
        dispatchedThisWindow = 0;
        continue;
      }
      const group = groups[index++];
      if (!group) return;
      dispatchedThisWindow++;
      await worker(group);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, groups.length || 1));
  await Promise.all(
    Array.from({ length: groups.length === 0 ? 0 : workerCount }, () => runOne()),
  );
}

// =============================================================
// Per-anchor verification + DB application
// =============================================================

async function callStoreClient(
  group: AnchorGroup,
  deps: ImportVerifyDeps,
  projectId: string,
): Promise<StoreAnchorVerificationResult> {
  switch (group.store) {
    case "APP_STORE":
      return deps.verifyAppleAnchor({
        projectId,
        originalTransactionId: group.anchor,
        isSandbox: group.isSandbox,
      });
    case "PLAY_STORE":
      return deps.verifyGoogleAnchor({
        projectId,
        purchaseToken: group.anchor,
        productIdentifier: group.productIdentifier,
      });
    case "STRIPE":
      return deps.verifyStripeAnchor({
        projectId,
        subscriptionId: group.anchor,
      });
    default:
      throw new Error(
        `verifyImportedAnchors: unsupported store "${group.store}" reached verification`,
      );
  }
}

/**
 * Applies a confirmed live status to every purchase this anchor covers.
 *
 * APP_STORE goes through `updateChainStatusGuarded` keyed on the
 * `originalTransactionId` column — the same primitive the live Apple
 * webhook uses to propagate a refund/expiry across a whole transaction
 * chain — which reaches every purchase under this anchor in the project,
 * not just the storeTransactionIds this file happened to carry, and
 * refuses to resurrect a REFUNDED/REVOKED row.
 *
 * PLAY_STORE and STRIPE have no such chain column on `purchases`, so each
 * storeTransactionId this anchor's rows resolved to is updated
 * individually via `updatePurchase` (terminal-guarded by default).
 */
async function applyVerifiedResult(
  db: Db,
  projectId: string,
  group: AnchorGroup,
  result: Extract<StoreAnchorVerificationResult, { kind: "verified" }>,
): Promise<void> {
  const patch = {
    status: result.status,
    verifiedAt: new Date(),
    expiresDate: result.expiresDate,
    autoRenewStatus: result.autoRenewStatus,
  };

  if (group.store === "APP_STORE") {
    await drizzle.purchaseRepo.updateChainStatusGuarded(
      db,
      projectId,
      group.anchor,
      patch,
    );
    return;
  }

  for (const storeTransactionId of group.storeTransactionIds) {
    const purchase: Purchase | null =
      await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
        db,
        group.store,
        storeTransactionId,
      );
    if (!purchase) continue;
    await drizzle.purchaseRepo.updatePurchase(db, purchase.id, patch);
  }
}

type AnchorOutcome = "verified" | "notFound" | "pending";

async function verifyOneAnchor(
  db: Db,
  projectId: string,
  group: AnchorGroup,
  deps: ImportVerifyDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<AnchorOutcome> {
  let delay = THROTTLE_RETRY_BASE_DELAY_MS;
  for (let attempt = 1; attempt <= THROTTLE_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await callStoreClient(group, deps, projectId);
    if (result.kind === "throttled") {
      if (attempt === THROTTLE_RETRY_MAX_ATTEMPTS) return "pending";
      await sleep(delay);
      delay = Math.min(delay * 2, THROTTLE_RETRY_MAX_DELAY_MS);
      continue;
    }
    if (result.kind === "notFound") {
      // Rule 1: stays as history. No write at all.
      return "notFound";
    }
    await applyVerifiedResult(db, projectId, group, result);
    return "verified";
  }
  return "pending";
}

// =============================================================
// verifyImportedAnchors
// =============================================================

export async function verifyImportedAnchors(
  jobId: string,
  deps: ImportVerifyDeps,
): Promise<VerifySummary> {
  const db = drizzle.db;
  const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!job) {
    throw new Error(`verifyImportedAnchors: import job ${jobId} not found`);
  }
  const projectId = job.projectId;
  const mapping = job.mapping as Record<string, CanonicalField>;
  const sleep = deps.sleep ?? defaultSleep;

  const { groups, rowsSkippedAnchorless } = await buildAnchorGroups(
    db,
    projectId,
    job.storageKey,
    mapping,
  );

  let anchorsVerified = 0;
  let anchorsNotFound = 0;
  let anchorsPending = 0;
  let newlyVerified = 0;
  let newlyNotFound = 0;
  let newlyPending = 0;

  await verifyWithPacing(
    [...groups.values()],
    IMPORT_VERIFY_CONCURRENCY,
    IMPORT_VERIFY_RATE_PER_SECOND,
    sleep,
    async (group) => {
      // Resume checkpoint: `verifiedAt` on an already-written purchase IS
      // the record that an earlier `verifyImportedAnchors` call already
      // resolved this anchor — no separate checkpoint column needed. A
      // representative storeTransactionId also tells us whether Phase A
      // even persisted this row at all (unresolvedProduct/invalidRow/
      // sandbox-skip/dead-ended-subscriber rows never did).
      const representativeId = group.storeTransactionIds[0];
      if (!representativeId) return;
      const existing = await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
        db,
        group.store,
        representativeId,
      );
      if (!existing) return; // Phase A never wrote this row.
      if (existing.verifiedAt) {
        anchorsVerified++;
        return;
      }

      const outcome = await verifyOneAnchor(db, projectId, group, deps, sleep);
      if (outcome === "verified") {
        anchorsVerified++;
        newlyVerified++;
      } else if (outcome === "notFound") {
        anchorsNotFound++;
        newlyNotFound++;
      } else {
        anchorsPending++;
        newlyPending++;
      }
    },
  );

  await drizzle.importJobRepo.incrementImportJobCounters(db, projectId, jobId, {
    [VERIFY_COUNTER_KEYS.ANCHOR_VERIFIED]: newlyVerified,
    [VERIFY_COUNTER_KEYS.ANCHOR_NOT_FOUND]: newlyNotFound,
    [VERIFY_COUNTER_KEYS.ANCHOR_PENDING]: newlyPending,
  });

  const status: VerifySummary["status"] =
    anchorsPending > 0 ? "VERIFICATION_INCOMPLETE" : "COMPLETED";

  if (status === "VERIFICATION_INCOMPLETE") {
    await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "VERIFICATION_INCOMPLETE",
    });
  }

  return {
    jobId,
    status,
    anchorsTotal: groups.size,
    anchorsVerified,
    anchorsNotFound,
    anchorsPending,
    rowsSkippedAnchorless,
  };
}
