// =============================================================
// /dashboard/notifications/preferences
// =============================================================
//
// GET   ?projectId= → resolved view of the user's notification
//                     settings: master channels, locale/tz, and
//                     when projectId is supplied, the per-(user,
//                     project) override map + the project's
//                     default overrides.
//
// PATCH               discriminated-union body:
//                       { scope: "global", channels?: {...},
//                         locale?, timezone? }
//                       { scope: "project", projectId, overrides:
//                         Record<eventKey, boolean> }
//
//                     Overrides that target events with non-empty
//                     forcedChannels are refused with 400
//                     FORCED_EVENT (the catalog defines which
//                     channels can't be opted out). After a
//                     successful write the route publishes the
//                     matching cache-invalidation message so the
//                     notifier worker's per-process LRUs refresh.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { validate } from "../../../lib/validate";
import { drizzle } from "@rovenue/db";
import { getEvent } from "@rovenue/shared/notifications";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { redis } from "../../../lib/redis";
import { logger } from "../../../lib/logger";
import { ok } from "../../../lib/response";
import { publishInvalidation } from "../../../services/notifications/prefs-cache";

const log = logger.child("dashboard.notifications.preferences");

/**
 * Best-effort cache invalidation. A redis hiccup must not fail
 * the user's preference write — the per-process LRU TTL (60s in
 * prefs-cache.ts) provides eventual consistency anyway.
 */
async function invalidateUserPrefs(userId: string): Promise<void> {
  try {
    await publishInvalidation(redis, "userPrefs", userId);
  } catch (err) {
    log.warn("publish_invalidation_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

const { notificationPreferencesRepo } = drizzle;

const getQuerySchema = z.object({
  projectId: z.string().optional(),
});

const patchBodySchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("global"),
      channels: z
        .object({
          email: z.boolean().optional(),
          push: z.boolean().optional(),
        })
        .optional(),
      locale: z.string().min(2).max(10).optional(),
      timezone: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("project"),
      projectId: z.string().min(1),
      overrides: z.record(z.string(), z.boolean()).refine(
        (o) => Object.keys(o).length > 0,
        { message: "overrides must contain at least one entry" },
      ),
    })
    .strict(),
]);

/** Reject overrides targeting forced-channel events. */
function rejectForcedOverrides(overrides: Record<string, boolean>) {
  for (const key of Object.keys(overrides)) {
    let descriptor;
    try {
      descriptor = getEvent(key);
    } catch {
      throw new HTTPException(400, {
        message: `Unknown event key: ${key}`,
      });
    }
    if (descriptor.forcedChannels && descriptor.forcedChannels.length > 0) {
      // The dashboard renders the message verbatim, so include
      // the failing key + the forced-channels phrase the test
      // (and the UI copy) can pattern-match on.
      throw new HTTPException(400, {
        message: `FORCED_EVENT: ${key} has forced channels and cannot be overridden`,
      });
    }
  }
}

export const notificationPreferencesRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /
  .get("/", validate("query", getQuerySchema), async (c) => {
    const user = c.get("user");
    const { projectId } = c.req.valid("query");

    const channels = await notificationPreferencesRepo.getUserChannels(
      drizzle.db,
      user.id,
    );

    if (!projectId) {
      return c.json(
        ok({
          channels: channels ?? {
            email: true,
            push: true,
            locale: "en",
            timezone: "UTC",
          },
          projectId: null,
          projectDefaults: {},
          userOverrides: {},
        }),
      );
    }

    // The project's default overrides are tenant data — only a member may
    // read them (and their own per-project override map for that project).
    await assertProjectAccess(projectId, user.id);

    const [projectDefaults, userOverrides] = await Promise.all([
      notificationPreferencesRepo.getProjectDefaults(drizzle.db, projectId),
      notificationPreferencesRepo.getUserProjectOverrides(
        drizzle.db,
        user.id,
        projectId,
      ),
    ]);

    return c.json(
      ok({
        channels: channels ?? {
          email: true,
          push: true,
          locale: "en",
          timezone: "UTC",
        },
        projectId,
        projectDefaults,
        userOverrides,
      }),
    );
  })

  // PATCH /
  .patch("/", validate("json", patchBodySchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    if (body.scope === "global") {
      await notificationPreferencesRepo.updateUserChannels(
        drizzle.db,
        user.id,
        {
          ...(body.channels?.email !== undefined && { email: body.channels.email }),
          ...(body.channels?.push !== undefined && { push: body.channels.push }),
          ...(body.locale !== undefined && { locale: body.locale }),
          ...(body.timezone !== undefined && { timezone: body.timezone }),
        },
      );
      await invalidateUserPrefs(user.id);
      return c.json(ok({ ok: true }));
    }

    // A per-project override row must not be writable for a project the
    // user isn't a member of — guard before touching any data.
    await assertProjectAccess(body.projectId, user.id);

    rejectForcedOverrides(body.overrides);
    await notificationPreferencesRepo.upsertUserProjectOverrides(
      drizzle.db,
      user.id,
      body.projectId,
      body.overrides,
    );
    // The per-(user, project) override map is keyed off userPrefs
    // in the cache; publish that key so the notifier reloads it.
    await publishInvalidation(redis, "userPrefs", user.id);
    return c.json(ok({ ok: true }));
  });
