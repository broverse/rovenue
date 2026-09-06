import { createHmac } from "node:crypto";
import { drizzle } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { env } from "../../lib/env";
import { getConnectedStripe } from "../../lib/stripe-platform";

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
  | "retention_policy"
  // A self-service DSAR erasure (workers/dsar-erasure.ts, ROADMAP §9.1
  // Task 5), reached via POST /v1/dsar/erasure. Distinct from
  // "gdpr_request" / "kvkk_request" (an admin's own jurisdiction choice
  // made from the dashboard — routes/dashboard/subscribers.ts) and from
  // "retention_policy" (the automated nightly sweep,
  // workers/retention-sweep.ts): a bare `dsar_requests` row carries no
  // jurisdiction field for the worker to read, so this reason exists
  // purely to keep the audit trail honest about which path triggered
  // the anonymisation.
  | "dsar_request";

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

  // Read the live Stripe subscription ids INSIDE the transaction (before
  // the row flips), cancelled after commit — Stripe roundtrips must not
  // run while a DB transaction is open.
  let stripeSubscriptionIds: string[] = [];

  await drizzle.db.transaction(async (tx) => {
    stripeSubscriptionIds =
      await drizzle.purchaseRepo.findActiveStripeSubscriptionIds(
        tx,
        input.subscriberId,
      );

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

  // Post-commit, best-effort: cancel the forgotten customer's live funnel
  // subscriptions on the connected account so they are not billed again —
  // erasure that keeps charging the customer isn't erasure. A failure here
  // must not undo the anonymization (the row is already flipped); log for
  // follow-up. No connection → the subscriptions are unreachable anyway.
  if (stripeSubscriptionIds.length > 0) {
    const connected = await getConnectedStripe(input.projectId).catch(
      () => null,
    );
    if (connected) {
      for (const subscriptionId of stripeSubscriptionIds) {
        try {
          await connected.account.subscriptions.cancel(subscriptionId);
          log.info("cancelled a forgotten customer's stripe subscription", {
            projectId: input.projectId,
            subscriberId: input.subscriberId,
            subscriptionId,
          });
        } catch (err) {
          log.error("could not cancel a forgotten customer's subscription", {
            projectId: input.projectId,
            subscriberId: input.subscriberId,
            subscriptionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      log.warn(
        "erased subscriber has stripe subscriptions but no live connection to cancel them",
        {
          projectId: input.projectId,
          subscriberId: input.subscriberId,
          count: stripeSubscriptionIds.length,
        },
      );
    }
  }

  return { anonymousId, deletedAt };
}
