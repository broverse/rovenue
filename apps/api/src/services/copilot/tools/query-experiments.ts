import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const ListArgs = z.object({
  status: z
    .enum(["DRAFT", "RUNNING", "PAUSED", "COMPLETED"])
    .optional(),
  type: z
    .enum(["FLAG", "OFFERING", "PAYWALL", "ELEMENT"])
    .optional(),
  limit: z.number().int().positive().max(100).default(50),
});

export function queryExperimentsTools(ctx: ToolContext) {
  return {
    "query.experiments.list": tool({
      description:
        "List A/B experiments in the current project. Returns id, name, status, type, audienceId, startedAt, endedAt.",
      inputSchema: ListArgs,
      execute: async ({ status, type, limit }) => {
        const rows = await drizzle.experimentRepo.findExperimentsByProject(
          drizzle.db,
          { projectId: ctx.projectId, status, type },
        );
        return sterilizeToolResult({ experiments: rows.slice(0, limit) });
      },
    }),
  };
}
