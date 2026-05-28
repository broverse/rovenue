import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./query-subscribers";

export function uiTools(_ctx: ToolContext) {
  return {
    "ui.navigate": tool({
      description: "Navigate the dashboard to a specific page.",
      inputSchema: z.object({
        to: z.enum([
          "overview",
          "subscribers",
          "subscriptions",
          "products",
          "audiences",
          "experiments",
          "featureFlags",
          "transactions",
        ]),
        params: z.record(z.string()).optional(),
      }),
      execute: async (input) => ({ uiAction: "navigate", ...input }),
    }),
    "ui.filter": tool({
      description: "Apply a filter to the currently visible table.",
      inputSchema: z.object({
        entity: z.string(),
        filter: z.record(z.unknown()),
      }),
      execute: async (input) => ({ uiAction: "filter", ...input }),
    }),
    "ui.openSubscriber": tool({
      description: "Open a subscriber's detail page.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async (input) => ({ uiAction: "openSubscriber", ...input }),
    }),
  };
}
