import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { ok } from "../../../lib/response";
import { buildBillingSummary } from "../../../services/billing/billing-summary";

// =============================================================
// GET /dashboard/projects/:projectId/billing
// =============================================================
//
// Read-only summary endpoint: returns the project's current
// billing_subscriptions row (state/tier/cycle/period) plus the
// default payment method (if any), assembled by
// `buildBillingSummary`. Gated by `BILLING_ENABLED` so the surface
// is fully hidden in self-host where the platform-billing feature
// is irrelevant.
//
// Auth + per-user rate limit are mounted by the parent dashboard
// router tree (apps/api/src/routes/dashboard/index.ts) — see the
// comment there for the rationale — so we do NOT re-mount
// `requireDashboardAuth` here; `c.get("user")` is already set.

export const summaryRoute = new Hono().get("/", async (c) => {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  const projectId = c.req.param("projectId")!;
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
  const summary = await buildBillingSummary(db, projectId);
  return c.json(ok(summary));
});
