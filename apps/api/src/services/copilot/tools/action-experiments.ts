import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { RoviIntentPreview } from "@rovenue/shared";
import type { ToolContext } from "./query-subscribers";

/**
 * Preview builders shared by the chat action tools and the MCP write
 * tools: one source of truth for what the approver sees. MCP passes the
 * same fields (reason optional there — the brief's call shape carries no
 * reason, and the audit row records what was given).
 */
export function buildExperimentStartPreview(input: {
  experimentId: string;
  reason: string;
}): RoviIntentPreview {
  return {
    title: `Start experiment ${input.experimentId}`,
    fields: [
      { label: "Experiment", after: input.experimentId },
      { label: "Action", after: "start" },
      { label: "Reason", after: input.reason },
    ],
  };
}

export function buildExperimentStopPreview(input: {
  experimentId: string;
  winnerVariantId?: string;
  reason: string;
}): RoviIntentPreview {
  return {
    title: `Stop experiment ${input.experimentId}`,
    fields: [
      { label: "Experiment", after: input.experimentId },
      { label: "Winning Variant", after: input.winnerVariantId ?? "none" },
      { label: "Reason", after: input.reason },
    ],
  };
}

export function actionExperimentsTools(ctx: ToolContext) {
  const tools = {
    "action_experiments_start": createIntentTool({
      ctx,
      toolName: "action_experiments_start",
      description:
        "Start a draft experiment to begin enrolling subscribers. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        experimentId: z.string().min(1),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: buildExperimentStartPreview,
    }),

    "action_experiments_stop": createIntentTool({
      ctx,
      toolName: "action_experiments_stop",
      description:
        "Stop a running experiment and conclude enrollment. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        experimentId: z.string().min(1),
        winnerVariantId: z.string().min(1).optional(),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: buildExperimentStopPreview,
    }),
  };
  // MCP serves no action tools yet (writes arrive in Task 9
  // through the intent flow, never as direct ports). Fail closed here so
  // a future unconditional spread cannot leak a mutation tool.
  if (ctx.surface === "mcp") return {} as typeof tools;
  return tools;
}
