import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { MemberRole, drizzle, getDb } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";

// =============================================================
// Dashboard: Refund Shield — aggregate metrics (T18)
// =============================================================
//
//   GET /dashboard/projects/:projectId/refund-shield/metrics
//     ?since=ISO8601 &until=ISO8601
//
// Returns sent count, win rate, and estimated revenue saved (USD).
// All numbers come from Postgres alone — joins `refund_shield_responses`
// against `purchases` on `appleOriginalTransactionId` so the response
// row's outcome can be priced via the matching purchase's
// `priceAmount`. ClickHouse-backed views are deferred (plan §T18 notes
// Postgres-only is sufficient for v1).

const { refundShieldResponses, purchases } = drizzle.schema;

const querySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

interface MetricsWire {
  sentCount: number;
  outcomeCount: number;
  declinedCount: number;
  approvedCount: number;
  reversedCount: number;
  winRate: number;
  estimatedRevenueSavedCents: number;
  range: { since: string | null; until: string | null };
}

export const refundShieldMetricsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /metrics -----
  .get("/", zValidator("query", querySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const q = c.req.valid("query");
    const since = q.since ? new Date(q.since) : null;
    const until = q.until ? new Date(q.until) : null;

    const db = getDb();

    // Single aggregate query: counts by status/outcome + sum of
    // matching purchase priceAmount * 100 (DB stores decimal price;
    // we expose cents to the dashboard). Revenue saved counts only
    // REFUND_DECLINED outcomes — that's the case where our consumption
    // info changed Apple's decision in our favour.
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE rsr.status = 'SENT')::int                            AS "sentCount",
        COUNT(*) FILTER (WHERE rsr.outcome IS NOT NULL)::int                        AS "outcomeCount",
        COUNT(*) FILTER (WHERE rsr.outcome = 'REFUND_DECLINED')::int                AS "declinedCount",
        COUNT(*) FILTER (WHERE rsr.outcome = 'REFUND_APPROVED')::int                AS "approvedCount",
        COUNT(*) FILTER (WHERE rsr.outcome = 'REFUND_REVERSED')::int                AS "reversedCount",
        COALESCE(
          SUM(
            CASE WHEN rsr.outcome = 'REFUND_DECLINED'
                 THEN ROUND(COALESCE(p."priceAmount", 0)::numeric * 100)::bigint
                 ELSE 0
            END
          ),
          0
        )::bigint                                                                    AS "estimatedRevenueSavedCents"
      FROM ${refundShieldResponses} rsr
      LEFT JOIN ${purchases} p
        ON p."projectId" = rsr.project_id
       AND p."originalTransactionId" = rsr.apple_original_transaction_id
      WHERE rsr.project_id = ${projectId}
        ${since ? sql`AND rsr.detected_at >= ${since}` : sql``}
        ${until ? sql`AND rsr.detected_at <= ${until}` : sql``}
    `);

    type Row = {
      sentCount: number | string | null;
      outcomeCount: number | string | null;
      declinedCount: number | string | null;
      approvedCount: number | string | null;
      reversedCount: number | string | null;
      estimatedRevenueSavedCents: number | string | bigint | null;
    };
    const rows =
      (result as unknown as { rows: Row[] }).rows ??
      // node-postgres returns an array-shaped result depending on
      // the underlying driver — fall back to treating `result` itself
      // as the row array.
      (result as unknown as Row[]);
    const row = rows[0] ?? {
      sentCount: 0,
      outcomeCount: 0,
      declinedCount: 0,
      approvedCount: 0,
      reversedCount: 0,
      estimatedRevenueSavedCents: 0,
    };

    const toNumber = (v: number | string | bigint | null | undefined): number =>
      v === null || v === undefined ? 0 : Number(v);

    const sentCount = toNumber(row.sentCount);
    const outcomeCount = toNumber(row.outcomeCount);
    const declinedCount = toNumber(row.declinedCount);
    const approvedCount = toNumber(row.approvedCount);
    const reversedCount = toNumber(row.reversedCount);
    const estimatedRevenueSavedCents = toNumber(row.estimatedRevenueSavedCents);

    // Win rate = declined / outcomeCount. REFUND_REVERSED counts as a
    // loss (Apple ultimately granted the refund). Zero outcomes → 0,
    // matching the "no data in range" UX contract.
    const winRate = outcomeCount > 0 ? declinedCount / outcomeCount : 0;

    const payload: MetricsWire = {
      sentCount,
      outcomeCount,
      declinedCount,
      approvedCount,
      reversedCount,
      winRate,
      estimatedRevenueSavedCents,
      range: {
        since: since?.toISOString() ?? null,
        until: until?.toISOString() ?? null,
      },
    };

    return c.json(ok(payload));
  });
