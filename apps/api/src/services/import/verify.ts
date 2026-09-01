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
// Fix round 1, FIX 1: `subscriber_access` is pure derived state — Phase
// A's own rule 5 (write.ts) never writes it directly, only ever through
// `syncAccess`, and Phase B must not be the one code path that forgets.
// Every subscriber whose purchase this module touches (in EITHER
// direction — upgraded to access-granting, or downgraded out of it) is
// synced exactly once after the whole run, mirroring write.ts's own
// touched-subscriber-set pattern and `expiry-checker.ts`'s
// swallow-and-log `safeSyncAccess` precedent (syncAccess holds a
// per-subscriber advisory lock and can fail under contention; that must
// not sink an otherwise-successful verification run).
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
//   - Fix round 1, FIX 4: a per-anchor retry budget alone does not bound
//     the RUN. With quota genuinely exhausted, every anchor independently
//     burns its own attempts and backoff — a run-level give-up
//     (`RUN_GIVE_UP_CONSECUTIVE_THROTTLES` consecutive throttles across
//     ALL anchors) stops the whole run promptly instead of grinding
//     through the full backoff schedule anchor by anchor. A cancellation
//     check runs alongside it, at the same anchor-boundary granularity
//     Phase A checks at batch boundaries.
//
// Fix round 1, FIX 5: `buildAnchorGroups` still holds one entry per
// DISTINCT anchor for the whole file in memory (dedup requires seeing
// every row before an anchor's identity is known — this is not batched
// the way Phase A is). What's bounded is the per-anchor blowup a single
// huge chain used to cause: see `AnchorGroup`'s own comment and the
// report for the resulting memory profile.
//
// Fix round 2, FIX B: the DISTINCT ANCHOR COUNT itself is now ALSO
// bounded (`IMPORT_VERIFY_MAX_ANCHORS_PER_RUN`), the same way plan.ts's
// `IMPORT_DUPLICATE_TRACKING_MAX_KEYS` bounds its own tracking — a named
// cap, disclosed on the summary (`anchorCapReached`), never a silent
// truncation. Hitting it forces `VERIFICATION_INCOMPLETE` for the whole
// run regardless of how the capped subset resolved, and — critically —
// an anchor `buildAnchorGroups` finds ALREADY verified during the scan
// costs no cap slot at all, so a resumed call's budget goes toward
// anchors that still need work rather than re-discovering the same first
// N anchors forever (see `buildAnchorGroups`'s own comment).
//
// Fix round 2, FIX C: `deps.isCancelled` is the same kind of test seam
// `deps.sleep` already is — production leaves it unset and gets the real
// DB-polling check; a test can inject a scripted predicate to prove
// cancellation is noticed BETWEEN two specific anchors without needing
// real wall-clock time to pass.
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
import { logger } from "../../lib/logger";
import { syncAccess } from "../access-engine";
import { buildCanonicalRow } from "./plan";
import { resolveStoreTransactionId } from "./write";

const log = logger.child("import-verify");

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

/** Fix round 1, FIX 4: a RUN-level circuit breaker, independent of any
 *  single anchor's own retry budget. Each anchor burning
 *  THROTTLE_RETRY_MAX_ATTEMPTS attempts of its own 2s→4s→8s→16s backoff
 *  is fine in isolation, but a genuinely quota-exhausted run of
 *  thousands of anchors would otherwise grind through that full schedule
 *  PER ANCHOR before ever reporting `VERIFICATION_INCOMPLETE` — hours,
 *  not seconds. Once this many THROTTLED responses land in a row across
 *  every anchor this run has touched (reset by any non-throttled
 *  response), the whole run stops dispatching new store calls and every
 *  remaining anchor is reported pending immediately. */
const RUN_GIVE_UP_CONSECUTIVE_THROTTLES = 10;

/** Fix round 1, FIX 4: how often (at most) the run re-reads the job's own
 *  status to notice an operator's Cancel. Phase A checks at batch
 *  boundaries; Phase B has no natural "batch", so this bounds the check
 *  to a fixed wall-clock cadence instead of once per anchor (which would
 *  mean one extra DB round trip per anchor on a huge file). */
const CANCELLATION_CHECK_INTERVAL_MS = 2_000;

/** Fix round 1, FIX 5: PLAY_STORE/STRIPE have no chain column on
 *  `purchases` (unlike Apple's `originalTransactionId`), so every
 *  distinct storeTransactionId a shared anchor's rows resolved to must be
 *  tracked to apply the verified result to each one individually. Capped
 *  so one pathological chain cannot grow this file's memory (or, before
 *  this fix, its CPU — see AnchorGroup) without bound; see the report for
 *  what this leaves unbounded. */
const IMPORT_VERIFY_MAX_TRACKED_ROWS_PER_ANCHOR = 2_000;

/** Fix round 2, FIX B: bounds the number of DISTINCT anchors this call
 *  holds in `AnchorGroup` form at once. This repo's own
 *  `IMPORT_DUPLICATE_TRACKING_MAX_KEYS` comment puts a 2 GiB file at "on
 *  the order of ten million" distinct transaction keys — a file with
 *  little renewal-chain sharing (mostly one-time purchases) pushes the
 *  distinct-anchor count to that same order. At roughly 300-500 bytes per
 *  `AnchorGroup` with V8/Map overhead, ten million would be several GB
 *  resident, potentially more than the file itself. 100,000 anchors caps
 *  that at ~50MB — comfortably safe — while still being far larger than
 *  any real single-project import is expected to need in one call.
 *  Reached anchors are verified what fits, resumed the rest: see
 *  `buildAnchorGroups`. */
const IMPORT_VERIFY_MAX_ANCHORS_PER_RUN = 100_000;

/** Keys this module writes under `import_jobs.counters` (the same jsonb
 *  column report.ts's IMPORT_OUTCOMES bucket list lives in) —
 *  deliberately namespaced so they can never collide with a Phase-A
 *  outcome bucket. Fix round 1, FIX 6: `ANCHOR_VERIFIED` is checkpointed
 *  (`purchases.verifiedAt`) and safe to increment additively across
 *  resumed calls; `ANCHOR_NOT_FOUND` and `ANCHOR_PENDING` are NOT
 *  checkpointed — every resumed call rediscovers the same anchors from
 *  scratch — so those two are OVERWRITTEN with this call's fresh, full
 *  count each time (`setImportJobCounters`), never incremented. */
const VERIFY_COUNTER_KEYS = {
  ANCHOR_VERIFIED: "verifyAnchorVerified",
  ANCHOR_NOT_FOUND: "verifyAnchorNotFound",
  ANCHOR_PENDING: "verifyAnchorPending",
  /** Final-fix-wave FIX 4: a per-anchor store failure this module never
   *  modelled as `notFound`/`throttled` — most commonly, the project has
   *  no credentials connected for that anchor's store, a very likely
   *  mid-migration state. NOT checkpointed, same reasoning as
   *  ANCHOR_NOT_FOUND/ANCHOR_PENDING: connecting the missing credentials
   *  and resuming should re-attempt it, not skip it forever. */
  ANCHOR_UNVERIFIABLE: "verifyAnchorUnverifiable",
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
  /** Fix round 2, FIX C: overridable for tests — production leaves this
   *  unset and gets the real, rate-limited DB-polling check
   *  (`checkCancelled`). A test can inject a scripted predicate (e.g.
   *  "false" on the first call, "true" from the second call on) to prove
   *  a mid-run Cancel between two specific anchors is noticed
   *  deterministically, without needing real wall-clock time to pass. */
  isCancelled?: () => Promise<boolean>;
  /** Override for tests only — production always gets
   *  IMPORT_VERIFY_MAX_ANCHORS_PER_RUN. Exists so a cap/resume test can
   *  prove the behaviour with a handful of anchors instead of 100,000,
   *  the same "inject a smaller unit" seam `RunImportJobOptions.batchSize`
   *  uses for Phase A. */
  maxAnchorsPerRun?: number;
}

// =============================================================
// Public shape
// =============================================================

export interface VerifySummary {
  jobId: string;
  /** `VERIFICATION_INCOMPLETE` the moment even one anchor is still
   *  pending after this call's retry/give-up budget — never `COMPLETED`
   *  in that case. `CANCELLED` when an operator cancelled the job while
   *  this call was running — see FIX 4. */
  status: "COMPLETED" | "VERIFICATION_INCOMPLETE" | "CANCELLED";
  /** Distinct (store, anchor) pairs this call actually inspected — bounded
   *  by `IMPORT_VERIFY_MAX_ANCHORS_PER_RUN` (fix round 2, FIX B). When
   *  `anchorCapReached` is true, the file has MORE distinct anchors than
   *  this — never treat this as "the whole file's anchor count". */
  anchorsTotal: number;
  /** Fix round 2, FIX B: true the moment this call stopped scanning the
   *  file because it hit `IMPORT_VERIFY_MAX_ANCHORS_PER_RUN` distinct,
   *  not-yet-verified anchors. Forces `status` to
   *  `VERIFICATION_INCOMPLETE` regardless of how the inspected subset
   *  resolved — the run definitively did NOT cover the whole file, so it
   *  must never report `COMPLETED`. A later call resumes from wherever
   *  this one left off (anchors it already verified cost no cap slot on
   *  the next scan). */
  anchorCapReached: boolean;
  /** Anchors this call confirmed live, OR found already verified by an
   *  earlier call while scanning (those cost no cap slot — see
   *  `anchorCapReached`). Not necessarily every verified anchor in the
   *  whole file when `anchorCapReached` is true. */
  anchorsVerified: number;
  /** Anchors the store said it no longer recognises this call — left as
   *  history, never deleted (rule 1). NOT checkpointed (see
   *  VERIFY_COUNTER_KEYS): re-discovered fresh on every call. */
  anchorsNotFound: number;
  /** Anchors still unresolved after this call's throttle-retry/give-up
   *  budget. NOT checkpointed: re-discovered fresh on every call. */
  anchorsPending: number;
  /** Final-fix-wave FIX 4: anchors whose store call failed with something
   *  this module never modelled as `notFound`/`throttled` — most
   *  commonly, no credentials connected yet for that anchor's store. Left
   *  as history (never marked verified, never marked notFound); counted
   *  separately so the operator sees WHY these differ from a plain
   *  `notFound`/`pending` and can act (connect the store, then resume).
   *  Forces `VERIFICATION_INCOMPLETE` the same way `anchorsPending` does
   *  — unlike `notFound`, this is not a definitive answer from the store,
   *  so it must not be reported as if the run had concluded normally.
   *  NOT checkpointed: re-discovered fresh on every call, so a resume
   *  after connecting credentials re-attempts it rather than skipping it
   *  forever. */
  anchorsUnverifiable: number;
  /** Rows skipped because they carried no store anchor at all (rule 2). */
  rowsSkippedAnchorless: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fix round 1, FIX 1: mirrors expiry-checker.ts's own `safeSyncAccess` —
 *  syncAccess holds a per-subscriber Postgres advisory lock and can fail
 *  under contention; that must not turn an otherwise-successful
 *  verification run into a failed one. Logged and swallowed; a later
 *  Phase B or webhook/receipt sync for the same subscriber will catch up
 *  any straggler. */
async function safeSyncAccess(subscriberId: string): Promise<void> {
  try {
    await syncAccess(subscriberId);
  } catch (err) {
    log.warn("syncAccess failed after phase B verification", {
      subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
  /** First-seen storeTransactionId (write.ts's natural purchase key) for
   *  this anchor. Always enough on its own to check the `verifiedAt`
   *  resume checkpoint; for APP_STORE it is ALSO enough to apply a
   *  verified result (`updateChainStatusGuarded` reaches the whole chain
   *  through the `originalTransactionId` column, not through a row
   *  list). */
  representativeStoreTransactionId: string;
  /** PLAY_STORE/STRIPE only — every OTHER distinct storeTransactionId
   *  this anchor's rows resolved to (there is no chain column for these
   *  stores, so each must be updated individually). A Set for O(1)
   *  membership — fix round 1, FIX 5: a large chain sharing one anchor
   *  was previously O(n^2) via `Array.includes`. Bounded at
   *  IMPORT_VERIFY_MAX_TRACKED_ROWS_PER_ANCHOR. Left `undefined` for
   *  APP_STORE, which never reads it — that keeps a large Apple renewal
   *  chain (this module's motivating case) at O(1) extra memory per
   *  anchor, not O(chain length). */
  storeTransactionIds?: Set<string>;
};

interface BuildAnchorGroupsResult {
  groups: Map<string, AnchorGroup>;
  rowsSkippedAnchorless: number;
  /** Fix round 2, FIX B: anchors the scan found ALREADY verified
   *  (`purchases.verifiedAt` set by an earlier call) before ever adding
   *  them to `groups` — these cost no cap slot. */
  alreadyVerifiedDuringScan: number;
  /** Fix round 2, FIX B: true iff the scan stopped early because
   *  `groups` reached `IMPORT_VERIFY_MAX_ANCHORS_PER_RUN` distinct,
   *  not-yet-verified anchors — there is more of the file left unread. */
  capReached: boolean;
}

async function buildAnchorGroups(
  db: Db,
  projectId: string,
  storageKey: string,
  mapping: Record<string, CanonicalField>,
  maxAnchorsPerRun: number,
): Promise<BuildAnchorGroupsResult> {
  const groups = new Map<string, AnchorGroup>();
  let rowsSkippedAnchorless = 0;
  let alreadyVerifiedDuringScan = 0;
  let capReached = false;
  const now = new Date();

  const objectStream = await importStore.getObject(storageKey);
  let header: string[] = [];
  for await (const event of parseCsvStream(objectStream)) {
    if ("header" in event) {
      header = event.header;
      continue;
    }
    if (capReached) break; // This call's anchor budget is spent — stop reading.

    const canonicalRow = buildCanonicalRow(header, event.row, mapping);
    const normalized = normalizeRow(canonicalRow, { now });
    if ("error" in normalized) continue; // Phase A never persisted this row.

    if (normalized.isAnchorless) {
      rowsSkippedAnchorless++;
      continue; // rule 2 — never sent to verification.
    }
    if (normalized.store === "PLAY_STORE" && !normalized.googlePurchaseToken) {
      // Final-fix-wave FIX 2: Phase A now DOES persist this row (as
      // history, `androidNoToken` bucket, `verifiedAt` left null) — but
      // there is nothing to verify without a token, so it is still
      // excluded from Phase B's anchor discovery here. This is a
      // deliberate "no anchor" skip, not "Phase A never wrote it".
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
    const existingGroup = groups.get(key);
    if (existingGroup) {
      if (
        existingGroup.storeTransactionIds &&
        existingGroup.storeTransactionIds.size < IMPORT_VERIFY_MAX_TRACKED_ROWS_PER_ANCHOR
      ) {
        existingGroup.storeTransactionIds.add(storeTransactionId);
      }
      continue;
    }

    // Fix round 2, FIX B: this is a NEWLY discovered distinct anchor — the
    // resume checkpoint is resolved HERE, before it can cost a cap slot.
    // Without this, a resumed call would re-discover the SAME first
    // IMPORT_VERIFY_MAX_ANCHORS_PER_RUN anchors on every call (the file is
    // always scanned from the start, in the same order) and NEVER reach
    // anchors further into the file — a cap that returns the same
    // anchors forever, which the fix explicitly must not do.
    const existingPurchase = await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
      db,
      normalized.store,
      storeTransactionId,
    );
    if (!existingPurchase) continue; // Phase A never wrote this row.
    if (existingPurchase.verifiedAt) {
      alreadyVerifiedDuringScan++;
      continue; // Already resolved by an earlier call — no slot needed.
    }

    if (groups.size >= maxAnchorsPerRun) {
      capReached = true;
      break;
    }

    groups.set(key, {
      store: normalized.store,
      anchor,
      productIdentifier: normalized.productIdentifier,
      isSandbox: normalized.isSandbox,
      representativeStoreTransactionId: storeTransactionId,
      storeTransactionIds:
        normalized.store === "APP_STORE" ? undefined : new Set([storeTransactionId]),
    });
  }

  return { groups, rowsSkippedAnchorless, alreadyVerifiedDuringScan, capReached };
}

// =============================================================
// Run-level state: give-up circuit + cancellation (FIX 4)
// =============================================================

type RunState = {
  consecutiveThrottles: number;
  giveUp: boolean;
  cancelled: boolean;
  lastCancelCheckAt: number;
};

function newRunState(): RunState {
  return { consecutiveThrottles: 0, giveUp: false, cancelled: false, lastCancelCheckAt: 0 };
}

function noteThrottled(runState: RunState): void {
  runState.consecutiveThrottles += 1;
  if (runState.consecutiveThrottles >= RUN_GIVE_UP_CONSECUTIVE_THROTTLES) {
    runState.giveUp = true;
  }
}

function noteResolved(runState: RunState): void {
  runState.consecutiveThrottles = 0;
}

/** Cheap, rate-limited check for an operator's Cancel — at most one DB
 *  read per CANCELLATION_CHECK_INTERVAL_MS regardless of anchor volume,
 *  and none at all once cancellation is confirmed (the flag is sticky
 *  for the rest of this call). Fix round 2, FIX C: `isCancelledOverride`
 *  (from `deps.isCancelled`) bypasses the DB and the interval throttle
 *  entirely when present — the injectable seam a test uses to prove
 *  cancellation is noticed between two specific anchors deterministically. */
async function checkCancelled(
  db: Db,
  projectId: string,
  jobId: string,
  runState: RunState,
  isCancelledOverride?: () => Promise<boolean>,
): Promise<boolean> {
  if (runState.cancelled) return true;

  if (isCancelledOverride) {
    if (await isCancelledOverride()) {
      runState.cancelled = true;
    }
    return runState.cancelled;
  }

  const now = Date.now();
  if (now - runState.lastCancelCheckAt < CANCELLATION_CHECK_INTERVAL_MS) {
    return false;
  }
  runState.lastCancelCheckAt = now;
  const fresh = await drizzle.importJobRepo.getImportJob(db, projectId, jobId);
  if (fresh?.status === "CANCELLED") {
    runState.cancelled = true;
  }
  return runState.cancelled;
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
 * Applies a confirmed live status to every purchase this anchor covers,
 * and returns every subscriberId touched (Fix round 1, FIX 1) so the
 * caller can `syncAccess` them — this function never writes
 * `subscriber_access` itself.
 *
 * APP_STORE goes through `updateChainStatusGuarded` keyed on the
 * `originalTransactionId` column — the same primitive the live Apple
 * webhook uses to propagate a refund/expiry across a whole transaction
 * chain — which reaches every purchase under this anchor in the project,
 * not just the storeTransactionIds this file happened to carry, and
 * refuses to resurrect a REFUNDED/REVOKED row. The affected subscribers
 * are read back by the same `originalTransactionId` scope, so a chain
 * whose rows fell outside this run's tracked set (impossible for
 * APP_STORE, which tracks none — see AnchorGroup) is still covered.
 *
 * PLAY_STORE and STRIPE have no such chain column on `purchases`, so each
 * tracked storeTransactionId is updated individually via `updatePurchase`
 * (terminal-guarded by default).
 */
async function applyVerifiedResult(
  db: Db,
  projectId: string,
  group: AnchorGroup,
  result: Extract<StoreAnchorVerificationResult, { kind: "verified" }>,
): Promise<string[]> {
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
    return drizzle.purchaseRepo.findSubscriberIdsByOriginalTransaction(
      db,
      projectId,
      group.anchor,
    );
  }

  const subscriberIds = new Set<string>();
  // PLAY_STORE/STRIPE always populate storeTransactionIds (including the
  // representative id itself, seeded at group creation) — this fallback
  // only guards a group shape this branch should never actually see.
  const storeTransactionIds =
    group.storeTransactionIds ?? new Set([group.representativeStoreTransactionId]);
  for (const storeTransactionId of storeTransactionIds) {
    const purchase: Purchase | null =
      await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
        db,
        group.store,
        storeTransactionId,
      );
    if (!purchase) continue;
    const updated = await drizzle.purchaseRepo.updatePurchase(db, purchase.id, patch);
    if (updated) subscriberIds.add(updated.subscriberId);
  }
  return [...subscriberIds];
}

type AnchorOutcome = "verified" | "notFound" | "pending" | "unverifiable";

async function verifyOneAnchor(
  db: Db,
  projectId: string,
  group: AnchorGroup,
  deps: ImportVerifyDeps,
  sleep: (ms: number) => Promise<void>,
  runState: RunState,
): Promise<{ outcome: AnchorOutcome; subscriberIds: string[] }> {
  let delay = THROTTLE_RETRY_BASE_DELAY_MS;
  for (let attempt = 1; attempt <= THROTTLE_RETRY_MAX_ATTEMPTS; attempt++) {
    if (runState.giveUp) return { outcome: "pending", subscriberIds: [] };

    let result: StoreAnchorVerificationResult;
    try {
      result = await callStoreClient(group, deps, projectId);
    } catch (err) {
      // Final-fix-wave FIX 4: `verify-store-clients.ts`'s per-store
      // clients throw synchronously for a condition neither `notFound`
      // nor `throttled` models — most commonly `requireConnectedStripe`/
      // the Apple/Google credential loaders throwing because this
      // project has no credentials connected for that store yet, a very
      // likely mid-migration state. Before this fix, an unmodelled throw
      // escaped straight out of `Promise.all` (verifyWithPacing) and
      // aborted verification for EVERY anchor in this call, including
      // anchors for stores that ARE fully configured. This is a per-anchor
      // outcome, not a run-ending one: the row degrades to history-only
      // (already true — Phase A never set verifiedAt) and is counted
      // under its own bucket instead of taking anything else down.
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(
        "phase B: anchor verification failed with an unmodelled error; leaving it as history-only rather than aborting the run",
        { projectId, store: group.store, anchor: group.anchor, reason },
      );
      return { outcome: "unverifiable", subscriberIds: [] };
    }
    if (result.kind === "throttled") {
      noteThrottled(runState);
      if (runState.giveUp || attempt === THROTTLE_RETRY_MAX_ATTEMPTS) {
        return { outcome: "pending", subscriberIds: [] };
      }
      await sleep(delay);
      delay = Math.min(delay * 2, THROTTLE_RETRY_MAX_DELAY_MS);
      continue;
    }

    noteResolved(runState);
    if (result.kind === "notFound") {
      // Rule 1: stays as history. No write at all.
      return { outcome: "notFound", subscriberIds: [] };
    }
    const subscriberIds = await applyVerifiedResult(db, projectId, group, result);
    return { outcome: "verified", subscriberIds };
  }
  return { outcome: "pending", subscriberIds: [] };
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

  const { groups, rowsSkippedAnchorless, alreadyVerifiedDuringScan, capReached } =
    await buildAnchorGroups(
      db,
      projectId,
      job.storageKey,
      mapping,
      deps.maxAnchorsPerRun ?? IMPORT_VERIFY_MAX_ANCHORS_PER_RUN,
    );

  const runState = newRunState();
  const touchedSubscriberIds = new Set<string>();
  // Fix round 2, FIX B: anchors buildAnchorGroups already confirmed
  // verified during the scan (no cap slot spent) count toward this call's
  // reported total immediately — every anchor that DID take a slot in
  // `groups` is, by construction, one `findPurchaseByStoreTransaction`
  // already showed is NOT yet verified, so the pacing loop below no
  // longer needs to re-check that (fix round 1's redundant per-anchor
  // checkpoint read is gone).
  let anchorsVerified = alreadyVerifiedDuringScan;
  let anchorsNotFound = 0;
  let anchorsPending = 0;
  let anchorsUnverifiable = 0;
  let newlyVerified = 0;

  await verifyWithPacing(
    [...groups.values()],
    IMPORT_VERIFY_CONCURRENCY,
    IMPORT_VERIFY_RATE_PER_SECOND,
    sleep,
    async (group) => {
      // FIX 4: an operator's Cancel wins over everything else — stop
      // touching anchors entirely and leave them exactly as-is for a
      // future resume (this run's counters simply won't cover them).
      if (await checkCancelled(db, projectId, jobId, runState, deps.isCancelled)) return;

      // FIX 4: once the run has given up, every remaining anchor is
      // reported pending immediately, with no further store calls.
      if (runState.giveUp) {
        anchorsPending++;
        return;
      }

      const { outcome, subscriberIds } = await verifyOneAnchor(
        db,
        projectId,
        group,
        deps,
        sleep,
        runState,
      );
      for (const subscriberId of subscriberIds) {
        touchedSubscriberIds.add(subscriberId);
      }
      if (outcome === "verified") {
        anchorsVerified++;
        newlyVerified++;
      } else if (outcome === "notFound") {
        anchorsNotFound++;
      } else if (outcome === "unverifiable") {
        anchorsUnverifiable++;
      } else {
        anchorsPending++;
      }
    },
  );

  // FIX 1: subscriber_access is derived state — recompute it, once per
  // touched subscriber, for every purchase Phase B changed in EITHER
  // direction (upgraded to access-granting, or downgraded out of it).
  for (const subscriberId of touchedSubscriberIds) {
    await safeSyncAccess(subscriberId);
  }

  // FIX 6: verified is checkpointed and additive; notFound/pending are
  // NOT checkpointed and must be OVERWRITTEN with this call's fresh,
  // complete counts, never accumulated across resumed calls.
  await drizzle.importJobRepo.incrementImportJobCounters(db, projectId, jobId, {
    [VERIFY_COUNTER_KEYS.ANCHOR_VERIFIED]: newlyVerified,
  });
  await drizzle.importJobRepo.setImportJobCounters(db, projectId, jobId, {
    [VERIFY_COUNTER_KEYS.ANCHOR_NOT_FOUND]: anchorsNotFound,
    [VERIFY_COUNTER_KEYS.ANCHOR_PENDING]: anchorsPending,
    [VERIFY_COUNTER_KEYS.ANCHOR_UNVERIFIABLE]: anchorsUnverifiable,
  });

  // Minor fix: the status is always written back explicitly — a
  // successful RESUME (this call clears a prior VERIFICATION_INCOMPLETE)
  // must actually flip the persisted row to COMPLETED, not just say so in
  // the returned summary.
  //
  // Fix round 2, FIX B: `capReached` forces VERIFICATION_INCOMPLETE even
  // when the inspected subset itself has zero anchorsPending — the run
  // definitively did not cover the whole file, so claiming COMPLETED
  // would be a false all-clear.
  let status: VerifySummary["status"];
  if (runState.cancelled) {
    // Already CANCELLED at the DB (that is how it was detected) —
    // nothing to write.
    status = "CANCELLED";
  } else if (anchorsPending > 0 || anchorsUnverifiable > 0 || capReached) {
    status = "VERIFICATION_INCOMPLETE";
    await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "VERIFICATION_INCOMPLETE",
    });
  } else {
    status = "COMPLETED";
    // Task 10 fix round 2 (FIX A): `finishedAt` is set HERE now, not by
    // Phase A — Phase A writes VERIFYING, not COMPLETED, before calling
    // this function (workers/import-runner.ts), specifically so a job
    // isn't marked "finished" while Phase B is still actively running or
    // crash-interrupted. This is the run's true completion moment, and
    // the ONLY place COMPLETED is persisted with `finishedAt` set —
    // required for `listImportJobsEligibleForFileRetention`'s `finishedAt
    // IS NOT NULL` filter, which gates the retention sweep.
    await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "COMPLETED",
      finishedAt: new Date(),
    });
  }

  return {
    jobId,
    status,
    anchorsTotal: groups.size,
    anchorCapReached: capReached,
    anchorsVerified,
    anchorsNotFound,
    anchorsPending,
    anchorsUnverifiable,
    rowsSkippedAnchorless,
  };
}
