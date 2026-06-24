import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionSubscribersTools(ctx: ToolContext) {
  return {
    "action_subscribers_grantAccess": createIntentTool({
      ctx,
      toolName: "action_subscribers_grantAccess",
      description:
        "Grant a subscriber an entitlement (access id). Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        subscriberId: z.string().min(1),
        accessId: z.string().min(1),
        expiresDate: z.string().datetime().optional(),
        reason: z.string().min(1),
      }),
      requiresRole: "CUSTOMER_SUPPORT",
      buildPreview: (i) => ({
        title: `Grant access ${i.accessId} to subscriber ${i.subscriberId}`,
        fields: [
          { label: "Subscriber", after: i.subscriberId },
          { label: "Access (entitlement)", after: i.accessId },
          { label: "Expires", after: i.expiresDate ?? "never" },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),

    "action_subscribers_transfer": createIntentTool({
      ctx,
      toolName: "action_subscribers_transfer",
      description:
        "Transfer (merge) a subscriber's purchases, access and experiment assignments into another subscriber. The user must approve.",
      inputSchema: z.object({
        fromSubscriberId: z.string().min(1),
        toSubscriberId: z.string().min(1),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `Transfer subscriber ${i.fromSubscriberId} into ${i.toSubscriberId}`,
        fields: [
          { label: "From Subscriber", after: i.fromSubscriberId },
          { label: "To Subscriber", after: i.toSubscriberId },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
}
