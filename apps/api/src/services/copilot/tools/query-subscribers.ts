import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";

export interface ToolContext {
  projectId: string;
  userId: string;
  role: string;
  threadId: string;
  messageId: string;
  /**
   * The dashboard route the chat request was sent from (`context.route` in
   * the chat body — see `chat.ts`). Route-gated tool sets (e.g. the paywall
   * builder tools in `tools/index.ts`) key off this instead of a dedicated
   * feature flag, so a tool is only offered to the model while the user is
   * actually looking at the surface it edits.
   */
  route?: string;
}

const SearchArgs = z.object({
  filter: z
    .object({
      q: z.string().optional(),
      status: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(50).default(20),
});

const GetArgs = z.object({ id: z.string().min(1) });

export function querySubscribersTools(ctx: ToolContext) {
  return {
    "query_subscribers_search": tool({
      description:
        "Search subscribers in the current project. Returns id, appUserId, status, country, firstSeenAt, lastSeenAt only.",
      inputSchema: SearchArgs,
      execute: async ({ filter, limit }) => {
        const rows = await drizzle.subscriberRepo.listSubscribers(drizzle.db, {
          projectId: ctx.projectId,
          q: filter?.q,
          status: filter?.status as
            | "active"
            | "trial"
            | "grace"
            | "churned"
            | undefined,
          country: filter?.country,
          limit,
        });
        return sterilizeToolResult({ subscribers: rows });
      },
    }),
    "query_subscribers_get": tool({
      description: "Get subscriber details by id within the current project.",
      inputSchema: GetArgs,
      execute: async ({ id }) => {
        const row = await drizzle.subscriberRepo.findSubscriberById(
          drizzle.db,
          id,
        );
        if (!row || row.projectId !== ctx.projectId) {
          return sterilizeToolResult(null);
        }
        return sterilizeToolResult(row);
      },
    }),
  };
}
