import { queryAnalytics } from "../../lib/clickhouse";

export interface ListEngagementInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface EngagementPoint {
  bucket: Date;
  sessionCount: number;
  avgSessionMs: number;
  activeSubscribers: number;
}

interface ChEngagementRow {
  bucket: string;
  session_count: string;
  session_ms: string;
  active_subscribers: string;
}

export async function listEngagement(
  input: ListEngagementInput,
): Promise<EngagementPoint[]> {
  const rows = await queryAnalytics<ChEngagementRow>(
    input.projectId,
    `
      SELECT
        toString(day)                      AS bucket,
        toString(sum(session_count))       AS session_count,
        toString(sum(session_ms))          AS session_ms,
        toString(uniqExact(subscriberId))  AS active_subscribers
      FROM rovenue.sdk_sessions_daily_tbl
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day ASC
    `,
    {
      from: input.from.toISOString().slice(0, 10),
      to: input.to.toISOString().slice(0, 10),
    },
  );

  return rows.map((r) => {
    const count = Number(r.session_count);
    const ms = Number(r.session_ms);
    return {
      bucket: new Date(r.bucket + "T00:00:00Z"),
      sessionCount: count,
      avgSessionMs: count > 0 ? Math.round(ms / count) : 0,
      activeSubscribers: Number(r.active_subscribers),
    };
  });
}
