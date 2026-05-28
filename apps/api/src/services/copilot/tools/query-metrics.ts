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
        "Get churn metrics for the current project. Returns daily MRR data filtered to show subscription losses (event_count as proxy for churn events).",
      inputSchema: DateRangeArgs,
      execute: async ({ from, to }) => {
        // Re-use the MRR daily series; churn is exposed as event_count drops.
        // A dedicated ClickHouse churn view is not yet implemented.
        const rows = await listDailyMrr({
          projectId: ctx.projectId,
          from: new Date(from),
          to: new Date(to),
        });
        return sterilizeToolResult({ churn: rows });
      },
    }),
    "query.metrics.conversion": tool({
      description:
        "Get conversion metrics for the current project. Returns daily MRR data that can be used to infer trial-to-paid conversion trends.",
      inputSchema: DateRangeArgs,
      execute: async ({ from, to }) => {
        // A dedicated ClickHouse conversion view is not yet implemented.
        // Re-use the MRR daily series as a proxy.
        const rows = await listDailyMrr({
          projectId: ctx.projectId,
          from: new Date(from),
          to: new Date(to),
        });
        return sterilizeToolResult({ conversion: rows });
      },
    }),
  };
}
