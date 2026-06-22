import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/host-mode";
import { ok } from "../../../lib/response";
import { buildUsageReport } from "../../../services/billing/usage";

// =============================================================
// GET /dashboard/projects/:projectId/billing/usage
// =============================================================
//
// Returns real-time billing meter values for the three meters
// (mtr, events, sql_queries) computed for the current billing
// period. Gated by `isBillingEnabled()` so the surface is fully
// hidden in self-host (HOST_MODE=self) where the platform-billing
// feature is irrelevant.
//
// Auth + per-user rate limit are mounted by the parent dashboard
// router tree (apps/api/src/routes/dashboard/index.ts) — see the
// comment there for the rationale — so we do NOT re-mount
// `requireDashboardAuth` here; `c.get("user")` is already set.

export const usageRoute = new Hono().get("/", async (c) => {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  const projectId = c.req.param("projectId")!;
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
  const usage = await buildUsageReport(db, projectId);
  return c.json(ok(usage));
});
