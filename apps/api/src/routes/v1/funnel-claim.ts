// =============================================================
// /v1/subscribers/claim-funnel-token + /v1/sdk/claim-* — SDK
// =============================================================
//
// Three endpoints share this file because they all close out
// the onboarding funnel handshake:
//
//   POST /subscribers/claim-funnel-token  — known plaintext path
//   POST /sdk/claim-install               — Android Referrer or
//     iOS fingerprint recovery when no token reached the SDK
//     through any user-visible path.
//
// (Email magic-link fallback joins this file in Task 35.)
//
// Gated by API key auth (PUBLIC or SECRET) via the shared /v1
// middleware: the project id lives at `c.get("project").id`.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import {
  generateClaimToken,
  hashToken,
  safeEqualHash,
} from "../../services/funnel/token";
import { parseInstallReferrer } from "../../services/funnel/install-referrer";
import {
  fingerprintsMatch,
  normalizeFingerprint,
  type NormalizedFingerprint,
} from "../../services/funnel/fingerprint";

// =============================================================
// Body schemas
// =============================================================

const claimTokenBody = z.object({
  token: z.string().min(40).max(64),
  anon_id: z.string().min(1).max(64),
});

const claimInstallBody = z.object({
  platform: z.enum(["ios", "android"]),
  locale: z.string().min(2).max(16),
  timezone: z.string().min(1).max(64),
  screen_dims: z.string().regex(/^\d+x\d+$/),
  device_model: z.string().max(64).optional(),
  install_referrer: z.string().max(2048).optional(),
  install_id: z.string().min(1).max(128),
});

// =============================================================
// Helpers
// =============================================================

function readIp(c: import("hono").Context): string {
  return (
    c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? ""
  );
}

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
      if (!safeEqualHash(tokenRow.tokenHash, tokenHash)) {
        throw new HTTPException(404, { message: "Unknown token" });
      }
      if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
        throw new HTTPException(410, { message: "Token expired" });
      }

      const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        { projectId: project.id, appUserId: anon_id },
      );

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
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      await drizzle.funnelSessionRepo.setState(
        drizzle.db,
        tokenRow.sessionId,
        "completed",
      );

      const body = await buildClaimResponse(tokenRow.sessionId, subscriber.id);
      return c.json({ data: body });
    },
  )

  // ---------------------------------------------------------------
  // POST /sdk/claim-install — Android Referrer + iOS fingerprint
  // ---------------------------------------------------------------
  //
  // Two recovery paths:
  //
  //   Android: Google Play passes the install referrer string set
  //   by the universal-link redirect. We extract the embedded
  //   token, confirm the hash exists for this project, and hand
  //   the same plaintext back.
  //
  //   iOS: there is no install referrer — instead we stamped a
  //   `funnel_deferred_claims` fingerprint when the user tapped
  //   the universal link. The SDK now POSTs its own fingerprint;
  //   on a match we rotate the stored hash and return the *new*
  //   plaintext (so the original token in the URL trail is dead).
  // ---------------------------------------------------------------
  .post(
    "/sdk/claim-install",
    zValidator("json", claimInstallBody),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");

      if (body.platform === "android" && body.install_referrer) {
        const token = parseInstallReferrer(body.install_referrer);
        if (token) {
          const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(
            drizzle.db,
            hashToken(token),
          );
          if (tokenRow && tokenRow.projectId === project.id) {
            return c.json({ data: { token } });
          }
        }
        return c.json({ data: null }, 404);
      }

      if (body.platform === "ios") {
        const fp = normalizeFingerprint({
          ip: readIp(c),
          userAgent: c.req.header("user-agent") ?? "",
          locale: body.locale,
          timezone: body.timezone,
          screenDims: body.screen_dims,
          deviceModel: body.device_model ?? null,
        });

        const candidates =
          await drizzle.funnelDeferredClaimRepo.findRecentByIpHash(
            drizzle.db,
            fp.ipHash,
            new Date(),
          );

        for (const cand of candidates) {
          // The stored row's IP column is ALREADY hashed (the
          // deferred-claim insert ran it through hashIp at the
          // universal-link redirect step), so we substitute it
          // post-normalize instead of feeding raw IP back in.
          const candFp: NormalizedFingerprint = {
            ipHash: cand.ipHash,
            userAgent: cand.userAgent,
            locale: cand.locale,
            timezone: cand.timezone,
            screenDims: cand.screenDims,
            deviceModel: cand.deviceModel,
          };
          if (!fingerprintsMatch(fp, candFp)) continue;

          // Rotate the token hash so the original universal-link
          // plaintext can never be replayed. The new plaintext is
          // returned exactly once, to this SDK install.
          const fresh = generateClaimToken();
          await drizzle.funnelClaimTokenRepo.rotateHash(
            drizzle.db,
            cand.tokenId,
            hashToken(fresh),
          );
          await drizzle.funnelDeferredClaimRepo.markMatched(
            drizzle.db,
            cand.id,
            body.install_id,
          );
          return c.json({ data: { token: fresh } });
        }

        return c.json({ data: null }, 404);
      }

      // Android without referrer: nothing we can do.
      return c.json({ data: null }, 404);
    },
  );
