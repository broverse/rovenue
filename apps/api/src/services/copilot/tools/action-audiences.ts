import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionAudiencesTools(ctx: ToolContext) {
  return {
    "action.audiences.create": createIntentTool({
      ctx,
      toolName: "action.audiences.create",
      description:
        "Create a new audience segment with filter rules. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        filters: z.record(z.unknown()),
        reason: z.string().min(1),
      }),
      requiresRole: "DEVELOPER",
      buildPreview: (i) => ({
        title: `Create audience "${i.name}"`,
        fields: [
          { label: "Name", after: i.name },
          { label: "Description", after: i.description ?? "" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),

    "action.audiences.update": createIntentTool({
      ctx,
      toolName: "action.audiences.update",
      description:
        "Update an existing audience segment. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        audienceId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        reason: z.string().min(1),
      }),
      requiresRole: "DEVELOPER",
      buildPreview: (i) => ({
        title: `Update audience ${i.audienceId}`,
        fields: [
          { label: "Audience", after: i.audienceId },
          { label: "New Name", after: i.name ?? "(unchanged)" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
