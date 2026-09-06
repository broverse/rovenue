import { and, eq, inArray } from "drizzle-orm";
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

/**
 * Conditional UPDATE PENDING -> RUNNING. Returns the claimed row, or null
 * if another worker already claimed it (or it is not PENDING at all) —
 * the caller must treat null as "someone else has this", not as an error,
 * so a request is never worked twice.
 */
export async function claimDsarRequest(
  db: Db,
  id: string,
): Promise<DsarRequest | null> {
  const [row] = await db
    .update(dsarRequests)
    .set({ status: "RUNNING", updatedAt: new Date() })
    .where(and(eq(dsarRequests.id, id), eq(dsarRequests.status, "PENDING")))
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
