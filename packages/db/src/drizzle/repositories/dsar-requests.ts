import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { Db } from "../client";
import {
  dsarRequests,
  OPEN_DSAR_REQUEST_STATUSES,
  type DsarRequest,
} from "../schema";
import { dsarRequestStatus, dsarRequestType } from "../enums";

// =============================================================
// dsar_requests repository
// =============================================================
//
// One row per customer-initiated EXPORT or ERASURE ask for one of their
// subscribers. Idempotency is the point of this table: the partial unique
// index on (subscriberId, type) WHERE status IN (PENDING, RUNNING) — see
// `OPEN_DSAR_REQUEST_STATUSES` in ../schema.ts — makes a concurrent
// double-submit a database error rather than two exports. This repository
// never re-implements that check in application code; a caller that wants
// idempotent creation must call `findOpenDsarRequest` first and only fall
// back to `createDsarRequest` when it returns null.

export type DsarRequestType = (typeof dsarRequestType.enumValues)[number];
export type DsarRequestStatus = (typeof dsarRequestStatus.enumValues)[number];

// ---------------------------------------------------------------------------
// findOpenDsarRequest
// ---------------------------------------------------------------------------

export interface FindOpenDsarRequestArgs {
  projectId: string;
  subscriberId: string;
  type: DsarRequestType;
}

/**
 * The subject's current open (PENDING or RUNNING) request of one type, if
 * any. Scoped to `projectId` even though `subscriberId` alone already
 * identifies the row's project — a caller must never learn about a request
 * that belongs to a subscriber outside its own project, and this makes
 * that refusal structural rather than a convention every call site has to
 * remember.
 */
export async function findOpenDsarRequest(
  db: Db,
  args: FindOpenDsarRequestArgs,
): Promise<DsarRequest | null> {
  const rows = await db
    .select()
    .from(dsarRequests)
    .where(
      and(
        eq(dsarRequests.projectId, args.projectId),
        eq(dsarRequests.subscriberId, args.subscriberId),
        eq(dsarRequests.type, args.type),
        // The same named tuple the partial unique index is built from
        // (../schema.ts), so the application's idea of "open" and the
        // database's cannot drift apart.
        inArray(dsarRequests.status, OPEN_DSAR_REQUEST_STATUSES),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// createDsarRequest
// ---------------------------------------------------------------------------

export interface CreateDsarRequestInput {
  projectId: string;
  subscriberId: string;
  type: DsarRequestType;
  /** Free text the customer's own backend supplies, identifying who asked. */
  requestedBy: string;
}

/**
 * Insert a new PENDING request. Relies on the database's partial unique
 * index to reject a concurrent second open request for the same
 * (subscriberId, type) — see the module doc above — rather than checking
 * `findOpenDsarRequest` first and racing another writer between the check
 * and the insert.
 */
export async function createDsarRequest(
  db: Db,
  input: CreateDsarRequestInput,
): Promise<DsarRequest> {
  const [row] = await db
    .insert(dsarRequests)
    .values({
      projectId: input.projectId,
      subscriberId: input.subscriberId,
      type: input.type,
      requestedBy: input.requestedBy,
    })
    .returning();
  if (!row) throw new Error("createDsarRequest: insert returned no row");
  return row;
}

// ---------------------------------------------------------------------------
// claimDsarRequest
// ---------------------------------------------------------------------------

// Both dsar-export.ts and dsar-erasure.ts run the identical
// claim-then-work-then-complete lifecycle: on ANY failure (including a
// failure of the FAILED-transition write itself — a transient DB fault is
// enough) the catch's own transaction can throw and escape the worker
// before the row is marked FAILED. BullMQ still retries the job, but the
// retry's claim used to see `status <> 'PENDING'` and treat the row as an
// already-claimed no-op, reporting job SUCCESS and leaving the row
// permanently RUNNING — with no reaper anywhere to ever revisit it.
//
// The fix folds "orphaned RUNNING" recovery into the SAME conditional
// UPDATE both workers already share, mirroring this codebase's existing
// claim-lease convention: `WEBHOOK_CLAIM_LEASE_MS`
// (webhook-events.ts's `claimWebhookEvent`) and `CLAIM_LEASE_MS`
// (outgoing-webhooks.ts) both use this exact 5-minute window for the same
// "was the claimant a worker that crashed, or one still legitimately
// working" question, and both are already argued elsewhere in this
// codebase to exceed the slowest realistic handler run by a wide margin.
// For DSAR specifically: the erasure worker's own longest bounded step
// (`DSAR_ERASURE_MUTATION_WAIT_TIMEOUT_MS`, dsar-erasure.ts) times out at
// 60s, so a healthy erasure run finishes in well under two minutes; a
// healthy export is a single subscriber's own data (never a bulk/tenant
// export), not the kind of job expected to run for minutes. Five minutes
// is comfortably above either's realistic runtime, so it cannot steal a
// row from a worker that is still genuinely in flight — while staying
// below the DSAR queues' own cumulative BullMQ backoff window before the
// final retry attempt (30s+60s+120s+240s = 450s, from
// `DSAR_JOB_ATTEMPTS`/`DSAR_JOB_BACKOFF_MS` in apps/api/src/queues/dsar.ts),
// so a genuinely wedged row gets reclaimed by a retry before the job's
// attempts are exhausted rather than staying wedged forever.
export const DSAR_CLAIM_STALE_RUNNING_MS = 5 * 60_000;

/**
 * Conditional UPDATE PENDING|stale-RUNNING -> RUNNING. Returns the claimed
 * row, or null if another worker already claimed it and is still within
 * its lease (or the row is terminal). The caller must treat null as
 * "someone else has this", not as an error, so a request is never worked
 * twice.
 *
 * A row is claimable when it is PENDING, OR it is RUNNING but its
 * `updatedAt` predates `now - DSAR_CLAIM_STALE_RUNNING_MS` — i.e. no
 * claim/complete/fail transition has touched it inside the lease window,
 * which only happens when the worker that claimed it crashed or hit the
 * double-fault above. A fresh RUNNING row (updatedAt inside the window)
 * is NOT reclaimable — see this file's `dsar-requests.integration.test.ts`
 * counterpart for both directions.
 */
export async function claimDsarRequest(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<DsarRequest | null> {
  const staleBefore = new Date(now.getTime() - DSAR_CLAIM_STALE_RUNNING_MS);
  const [row] = await db
    .update(dsarRequests)
    .set({ status: "RUNNING", updatedAt: now })
    .where(
      and(
        eq(dsarRequests.id, id),
        or(
          eq(dsarRequests.status, "PENDING"),
          and(eq(dsarRequests.status, "RUNNING"), lt(dsarRequests.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// completeDsarRequest
// ---------------------------------------------------------------------------

export interface CompleteDsarRequestArgs {
  id: string;
  /** Null for ERASURE, which produces no artifact. */
  artifactKey: string | null;
  /** Null for ERASURE. */
  expiresAt: Date | null;
}

export async function completeDsarRequest(
  db: Db,
  args: CompleteDsarRequestArgs,
): Promise<DsarRequest> {
  const now = new Date();
  const [row] = await db
    .update(dsarRequests)
    .set({
      status: "COMPLETED",
      artifactKey: args.artifactKey,
      expiresAt: args.expiresAt,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(dsarRequests.id, args.id))
    .returning();
  if (!row) throw new Error(`completeDsarRequest: id=${args.id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// failDsarRequest
// ---------------------------------------------------------------------------

export async function failDsarRequest(
  db: Db,
  id: string,
  error: string,
): Promise<DsarRequest> {
  const [row] = await db
    .update(dsarRequests)
    .set({ status: "FAILED", error, updatedAt: new Date() })
    .where(eq(dsarRequests.id, id))
    .returning();
  if (!row) throw new Error(`failDsarRequest: id=${id} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// findDsarRequestById
// ---------------------------------------------------------------------------
//
// Not project-scoped, matching `import-jobs.ts`'s `getImportJobById`
// precedent: `id` is a full, unguessable cuid2 scope on its own, and every
// caller that reaches this with a caller-supplied id (the download route)
// authorises separately by re-resolving the row's own `subscriberId`
// against the calling project — the same pattern the DSAR routes already
// use for every other lookup.

export async function findDsarRequestById(
  db: Db,
  id: string,
): Promise<DsarRequest | null> {
  const rows = await db.select().from(dsarRequests).where(eq(dsarRequests.id, id));
  return rows[0] ?? null;
}
