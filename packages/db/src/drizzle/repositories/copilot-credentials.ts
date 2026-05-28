import { eq } from "drizzle-orm";
import { type Db } from "../client";
import { copilotCredentials } from "../schema";

export type CopilotCredentials = typeof copilotCredentials.$inferSelect;

export async function getCredentials(
  db: Db,
  projectId: string,
): Promise<CopilotCredentials | null> {
  const [row] = await db
    .select()
    .from(copilotCredentials)
    .where(eq(copilotCredentials.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export async function upsertCredentials(
  db: Db,
  input: Omit<CopilotCredentials, "updatedAt"> & { updatedAt?: Date },
): Promise<CopilotCredentials> {
  const [row] = await db
    .insert(copilotCredentials)
    .values({ ...input, updatedAt: input.updatedAt ?? new Date() })
    .onConflictDoUpdate({
      target: copilotCredentials.projectId,
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function deleteCredentials(
  db: Db,
  projectId: string,
): Promise<void> {
  await db
    .delete(copilotCredentials)
    .where(eq(copilotCredentials.projectId, projectId));
}
