import { createHmac } from "node:crypto";
import { drizzle } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { env } from "../../lib/env";

// =============================================================
// GDPR / KVKK right-to-erasure — subscriber anonymization
// =============================================================
//
// Append-only ledgers (credit_ledger, audit_logs, revenue_events)
// make a hard DELETE impossible without breaking referential
// integrity and tamper-evident chains. Instead we anonymize: the
// subscriber row's appUserId is replaced with a deterministic
// `anon_<hmac[:24]>` token derived from the subscriberId, the
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
  reason: AnonymizeReason;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// Derive a per-deployment anonymous id. Using HMAC with the master
// encryption key as the pepper means the mapping from subscriberId →
// anonymousId cannot be recomputed by anyone without the key — even
// if they know the subscriberId (which, being a cuid2, appears in
// logs, webhooks, and other retained records). Deterministic within
// a deployment so retries are idempotent; breaks across deployments
// with rotated keys, which is the correct security/operational trade
// (rotating the pepper re-anonymizes everyone, intentionally).
function deriveAnonymousId(subscriberId: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY as string, "hex");
  const hex = createHmac("sha256", key).update(subscriberId).digest("hex");
  return `anon_${hex.slice(0, 24)}`;
}

export async function anonymizeSubscriber(
  input: AnonymizeSubscriberInput,
): Promise<{ anonymousId: string; deletedAt: Date }> {
  // Verify the subscriber belongs to this project before doing any
  // work. Route-level `assertProjectAccess` only checks that the
  // caller is an ADMIN of the project in the URL — it doesn't tie the
  // subscriberId to that project. Without this check an ADMIN of
  // project A who knows a subscriberId from project B could anonymize
  // (or export) that row. Return 404 instead of 403 so we don't leak
  // the existence of the subscriber across tenants.
  const [subscriberRow] = await drizzle.db
    .select({
      id: drizzle.schema.subscribers.id,
      projectId: drizzle.schema.subscribers.projectId,
    })
    .from(drizzle.schema.subscribers)
    .where(eq(drizzle.schema.subscribers.id, input.subscriberId));

  if (!subscriberRow) {
    throw new HTTPException(404, {
      message: `Subscriber not found: ${input.subscriberId}`,
    });
  }
  if (subscriberRow.projectId !== input.projectId) {
    throw new HTTPException(404, {
      message: `Subscriber not found: ${input.subscriberId}`,
    });
  }

  const anonymousId = deriveAnonymousId(input.subscriberId);
  const deletedAt = new Date();

  await drizzle.db.transaction(async (tx) => {
    await drizzle.subscriberRepo.anonymizeSubscriberRow(
      tx,
      input.subscriberId,
      anonymousId,
      deletedAt,
    );

    // TODO(audit-tx): once audit() re-threads _callerTx we should
    // pass `tx` to guarantee atomicity with the row update. Today
    // audit() opens its own transaction (see apps/api/src/lib/
    // audit.ts:205-212 comment), so the row update and audit entry
    // commit independently. Pre-existing limitation, not a Task 4.1
    // regression.
    await audit(
      {
        projectId: input.projectId,
        userId: input.actorUserId,
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: input.subscriberId,
        before: null,
        after: { reason: input.reason, anonymousId },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
  });

  log.info("subscriber anonymized", {
    subscriberId: input.subscriberId,
    anonymousId,
    projectId: input.projectId,
    reason: input.reason,
  });

  return { anonymousId, deletedAt };
}
