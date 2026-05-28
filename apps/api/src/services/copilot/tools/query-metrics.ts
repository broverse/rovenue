import { tool } from "ai";
import { z } from "zod";
import { listDailyMrr } from "../../metrics/mrr";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const DateRangeArgs = z.object({
  from: z
    .string()
    .describe("ISO date string, e.g. 2025-01-01")
    .default(() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10);
    }),
  to: z
    .string()
    .describe("ISO date string, e.g. 2025-01-31")
    .default(() => new Date().toISOString().slice(0, 10)),
});

export function queryMetricsTools(ctx: ToolContext) {
  return {
    "query.metrics.mrr": tool({
      description:
        "Get daily MRR (Monthly Recurring Revenue) data for the current project from ClickHouse. Returns an array of {bucket, grossUsd, eventCount, activeSubscribers} points.",
      inputSchema: DateRangeArgs,
      execute: async ({ from, to }) => {
        const rows = await listDailyMrr({
          projectId: ctx.projectId,
          from: new Date(from),
          to: new Date(to),
        });
        return sterilizeToolResult({ mrr: rows });
      },
    }),
    "query.metrics.churn": tool({
      description:
        "Compute churn rate over a time window. (not implemented in this release)",
      inputSchema: DateRangeArgs,
      execute: async () => {
        throw new Error(
          "query.metrics.churn is not implemented yet — a dedicated ClickHouse view is required.",
        );
      },
    } as unknown as ReturnType<typeof tool>),
    "query.metrics.conversion": tool({
      description:
        "Compute trial-to-paid conversion rate over a time window. (not implemented in this release)",
      inputSchema: DateRangeArgs,
      execute: async () => {
        throw new Error(
          "query.metrics.conversion is not implemented yet — funnel-conversion ClickHouse view does not exist.",
        );
      },
    } as unknown as ReturnType<typeof tool>),
  };
}
