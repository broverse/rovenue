import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { listDailyMrr } from "../../services/metrics/mrr";
import { getRevenueSummary } from "../../services/metrics/summary";
import { getLtvDistribution } from "../../services/metrics/ltv";
import { getMrrDecomposition } from "../../services/metrics/mrr-decomposition";
import { listEngagement } from "../../services/metrics/engagement";
import { getLtvPrediction } from "../../services/metrics/ltv-prediction";

// =============================================================
// Dashboard: Project metrics
// =============================================================
//
// Thin surface over the ClickHouse `mv_mrr_daily_target`
// aggregate. The endpoint reads CH exclusively (Plan 3); the
// freshness budget is set by the outbox dispatcher cadence
// (≤5s p95, ≤30s p99 from PG commit to CH visibility).
//
// Window defaults to the trailing 30 days. Callers may override
// with `from` / `to` as ISO-8601 strings; the schema rejects
// windows wider than MRR_WINDOW_MAX_DAYS or where from > to.

// Cap chosen to cover up to "All" (24 months) on the Charts page
// without forcing a second round-trip. Compare-mode adds a *second*
// request for the prior period, so this cap doesn't need to grow
// just because the UI offers a "previous-period overlay".
const MRR_WINDOW_MAX_DAYS = 800;
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ltvPredictionQuerySchema = z.object({
  horizonMonths: z.coerce.number().int().min(1).max(36).default(12),
  minMatureCohorts: z.coerce.number().int().min(1).max(24).default(3),
});

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
  .use("*", async (c, next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.CUSTOMER_SUPPORT);
    await next();
  })
  // =============================================================
  // GET /dashboard/projects/:projectId/metrics/mrr
  // =============================================================
  //
  // Per-day gross USD, event count, and distinct active
  // subscribers for the window. Returns buckets in ascending
  // order so the client can render a line chart without sorting.
  .get("/mrr", validate("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId")!;
    const { from, to } = c.req.valid("query");

    const points = await listDailyMrr({ projectId, from, to });

    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        points: points.map((p) => ({
          bucket: p.bucket.toISOString(),
          grossUsd: p.grossUsd,
          refundsUsd: p.refundsUsd,
          netUsd: p.netUsd,
          eventCount: p.eventCount,
          activeSubscribers: p.activeSubscribers,
        })),
      }),
    );
  })
  .get("/summary", validate("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId")!;
    const { from, to } = c.req.valid("query");
    const summary = await getRevenueSummary({ projectId, from, to });

    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        ...summary,
      }),
    );
  })
  // =============================================================
  // GET /dashboard/projects/:projectId/metrics/ltv
  // =============================================================
  //
  // Lifetime-value distribution across all subscribers: avg/median/
  // p90 plus a fixed-band histogram. Cumulative, so no window.
  .get("/ltv", async (c) => {
    const projectId = c.req.param("projectId")!;
    const distribution = await getLtvDistribution(projectId);
    return c.json(ok(distribution));
  })
  .get(
    "/mrr-decomposition",
    validate("query", mrrQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId")!;
      const { from, to } = c.req.valid("query");
      const d = await getMrrDecomposition({ projectId, from, to });
      return c.json(
        ok({ from: from.toISOString(), to: to.toISOString(), ...d }),
      );
    },
  )
  .get("/engagement", validate("query", mrrQuerySchema), async (c) => {
    const projectId = c.req.param("projectId")!;
    const { from, to } = c.req.valid("query");
    const points = await listEngagement({ projectId, from, to });
    return c.json(
      ok({
        from: from.toISOString(),
        to: to.toISOString(),
        points: points.map((p) => ({
          bucket: p.bucket.toISOString(),
          sessionCount: p.sessionCount,
          avgSessionMs: p.avgSessionMs,
          activeSubscribers: p.activeSubscribers,
        })),
      }),
    );
  })
  .get(
    "/ltv-prediction",
    validate("query", ltvPredictionQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId")!;
      const { horizonMonths, minMatureCohorts } = c.req.valid("query");
      const data = await getLtvPrediction({ projectId, horizonMonths, minMatureCohorts });
      return c.json(ok(data));
    },
  );
