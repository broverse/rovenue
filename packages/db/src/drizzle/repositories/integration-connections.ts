import { eq } from "drizzle-orm";
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
