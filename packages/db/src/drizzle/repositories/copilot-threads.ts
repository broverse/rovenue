import { and, desc, eq, isNull } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { type Db } from "../client";
import { copilotThreads } from "../schema";

export type CopilotThread = typeof copilotThreads.$inferSelect;
export type NewCopilotThread = typeof copilotThreads.$inferInsert;

export async function createThread(
  db: Db,
  input: {
    /** Optional client-supplied id (e.g. v6 useChat session id). Defaults to a cuid2. */
    id?: string;
    projectId: string;
    userId: string;
    title: string;
    provider: string;
    model: string;
  },
): Promise<CopilotThread> {
  const { id, ...rest } = input;
  const [row] = await db
    .insert(copilotThreads)
    .values({ id: id ?? createId(), ...rest })
    .returning();
  return row;
}

export async function listThreadsForUser(
  db: Db,
  projectId: string,
  userId: string,
  limit = 50,
): Promise<CopilotThread[]> {
  return db
    .select()
    .from(copilotThreads)
    .where(
      and(
        eq(copilotThreads.projectId, projectId),
        eq(copilotThreads.userId, userId),
        isNull(copilotThreads.archivedAt),
      ),
    )
    .orderBy(desc(copilotThreads.lastMessageAt))
    .limit(limit);
}

export async function getThread(
  db: Db,
  id: string,
): Promise<CopilotThread | null> {
  const [row] = await db
    .select()
    .from(copilotThreads)
    .where(eq(copilotThreads.id, id))
    .limit(1);
  return row ?? null;
}

export async function archiveThread(db: Db, id: string): Promise<void> {
  await db
    .update(copilotThreads)
    .set({ archivedAt: new Date() })
    .where(eq(copilotThreads.id, id));
}

export async function touchThread(db: Db, id: string): Promise<void> {
  await db
    .update(copilotThreads)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(copilotThreads.id, id));
}
