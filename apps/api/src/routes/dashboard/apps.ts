import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { readAppConnections } from "../../services/apps-connections";

// =============================================================
// Dashboard: Apps catalog connections overlay (Phase 4.2)
// =============================================================
//
// The catalog itself stays static (no marketplace). This
// endpoint reports real connection state for the catalog entries
// the platform has backing for — Apple / Google / Stripe webhook
// activity + outbound webhook endpoints — so the page renders
// `connected` from truth rather than mock.

export const appsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/connections", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    return c.json(ok(await readAppConnections(projectId)));
  });
