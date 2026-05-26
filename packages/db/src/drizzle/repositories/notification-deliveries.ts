// =============================================================
// notification-deliveries repo — Drizzle repository
// =============================================================
//
// Per-channel delivery records. The notifier worker creates one
// row per channel (email/push/inapp) when fanning out a
// notification; the send workers transition status as the
// underlying transport reports back. providerMessageId is the
// SES MessageId / FCM message_id / APNs apns-id used to
// correlate webhook feedback to the originating row.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import type { DbOrTx } from "./projects";
import {
  notificationDeliveries,
  notificationDeliveryStatus,
  type NewNotificationDelivery,
  type NotificationDelivery,
} from "../schema";

export type NotificationDeliveryStatus =
  (typeof notificationDeliveryStatus.enumValues)[number];

// ---------- writes ----------

/**
 * Batch insert. Order of returned rows mirrors the input order
 * because Postgres preserves VALUES ordering in RETURNING.
 */
export async function insertNotificationDeliveries(
  tx: DbOrTx,
  rows: NewNotificationDelivery[],
): Promise<NotificationDelivery[]> {
  if (rows.length === 0) return [];
  return tx.insert(notificationDeliveries).values(rows).returning();
}

/**
 * Apply a status transition from the send-worker callback. Always
 * bumps lastAttemptAt — the dispatcher uses it for backoff
 * decisions on retries.
 */
export async function markDeliveryStatus(
  db: Db,
  id: string,
  status: NotificationDeliveryStatus,
  patch?: { providerMessageId?: string; providerResponse?: unknown },
): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({
      status,
      lastAttemptAt: new Date(),
      ...(patch?.providerMessageId !== undefined && {
        providerMessageId: patch.providerMessageId,
      }),
      ...(patch?.providerResponse !== undefined && {
        providerResponse: patch.providerResponse as
          typeof notificationDeliveries.$inferInsert.providerResponse,
      }),
    })
    .where(eq(notificationDeliveries.id, id));
}

/**
 * Reverse lookup for SES/FCM/APNs feedback webhooks. providerMessageId
 * is unique-by-construction per channel (transports never collide on
 * their own ID space), so a row match identifies exactly one delivery.
 */
export async function findDeliveryByProviderMessageId(
  db: Db,
  providerMessageId: string,
): Promise<NotificationDelivery | null> {
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(
      eq(notificationDeliveries.providerMessageId, providerMessageId),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomic counter bump used by the retry path. Increment +
 * lastAttemptAt update in one round-trip so concurrent retries
 * never lose an attempt.
 */
export async function incrementDeliveryAttempts(
  db: Db,
  id: string,
): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({
      attempts: sql`${notificationDeliveries.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(eq(notificationDeliveries.id, id));
}
