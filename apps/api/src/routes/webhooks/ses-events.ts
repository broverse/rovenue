import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { parseSesEvent } from "../../lib/ses-events";
import { verifySnsSignature, type SnsPayload } from "../../lib/sns-signature";

const log = logger.child("ses-events");

export const sesEventsRoute = new Hono().post("/", async (c) => {
  const payload = (await c.req.json()) as SnsPayload;

  if (env.AWS_SES_EVENTS_VERIFY_SIGNATURE) {
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

  return c.json({ ok: true });
});
