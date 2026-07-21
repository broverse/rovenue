import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { parseResendEvent } from "../../lib/resend-events";
import { verifySvixSignature } from "../../lib/svix-signature";

const log = logger.child("resend-events");

export const resendEventsRoute = new Hono().post("/", async (c) => {
  // Raw body first: the Svix signature covers the exact bytes on the wire.
  const rawBody = await c.req.text();

  // Fail closed: signature verification is MANDATORY in production; the
  // flag can only RELAX it in non-production (local testing without real
  // Svix signatures). Same threat model as ses-events: an unauthenticated
  // caller could otherwise poison the suppression list (permanent
  // denial-of-email for a victim) or flip a user's email master switch.
  const mustVerify =
    env.NODE_ENV === "production" || env.RESEND_EVENTS_VERIFY_SIGNATURE;
  if (mustVerify) {
    if (!env.RESEND_WEBHOOK_SECRET) {
      log.warn("RESEND_WEBHOOK_SECRET unset; rejecting event");
      return c.json({ ok: false }, 403);
    }
    try {
      verifySvixSignature(
        {
          id: c.req.header("svix-id"),
          timestamp: c.req.header("svix-timestamp"),
          signature: c.req.header("svix-signature"),
        },
        rawBody,
        env.RESEND_WEBHOOK_SECRET,
      );
    } catch (e) {
      log.warn("rejected resend payload", {
        err: e instanceof Error ? e.message : String(e),
      });
      return c.json({ ok: false }, 403);
    }
  }

  // svix-id dedup — Svix delivers at-least-once; guard against a replayed
  // event re-applying suppression / status writes. Fail open on Redis
  // error so a cache outage doesn't drop live events.
  const svixId = c.req.header("svix-id");
  if (svixId) {
    const dedupKey = `resend:seen:${svixId}`;
    try {
      const added = await redis.set(dedupKey, "1", "EX", 3600, "NX");
      if (added !== "OK") {
        log.info("resend event deduplicated", { svixId });
        return c.json({ ok: true });
      }
    } catch (err) {
      log.warn("resend dedup redis error, failing open", {
        svixId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const patch = parseResendEvent(rawBody);
  if (!patch) return c.json({ ok: true });

  await drizzle.invitationRepo.setDeliveryStatus(
    drizzle.db,
    patch.providerMessageId,
    patch.status,
    patch.error,
  );

  // ---------- notifications pipeline side-effects ----------
  //
  // Same event also drives the notification_deliveries status + the
  // global suppression list + the per-user email master switch — the
  // exact flow ses-events runs. Lookup is by providerMessageId, which
  // the send-email-worker stores when the provider accepts the send.
  // Missing row → the event is for a non-notification send (e.g. an
  // invitation), so the invitation patch above is all there is to do.
  const delivery =
    await drizzle.notificationDeliveryRepo.findDeliveryByProviderMessageId(
      drizzle.db,
      patch.providerMessageId,
    );

  if (patch.status === "DELIVERED") {
    if (delivery) {
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "delivered",
      );
    }
    return c.json({ ok: true });
  }

  if (patch.status === "BOUNCED") {
    // parseResendEvent already filtered out transient bounces, so every
    // recipient here is a hard bounce → permanent suppression.
    for (const email of patch.recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "hard_bounce",
        source: "resend",
      });
    }
    if (delivery) {
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "bounced",
        { providerResponse: { error: patch.error, recipients: patch.recipients } },
      );
    }
    return c.json({ ok: true });
  }

  if (patch.status === "COMPLAINED") {
    for (const email of patch.recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "complaint",
        source: "resend",
      });
    }
    if (delivery) {
      // Flip the user's email master switch — a spam complaint is a
      // strong "stop sending me anything" signal across every category.
      const notifRows = await drizzle.db
        .select({ userId: drizzle.schema.notifications.userId })
        .from(drizzle.schema.notifications)
        .where(eq(drizzle.schema.notifications.id, delivery.notificationId))
        .limit(1);
      const userId = notifRows[0]?.userId;
      if (userId) {
        await drizzle.notificationPreferencesRepo.updateUserChannels(
          drizzle.db,
          userId,
          { email: false },
        );
      }
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "bounced",
        { providerResponse: { reason: "complaint", recipients: patch.recipients } },
      );
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
