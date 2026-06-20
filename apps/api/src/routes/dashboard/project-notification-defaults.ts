// =============================================================
// /dashboard/projects/:projectId/notification-defaults
// =============================================================
//
// GET   — any project member (capability "project:read") gets
//         the current defaults map. Returns {} if no row exists.
// PATCH — OWNER + ADMIN only (capability "project:settings:write").
//         Body is { defaults: Record<eventKey, boolean> }, merged
//         into the existing JSONB via the repo's `||` semantics.
//         Forced-channel events are rejected here too — defaults
//         set "off" for a forced event would be misleading even
//         though the notifier still forces the channel.
//
// After every successful PATCH the route publishes a Redis
// "projectDefaults" invalidation message so the notifier worker's
// LRU drops its cached copy. Publish failures don't fail the
// write (LRU TTL guarantees eventual consistency).

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { validate } from "../../lib/validate";
import { drizzle } from "@rovenue/db";
import { getEvent } from "@rovenue/shared/notifications";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { ok } from "../../lib/response";
import { publishInvalidation } from "../../services/notifications/prefs-cache";

const { notificationPreferencesRepo } = drizzle;
const log = logger.child("dashboard.project-notification-defaults");

const patchBodySchema = z
  .object({
    defaults: z.record(z.string(), z.boolean()).refine(
      (o) => Object.keys(o).length > 0,
      { message: "defaults must contain at least one entry" },
    ),
  })
  .strict();

function rejectForcedDefaults(defaults: Record<string, boolean>) {
  for (const key of Object.keys(defaults)) {
    let descriptor;
    try {
      descriptor = getEvent(key);
    } catch {
      throw new HTTPException(400, {
        message: `Unknown event key: ${key}`,
      });
    }
    if (descriptor.forcedChannels && descriptor.forcedChannels.length > 0) {
      throw new HTTPException(400, {
        message: `FORCED_EVENT: ${key} has forced channels and cannot have a project default`,
      });
    }
  }
}

async function invalidateProjectDefaults(projectId: string): Promise<void> {
  try {
    await publishInvalidation(redis, "projectDefaults", projectId);
  } catch (err) {
    log.warn("publish_invalidation_failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export const projectNotificationDefaultsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId required" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:read");

    const defaults = await notificationPreferencesRepo.getProjectDefaults(
      drizzle.db,
      projectId,
    );
    return c.json(ok({ projectId, defaults }));
  })

  // PATCH /
  .patch("/", validate("json", patchBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId required" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");

    const { defaults } = c.req.valid("json");
    rejectForcedDefaults(defaults);

    await notificationPreferencesRepo.upsertProjectDefaults(
      drizzle.db,
      projectId,
      defaults,
    );
    await invalidateProjectDefaults(projectId);
    return c.json(ok({ ok: true }));
  });
