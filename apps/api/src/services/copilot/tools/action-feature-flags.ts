import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionFeatureFlagsTools(ctx: ToolContext) {
  return {
    "action_featureFlags_toggle": createIntentTool({
      ctx,
      toolName: "action_featureFlags_toggle",
      description:
        "Enable or disable a feature flag globally. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        flagId: z.string().min(1),
        enabled: z.boolean(),
        reason: z.string().min(1),
      }),
      requiresRole: "DEVELOPER",
      buildPreview: (i) => ({
        title: `${i.enabled ? "Enable" : "Disable"} feature flag ${i.flagId}`,
        fields: [
          { label: "Feature Flag", after: i.flagId },
          { label: "New State", after: i.enabled ? "enabled" : "disabled" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),

    "action_featureFlags_updateRules": createIntentTool({
      ctx,
      toolName: "action_featureFlags_updateRules",
      description:
        "Update targeting rules for a feature flag. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        flagId: z.string().min(1),
        rules: z.array(z.record(z.unknown())),
        reason: z.string().min(1),
      }),
      requiresRole: "DEVELOPER",
      buildPreview: (i) => ({
        title: `Update rules for feature flag ${i.flagId}`,
        fields: [
          { label: "Feature Flag", after: i.flagId },
          { label: "Rule Count", after: i.rules.length },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
