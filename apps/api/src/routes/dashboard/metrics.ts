import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import * as mrrAdapter from "../../services/metrics/mrr-adapter";

// =============================================================
// Dashboard: Project metrics
// =============================================================
//
// Thin surface over the TimescaleDB continuous aggregates. The
// MRR endpoint reads daily_mrr (refreshed every ~10 minutes with
// a 1-hour real-time tail) so the chart stays constant-time even
// as the revenue_events hypertable grows past billions of rows.
//
// Window defaults to the trailing 30 days. Callers may override
// with `from` / `to` as ISO-8601 strings; the endpoint clamps
// `to` at now + 24h to block open-ended future-dated reads that
// would scan empty chunks and return nothing useful.

const MRR_WINDOW_MAX_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const mrrQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .transform((v) => {
    const now = Date.now();
    const to = v.to ? new Date(v.to) : new Date(now);
    const from = v.from
      ? new Date(v.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    return { from, to };
  })
  .superRefine((v, ctx) => {
    if (v.from.getTime() > v.to.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be <= to",
      });
      return;
    }
    const spanDays = (v.to.getTime() - v.from.getTime()) / DAY_MS;
    if (spanDays > MRR_WINDOW_MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window exceeds ${MRR_WINDOW_MAX_DAYS} days`,
      });
    }
  });

export const metricsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // =============================================================
  // GET /dashboard/projects/:projectId/metrics/mrr
  // =============================================================
  //
  // Per-day gross USD, event count, and distinct active
  // subscribers for the window. Returns buckets in ascending
  // order so the client can render a line chart without sorting.
  .get("/mrr", zValidator("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const { from, to } = c.req.valid("query");

    const points = await mrrAdapter.listDailyMrr({ projectId, from, to });

    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        points: points.map((p) => ({
          bucket: p.bucket.toISOString(),
          grossUsd: p.grossUsd,
          eventCount: p.eventCount,
          activeSubscribers: p.activeSubscribers,
        })),
      }),
    );
  });
