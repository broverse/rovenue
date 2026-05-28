import { asc, eq, lt, sql } from "drizzle-orm";
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

/**
 * Hard-delete copilot_messages older than `retentionDays` days.
 * Called by the daily retention worker to satisfy GDPR Art. 5(1)(e).
 * Returns the number of rows deleted.
 */
export async function purgeOldMessages(db: Db, retentionDays: number): Promise<number> {
  const cutoff = sql`now() - (${retentionDays} || ' days')::interval`;
  const result = await db
    .delete(copilotMessages)
    .where(lt(copilotMessages.createdAt, cutoff));
  return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
}
