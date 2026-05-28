import { asc, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { type Db } from "../client";
import { copilotMessages } from "../schema";

export type CopilotMessage = typeof copilotMessages.$inferSelect;
export type CopilotMessageRole = CopilotMessage["role"];

export async function appendMessage(
  db: Db,
  input: {
    threadId: string;
    role: CopilotMessageRole;
    parts: unknown;
    tokenIn?: number;
    tokenOut?: number;
  },
): Promise<CopilotMessage> {
  const [row] = await db
    .insert(copilotMessages)
    .values({ id: createId(), ...input })
    .returning();
  return row;
}

export async function listMessages(
  db: Db,
  threadId: string,
): Promise<CopilotMessage[]> {
  return db
    .select()
    .from(copilotMessages)
    .where(eq(copilotMessages.threadId, threadId))
    .orderBy(asc(copilotMessages.createdAt));
}

export async function recentMessages(
  db: Db,
  threadId: string,
  limit = 20,
): Promise<CopilotMessage[]> {
  const rows = await db
    .select()
    .from(copilotMessages)
    .where(eq(copilotMessages.threadId, threadId))
    .orderBy(asc(copilotMessages.createdAt));
  return rows.slice(-limit);
}
