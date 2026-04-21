import { createHash } from "node:crypto";
import { drizzle } from "@rovenue/db";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";

// =============================================================
// GDPR / KVKK right-to-erasure — subscriber anonymization
// =============================================================
//
// Append-only ledgers (credit_ledger, audit_logs, revenue_events)
// make a hard DELETE impossible without breaking referential
// integrity and tamper-evident chains. Instead we anonymize: the
// subscriber row's appUserId is replaced with a deterministic
// `anon_<sha256[:24]>` token derived from the subscriberId, the
// attributes JSON is cleared, and deletedAt is stamped.
//
// The anonymous id is *deterministic* so re-running anonymization
// on the same subscriber (idempotent retry, reconciliation) yields
// the same token — never creating a second shadow identity.

const log = logger.child("gdpr:anonymize");

export type AnonymizeReason =
  | "gdpr_request"
  | "kvkk_request"
  | "retention_policy";

export interface AnonymizeSubscriberInput {
  subscriberId: string;
  projectId: string;
  actorUserId: string;
  reason?: AnonymizeReason;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function deriveAnonymousId(subscriberId: string): string {
  const hex = createHash("sha256").update(subscriberId).digest("hex");
  return `anon_${hex.slice(0, 24)}`;
}

export async function anonymizeSubscriber(
  input: AnonymizeSubscriberInput,
): Promise<{ anonymousId: string }> {
  const anonymousId = deriveAnonymousId(input.subscriberId);
  const deletedAt = new Date();

  await drizzle.db.transaction(async (tx) => {
    await drizzle.subscriberRepo.anonymizeSubscriberRow(
      tx,
      input.subscriberId,
      anonymousId,
      deletedAt,
    );

    await audit(
      {
        projectId: input.projectId,
        userId: input.actorUserId,
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: input.subscriberId,
        before: null,
        after: null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
  });

  log.info("subscriber anonymized", {
    subscriberId: input.subscriberId,
    projectId: input.projectId,
    reason: input.reason ?? "gdpr_request",
  });

  return { anonymousId };
}
