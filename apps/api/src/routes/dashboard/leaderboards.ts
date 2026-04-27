import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// Dashboard: Leaderboards (Plan 3 §B.2)
// =============================================================
//
// Top-N rollups over the ClickHouse analytics tables. Two flavours:
//
//   GET /dashboard/projects/:projectId/leaderboards/top-spenders
//     Sum of `amountUsd` from `raw_revenue_events` per subscriber.
//
//   GET /dashboard/projects/:projectId/leaderboards/top-consumers
//     Sum of debited credits (signed-negative `amount`) from
//     `raw_credit_ledger` per subscriber.
//
// Both queries require an inclusive ISO-8601 day range (`from`,
// `to`) and accept an optional `limit` (default 10, max 100).
//
// Freshness budget (documented for ops): ≤2s p99 from the outbox
// dispatcher publish until the row contributes to the rollup. Set
// by the Kafka Engine consumer + the SummingMergeTree merge cadence;
// `mv_credit_consumption_daily_target` aggregates per (project, day),
// not per subscriber, so subscriber-grain rollups go directly
// against `raw_credit_ledger FINAL`.

const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const leaderboardQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .superRefine((v, ctx) => {
    const fromMs = new Date(v.from).getTime();
    const toMs = new Date(v.to).getTime();
    if (fromMs > toMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be <= to",
      });
      return;
    }
    if ((toMs - fromMs) / DAY_MS > MAX_WINDOW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window exceeds ${MAX_WINDOW_DAYS} days`,
      });
    }
  });

interface TopSpenderRow {
  subscriberId: string;
  totalUsd: string;
  eventCount: string;
}

interface TopConsumerRow {
  subscriberId: string;
  debited: string;
  eventCount: string;
}

export const leaderboardsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/top-spenders", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    let query: z.infer<typeof leaderboardQuerySchema>;
    try {
      query = leaderboardQuerySchema.parse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      });
    } catch (err) {
      throw new HTTPException(400, {
        message:
          err instanceof z.ZodError
            ? err.errors[0]?.message ?? "Invalid query parameters"
            : "Invalid query parameters",
      });
    }

    const rows = await queryAnalytics<TopSpenderRow>(
      projectId,
      `
        SELECT
          subscriberId,
          toString(sum(amountUsd))    AS totalUsd,
          toString(count())            AS eventCount
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND eventDate >= {from:Date}
          AND eventDate <= {to:Date}
        GROUP BY subscriberId
        ORDER BY sum(amountUsd) DESC, subscriberId ASC
        LIMIT {limit:UInt32}
      `,
      {
        from: query.from.slice(0, 10),
        to: query.to.slice(0, 10),
        limit: query.limit,
      },
    );

    return c.json(
      ok({
        from: query.from,
        to: query.to,
        entries: rows.map((r) => ({
          subscriberId: r.subscriberId,
          totalUsd: r.totalUsd,
          eventCount: Number(r.eventCount),
        })),
      }),
    );
  })
  .get("/top-consumers", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    let query: z.infer<typeof leaderboardQuerySchema>;
    try {
      query = leaderboardQuerySchema.parse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      });
    } catch (err) {
      throw new HTTPException(400, {
        message:
          err instanceof z.ZodError
            ? err.errors[0]?.message ?? "Invalid query parameters"
            : "Invalid query parameters",
      });
    }

    const rows = await queryAnalytics<TopConsumerRow>(
      projectId,
      `
        SELECT
          subscriberId,
          toString(sumIf(-amount, amount < 0)) AS debited,
          toString(countIf(amount < 0))         AS eventCount
        FROM rovenue.raw_credit_ledger FINAL
        WHERE projectId = {projectId:String}
          AND toDate(createdAt) >= {from:Date}
          AND toDate(createdAt) <= {to:Date}
        GROUP BY subscriberId
        HAVING sumIf(-amount, amount < 0) > 0
        ORDER BY sumIf(-amount, amount < 0) DESC, subscriberId ASC
        LIMIT {limit:UInt32}
      `,
      {
        from: query.from.slice(0, 10),
        to: query.to.slice(0, 10),
        limit: query.limit,
      },
    );

    return c.json(
      ok({
        from: query.from,
        to: query.to,
        entries: rows.map((r) => ({
          subscriberId: r.subscriberId,
          debited: r.debited,
          eventCount: Number(r.eventCount),
        })),
      }),
    );
  });
