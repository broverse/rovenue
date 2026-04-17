import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { type Prisma } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Audit log viewer
// =============================================================
//
// Read-only endpoint for the dashboard audit trail. Supports
// filtering by action, userId, resource, resourceId, and a
// date range. Results are paginated with cursor-based or
// offset-based pagination (limit + offset for simplicity).

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const auditLogsRoute = new Hono();

auditLogsRoute.use("*", requireDashboardAuth);

auditLogsRoute.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId query param required" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id);

  const action = c.req.query("action");
  const filterUserId = c.req.query("userId");
  const resource = c.req.query("resource");
  const resourceId = c.req.query("resourceId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rawLimit = c.req.query("limit");
  const rawOffset = c.req.query("offset");

  const limit = Math.min(
    rawLimit ? parseInt(rawLimit, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const offset = rawOffset ? parseInt(rawOffset, 10) || 0 : 0;

  const where: Prisma.AuditLogWhereInput = { projectId };
  if (action) where.action = action;
  if (filterUserId) where.userId = filterUserId;
  if (resource) where.resource = resource;
  if (resourceId) where.resourceId = resourceId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return c.json(
    ok({
      logs,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    }),
  );
});

auditLogsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const entry = await prisma.auditLog.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  if (!entry) {
    throw new HTTPException(404, { message: "Audit log entry not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(entry.projectId, user.id);

  return c.json(ok({ entry }));
});
