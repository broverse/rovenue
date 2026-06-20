// =============================================================
// /v1/subscribers/claim-funnel-token + /v1/sdk/claim-* — SDK
// =============================================================
//
// Three endpoints share this file because they all close out
// the onboarding funnel handshake:
//
//   POST /subscribers/claim-funnel-token  — known plaintext path
//     The most common case: the SDK is handed a token via deep
//     link / universal link / install referrer, posts here with
//     its `anon_id`, and gets back the funnel answers + an
//     entitlements snapshot.
//
//   POST /sdk/claim-install               — recover token by
//     fingerprint (iOS) or install referrer (Android) when the
//     SDK didn't receive a token through any user-visible path.
//
//   POST /sdk/claim-via-email             — last-resort magic
//     link sent to the email the user typed during the funnel.
//
// All three are gated by API key auth (PUBLIC or SECRET — the
// shared /v1 middleware applies `apiKeyAuth("any")`). The
// project id comes from `c.get("project").id`.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "@rovenue/db";
import {
  generateClaimToken,
  hashToken,
  safeEqualHash,
} from "../../services/funnel/token";
import { parseInstallReferrer } from "../../services/funnel/install-referrer";
import { emitFunnelEvent } from "../../services/funnel/outbox";
import { hashIp } from "../../services/funnel/fingerprint";
import { selectUniqueCandidate } from "../../services/funnel/deferred-match";
import { redis } from "../../lib/redis";
import { mailer } from "../../lib/mailer";

// =============================================================
// Body schemas
// =============================================================

const claimTokenBody = z.object({
  token: z.string().min(40).max(64),
  anon_id: z.string().min(1).max(64),
});

const claimInstallBody = z.object({
  platform: z.enum(["ios", "android"]),
  locale: z.string().max(16).optional(),
  timezone: z.string().max(64).optional(),
  screen_dims: z.string().max(16).optional(),
  device_model: z.string().max(64).optional(),
  install_referrer: z.string().max(2048).optional(),
  install_id: z.string().min(1).max(128),
});

const claimViaEmailBody = z.object({
  email: z.string().email().max(254),
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

async function sendFunnelMagicLink(
  email: string,
  nonce: string,
): Promise<void> {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/public/magic/${nonce}`;
  await mailer().send({
    to: email,
    subject: "Open your Rovenue onboarding",
    html: `<p>Tap to continue your onboarding:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes.</p>`,
    text: `Open your Rovenue onboarding:\n${url}\n\nThis link expires in 15 minutes.`,
  });
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

      // Resolve / upsert the subscriber so the claim binds to a stable
      // subscriber row. Resolve FIRST — `upsertSubscriber` matches on
      // (projectId, rovenueId) and would happily return a soft-deleted,
      // merged-away row, stranding the claim on a dead subscriber.
      // `resolveSubscriberByRovenueId` follows the `mergedInto` chain to the
      // canonical survivor; only create when there is no row yet.
      const resolved =
        await drizzle.subscriberRepo.resolveSubscriberByRovenueId(drizzle.db, {
          projectId: project.id,
          rovenueId: anon_id,
        });
      const subscriber =
        resolved ??
        (await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
          projectId: project.id,
          rovenueId: anon_id,
        }));

      // Idempotent reclaim by SAME subscriber: return the same
      // payload without retrying the UPDATE.
      if (tokenRow.claimedAt && tokenRow.claimedBySubscriberId) {
        if (tokenRow.claimedBySubscriberId === subscriber.id) {
          const body = await buildClaimResponse(tokenRow.sessionId, subscriber.id);
          return c.json({ data: body });
        }
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      // Load the session up-front so we have funnel_id / version_id
      // in scope for the outbox payload — `tryClaim` only touches the
      // claim-token row.
      const sessionForEvent = await drizzle.funnelSessionRepo.findById(
        drizzle.db,
        tokenRow.sessionId,
      );

      const claimed = await drizzle.db.transaction(async (tx) => {
        const winner = await drizzle.funnelClaimTokenRepo.tryClaim(
          tx,
          tokenRow.id,
          subscriber.id,
        );
        if (!winner) return false;

        // Flip session to completed so /state stops reporting it as
        // still in flight.
        await drizzle.funnelSessionRepo.setState(
          tx,
          tokenRow.sessionId,
          "completed",
        );

        if (sessionForEvent) {
          await emitFunnelEvent(tx, "funnel.session.completed", tokenRow.sessionId, {
            funnel_id: sessionForEvent.funnelId,
            version_id: sessionForEvent.funnelVersionId,
            project_id: sessionForEvent.projectId,
            subscriber_id: subscriber.id,
          });
          await emitFunnelEvent(
            tx,
            "funnel.claim_token.claimed",
            tokenRow.sessionId,
            {
              funnel_id: sessionForEvent.funnelId,
              version_id: sessionForEvent.funnelVersionId,
              project_id: sessionForEvent.projectId,
              subscriber_id: subscriber.id,
            },
          );
        }
        return true;
      });

      if (!claimed) {
        // Lost the race — someone else just claimed it.
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      const body = await buildClaimResponse(tokenRow.sessionId, subscriber.id);
      return c.json({ data: body });
    },
  )

  // ---------------------------------------------------------------
  // POST /sdk/claim-install — Android Referrer + iOS fingerprint
  // ---------------------------------------------------------------
  .post(
    "/sdk/claim-install",
    zValidator("json", claimInstallBody),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");

      // -- Android: install referrer is authoritative.
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

      // -- iOS: deterministic IP-only unique-match (no device fingerprinting).
      // We match the request IP against unclaimed deferred rows in the window
      // and grant ONLY when exactly one exists. Zero candidates → no match;
      // two or more → shared IP (NAT/CGNAT) where granting could leak one
      // user's purchase to another — so we decline rather than guess.
      if (body.platform === "ios") {
        const ipHash = hashIp(readIp(c));
        const candidates =
          await drizzle.funnelDeferredClaimRepo.findRecentByIpHash(
            drizzle.db,
            ipHash,
            new Date(),
          );
        const cand = selectUniqueCandidate(candidates);
        if (!cand) return c.json({ data: null }, 404);

        // Rotate the token hash so the universal-link plaintext can never be
        // replayed; return the fresh plaintext exactly once to this install.
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

      // Android without referrer: nothing we can do.
      return c.json({ data: null }, 404);
    },
  )

  // ---------------------------------------------------------------
  // POST /sdk/claim-via-email — magic-link fallback
  //
  // Returns 202 regardless of whether the email matched a stored
  // token: leaking "no such email" lets an attacker enumerate
  // which addresses have started a funnel.
  // ---------------------------------------------------------------
  .post(
    "/sdk/claim-via-email",
    zValidator("json", claimViaEmailBody),
    async (c) => {
      const project = c.get("project");
      const { email, install_id } = c.req.valid("json");

      const normalized = email.trim().toLowerCase();
      const emailHash = createHash("sha256").update(normalized).digest("hex");

      const tokenRow = await drizzle.funnelClaimTokenRepo.findByEmailHash(
        drizzle.db,
        project.id,
        emailHash,
      );
      if (!tokenRow) {
        return c.json({ data: null }, 202);
      }
      if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
        return c.json({ data: null }, 202);
      }

      // Mint fresh plaintext and rotate the hash so the eventual
      // magic-link click resolves to a brand-new secret.
      const fresh = generateClaimToken();
      await drizzle.funnelClaimTokenRepo.rotateHash(
        drizzle.db,
        tokenRow.id,
        hashToken(fresh),
      );

      const nonce = randomBytes(24).toString("base64url");
      const redisKey = `funnel:magic:${nonce}`;
      await redis.set(
        redisKey,
        JSON.stringify({ tokenPlaintext: fresh, installId: install_id }),
        "EX",
        15 * 60,
      );

      await sendFunnelMagicLink(normalized, nonce);

      return c.json({ data: null }, 202);
    },
  );
