import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionExperimentsTools(ctx: ToolContext) {
  return {
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
      buildPreview: (i) => ({
        title: `Start experiment ${i.experimentId}`,
        fields: [
          { label: "Experiment", after: i.experimentId },
          { label: "Action", after: "start" },
          { label: "Reason", after: i.reason },
        ],
      }),
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
      buildPreview: (i) => ({
        title: `Stop experiment ${i.experimentId}`,
        fields: [
          { label: "Experiment", after: i.experimentId },
          { label: "Winning Variant", after: i.winnerVariantId ?? "none" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
