// =============================================================
// Public unsubscribe route (RFC 8058 one-click)
// =============================================================
//
// POST /unsubscribe
//   body: { token: string }
//
// The token is signed by UNSUB_SIGNING_KEY (lib/unsubscribe-token).
// Two scope flavours:
//
//   scope === "channel:email"  → flip user_preferences.notifications
//                                .channels.email to false (master switch).
//   scope === "event:<key>"    → upsert user_project_notification_prefs
//                                .overrides[<key>] = false for the
//                                token's projectId.
//
// Forced channels (catalog flag) cannot be opted out — token
// payloads for forced events are rejected at sign time, but we
// re-check here as a defence in depth.
//
// On success: 204. On token error: 400 (malformed) or 401
// (expired/invalid signature). Missing token: 400.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { getEvent } from "@rovenue/shared/notifications";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import {
  UnsubscribeTokenError,
  verifyUnsubscribeToken,
} from "../../lib/unsubscribe-token";

const log = logger.child("unsubscribe");

const bodySchema = z.object({
  token: z.string().min(1, "token required"),
});

export const publicUnsubscribeRoute = new Hono().post("/", async (c) => {
  if (!env.UNSUB_SIGNING_KEY) {
    // Misconfiguration — refuse loudly rather than silently
    // accepting unsigned tokens.
    throw new HTTPException(503, {
      message: "Unsubscribe endpoint is not configured on this instance",
    });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: "Missing token" });
  }

  let payload;
  try {
    payload = verifyUnsubscribeToken(body.token, env.UNSUB_SIGNING_KEY);
  } catch (err) {
    if (err instanceof UnsubscribeTokenError) {
      const status = err.code === "expired" ? 401 : 400;
      log.warn("rejected_token", { code: err.code });
      throw new HTTPException(status, { message: err.message });
    }
    throw err;
  }

  if (payload.scope === "channel:email") {
    await drizzle.notificationPreferencesRepo.updateUserChannels(
      drizzle.db,
      payload.userId,
      { email: false },
    );
    log.info("channel_email_off", { userId: payload.userId });
    return c.body(null, 204);
  }

  // event:<key>
  const eventKey = payload.scope.slice("event:".length);
  if (!eventKey) {
    throw new HTTPException(400, { message: "Malformed event scope" });
  }

  let event;
  try {
    event = getEvent(eventKey);
  } catch {
    throw new HTTPException(400, { message: `Unknown event ${eventKey}` });
  }
  if (event.forcedChannels && event.forcedChannels.length > 0) {
    // Forced channels are non-opt-out (security alerts, billing
    // failures, …). Token shouldn't have been minted in the first
    // place; refuse anyway.
    throw new HTTPException(400, {
      message: `Event ${eventKey} cannot be unsubscribed from`,
    });
  }
  if (!payload.projectId) {
    throw new HTTPException(400, {
      message: "Event-scope tokens require a projectId",
    });
  }

  await drizzle.notificationPreferencesRepo.upsertUserProjectOverrides(
    drizzle.db,
    payload.userId,
    payload.projectId,
    { [eventKey]: false },
  );
  log.info("event_off", {
    userId: payload.userId,
    projectId: payload.projectId,
    eventKey,
  });
  return c.body(null, 204);
});
