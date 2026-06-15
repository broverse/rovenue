import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { bindAppUserId } from "../../services/identify";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:v1:identify");

export const identifyBodySchema = z.object({
  rovenueId: z.string().min(1),
  appUserId: z.string().min(1),
});

// Public-key endpoint. The SDK (Rust core) calls this after the app sets
// an identity. It binds the customer label to the device's permanent
// rovenueId and auto-transfers any prior holder's assets. Merging is a
// label-bind, never a privileged read of another user's data, so the
// public key is sufficient (opaque appUserId required; authoritative
// consolidation stays on the secret-key /v1/subscribers/transfer endpoint).
export const identifyRoute = new Hono().post(
  "/",
  zValidator("json", identifyBodySchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");
    try {
      const result = await bindAppUserId(
        project.id,
        body.rovenueId,
        body.appUserId,
      );
      log.info("identify completed", { projectId: project.id, ...result });
      return c.json(ok(result));
    } catch (err) {
      if (err instanceof Error) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }
  },
);
