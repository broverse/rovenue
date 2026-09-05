import { and, inArray, lt, sql, type Column, type Table } from "drizzle-orm";
import type { Db } from "../client";
import { copilotMessages, outgoingWebhooks, webhookEvents } from "../schema";

type DbOrTx = Db;

// =============================================================
// Generic DELETE_ROWS reclaim (ROADMAP §9.2 Task 3)
// =============================================================
//
// The retention policy registry (@rovenue/shared/retention) names a
// policy's table and timestamp column as plain strings, and those
// strings are DRIZZLE SCHEMA PROPERTY NAMES, not guaranteed-matching
// physical DB column names. `copilot_messages` is the proof this
// distinction matters: its Drizzle field is `createdAt`
// (packages/db/src/drizzle/schema.ts) but the physical column is
// `created_at`. Building this query by raw-interpolating the policy's
// strings as quoted SQL identifiers would target a column that does
// not exist for that one table while looking correct for the other
// five. Indexing into the real Drizzle table objects below sidesteps
// the whole class of bug — Drizzle already knows each field's true
// physical name, so the property name is all this needs.
//
// Only the three DELETE_ROWS tables are registered here on purpose:
// `audit_logs` (CHECKPOINT_TRUNCATE) and `credit_ledger` /
// `revenue_events` (DROP_PARTITION) are out of scope for this
// strategy and are handled by Tasks 4 and 5.

interface DeleteRowsTable {
  table: Table;
  idColumn: Column;
  timestampColumns: Record<string, Column>;
  statusColumn?: Column;
}

const DELETE_ROWS_TABLES: Record<string, DeleteRowsTable> = {
  outgoing_webhooks: {
    table: outgoingWebhooks,
    idColumn: outgoingWebhooks.id,
    timestampColumns: { createdAt: outgoingWebhooks.createdAt },
    statusColumn: outgoingWebhooks.status,
  },
  webhook_events: {
    table: webhookEvents,
    idColumn: webhookEvents.id,
    timestampColumns: { createdAt: webhookEvents.createdAt },
  },
  copilot_messages: {
    table: copilotMessages,
    idColumn: copilotMessages.id,
    timestampColumns: { createdAt: copilotMessages.createdAt },
  },
};

/**
 * Batched DELETE_ROWS reclaim for one retention policy's table.
 *
 * Mirrors `deleteWebhookEventsOlderThan` (webhook-events.ts): a bounded
 * subselect, looping until a batch comes back partial, capped at
 * `maxBatches` as a safety brake against a single long table-wide
 * lock, WAL spike, or OOM'd `.returning()`.
 *
 * `terminalStatuses`, when given and non-empty, additionally restricts
 * the delete to rows whose status is one of those values
 * (`RetentionPolicy.terminalStatuses`) — an age-only delete is unsafe
 * for a table with a delivery lifecycle (a still-owed outgoing webhook
 * must not be destroyed merely because it is old).
 *
 * Throws if `table`/`timestampColumn` name a pair this function does
 * not recognize, or if `terminalStatuses` is given for a table with no
 * status column registered — a policy pointing at a table this sweep
 * cannot reach is a configuration bug that must fail loudly rather
 * than silently deleting nothing or, worse, deleting everything.
 */
export async function deleteRetentionRowsOlderThan(
  db: DbOrTx,
  table: string,
  timestampColumn: string,
  cutoff: Date,
  terminalStatuses: readonly string[] | undefined,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  const entry = DELETE_ROWS_TABLES[table];
  if (!entry) {
    throw new Error(
      `deleteRetentionRowsOlderThan: unknown DELETE_ROWS table "${table}"`,
    );
  }
  const column = entry.timestampColumns[timestampColumn];
  if (!column) {
    throw new Error(
      `deleteRetentionRowsOlderThan: table "${table}" has no registered timestamp column "${timestampColumn}"`,
    );
  }
  const hasTerminalStatuses = Boolean(terminalStatuses?.length);
  if (hasTerminalStatuses && !entry.statusColumn) {
    throw new Error(
      `deleteRetentionRowsOlderThan: table "${table}" has no status column but terminalStatuses was given`,
    );
  }

  const condition =
    hasTerminalStatuses && entry.statusColumn
      ? and(lt(column, cutoff), inArray(entry.statusColumn, [...terminalStatuses!]))
      : lt(column, cutoff);

  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await db.execute(sql`
      DELETE FROM ${entry.table}
      WHERE ${entry.idColumn} IN (
        SELECT ${entry.idColumn} FROM ${entry.table}
        WHERE ${condition}
        ORDER BY ${column} ASC
        LIMIT ${batchSize}
      )
    `);
    // node-postgres returns rowCount on Result; drizzle's execute
    // returns the underlying QueryResult. Both expose `rowCount`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = (result as any)?.rowCount ?? 0;
    total += Number(n);
    if (Number(n) < batchSize) break;
  }
  return total;
}
