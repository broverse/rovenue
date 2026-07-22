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
import { validate } from "../../lib/validate";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { type Db, type Subscriber, drizzle } from "@rovenue/db";
import {
  reassignAllAssets,
  safeSyncAccessAfterMerge,
} from "../../services/subscriber-transfer";
import { getActiveAccess } from "../../services/access-engine";
import { logger } from "../../lib/logger";
import {
  generateClaimToken,
  hashEmail,
  hashToken,
  normalizeEmail,
  safeEqualHash,
} from "../../services/funnel/token";
import { parseInstallReferrer } from "../../services/funnel/install-referrer";
import { emitFunnelEvent } from "../../services/funnel/outbox";
import { hashIp } from "../../services/funnel/fingerprint";
import { selectUniqueCandidate } from "../../services/funnel/deferred-match";
import { redis } from "../../lib/redis";
import { mailer } from "../../lib/mailer";

const log = logger.child("funnel-claim");

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

/**
 * Claim-time convergence: move the funnel purchase onto the subscriber
 * that is actually claiming.
 *
 * The buyer paid before they had an app install, so
 * `completeFunnelPurchase` anchored a synthetic subscriber on the Stripe
 * customer (`stripe:<customer>`) and hung the purchase, its access rows
 * and its revenue events off that. The device arriving here is a
 * different row. Without this the buyer installs the app and finds
 * nothing they paid for.
 *
 * MUST be called inside the claim transaction, AFTER `tryClaim` has
 * returned a winner. `tryClaim` is `UPDATE ... WHERE claimed_at IS NULL
 * RETURNING`, so exactly one caller ever proceeds past it — running the
 * merge under that same transaction is what makes a replayed claim
 * unable to move assets twice. It also means a merge that throws rolls
 * the claim back with it: the token stays unclaimed and the SDK can
 * retry, rather than being marked claimed against assets that never
 * moved.
 *
 * Only two conditions here are legitimate and silent: a purchase with no
 * subscriber (the dev-mode stub) and a purchase already sitting on the
 * claimer. Every other guard below describes state that cannot exist
 * unless the data is corrupt, and each one THROWS. Returning false there
 * would spend the token, complete the session, emit both claimed events
 * and answer `200 { entitlements: [] }` — a paying buyer permanently
 * stranded behind one log line, with no retry and nothing that reaches
 * them. A throw rolls the claim back, leaves the token reclaimable, and
 * turns a silent loss into a 500 someone will see.
 *
 * Returns whether assets were reassigned. Note that `false` does not mean
 * nothing was written: the already-merged-into-this-claimer branch still
 * repoints the purchase row before returning false, because the assets
 * are already where they belong and only the pointer is stale.
 */
async function mergeFunnelPurchaseSubscriber(
  tx: Db,
  projectId: string,
  sessionId: string,
  claimer: { id: string; projectId: string; rovenueId: string },
): Promise<boolean> {
  const purchase = await drizzle.funnelPurchaseRepo.findBySession(tx, sessionId);
  // No purchase, or one with no subscriber: the dev-mode stub in
  // routes/public/funnels.ts inserts a paid purchase row directly, with
  // no Stripe customer and therefore no synthetic subscriber. There is
  // nothing to move, and a developer testing the claim flow end-to-end
  // must not get an error for it.
  if (!purchase?.subscriberId) return false;
  if (purchase.subscriberId === claimer.id) return false;

  // Cross-project defence. `reassignAllAssets` takes a projectId but
  // cannot enforce it: every statement it issues is keyed on subscriber
  // id alone (reassignPurchases / reassignRevenueEvents /
  // reassignSubscriberAccess / softDeleteSubscriberAsMerged all filter
  // on `subscriberId` or `id`), and the projectId is used only to stamp
  // the credit-ledger rows it writes. Handing it a subscriber from
  // another project would move that project's purchases — one person's
  // purchase to someone else — so the check has to happen here, before
  // anything moves.
  if (purchase.projectId !== projectId) {
    log.error("funnel purchase belongs to a different project; refusing merge", {
      projectId,
      sessionId,
      purchaseProjectId: purchase.projectId,
    });
    throw new Error(
      `Funnel purchase for session ${sessionId} belongs to project ${purchase.projectId}, not ${projectId}`,
    );
  }

  // Read once to learn the source's identity, purely so the lock keys
  // below can be built; every decision is made on the post-lock read.
  const anchor = await drizzle.subscriberRepo.findSubscriberById(
    tx,
    purchase.subscriberId,
  );
  if (!anchor) {
    log.error("funnel purchase points at a missing subscriber", {
      projectId,
      sessionId,
      subscriberId: purchase.subscriberId,
    });
    throw new Error(
      `Funnel purchase for session ${sessionId} points at missing subscriber ${purchase.subscriberId}`,
    );
  }

  // `reassignAllAssets`'s contract: the caller must already hold the
  // advisory locks for BOTH subscribers. It is not decorative — the
  // credit block does `findLatestBalance` then
  // `insertCreditLedger({ balance: toBal + balance })`, a read-then-write
  // against a table with a DB-enforced append-only trigger, so a lost
  // update there cannot be repaired by a later UPDATE.
  //
  // The keys use identify.ts's construction byte-for-byte
  // (`${projectId}:rov:${rovenueId}`, sorted to avoid ordering deadlocks)
  // so a concurrent identify/transfer on either row serialises against
  // the same locks rather than a parallel scheme of our own.
  const keys = [
    `${projectId}:rov:${anchor.rovenueId}`,
    `${projectId}:rov:${claimer.rovenueId}`,
  ].sort();
  await drizzle.lockRepo.advisoryXactLock2(tx, keys[0]!, keys[1]!);

  // Re-read both rows under a ROW lock, not just the advisory one.
  //
  // The advisory keys above only serialise callers that pick the same
  // key, and the writers that can retire a subscriber do not:
  // `transferSubscriber` and the receipt paths key on appUserId, and
  // `identify` keys on rovenueId but only ever locks the survivor, never
  // the row it soft-deletes. So the advisory pair contends with nothing
  // that can retire either of these two rows, and on its own it would
  // narrow the window to already-committed merges rather than close it.
  // `SELECT ... FOR UPDATE` blocks against the UPDATE itself, whichever
  // key the other writer chose.
  //
  // Taken in sorted-id order so two claims touching the same pair queue
  // instead of deadlocking. The other writers reach these rows through
  // single-row UPDATEs, so they cannot hold one of our pair while
  // waiting on the other.
  const lockIds = [purchase.subscriberId, claimer.id].sort();
  const locked = new Map<string, Subscriber>();
  for (const id of lockIds) {
    const row = await drizzle.subscriberRepo.findSubscriberByIdForUpdate(
      tx,
      id,
    );
    if (row) locked.set(id, row);
  }

  const source = locked.get(purchase.subscriberId) ?? null;
  if (!source) {
    log.error("funnel purchase points at a missing subscriber", {
      projectId,
      sessionId,
      subscriberId: purchase.subscriberId,
    });
    throw new Error(
      `Funnel purchase for session ${sessionId} points at missing subscriber ${purchase.subscriberId}`,
    );
  }
  // The claimer needs the same protection, for the same reason. It was
  // resolved at route level, on the pooled connection, before this
  // transaction even opened, so a concurrent identify/transferSubscriber
  // can have merged it away in the meantime. Moving every asset onto a
  // row that is now soft-deleted, and repointing the purchase at it,
  // would leave the buyer with nothing: `resolveSubscriberByRovenueId`
  // sends their SDK to the survivor, which is not where any of it
  // landed. The row lock above is what makes the guards below — and the
  // merge, the purchase repoint and the response that follow — judge a
  // row that cannot change underneath them.
  const target = locked.get(claimer.id) ?? null;
  if (!target) {
    log.error("the claiming subscriber vanished before the merge", {
      projectId,
      sessionId,
      claimerId: claimer.id,
    });
    throw new Error(
      `Claiming subscriber ${claimer.id} no longer exists for session ${sessionId}`,
    );
  }
  if (
    source.projectId !== projectId ||
    claimer.projectId !== projectId ||
    target.projectId !== projectId
  ) {
    log.error("refusing a cross-project subscriber merge at claim", {
      projectId,
      sessionId,
      sourceProjectId: source.projectId,
      claimerProjectId: claimer.projectId,
      targetProjectId: target.projectId,
    });
    throw new Error(
      `Refusing a cross-project subscriber merge at claim for session ${sessionId}`,
    );
  }
  // Retired between the route's read and this lock. Unlike the source
  // side there is no benign shape of this: whichever row the concurrent
  // merge made the survivor, it is not the one this claim is about to
  // write to, and the SDK will be resolved to that survivor on its next
  // read. Throwing rolls the claim back and leaves the token reclaimable,
  // so the retry resolves the survivor and merges onto it instead.
  if (target.deletedAt) {
    log.error("the claiming subscriber was merged away before the merge", {
      projectId,
      sessionId,
      claimerId: target.id,
      mergedInto: target.mergedInto,
    });
    throw new Error(
      `Claiming subscriber ${target.id} was merged into ${target.mergedInto ?? "nothing"} before the claim for session ${sessionId} could move anything`,
    );
  }
  // Already merged away. Its assets left with the earlier merge, so
  // there is nothing to move — and re-merging would repoint its
  // `mergedInto` at this claimer, corrupting the chain that
  // `resolveSubscriberByRovenueId` walks.
  //
  // Merged into THIS claimer is the one benign shape: the assets are
  // already exactly where this claim wants them, which is idempotency,
  // not corruption. Merged into anyone else means the buyer's purchase
  // is on a third party's row and answering 200 would hide that.
  if (source.deletedAt) {
    if (source.mergedInto === target.id) {
      // The assets are already here, but the purchase row may not be:
      // the earlier merge could have been a transferSubscriber/identify
      // that moved the access rows without knowing this column exists.
      // Repointing it is idempotent and keeps every funnel report that
      // joins `funnel_purchases.subscriber_id` off the retired row.
      await drizzle.funnelPurchaseRepo.setSubscriber(tx, purchase.id, target.id);
      log.info("funnel purchase subscriber already merged into this claimer", {
        projectId,
        sessionId,
        subscriberId: source.id,
      });
      return false;
    }
    log.error("funnel purchase subscriber was merged into someone else", {
      projectId,
      sessionId,
      subscriberId: source.id,
      mergedInto: source.mergedInto,
    });
    throw new Error(
      `Funnel purchase subscriber ${source.id} was already merged into ${source.mergedInto ?? "nothing"}, not ${target.id}`,
    );
  }

  await reassignAllAssets(
    tx,
    projectId,
    { id: source.id, label: source.appUserId ?? source.rovenueId },
    { id: target.id, label: "funnel claim" },
  );
  // The merge soft-deletes `source`; leaving this column on it would
  // point every funnel report that joins `funnel_purchases.subscriber_id`
  // at a retired row. Same transaction as the merge, so the two cannot
  // disagree.
  await drizzle.funnelPurchaseRepo.setSubscriber(tx, purchase.id, target.id);
  log.info("merged funnel purchase subscriber into the claiming subscriber", {
    projectId,
    sessionId,
    from: source.id,
    to: target.id,
  });
  return true;
}

/**
 * The claim payload.
 *
 * MUST be called AFTER the claim transaction has committed. The
 * entitlements it reports are the ones the merge inside that
 * transaction moved onto `subscriberId`, and `drizzle.db` is a
 * different connection from the transaction's `tx` — it cannot see
 * uncommitted writes. Called with that transaction still open it
 * returns an empty array on every claim, which looks exactly like a
 * buyer who has no entitlements.
 */
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

  // "Live" access is active AND not past its expiry, deduped per
  // accessId keeping the later expiry — a merge can leave the survivor
  // holding two rows for one accessId (one from each side) until
  // syncAccess collapses them. `getActiveAccess` is that rule: the
  // active/unexpired half runs in SQL (accessRepo.findActiveAccess) so
  // this stops pulling every historical row for the subscriber, and it
  // is the same path buildAccessResponse uses for
  // GET /v1/me/entitlements — one copy, no drift.
  const liveAccessIds = Object.keys(await getActiveAccess(subscriberId));

  // `subscriber_access.accessId` is the access ROW id; every
  // entitlement surface the SDK sees reports the catalog `identifier`
  // instead (lib/access-response.ts does the same translation for
  // GET /v1/me/entitlements). Returning internal ids here would hand
  // callers strings that match nothing they can check against. A
  // catalog row that has since been deleted drops out, as it does
  // there.
  const catalog = await drizzle.accessCatalogRepo.findByIds(
    drizzle.db,
    liveAccessIds,
  );
  const entitlements = catalog.map((row) => row.identifier).sort();

  return { subscriber_id: subscriberId, entitlements, funnel_answers };
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
    validate("json", claimTokenBody),
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

      const outcome = await drizzle.db.transaction(async (tx) => {
        const winner = await drizzle.funnelClaimTokenRepo.tryClaim(
          tx,
          tokenRow.id,
          subscriber.id,
        );
        if (!winner) return { claimed: false, merged: false };

        // Single use is decided by the UPDATE above; everything below
        // inherits it. In particular the merge cannot run twice for one
        // token, because a second caller never gets a `winner`.
        const merged = await mergeFunnelPurchaseSubscriber(
          tx,
          tokenRow.projectId,
          tokenRow.sessionId,
          subscriber,
        );

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
        return { claimed: true, merged };
      });

      if (!outcome.claimed) {
        // Lost the race — someone else just claimed it.
        throw new HTTPException(409, { message: "Token already claimed" });
      }

      // Post-commit, in this order, and neither may move earlier:
      //
      //  * syncAccess opens its OWN transaction and takes an advisory
      //    lock on the subscriber — running it inside the claim
      //    transaction would block on rows that transaction still
      //    holds. It collapses the duplicate accessId rows a merge
      //    leaves behind, so the snapshot below reads a reconciled set.
      //  * buildClaimResponse reads through `drizzle.db`, a different
      //    connection, which cannot see the merge until it commits.
      if (outcome.merged) {
        await safeSyncAccessAfterMerge(subscriber.id);
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
    validate("json", claimInstallBody),
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
    validate("json", claimViaEmailBody),
    async (c) => {
      const project = c.get("project");
      const { email, install_id } = c.req.valid("json");

      // Both derivations come from services/funnel/token so this endpoint
      // and the payment-intent route that writes the hash cannot drift.
      const normalized = normalizeEmail(email);
      const emailHash = hashEmail(email);

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
