// =============================================================
// /dashboard/notifications — in-app feed routes
// =============================================================
//
// GET    /             → cursor-paginated list (newest first).
// GET    /unread-count → total + per-project unread breakdown.
// POST   /:id/read     → mark one row read.
// POST   /read-all     → mark all (optionally per-project) read.
//
// Auth is mounted at the dashboardRoute tree level
// (requireDashboardAuth + per-user rate limit); each handler
// still re-reads c.get("user") so it's independently testable.
//
// Cross-user access returns 404 not 403 — we don't leak whether
// a notification id exists for another user.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { decodeCursor, encodeCursor } from "../../../lib/pagination";
import { ok } from "../../../lib/response";
import { notificationPreferencesRoute } from "./preferences";
import { notificationTestSendRoute } from "./test-send";

const { notificationRepo } = drizzle;
const { notifications } = drizzle.schema;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  projectId: z.string().optional(),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const readAllBodySchema = z
  .object({ projectId: z.string().optional() })
  .strict();

export const notificationsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .route("/preferences", notificationPreferencesRoute)
  .route("/test-send", notificationTestSendRoute)

  // GET /
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const user = c.get("user");
    const { limit, cursor: rawCursor, projectId, unreadOnly } =
      c.req.valid("query");
    const cursor = decodeCursor(rawCursor) ?? undefined;

    const rows = await notificationRepo.listNotificationsForUser(
      drizzle.db,
      user.id,
      {
        limit: limit + 1,
        cursor,
        projectId,
        unreadOnly,
      },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return c.json(
      ok({
        items: page.map((n) => ({
          id: n.id,
          eventKey: n.eventKey,
          projectId: n.projectId,
          title: n.title,
          body: n.body,
          data: n.data,
          readAt: n.readAt?.toISOString() ?? null,
          createdAt: n.createdAt.toISOString(),
        })),
        nextCursor,
      }),
    );
  })

  // GET /unread-count
  .get("/unread-count", async (c) => {
    const user = c.get("user");
    const counts = await notificationRepo.unreadNotificationCount(
      drizzle.db,
      user.id,
    );
    return c.json(ok(counts));
  })

  // POST /:id/read
  .post("/:id/read", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!id) throw new HTTPException(400, { message: "id required" });

    // Existence check scoped to this user — protects against
    // information leak (cross-user id returns 404, not 403).
    const rows = await drizzle.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)))
      .limit(1);
    if (rows.length === 0) {
      throw new HTTPException(404, { message: "Notification not found" });
    }

    await notificationRepo.markNotificationRead(drizzle.db, user.id, id);
    return c.json(ok({ ok: true }));
  })

  // POST /read-all
  .post(
    "/read-all",
    zValidator("json", readAllBodySchema),
    async (c) => {
      const user = c.get("user");
      const { projectId } = c.req.valid("json");
      const updated = await notificationRepo.markAllNotificationsRead(
        drizzle.db,
        user.id,
        projectId,
      );
      return c.json(ok({ updated }));
    },
  );
