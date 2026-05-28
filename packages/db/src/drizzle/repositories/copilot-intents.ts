import { and, eq, lt, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { type Db } from "../client";
import { copilotIntents } from "../schema";

export type CopilotIntent = typeof copilotIntents.$inferSelect;
export type CopilotIntentStatus = CopilotIntent["status"];

const INTENT_TTL_MS = 5 * 60 * 1000;

export async function createIntent(
  db: Db,
  input: {
    projectId: string;
    userId: string;
    threadId: string;
    messageId: string;
    toolName: string;
    payload: unknown;
    preview: unknown;
    requiresRole: string;
  },
): Promise<CopilotIntent> {
  const [row] = await db
    .insert(copilotIntents)
    .values({
      id: createId(),
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      ...input,
    })
    .returning();
  return row;
}

export async function getIntent(
  db: Db,
  id: string,
): Promise<CopilotIntent | null> {
  const [row] = await db
    .select()
    .from(copilotIntents)
    .where(eq(copilotIntents.id, id))
    .limit(1);
  return row ?? null;
}

export async function transitionIntent(
  db: Db,
  id: string,
  next: {
    status: CopilotIntentStatus;
    result?: unknown;
    error?: unknown;
    executedAt?: Date;
  },
): Promise<CopilotIntent | null> {
  const [row] = await db
    .update(copilotIntents)
    .set(next)
    .where(and(eq(copilotIntents.id, id), eq(copilotIntents.status, "pending")))
    .returning();
  return row ?? null;
}

export async function expireStaleIntents(db: Db): Promise<number> {
  const result = await db
    .update(copilotIntents)
    .set({ status: "expired" })
    .where(
      and(eq(copilotIntents.status, "pending"), lt(copilotIntents.expiresAt, new Date())),
    );
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}

export async function countCreatedToday(
  db: Db,
  projectId: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM copilot_intents
    WHERE project_id = ${projectId}
      AND created_at >= date_trunc('day', now())
  `);
  const rows = (result as unknown as { rows: { count: number }[] }).rows ?? [];
  return Number(rows[0]?.count ?? 0);
}
