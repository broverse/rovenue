import { tool } from "ai";
import type { z } from "zod";
import { drizzle } from "@rovenue/db";
import type { ToolContext } from "./query-subscribers";
import type { RoviIntentPreview } from "@rovenue/shared";

export function createIntentTool<S extends z.ZodTypeAny>(args: {
  ctx: ToolContext;
  toolName: string;
  description: string;
  inputSchema: S;
  requiresRole: string;
  buildPreview: (input: z.infer<S>) => RoviIntentPreview;
}) {
  return tool({
    description: args.description,
    inputSchema: args.inputSchema,
    execute: async (input) => {
      const intent = await drizzle.copilotIntentRepo.createIntent(drizzle.db, {
        projectId: args.ctx.projectId,
        userId: args.ctx.userId,
        threadId: args.ctx.threadId,
        messageId: args.ctx.messageId,
        toolName: args.toolName,
        payload: input,
        preview: args.buildPreview(input),
        requiresRole: args.requiresRole,
      });
      return {
        intentId: intent.id,
        toolName: args.toolName,
        preview: intent.preview,
        requiresRole: args.requiresRole,
        expiresAt: intent.expiresAt.toISOString(),
      };
    },
  });
}
