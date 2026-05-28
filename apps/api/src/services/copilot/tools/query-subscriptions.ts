import { tool } from "ai";
import { z } from "zod";
import { listSubscriptions } from "../../metrics/subscriptions";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const ListArgs = z.object({
  scope: z
    .enum(["all", "active", "trial", "grace", "canceling", "issues", "churned"])
    .default("active"),
  search: z.string().optional(),
  limit: z.number().int().positive().max(50).default(20),
  productId: z.string().optional(),
});

export function querySubscriptionsTools(ctx: ToolContext) {
  return {
    "query.subscriptions.list": tool({
      description:
        "List subscriptions in the current project. Returns purchase/subscription records with store, product, status, expiry, and subscriber id.",
      inputSchema: ListArgs,
      execute: async ({ scope, search, limit, productId }) => {
        const result = await listSubscriptions({
          projectId: ctx.projectId,
          scope,
          limit,
          cursor: null,
          search: search ?? null,
          sort: "started_desc",
          store: null,
          productId: productId ? [productId] : null,
          autoRenew: null,
          isTrial: null,
          isIntro: null,
          hasIssue: false,
          purchasedFrom: null,
          purchasedTo: null,
          expiresFrom: null,
          expiresTo: null,
        });
        return sterilizeToolResult(result);
      },
    }),
  };
}
