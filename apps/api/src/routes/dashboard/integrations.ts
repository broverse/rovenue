import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull } from "drizzle-orm";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Integration connections
// =============================================================
//
// GET  /                   — list connections for a project (credentials redacted)
//
// Credentials are NEVER returned on list/read: only credentialsHint
// is exposed. credentialsCipher is excluded from the projection so it
// never reaches the wire, even accidentally.

export const integrationsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // =============================================================
  // GET /dashboard/projects/:projectId/integrations
  // =============================================================
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.db
      .select({
        id: drizzle.schema.integrationConnections.id,
        projectId: drizzle.schema.integrationConnections.projectId,
        providerId: drizzle.schema.integrationConnections.providerId,
        displayName: drizzle.schema.integrationConnections.displayName,
        credentialsHint: drizzle.schema.integrationConnections.credentialsHint,
        enabledEvents: drizzle.schema.integrationConnections.enabledEvents,
        eventMapping: drizzle.schema.integrationConnections.eventMapping,
        actionSource: drizzle.schema.integrationConnections.actionSource,
        testEventCode: drizzle.schema.integrationConnections.testEventCode,
        isEnabled: drizzle.schema.integrationConnections.isEnabled,
        lastValidatedAt: drizzle.schema.integrationConnections.lastValidatedAt,
        lastError: drizzle.schema.integrationConnections.lastError,
        lastBackfillAt: drizzle.schema.integrationConnections.lastBackfillAt,
        createdAt: drizzle.schema.integrationConnections.createdAt,
        updatedAt: drizzle.schema.integrationConnections.updatedAt,
      })
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    return c.json(ok({ connections: rows }));
  });
