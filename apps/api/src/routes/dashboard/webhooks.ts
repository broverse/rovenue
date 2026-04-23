import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
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

// Matches the compression policy in migration 0006_compression_policies.sql
// (outgoing_webhooks rows older than this are compressed). Operators
// cannot retry/dismiss older rows because UPDATEs on compressed chunks
// force a decompress and permanently bloat disk until the next
// compression policy pass. If the policy's INTERVAL changes, update
// this value + the rejection message below in lockstep.
const OUTGOING_WEBHOOK_COMPRESSION_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

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

  const ageMs = Date.now() - existing.createdAt.getTime();
  if (ageMs > OUTGOING_WEBHOOK_COMPRESSION_CUTOFF_MS) {
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    throw new HTTPException(410, {
      message: `Cannot retry webhook older than 7 days (age: ${ageDays} days). Row is in a compressed TimescaleDB chunk.`,
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
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  if (existing.status !== OutgoingWebhookStatus.DEAD) {
    throw new HTTPException(400, {
      message: `Can only dismiss DEAD webhooks (current: ${existing.status})`,
    });
  }

  const ageMs = Date.now() - existing.createdAt.getTime();
  if (ageMs > OUTGOING_WEBHOOK_COMPRESSION_CUTOFF_MS) {
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    throw new HTTPException(410, {
      message: `Cannot dismiss webhook older than 7 days (age: ${ageDays} days). Row is in a compressed TimescaleDB chunk.`,
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
