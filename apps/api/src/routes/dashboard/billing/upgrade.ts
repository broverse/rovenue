import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../../lib/validate";
import { z } from "zod";
import { db, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/host-mode";
import { ok } from "../../../lib/response";
import { upgradeProject } from "../../../services/billing/upgrade-project";

// =============================================================
// POST /dashboard/projects/:projectId/billing/upgrade
// =============================================================
//
// Free → Paid entry point. Delegates to `upgradeProject` which
// ensures a Stripe customer exists for the project and mints a
// SetupIntent the dashboard's Stripe Elements form attaches a card
// to. The setup_intent.succeeded webhook (T11) then bootstraps the
// real Stripe subscription off the captured payment method.
//
// Phase 2 ships monthly only — the `z.literal("monthly")` rejects
// `cycle: "annual"` with a 400 at the validator. P6 swaps the
// literal for `z.enum(["monthly", "annual"])` to unlock annual.
//
// Auth + per-user rate limit are mounted by the parent dashboard
// router tree so we do NOT re-mount `requireDashboardAuth` here;
// `c.get("user")` is already populated.

const bodySchema = z.object({
  // Phase 2: monthly only. Removing this literal in P6 unlocks annual.
  cycle: z.literal("monthly"),
});

export const upgradeRoute = new Hono().post(
  "/",
  validate("json", bodySchema),
  async (c) => {
    if (!isBillingEnabled()) {
      throw new HTTPException(404, { message: "Not found" });
    }
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const { cycle } = c.req.valid("json");

    try {
      const out = await upgradeProject({ db, projectId, cycle });
      return c.json(ok(out));
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "already_active") {
        throw new HTTPException(409, { message: "Project already active" });
      }
      if (code === "billing_disabled") {
        throw new HTTPException(404, { message: "Not found" });
      }
      if (code === "config_missing") {
        throw new HTTPException(503, { message: "Billing misconfigured" });
      }
      throw e;
    }
  },
);
