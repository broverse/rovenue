import { and, count, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../client";
import { outgoingWebhooks, type OutgoingWebhook } from "../schema";

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
