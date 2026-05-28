import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const ListArgs = z.object({
  limit: z.number().int().positive().max(100).default(50),
});

export function queryAudiencesTools(ctx: ToolContext) {
  return {
    "query_audiences_list": tool({
      description:
        "List audiences defined in the current project. Returns id, name, description, isDefault, estimatedSize.",
      inputSchema: ListArgs,
      execute: async ({ limit }) => {
        const rows = await drizzle.audienceRepo.listAudiences(
          drizzle.db,
          ctx.projectId,
        );
        return sterilizeToolResult({ audiences: rows.slice(0, limit) });
      },
    }),
  };
}
