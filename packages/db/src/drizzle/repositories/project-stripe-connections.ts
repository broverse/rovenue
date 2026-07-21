import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  projectStripeConnections,
  type NewProjectStripeConnection,
  type ProjectStripeConnection,
} from "../schema";

export type DisconnectReason = "user" | "stripe_deauthorized";

export interface AccountState {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  capabilities: unknown;
  country?: string | null;
  defaultCurrency?: string | null;
}

/** The project's live connection, or null when it has never connected. */
export async function findActiveByProject(
  db: Db,
  projectId: string,
): Promise<ProjectStripeConnection | null> {
  const rows = await db
    .select()
    .from(projectStripeConnections)
    .where(
      and(
        eq(projectStripeConnections.projectId, projectId),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reverse lookup used by the Connect webhook to turn `event.account`
 * into a project. Disconnected rows are excluded so in-flight events
 * for a revoked account resolve to nothing.
 */
export async function findActiveByAccountId(
  db: Db,
  accountId: string,
): Promise<ProjectStripeConnection | null> {
  const rows = await db
    .select()
    .from(projectStripeConnections)
    .where(
      and(
        eq(projectStripeConnections.stripeAccountId, accountId),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    )
    .orderBy(desc(projectStripeConnections.connectedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(
  db: Db,
  values: NewProjectStripeConnection,
): Promise<ProjectStripeConnection> {
  const rows = await db
    .insert(projectStripeConnections)
    .values(values)
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to insert project_stripe_connections row");
  return row;
}

export async function markDisconnected(
  db: Db,
  id: string,
  reason: DisconnectReason,
): Promise<void> {
  await db
    .update(projectStripeConnections)
    .set({ disconnectedAt: new Date(), disconnectReason: reason })
    .where(
      and(
        eq(projectStripeConnections.id, id),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    );
}

export async function updateAccountState(
  db: Db,
  id: string,
  state: AccountState,
): Promise<void> {
  await db
    .update(projectStripeConnections)
    .set({
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      capabilities: state.capabilities,
      country: state.country ?? null,
      defaultCurrency: state.defaultCurrency ?? null,
      lastSyncedAt: new Date(),
    })
    .where(eq(projectStripeConnections.id, id));
}
