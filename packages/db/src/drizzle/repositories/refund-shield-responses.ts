import { eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  refundShieldResponses,
  type RefundShieldResponse,
} from "../schema";

// `DbOrTx` mirrors the convention used by every other repository in
// this package — the Drizzle tx handle has the same insert/select
// surface as the top-level db client, so a single type alias covers
// both call sites.
type DbOrTx = Db;

export type RefundShieldStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_NOT_FOUND"
  | "SKIPPED_DISABLED";

export interface InsertConsumptionRequestInput {
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: RefundShieldStatus;
}

/**
 * Idempotent insert of a CONSUMPTION_REQUEST work-queue row. The
 * unique index on `apple_notification_uuid` guarantees the second
 * delivery of the same Apple notification is a no-op — this is the
 * idempotency guarantee that lets the Apple webhook safely retry
 * without producing duplicate responder work.
 */
export async function insertConsumptionRequest(
  db: DbOrTx,
  input: InsertConsumptionRequestInput,
): Promise<void> {
  await db
    .insert(refundShieldResponses)
    .values({
      projectId: input.projectId,
      subscriberId: input.subscriberId,
      appleNotificationUuid: input.appleNotificationUuid,
      appleOriginalTransactionId: input.appleOriginalTransactionId,
      appleTransactionId: input.appleTransactionId,
      detectedAt: input.detectedAt,
      scheduledFor: input.scheduledFor,
      status: input.status,
    })
    .onConflictDoNothing({ target: refundShieldResponses.appleNotificationUuid });
}

/**
 * Lookup by notification UUID — exposed for tests / dashboard.
 * Returns the first (and, by unique index, only) matching row.
 */
export async function findByNotificationUuid(
  db: Db,
  appleNotificationUuid: string,
): Promise<RefundShieldResponse | null> {
  const rows = await db
    .select()
    .from(refundShieldResponses)
    .where(eq(refundShieldResponses.appleNotificationUuid, appleNotificationUuid))
    .limit(1);
  return rows[0] ?? null;
}
