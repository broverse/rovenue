import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
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
//
// For DSAR specifically — Fix Round 2 (this file's own history has two
// people re-deriving this wrong, so the number is pinned here instead of
// left to a comment someone has to re-check by hand):
//
// An EARLIER version of this comment quoted the erasure worker's
// single-mutation timeout (60s) as if it were the job's longest bounded
// step. That was already false when it was written: the ClickHouse table
// list the worker purges (`DSAR_ERASURE_CLICKHOUSE_TABLES`,
// apps/api/src/workers/dsar-erasure.ts) had grown from the task spec's
// two tables to five, and `purgeSubscriberFromClickHouseTables` waited
// for each table's mutation with its OWN independent 60s budget — so the
// real worst case was 5 x 60s = 300000ms, exactly equal to this constant
// with ZERO margin, before even counting the Postgres anonymisation,
// audit rows, or the five mutation submissions themselves. The fix is
// `purgeSubscriberFromClickHouseTables` sharing ONE total wait budget
// across every table instead of giving each its own — see
// `DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS` immediately below,
// which is owned HERE (not in dsar-erasure.ts) specifically so this
// threshold can be defined as a sum instead of a re-typed number: a
// future change to the purge budget moves this threshold with it
// automatically, and a sixth ClickHouse table added to that worker's
// list can never silently push the real worst case past what this
// threshold assumes, because the worst case no longer scales with the
// table count at all.
//
// `DSAR_CLAIM_STALE_RUNNING_MARGIN_MS` covers everything in a healthy
// erasure run OUTSIDE that ClickHouse wait — the Postgres
// `anonymizeSubscriber` write and its audit row, the five `ALTER TABLE
// ... DELETE` submission round-trips (fast HTTP calls, not the wait
// itself), and the final complete/audit transaction — plus slack so a
// healthy run never realistically approaches the combined threshold. A
// healthy export is a single subscriber's own data (never a bulk/tenant
// export), so it finishes in a small fraction of either number.
//
// The resulting threshold (240s) stays comfortably below the DSAR
// queues' own cumulative BullMQ backoff window before the final retry
// attempt (30s+60s+120s+240s = 450s, from
// `DSAR_JOB_ATTEMPTS`/`DSAR_JOB_BACKOFF_MS` in apps/api/src/queues/dsar.ts).
//
// Correctness-of-reasoning note (roadmap-9a final fix wave, Finding 4):
// that 450s comparison is NOT general cover for "a genuinely wedged row
// gets reclaimed before BullMQ gives up" — it only protects ONE narrow
// case. Both `runDsarExport` and `runDsarErasure` catch every ORDINARY
// failure (a ClickHouse timeout, a storage error, either fail-closed
// check) and resolve with `{ outcome: "failed" }` rather than throwing —
// from BullMQ's point of view that job RESOLVED, so it is marked
// succeeded and never retried, regardless of `DSAR_JOB_ATTEMPTS`. The
// 450s window (and this constant's margin below it) only matters on the
// DOUBLE fault this whole comment block is about: the ordinary failure is
// caught, AND the catch block's own FAILED-transition write also throws,
// so the throw escapes the worker function uncaught and the job's promise
// genuinely rejects — only then does BullMQ retry, and only then does the
// 240s-vs-450s margin do any work. An ordinary single-fault row is
// instead left FAILED (terminal, no longer "open") and recovered a
// different way entirely: the next `POST /v1/dsar/export` or `/erasure`
// for that subject starts a brand-new request and job
// (`findOpenDsarRequest` no longer returns the FAILED row) — this
// constant plays no part in that path, and does nothing for a row that
// never got a job enqueued in the first place (see routes/v1/dsar.ts's
// own Finding-3 fix for that separate gap).

/**
 * The TOTAL wait budget `purgeSubscriberFromClickHouseTables`
 * (apps/api/src/workers/dsar-erasure.ts) shares across every table in
 * `DSAR_ERASURE_CLICKHOUSE_TABLES` — a single deadline computed once per
 * purge, not a fresh budget per table. Owned here rather than in
 * dsar-erasure.ts: apps/api depends on packages/db, never the reverse, so
 * `DSAR_CLAIM_STALE_RUNNING_MS` below can only derive from this value
 * (rather than re-stating it) if it lives on this side of that boundary.
 * apps/api imports this constant (`drizzle.dsarRequestRepo
 * .DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS`) as the default total
 * budget for that purge, so the two numbers cannot drift apart.
 *
 * 90s: 1.5x the previous single-table 60s figure, to absorb realistic
 * contention between mutations ClickHouse now runs CONCURRENTLY (all
 * five DELETEs are submitted up front — see dsar-erasure.ts's module
 * doc), while staying a single constant that does not grow with the
 * table count.
 */
export const DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS = 90_000;

/**
 * Slack added on top of `DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS` to
 * get `DSAR_CLAIM_STALE_RUNNING_MS`. See the module doc above for what it
 * covers.
 */
export const DSAR_CLAIM_STALE_RUNNING_MARGIN_MS = 150_000;

// Worst case this constant assumes: 90s (ClickHouse purge, shared total)
// + 150s (everything else, argued above) = 240s. That is >1.6x the purge
// budget alone, and the combined 240s stays well under the 450s BullMQ
// backoff window checked above. Expressed as a sum of two named
// constants, not a re-typed literal, so raising the purge budget without
// revisiting this line is structurally impossible — see
// `dsar-requests.integration.test.ts`'s (or the sibling unit test's) pin
// on this exact relationship.
export const DSAR_CLAIM_STALE_RUNNING_MS =
  DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS + DSAR_CLAIM_STALE_RUNNING_MARGIN_MS;

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

// ---------------------------------------------------------------------------
// findCompletedExportArtifactsForSubscriber / invalidateExportArtifacts
// ---------------------------------------------------------------------------
//
// Finding 1 (roadmap-9a final fix wave): erasure never touched object
// storage, so a COMPLETED export's artifact — which contains the same
// appUserId, attributes, purchases and full credit_ledger erasure exists
// to remove — outlived it, downloadable for its full 30-day
// `DSAR_ARTIFACT_TTL_DAYS` window (and reachable in the bucket forever
// after that, since import-retention.ts only ever deletes keys it reads
// off `import_jobs` rows, never a `dsar_requests` one). A subject can have
// MULTIPLE completed exports over their lifetime (dsar.mdx: asking again
// after a completed export produces a NEW artifact, not a refresh of the
// old one), so erasure must purge every one it finds, not just the most
// recent.

export interface CompletedExportArtifact {
  id: string;
  artifactKey: string;
}

/**
 * Every COMPLETED EXPORT row for this subscriber that still points at a
 * live artifact. `workers/dsar-erasure.ts` deletes each returned
 * `artifactKey` from storage (OUTSIDE any DB transaction — storage writes
 * never run inside one, per this repo's convention) and then calls
 * `invalidateExportArtifacts` with the matching ids.
 */
export async function findCompletedExportArtifactsForSubscriber(
  db: Db,
  subscriberId: string,
): Promise<CompletedExportArtifact[]> {
  const rows = await db
    .select({ id: dsarRequests.id, artifactKey: dsarRequests.artifactKey })
    .from(dsarRequests)
    .where(
      and(
        eq(dsarRequests.subscriberId, subscriberId),
        eq(dsarRequests.type, "EXPORT"),
        eq(dsarRequests.status, "COMPLETED"),
        isNotNull(dsarRequests.artifactKey),
      ),
    );
  // The isNotNull filter above already guarantees this at the SQL level;
  // this narrows Drizzle's inferred `string | null` back to `string` for
  // callers without an unsound cast.
  return rows.filter(
    (row): row is CompletedExportArtifact => row.artifactKey != null,
  );
}

/**
 * Clears `artifactKey`/`expiresAt` on a set of already-COMPLETED EXPORT
 * rows once their artifact has been deleted from storage — see
 * `findCompletedExportArtifactsForSubscriber` and
 * `workers/dsar-erasure.ts`'s Finding-1 fix. `status` and `completedAt`
 * are left untouched: the export genuinely did complete at the time it
 * ran; only its now-deleted artifact stops being downloadable. A no-op on
 * an empty list (erasure calls this unconditionally after the storage
 * loop, whether or not there was anything to purge).
 */
export async function invalidateExportArtifacts(
  db: Db,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(dsarRequests)
    .set({ artifactKey: null, expiresAt: null, updatedAt: new Date() })
    .where(inArray(dsarRequests.id, ids));
}
