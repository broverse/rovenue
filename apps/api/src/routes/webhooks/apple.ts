import { Hono } from "hono";
import { z } from "zod";
import { handleAppleNotification } from "../../services/apple/apple-webhook";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:apple");

const bodySchema = z.object({
  signedPayload: z.string().min(1),
});

export const appleWebhookRoute = new Hono();

/**
 * App Store Server Notifications V2 webhook.
 *
 * The projectId path segment scopes the notification to one Rovenue project
 * so you can configure a distinct URL per project in App Store Connect.
 */
appleWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const body = bodySchema.parse(await c.req.json());

  const result = await handleAppleNotification({
    projectId,
    signedPayload: body.signedPayload,
  });

  log.info("apple notification handled", {
    projectId,
    status: result.status,
    type: result.notificationType,
  });

  return c.json(ok(result));
});
