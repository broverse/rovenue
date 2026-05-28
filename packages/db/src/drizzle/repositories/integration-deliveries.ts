import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../client";
import {
  integrationDeliveries,
  type IntegrationDelivery,
  type NewIntegrationDelivery,
} from "../schema";

// =============================================================
// insertPendingDelivery
// =============================================================
//
// ON CONFLICT DO NOTHING on the dedupe unique index
// (connection_id, outbox_event_id, created_at).
// Returns the inserted row, or undefined when a duplicate was
// silently skipped.
//
// Note: `onConflictDoNothing()` is called WITHOUT an explicit
// `target` because the table is partitioned. Postgres does not
// support an explicit conflict target referencing a partial/unique
// index on a partitioned table parent — the bare DO NOTHING form
// correctly catches any unique-constraint violation across all
// partitions.

export async function insertPendingDelivery(
  db: Db,
  values: NewIntegrationDelivery,
): Promise<IntegrationDelivery | undefined> {
  const [row] = await db
    .insert(integrationDeliveries)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return row;
}
