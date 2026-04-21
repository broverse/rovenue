import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { webhookEvents } from "../schema";

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
