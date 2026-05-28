import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

const ListProductsArgs = z.object({
  search: z.string().optional(),
  includeInactive: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(50),
});

export function queryProductsTools(ctx: ToolContext) {
  return {
    "query.products.list": tool({
      description:
        "List products (in-app purchases / subscriptions) in the current project. Returns id, identifier, displayName, type, isActive.",
      inputSchema: ListProductsArgs,
      execute: async ({ search, includeInactive, limit }) => {
        const rows = await drizzle.productRepo.listProducts(drizzle.db, {
          projectId: ctx.projectId,
          includeInactive,
          search: search ?? null,
        });
        return sterilizeToolResult({ products: rows.slice(0, limit) });
      },
    }),
  };
}
