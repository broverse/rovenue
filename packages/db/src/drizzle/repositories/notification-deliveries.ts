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

import { and, eq, notInArray, sql } from "drizzle-orm";
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

// ---------- reads ----------

/**
 * Lightweight read used by send-workers to short-circuit duplicate
 * deliveries on BullMQ retry. Only fetches id + status to keep the
 * round-trip cheap.
 */
export async function findDeliveryById(
  db: DbOrTx,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: notificationDeliveries.id, status: notificationDeliveries.status })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id))
    .limit(1);
  return rows[0] ?? null;
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

/**
 * Statuses a delivery row can no longer be claimed-for-send from. `sent`
 * and `suppressed` are terminal from the worker's own write; `delivered`
 * and `bounced` are post-send terminal states fed by transport feedback
 * webhooks; `sending` means another job has already won the claim and is
 * mid-flight. A `queued` (fresh) or `failed` (genuine prior failure) row
 * is still claimable — preserving the BullMQ retry-after-FAILED path.
 */
const UNCLAIMABLE_SEND_STATUSES: NotificationDeliveryStatus[] = [
  "sending",
  "sent",
  "delivered",
  "bounced",
  "suppressed",
];

/**
 * Atomic single-flight claim for the send path. Flips a claimable row to
 * `sending` (bumping attempts + lastAttemptAt) in ONE statement, gated on
 * the status NOT already being terminal/in-flight, and RETURNS whether a
 * row was claimed.
 *
 * Because the UPDATE both tests and mutates `status`, two jobs racing for
 * the same `deliveryId` are serialised by the row lock: the first flips
 * `queued`/`failed` → `sending` and matches; the second re-evaluates its
 * predicate against the now-`sending` row and matches 0 rows. The caller
 * that gets `true` owns the send; `false` means already terminal or
 * another worker is mid-flight, so skip. This closes the concurrent-
 * duplicate TOCTOU window the plain findDeliveryById read left open.
 */
export async function claimDeliveryForSend(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await db
    .update(notificationDeliveries)
    .set({
      status: "sending",
      attempts: sql`${notificationDeliveries.attempts} + 1`,
      lastAttemptAt: now,
    })
    .where(
      and(
        eq(notificationDeliveries.id, id),
        notInArray(notificationDeliveries.status, UNCLAIMABLE_SEND_STATUSES),
      ),
    )
    .returning({ id: notificationDeliveries.id });
  return claimed.length > 0;
}
