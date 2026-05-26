// =============================================================
// /v1/subscribers/claim-funnel-token + /v1/sdk/claim-* — SDK
// =============================================================
//
// All endpoints in this file close out the onboarding funnel
// handshake. They live together because they share the token
// rotation + answer-payload shape; Task 33 introduces only the
// known-plaintext path. /sdk/claim-install and /sdk/claim-via-
// email arrive in Tasks 34 and 35.
//
// Gated by API key auth (PUBLIC or SECRET) via the shared /v1
// middleware: the project id lives at `c.get("project").id`.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { hashToken, safeEqualHash } from "../../services/funnel/token";

// =============================================================
// Body schemas
// =============================================================

const claimTokenBody = z.object({
  token: z.string().min(40).max(64),
  anon_id: z.string().min(1).max(64),
});

// =============================================================
// Helpers
// =============================================================

async function buildClaimResponse(
  sessionId: string,
  subscriberId: string,
): Promise<{
  subscriber_id: string;
  entitlements: string[];
  funnel_answers: Record<string, unknown>;
}> {
  const answers = await drizzle.funnelAnswerRepo.listBySession(
    drizzle.db,
    sessionId,
  );
  const funnel_answers: Record<string, unknown> = {};
  for (const a of answers) {
    const payload = a.answerJson as { value: unknown } | null;
    funnel_answers[a.questionId] = payload?.value;
  }
  return { subscriber_id: subscriberId, entitlements: [], funnel_answers };
}

// =============================================================
// Route chain
// =============================================================

export const funnelClaimRoute = new Hono()
  // ---------------------------------------------------------------
  // POST /subscribers/claim-funnel-token — known plaintext path
  // ---------------------------------------------------------------
  .post(
    "/subscribers/claim-funnel-token",
    zValidator("json", claimTokenBody),
    async (c) => {
      const project = c.get("project");
      const { token, anon_id } = c.req.valid("json");

      const tokenHash = hashToken(token);
      const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(
        drizzle.db,
        tokenHash,
      );
      if (!tokenRow || tokenRow.projectId !== project.id) {
        throw new HTTPException(404, { message: "Unknown token" });
      }
      // Defence-in-depth: catch a (theoretical) hash collision
      // before we honour a claim someone forged against an
      // already-discovered hash.
      if (!safeEqualHash(tokenRow.tokenHash, tokenHash)) {
        throw new HTTPException(404, { message: "Unknown token" });
      }
      if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
        throw new HTTPException(410, { message: "Token expired" });
      }

      // Resolve / upsert the subscriber so the claim binds to a
      // stable subscriber row.
      const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        { projectId: project.id, appUserId: anon_id },
      );

      // Idempotent reclaim by SAME subscriber: return the same
      // payload without retrying the UPDATE.
      if (tokenRow.claimedAt && tokenRow.claimedBySubscriberId) {
        if (tokenRow.claimedBySubscriberId === subscriber.id) {
          const body = await buildClaimResponse(tokenRow.sessionId, subscriber.id);
          return c.json({ data: body });
        }
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      const claimed = await drizzle.funnelClaimTokenRepo.tryClaim(
        drizzle.db,
        tokenRow.id,
        subscriber.id,
      );
      if (!claimed) {
        // Lost the race — someone else just claimed it.
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      // Flip session to completed so /state stops reporting it as
      // still in flight.
      await drizzle.funnelSessionRepo.setState(
        drizzle.db,
        tokenRow.sessionId,
        "completed",
      );

      const body = await buildClaimResponse(tokenRow.sessionId, subscriber.id);
      return c.json({ data: body });
    },
  );
