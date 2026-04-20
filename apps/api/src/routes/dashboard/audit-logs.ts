import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { drizzle, type Prisma } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";

const log = logger.child("route:dashboard:audit-logs");

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

export const auditLogsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
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

    // Shadow repository filters mirror the Prisma `where` so the
    // structural diff compares identical result sets. Date fields
    // pass through as Date instances on both sides.
    const repoFilters = {
      projectId,
      ...(action && { action }),
      ...(filterUserId && { userId: filterUserId }),
      ...(resource && { resource }),
      ...(resourceId && { resourceId }),
      ...(from && { from: new Date(from) }),
      ...(to && { to: new Date(to) }),
    };
    const shadowCtx = { projectId, limit, offset };

    const [logs, total] = await Promise.all([
      drizzle.shadowRead(
        () =>
          prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          }),
        () =>
          drizzle.auditLogRepo.listAuditLogs(drizzle.db, {
            ...repoFilters,
            limit,
            offset,
          }),
        {
          name: "auditLog.list",
          context: shadowCtx,
          enabled: env.DB_SHADOW_READS,
          logger: log,
        },
      ),
      drizzle.shadowRead(
        () => prisma.auditLog.count({ where }),
        () => drizzle.auditLogRepo.countAuditLogs(drizzle.db, repoFilters),
        {
          name: "auditLog.count",
          context: shadowCtx,
          enabled: env.DB_SHADOW_READS,
          logger: log,
        },
      ),
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
  })
  .get("/:id", async (c) => {
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
