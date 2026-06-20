import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { getProjectOverview } from "../../services/metrics/overview";

// =============================================================
// Dashboard: Project overview
// =============================================================
//
// One read that feeds the project-overview page in a single
// roundtrip: KPI summary (MRR / active subs / trial→paid / net
// churn) + top products + recent activity + system health.
//
// `windowDays` selects the comparison window (default 30, capped
// at one year). Everything in the response is scoped to that
// window except `recentActivity`, which is intentionally a
// "latest N" list across all time so the panel still shows
// useful activity on a quiet day.

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;

const overviewQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .min(MIN_WINDOW_DAYS)
      .max(MAX_WINDOW_DAYS)
      .default(DEFAULT_WINDOW_DAYS),
  })
  .transform((v) => ({ windowDays: v.windowDays }));

export const overviewRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", validate("query", overviewQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const { windowDays } = c.req.valid("query");
    const payload = await getProjectOverview({ projectId, windowDays });
    return c.json(ok(payload));
  });
