import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionSubscriptionsTools(ctx: ToolContext) {
  return {
    "action.subscriptions.cancel": createIntentTool({
      ctx,
      toolName: "action.subscriptions.cancel",
      description:
        "Cancel a subscription. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        effectiveAt: z.enum(["immediate", "period_end"]).default("period_end"),
      }),
      requiresRole: "CUSTOMER_SUPPORT",
      buildPreview: (i) => ({
        title: `Cancel subscription ${i.id}`,
        fields: [
          { label: "Subscription", after: i.id },
          { label: "Reason", after: i.reason },
          { label: "Effective", after: i.effectiveAt },
        ],
      }),
    }),

    "action.subscriptions.refund": createIntentTool({
      ctx,
      toolName: "action.subscriptions.refund",
      description:
        "Full refund of a single purchase. The user must approve.",
      inputSchema: z.object({
        purchaseId: z.string().min(1),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `Refund purchase ${i.purchaseId}`,
        fields: [
          { label: "Purchase", after: i.purchaseId },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
