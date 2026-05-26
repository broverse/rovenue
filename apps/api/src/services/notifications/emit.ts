import { getEvent } from "@rovenue/shared/notifications";
import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// emitNotification — outbox writer for the notifier pipeline
// =============================================================
//
// Domain code calls this inside an existing transaction so the
// outbox row commits/rolls back atomically with whatever OLTP
// write triggered the notification (member invite, refund row,
// store-credential rotation, …).
//
// The outbox_events table has no `eventId` column — Kafka-side
// idempotency is the consumer's job (the notifier worker uses
// notifications.eventKey+eventId for dedup). We still propagate
// the caller-supplied eventId via the payload JSON so the consumer
// can build that key without inventing one.

export interface EmitNotificationInput {
  /** Event catalog key, e.g. "security.signin.new_device". */
  eventKey: string;
  /** Deterministic deduplication key — consumer dedups on (eventKey, eventId). */
  eventId: string;
  /** Project the event belongs to (optional for account-level events). */
  projectId?: string;
  /** Recipient user IDs when scope === "self"; ignored otherwise. */
  recipients?: string[];
  /** Per-event template context — validated against the event's zod schema. */
  context: Record<string, unknown>;
}

export async function emitNotification(
  tx: Db,
  input: EmitNotificationInput,
): Promise<void> {
  const event = getEvent(input.eventKey);
  const parsed = event.contextSchema.safeParse(input.context);
  if (!parsed.success) {
    throw new Error(
      `invalid context for ${input.eventKey}: ${parsed.error.message}`,
    );
  }

  const payload: Record<string, unknown> = {
    eventKey: input.eventKey,
    eventId: input.eventId,
    projectId: input.projectId,
    recipients: input.recipients,
    context: parsed.data,
  };

  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "NOTIFICATION",
    aggregateId: input.projectId ?? "account",
    eventType: input.eventKey,
    payload,
  });
}
