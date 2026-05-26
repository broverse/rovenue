import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Funnel templates (system catalog)
// =============================================================
//
// System templates are global — every authenticated dashboard user
// can browse them as a starting point for new funnels. No project
// scoping is required because there is no per-project data exposed
// here (the "user"-scoped templates Phase 6+ may introduce live
// under /projects/:projectId/funnel-templates instead).

export const funnelTemplatesRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/funnel-templates -----
  .get("/", async (c) => {
    const templates = await drizzle.funnelTemplateRepo.listSystem(drizzle.db);
    return c.json(ok({ templates }));
  })

  // ----- GET /dashboard/funnel-templates/:templateId -----
  .get("/:templateId", async (c) => {
    const templateId = c.req.param("templateId");
    if (!templateId) {
      throw new HTTPException(400, { message: "Missing templateId" });
    }
    const template = await drizzle.funnelTemplateRepo.findById(
      drizzle.db,
      templateId,
    );
    if (!template || template.scope !== "system") {
      throw new HTTPException(404, { message: "Template not found" });
    }
    return c.json(ok(template));
  });
