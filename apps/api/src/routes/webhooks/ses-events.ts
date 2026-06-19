import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { parseSesEvent } from "../../lib/ses-events";
import { verifySnsSignature, type SnsPayload } from "../../lib/sns-signature";

const log = logger.child("ses-events");

interface SesNotificationEnvelope {
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
  delivery?: {
    recipients?: string[];
  };
}

function recipientsFor(evt: SesNotificationEnvelope): string[] {
  const out: string[] = [];
  if (evt.notificationType === "Bounce") {
    for (const r of evt.bounce?.bouncedRecipients ?? []) {
      if (r.emailAddress) out.push(r.emailAddress.toLowerCase());
    }
  } else if (evt.notificationType === "Complaint") {
    for (const r of evt.complaint?.complainedRecipients ?? []) {
      if (r.emailAddress) out.push(r.emailAddress.toLowerCase());
    }
  } else if (evt.notificationType === "Delivery") {
    for (const r of evt.delivery?.recipients ?? []) {
      out.push(r.toLowerCase());
    }
  }
  return out;
}

export const sesEventsRoute = new Hono().post("/", async (c) => {
  const payload = (await c.req.json()) as SnsPayload;

  // Fail closed: SNS signature verification is MANDATORY in production. The
  // flag can only RELAX it in non-production (local testing without real SNS
  // signatures). Skipping verification would let an unauthenticated caller
  // poison the suppression list (permanent denial-of-email for a victim),
  // flip a user's email master switch, or trigger an SSRF via SubscribeURL —
  // all of which are gated behind this check.
  const mustVerify =
    env.NODE_ENV === "production" || env.AWS_SES_EVENTS_VERIFY_SIGNATURE;
  if (mustVerify) {
    try {
      await verifySnsSignature(payload);
    } catch (e) {
      log.warn("rejected SNS payload", {
        err: e instanceof Error ? e.message : String(e),
      });
      return c.json({ ok: false }, 403);
    }
  }

  if (payload.Type === "SubscriptionConfirmation" && payload.SubscribeURL) {
    // One-shot confirm.
    try {
      await fetch(payload.SubscribeURL);
    } catch (err) {
      log.warn("subscription confirm fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return c.json({ ok: true });
  }

  if (payload.Type !== "Notification") {
    return c.json({ ok: true });
  }

  const patch = parseSesEvent(payload.Message);
  if (!patch) return c.json({ ok: true });

  // Configuration-set guard: ignore events for unrelated config sets.
  if (
    env.AWS_SES_CONFIGURATION_SET &&
    patch.configurationSet &&
    patch.configurationSet !== env.AWS_SES_CONFIGURATION_SET
  ) {
    log.warn("ses event for unrelated configuration set", {
      got: patch.configurationSet,
      expected: env.AWS_SES_CONFIGURATION_SET,
    });
    return c.json({ ok: true });
  }

  await drizzle.invitationRepo.setDeliveryStatus(
    drizzle.db,
    patch.sesMessageId,
    patch.status,
    patch.error,
  );

  // ---------- notifications pipeline side-effects ----------
  //
  // Same SES event also drives the notification_deliveries
  // status + the global suppression list + the per-user email
  // master switch. The lookup is by providerMessageId, which
  // the send-email-worker (Phase 10) stores when SES accepts
  // the send. Missing row → SES is reporting for a non-notif
  // send (e.g. invitation), so we just return.

  const delivery =
    await drizzle.notificationDeliveryRepo.findDeliveryByProviderMessageId(
      drizzle.db,
      patch.sesMessageId,
    );

  let envelope: SesNotificationEnvelope = {};
  try {
    envelope = JSON.parse(payload.Message) as SesNotificationEnvelope;
  } catch {
    /* parser already accepted it; this should never fail. */
  }
  const recipients = recipientsFor(envelope);

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
    // Hard bounce → permanent suppression. parseSesEvent already
    // filtered out soft bounces (returns null), so we're safe to
    // mark every recipient hard_bounce here.
    for (const email of recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "hard_bounce",
        source: "ses",
      });
    }
    if (delivery) {
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "bounced",
        { providerResponse: { error: patch.error, recipients } },
      );
    }
    return c.json({ ok: true });
  }

  if (patch.status === "COMPLAINED") {
    for (const email of recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "complaint",
        source: "ses",
      });
    }
    if (delivery) {
      // Flip the user's email master switch — a spam complaint
      // is a strong "stop sending me anything" signal across
      // every notification category.
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
        { providerResponse: { reason: "complaint", recipients } },
      );
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
