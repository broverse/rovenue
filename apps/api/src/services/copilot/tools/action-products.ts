import { z } from "zod";
import { createIntentTool } from "./_action-helper";
import type { ToolContext } from "./query-subscribers";

export function actionProductsTools(ctx: ToolContext) {
  const tools = {
    "action_products_updatePrice": createIntentTool({
      ctx,
      toolName: "action_products_updatePrice",
      description:
        "Update the display price of a product. Returns a pending intent; the user must approve before it executes.",
      inputSchema: z.object({
        productId: z.string().min(1),
        price: z.number().positive(),
        currency: z.string().length(3),
        reason: z.string().min(1),
      }),
      requiresRole: "ADMIN",
      buildPreview: (i) => ({
        title: `Update price for product ${i.productId}`,
        fields: [
          { label: "Product", after: i.productId },
          { label: "New Price", after: `${i.price} ${i.currency}` },
          { label: "Reason", after: i.reason },
        ],
      }),
    }),
  };
  // MCP serves no action tools yet (writes arrive in Task 9
  // through the intent flow, never as direct ports). Fail closed here so
  // a future unconditional spread cannot leak a mutation tool.
  if (ctx.surface === "mcp") return {} as typeof tools;
  return tools;
}
