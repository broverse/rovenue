import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { webhookEvents, type WebhookEvent } from "../schema";

/** Idempotency lookup by (source, storeEventId) unique index. */
export async function findWebhookEventByStoreId(
  db: Db,
  source: "APPLE" | "GOOGLE" | "STRIPE",
  storeEventId: string,
): Promise<WebhookEvent | null> {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, source),
        eq(webhookEvents.storeEventId, storeEventId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** By primary id — used by the worker processor to hydrate the
 *  enqueued job payload after claiming it from the queue. */
export async function findWebhookEventById(
  db: Db,
  id: string,
): Promise<WebhookEvent | null> {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Webhook event reads — Drizzle repository
// =============================================================

export async function findLastProcessedWebhookAt(
  db: Db,
  projectId: string,
  source: "APPLE" | "GOOGLE" | "STRIPE",
): Promise<Date | null> {
  const rows = await db
    .select({ processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.projectId, projectId),
        eq(webhookEvents.source, source),
        eq(webhookEvents.status, "PROCESSED"),
      ),
    )
    .orderBy(desc(webhookEvents.processedAt))
    .limit(1);
  return rows[0]?.processedAt ?? null;
}
