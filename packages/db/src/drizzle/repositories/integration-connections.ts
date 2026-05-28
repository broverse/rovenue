import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  integrationConnections,
  type IntegrationConnection,
  type NewIntegrationConnection,
} from "../schema";

export async function createConnection(
  db: Db,
  values: NewIntegrationConnection,
): Promise<IntegrationConnection> {
  const [row] = await db
    .insert(integrationConnections)
    .values(values)
    .returning();
  if (!row) throw new Error("createConnection: insert returned no row");
  return row;
}

export async function getConnection(
  db: Db,
  id: string,
): Promise<IntegrationConnection | undefined> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row;
}

export async function listActiveConnectionsForProject(
  db: Db,
  projectId: string,
): Promise<IntegrationConnection[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.projectId, projectId),
        eq(integrationConnections.isEnabled, true),
      ),
    );
}

export async function updateConnection(
  db: Db,
  id: string,
  patch: Partial<NewIntegrationConnection>,
): Promise<IntegrationConnection> {
  const [row] = await db
    .update(integrationConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id))
    .returning();
  if (!row) throw new Error(`updateConnection: id=${id} not found`);
  return row;
}

export async function softDeleteConnection(
  db: Db,
  id: string,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      isEnabled: false,
      credentialsCipher: "",
      credentialsHint: "deleted",
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, id));
}
