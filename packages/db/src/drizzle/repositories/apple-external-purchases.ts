import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import { appleExternalPurchases } from "../schema";

// =============================================================
// apple_external_purchases
// =============================================================
//
// Apple's EXTERNAL_PURCHASE_TOKEN notification records that AN external
// purchase happened in the app — not whose. There is no subscriber to
// attach it to and no amount to record, so this repository deliberately
// offers no subscriber lookup and no revenue write.

export interface RecordExternalPurchaseInput {
  projectId: string;
  externalPurchaseId: string;
  tokenCreationDate: Date | null;
  appAppleId: number | null;
  webhookEventId: string | null;
}

/**
 * Idempotent by `(projectId, externalPurchaseId)`. Apple retries
 * notifications, and the inbound `webhook_events` dedup does not cover a
 * redelivery that arrives with a fresh event row, so the unique index is
 * the real guarantee.
 */
export async function recordExternalPurchase(
  db: Db,
  input: RecordExternalPurchaseInput,
): Promise<void> {
  await db
    .insert(appleExternalPurchases)
    .values({
      projectId: input.projectId,
      externalPurchaseId: input.externalPurchaseId,
      tokenCreationDate: input.tokenCreationDate,
      appAppleId: input.appAppleId,
      webhookEventId: input.webhookEventId,
    })
    .onConflictDoNothing({
      target: [
        appleExternalPurchases.projectId,
        appleExternalPurchases.externalPurchaseId,
      ],
    });
}

export async function findExternalPurchase(
  db: Db,
  projectId: string,
  externalPurchaseId: string,
) {
  const rows = await db
    .select()
    .from(appleExternalPurchases)
    .where(
      and(
        eq(appleExternalPurchases.projectId, projectId),
        eq(appleExternalPurchases.externalPurchaseId, externalPurchaseId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
