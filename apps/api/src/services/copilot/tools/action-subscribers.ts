import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionSubscribersTools(ctx: ToolContext) {
  return {
    "action.subscribers.grantAccess": createIntentTool({
      ctx,
      toolName: "action.subscribers.grantAccess",
      description:
        "Grant a subscriber access to a product group (entitlement). Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        subscriberId: z.string().min(1),
        productGroupId: z.string().min(1),
        expiresAt: z.string().datetime().optional(),
        reason: z.string().min(1),
      }),
      requiresRole: "CUSTOMER_SUPPORT",
      buildPreview: (i) => ({
        title: `Grant access to ${i.productGroupId} for subscriber ${i.subscriberId}`,
        fields: [
          { label: "Subscriber", after: i.subscriberId },
          { label: "Product Group", after: i.productGroupId },
          { label: "Expires At", after: i.expiresAt ?? "never" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),

    "action.subscribers.transfer": createIntentTool({
      ctx,
      toolName: "action.subscribers.transfer",
      description:
        "Transfer a subscriber's purchases to another app user ID. The user must approve.",
      inputSchema: z.object({
        fromSubscriberId: z.string().min(1),
        toAppUserId: z.string().min(1),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `Transfer subscriber ${i.fromSubscriberId} to app user ${i.toAppUserId}`,
        fields: [
          { label: "From Subscriber", after: i.fromSubscriberId },
          { label: "To App User ID", after: i.toAppUserId },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
