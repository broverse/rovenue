import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma, {
  MemberRole,
  OutgoingWebhookStatus,
  drizzle,
} from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Failed Webhooks (dead letter management)
// =============================================================

const DEAD_ALERT_THRESHOLD = 5;
const DEAD_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const webhooksDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /dashboard/webhooks/failed?projectId= -----
  // List DEAD webhooks with pagination.
  .get("/failed", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId query param required" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id);

  const rawLimit = c.req.query("limit");
  const rawOffset = c.req.query("offset");
  const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) || 50 : 50, 200);
  const offset = rawOffset ? parseInt(rawOffset, 10) || 0 : 0;

  const [webhooks, total] = await Promise.all([
    drizzle.outgoingWebhookRepo.listDeadWebhooks(drizzle.db, {
      projectId,
      limit,
      offset,
    }),
    drizzle.outgoingWebhookRepo.countDeadWebhooks(drizzle.db, projectId),
  ]);

    return c.json(
      ok({
        webhooks,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      }),
    );
  })
  // ----- POST /dashboard/webhooks/:id/retry -----
  // Reset a DEAD webhook back to PENDING so the delivery worker picks
  // it up again with a fresh attempt counter.
  .post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  const existing = await drizzle.outgoingWebhookRepo.findOutgoingWebhookById(
    drizzle.db,
    id,
  );
  if (!existing) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  if (existing.status !== OutgoingWebhookStatus.DEAD) {
    throw new HTTPException(400, {
      message: `Can only retry DEAD webhooks (current: ${existing.status})`,
    });
  }

  const webhook = await prisma.outgoingWebhook.update({
    where: { id },
    data: {
      status: OutgoingWebhookStatus.PENDING,
      attempts: 0,
      nextRetryAt: null,
      deadAt: null,
      httpStatus: null,
      responseBody: null,
      lastErrorMessage: null,
    },
  });

    return c.json(ok({ webhook }));
  })
  // ----- POST /dashboard/webhooks/:id/dismiss -----
  // Mark a DEAD webhook as DISMISSED — acknowledged by the operator,
  // permanently removed from the active dead-letter view.
  .post("/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  const existing = await drizzle.outgoingWebhookRepo.findOutgoingWebhookById(
    drizzle.db,
    id,
  );
  if (!existing) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  if (existing.status !== OutgoingWebhookStatus.DEAD) {
    throw new HTTPException(400, {
      message: `Can only dismiss DEAD webhooks (current: ${existing.status})`,
    });
  }

    const webhook = await prisma.outgoingWebhook.update({
      where: { id },
      data: { status: OutgoingWebhookStatus.DISMISSED },
    });

    return c.json(ok({ webhook }));
  })
  // ----- GET /dashboard/webhooks/alert?projectId= -----
  // Returns a dead webhook count for the last 24 hours and whether
  // the alert threshold is exceeded. The dashboard renders a warning
  // banner when `alert` is true.
  .get("/alert", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId query param required" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id);

  const since = new Date(Date.now() - DEAD_ALERT_WINDOW_MS);
  const deadCount = await drizzle.outgoingWebhookRepo.countRecentDeadWebhooks(
    drizzle.db,
    projectId,
    since,
  );

    return c.json(
      ok({
        deadCount,
        threshold: DEAD_ALERT_THRESHOLD,
        alert: deadCount >= DEAD_ALERT_THRESHOLD,
      }),
    );
  });
