import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  OutgoingWebhookStatus,
  drizzle,
} from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Failed Webhooks (dead letter management)
// =============================================================

const DEAD_ALERT_THRESHOLD = 5;
const DEAD_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

// NOTE: outgoing_webhooks is a plain declarative RANGE partition since
// migration 0017 (the TimescaleDB hypertable + compression policy were
// dropped in 0017/0017a/0018). There is no compressed-chunk constraint, so
// retry/dismiss are plain UPDATEs valid at any age.

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
  // ----- GET /dashboard/webhooks/deliveries?projectId= -----
  // List recent outgoing webhook deliveries (ALL statuses), newest
  // first. Powers the custom-webhook detail page's delivery history.
  .get("/deliveries", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) || 20 : 20, 100);
    const offset = rawOffset ? parseInt(rawOffset, 10) || 0 : 0;

    const [rows, total] = await Promise.all([
      drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks(drizzle.db, {
        projectId,
        limit,
        offset,
      }),
      drizzle.outgoingWebhookRepo.countOutgoingWebhooks(drizzle.db, projectId),
    ]);

    const webhooks = rows.map((w) => ({
      id: w.id,
      eventType: w.eventType,
      url: w.url,
      status: w.status,
      httpStatus: w.httpStatus,
      attempts: w.attempts,
      createdAt: w.createdAt.toISOString(),
      sentAt: w.sentAt ? w.sentAt.toISOString() : null,
      lastErrorMessage: w.lastErrorMessage,
    }));

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
  await assertProjectCapability(existing.projectId, user.id, "webhooks:write");

  if (existing.status !== OutgoingWebhookStatus.DEAD) {
    throw new HTTPException(400, {
      message: `Can only retry DEAD webhooks (current: ${existing.status})`,
    });
  }

  const webhook = await drizzle.outgoingWebhookRepo.resetWebhookForRetry(
    drizzle.db,
    id,
  );
  if (!webhook) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }

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
  await assertProjectCapability(existing.projectId, user.id, "webhooks:write");

  if (existing.status !== OutgoingWebhookStatus.DEAD) {
    throw new HTTPException(400, {
      message: `Can only dismiss DEAD webhooks (current: ${existing.status})`,
    });
  }

    const webhook = await drizzle.outgoingWebhookRepo.markWebhookDismissed(
      drizzle.db,
      id,
    );
    if (!webhook) {
      throw new HTTPException(404, { message: "Webhook not found" });
    }

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
