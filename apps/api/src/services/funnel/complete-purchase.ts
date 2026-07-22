import { drizzle } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { isUniqueViolationOf } from "../../lib/pg-errors";
import { emitFunnelEvent } from "./outbox";
import { generateClaimToken, hashToken } from "./token";

// =============================================================
// Completing a paid funnel session
// =============================================================
//
// Two callers race here on purpose: the browser's /confirm and the
// Connect webhook (for the buyer who closed the tab). Either may win, so
// this must be idempotent — and because only the token's HASH is stored,
// the plaintext exists exactly once, in the winner's return value. The
// loser gets `alreadyIssued: true` and no token rather than a fake one.

const log = logger.child("funnel-complete-purchase");

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The unique constraint on `funnel_claim_tokens.session_id`, created by
 * migration 0050_funnel_core.sql and left in place by 0051 (which drops
 * only the FK into the now-partitioned funnel_sessions).
 *
 * The INSERT below can violate three different unique constraints —
 * this one, `funnel_claim_tokens_token_hash_unique`, and the primary
 * key. Only this one means "another caller already issued the token for
 * this session"; the other two mean the token generator or the id
 * generator collided, which is not a race we may swallow. Reporting
 * those as `alreadyIssued` would roll back the paid transition and
 * leave a buyer who really paid sitting at `pending` with no token, so
 * they must surface as errors.
 */
const SESSION_ID_UNIQUE = "funnel_claim_tokens_session_id_unique";

/**
 * Drizzle does not rethrow the driver's error — it wraps it and hangs
 * the `pg` error off `.cause`, so the code and the constraint live one
 * level down. `isUniqueViolationOf` walks that chain; see lib/pg-errors.
 */
function isSessionTokenRace(err: unknown): boolean {
  return isUniqueViolationOf(err, SESSION_ID_UNIQUE);
}

export type CompleteResult =
  | { alreadyIssued: false; token: string }
  | { alreadyIssued: true };

export async function completeFunnelPurchase(input: {
  sessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
}): Promise<CompleteResult> {
  const plaintext = generateClaimToken();

  return drizzle.db.transaction(async (tx) => {
    const session = await drizzle.funnelSessionRepo.findById(tx, input.sessionId);
    if (!session) throw new Error(`funnel session ${input.sessionId} not found`);

    const purchase = await drizzle.funnelPurchaseRepo.findBySession(
      tx,
      input.sessionId,
    );
    if (!purchase) {
      throw new Error(`no purchase for funnel session ${input.sessionId}`);
    }
    if (purchase.status === "paid") {
      log.info("funnel session already completed; not minting a second token", {
        sessionId: input.sessionId,
      });
      return { alreadyIssued: true };
    }

    // Anchor a synthetic subscriber on the Stripe customer. The Connect
    // webhook's resolveSubscriber falls back to the same `stripe:<id>`
    // shape, so both paths converge on one row instead of fabricating
    // two identities for the same buyer. The claim merges it into the
    // installed subscriber later.
    const subscriber = await drizzle.subscriberRepo.upsertSubscriber(tx, {
      projectId: session.projectId,
      rovenueId: `stripe:${input.stripeCustomerId}`,
      appUserId: `stripe:${input.stripeCustomerId}`,
      createAttributes: { stripe_customer_id: input.stripeCustomerId },
    });

    await drizzle.funnelPurchaseRepo.markPaid(tx, purchase.id, {
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      subscriberId: subscriber.id,
    });
    await drizzle.funnelSessionRepo.setState(tx, input.sessionId, "paid");

    // The `status === "paid"` read above is a cheap short-circuit, not the
    // thing that makes this safe: at READ COMMITTED two racers can both
    // read `pending` and both arrive here. What actually decides the race
    // is the unique index on `funnel_claim_tokens.session_id` — exactly
    // one INSERT can win. The loser's 23505 aborts its transaction, so
    // everything it wrote above (markPaid, setState) is rolled back, which
    // is harmless precisely because the winner committed the identical
    // transition. All that is left to do is report it honestly instead of
    // letting a routine race surface as a 500.
    let tokenRow: { id: string };
    try {
      tokenRow = await drizzle.funnelClaimTokenRepo.insert(tx, {
        tokenHash: hashToken(plaintext),
        sessionId: input.sessionId,
        projectId: session.projectId,
        // Carried across from the purchase row, which is where the
        // payment-intent route parked it — this transaction never sees
        // the address itself, and asking Stripe for it would put a
        // network call inside an open transaction. Without this copy the
        // magic-link path has nothing to match on, which is the entire
        // reason a buyer who never returns to the tab can be reached at
        // all.
        //
        // `?? null` and not a throw: rows written before migration 0091
        // carry no hash, and a buyer who has genuinely paid must still
        // get their token. They simply lose the email fallback and keep
        // the session-id and deferred-match paths.
        emailHash: purchase.emailHash ?? null,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      });
    } catch (err) {
      if (!isSessionTokenRace(err)) throw err;
      log.info("lost the claim-token insert race; another caller issued it", {
        sessionId: input.sessionId,
      });
      return { alreadyIssued: true };
    }

    const payload = {
      funnel_id: session.funnelId,
      version_id: session.funnelVersionId,
      project_id: session.projectId,
      purchase_id: purchase.id,
      token_id: tokenRow.id,
    };
    await emitFunnelEvent(tx, "funnel.session.paid", input.sessionId, payload);
    await emitFunnelEvent(
      tx,
      "funnel.claim_token.issued",
      input.sessionId,
      payload,
    );

    return { alreadyIssued: false, token: plaintext };
  });
}
