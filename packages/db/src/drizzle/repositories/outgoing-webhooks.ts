import { and, count, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../client";
import { outgoingWebhooks, type OutgoingWebhook } from "../schema";

// DB or Drizzle tx handle — writes accept either.
type DbOrTx = Db;

/**
 * Dedup check: has this subscriber already been notified for
 * this event type + purchase? Used by webhook-processor to avoid
 * fan-out duplicates when a store retries the same notification.
 */
export async function findRecentOutgoingByPurchaseAndType(
  db: Db,
  projectId: string,
  subscriberId: string,
  eventType: string,
  purchaseId: string | null,
): Promise<OutgoingWebhook | null> {
  const clauses = [
    eq(outgoingWebhooks.projectId, projectId),
    eq(outgoingWebhooks.subscriberId, subscriberId),
    eq(outgoingWebhooks.eventType, eventType),
  ];
  if (purchaseId !== null) {
    clauses.push(eq(outgoingWebhooks.purchaseId, purchaseId));
  }
  const rows = await db
    .select()
    .from(outgoingWebhooks)
    .where(and(...clauses))
    .orderBy(desc(outgoingWebhooks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Outgoing webhook reads — Drizzle repository
// =============================================================
//
// Covers the dashboard's "failed webhooks" surface and the
// alert-threshold query.

export interface ListFailedArgs {
  projectId: string;
  limit: number;
  offset: number;
}

export async function listDeadWebhooks(
  db: Db,
  args: ListFailedArgs,
): Promise<OutgoingWebhook[]> {
  return db
    .select()
    .from(outgoingWebhooks)
    .where(
      and(
        eq(outgoingWebhooks.projectId, args.projectId),
        eq(outgoingWebhooks.status, "DEAD"),
      ),
    )
    .orderBy(desc(outgoingWebhooks.deadAt))
    .limit(args.limit)
    .offset(args.offset);
}

export async function countDeadWebhooks(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(outgoingWebhooks)
    .where(
      and(
        eq(outgoingWebhooks.projectId, projectId),
        eq(outgoingWebhooks.status, "DEAD"),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export async function countRecentDeadWebhooks(
  db: Db,
  projectId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(outgoingWebhooks)
    .where(
      and(
        eq(outgoingWebhooks.projectId, projectId),
        eq(outgoingWebhooks.status, "DEAD"),
        gte(outgoingWebhooks.deadAt, since),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export async function findOutgoingWebhookById(
  db: Db,
  id: string,
): Promise<OutgoingWebhook | null> {
  const rows = await db
    .select()
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Writes
// =============================================================

/**
 * Reset a DEAD webhook back to PENDING — used by the dashboard
 * retry endpoint. Clears every field that a previous attempt
 * could have populated so the worker starts from a clean slate.
 */
export async function resetWebhookForRetry(
  db: DbOrTx,
  id: string,
): Promise<OutgoingWebhook | null> {
  const rows = await db
    .update(outgoingWebhooks)
    .set({
      status: "PENDING",
      attempts: 0,
      nextRetryAt: null,
      deadAt: null,
      httpStatus: null,
      responseBody: null,
      lastErrorMessage: null,
    })
    .where(eq(outgoingWebhooks.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Mark a DEAD webhook as DISMISSED. Operators dismiss a dead
 * delivery when they've handled the underlying failure out of band
 * (e.g. redelivered manually) and want the banner cleared.
 */
export async function markWebhookDismissed(
  db: DbOrTx,
  id: string,
): Promise<OutgoingWebhook | null> {
  const rows = await db
    .update(outgoingWebhooks)
    .set({ status: "DISMISSED" })
    .where(eq(outgoingWebhooks.id, id))
    .returning();
  return rows[0] ?? null;
}

export interface EnqueueOutgoingWebhookInput {
  projectId: string;
  eventType: string;
  subscriberId: string;
  purchaseId: string | null;
  payload: unknown;
  url: string;
}

/**
 * Enqueue a webhook delivery. The worker picks it up via
 * pollDueWebhooks (raw SQL; see Phase 7d). We default status to
 * PENDING so the worker can claim the row on its next tick.
 */
export async function enqueueOutgoingWebhook(
  db: DbOrTx,
  input: EnqueueOutgoingWebhookInput,
): Promise<void> {
  await db.insert(outgoingWebhooks).values({
    projectId: input.projectId,
    eventType: input.eventType,
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    payload: input.payload as typeof outgoingWebhooks.$inferInsert.payload,
    url: input.url,
    status: "PENDING",
  });
}
