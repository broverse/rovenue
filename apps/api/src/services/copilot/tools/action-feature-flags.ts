import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionFeatureFlagsTools(ctx: ToolContext) {
  return {
    "action.featureFlags.toggle": createIntentTool({
      ctx,
      toolName: "action.featureFlags.toggle",
      description:
        "Enable or disable a feature flag globally. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        featureFlagId: z.string().min(1),
        enabled: z.boolean(),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `${i.enabled ? "Enable" : "Disable"} feature flag ${i.featureFlagId}`,
        fields: [
          { label: "Feature Flag", after: i.featureFlagId },
          { label: "New State", after: i.enabled ? "enabled" : "disabled" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),

    "action.featureFlags.updateRules": createIntentTool({
      ctx,
      toolName: "action.featureFlags.updateRules",
      description:
        "Update targeting rules for a feature flag. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        featureFlagId: z.string().min(1),
        rules: z.array(z.record(z.unknown())),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `Update rules for feature flag ${i.featureFlagId}`,
        fields: [
          { label: "Feature Flag", after: i.featureFlagId },
          { label: "Rule Count", after: i.rules.length },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
