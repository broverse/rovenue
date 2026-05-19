import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import {
  __creditsConstants,
  getCreditsRollup,
} from "../../services/metrics/credits";

// =============================================================
// Dashboard: Credits rollup (Phase 3.4)
// =============================================================

const { ROLLUP_WINDOW_DEFAULT_DAYS, ROLLUP_WINDOW_MAX_DAYS } = __creditsConstants;

const rollupQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROLLUP_WINDOW_MAX_DAYS)
    .default(ROLLUP_WINDOW_DEFAULT_DAYS),
});

export const creditsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/rollup", zValidator("query", rollupQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const { windowDays } = c.req.valid("query");
    const payload = await getCreditsRollup({ projectId, windowDays });
    return c.json(ok(payload));
  });
