import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const ListArgs = z.object({
  env: z.enum(["PROD", "STAGING", "DEVELOPMENT"]).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

export function queryFeatureFlagsTools(ctx: ToolContext) {
  return {
    "query.featureFlags.list": tool({
      description:
        "List feature flags in the current project. Returns id, key, env, defaultValue, audienceOverrides.",
      inputSchema: ListArgs,
      execute: async ({ env, limit }) => {
        const rows = await drizzle.dashboardFeatureFlagRepo.listFeatureFlags(
          drizzle.db,
          ctx.projectId,
          env,
        );
        return sterilizeToolResult({ featureFlags: rows.slice(0, limit) });
      },
    }),
  };
}
