import { sql, type Column, type SQL, type Table } from "drizzle-orm";
import type { Db } from "../client";
import { copilotMessages, copilotThreads, outgoingWebhooks, webhookEvents } from "../schema";

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
//
// --- Tenant scoping ---
//
// Every delete is scoped to ONE project — the sweep calls this once
// per (project, policy) unit, and a global, unscoped delete here would
// mean one project's resolved window (however short) destroys every
// project's rows in that table, INCLUDING a project the sweep skipped
// as "no-window" specifically to protect it. `outgoing_webhooks` and
// `webhook_events` carry their own `projectId` column. `copilot_messages`
// does NOT: it is scoped only through `copilot_threads.projectId`
// (physical column `project_id`), so that one table needs a subquery
// join rather than a plain equality predicate — see `ProjectScope`
// below. This is exactly the kind of per-table naming divergence this
// module already has to account for, so each table's scope is declared
// explicitly rather than assumed uniform.

type ProjectScope =
  | { kind: "direct"; column: Column }
  | {
      kind: "joined";
      viaColumn: Column;
      parentTable: Table;
      parentIdColumn: Column;
      parentProjectIdColumn: Column;
    };

interface DeleteRowsTable {
  table: Table;
  idColumn: Column;
  timestampColumns: Record<string, Column>;
  statusColumn?: Column;
  projectScope: ProjectScope;
}

const DELETE_ROWS_TABLES: Record<string, DeleteRowsTable> = {
  outgoing_webhooks: {
    table: outgoingWebhooks,
    idColumn: outgoingWebhooks.id,
    timestampColumns: { createdAt: outgoingWebhooks.createdAt },
    statusColumn: outgoingWebhooks.status,
    projectScope: { kind: "direct", column: outgoingWebhooks.projectId },
  },
  webhook_events: {
    table: webhookEvents,
    idColumn: webhookEvents.id,
    timestampColumns: { createdAt: webhookEvents.createdAt },
    projectScope: { kind: "direct", column: webhookEvents.projectId },
  },
  copilot_messages: {
    table: copilotMessages,
    idColumn: copilotMessages.id,
    timestampColumns: { createdAt: copilotMessages.createdAt },
    projectScope: {
      kind: "joined",
      viaColumn: copilotMessages.threadId,
      parentTable: copilotThreads,
      parentIdColumn: copilotThreads.id,
      parentProjectIdColumn: copilotThreads.projectId,
    },
  },
};

/**
 * Whether a DELETE_ROWS policy naming this table has a registered
 * mapping here. Exposed so a policy added to the registry
 * (@rovenue/shared/retention) without a matching entry in
 * `DELETE_ROWS_TABLES` fails a CI test instead of surfacing only as a
 * runtime error, once per project, every night the sweep runs.
 */
export function hasDeleteRowsMapping(table: string): boolean {
  return table in DELETE_ROWS_TABLES;
}

function projectScopeCondition(scope: ProjectScope, projectId: string): SQL {
  if (scope.kind === "direct") {
    return sql`${scope.column} = ${projectId}`;
  }
  // Uncorrelated subquery against the parent table alone — the parent's
  // columns never need qualifying against the outer table because the
  // outer table is never referenced inside this subquery.
  return sql`${scope.viaColumn} IN (
    SELECT ${scope.parentIdColumn} FROM ${scope.parentTable}
    WHERE ${scope.parentProjectIdColumn} = ${projectId}
  )`;
}

export interface DeleteRetentionRowsResult {
  deleted: number;
  /**
   * True when the loop stopped because `maxBatches` was reached while
   * the most recent batch was still a full `batchSize` — i.e. rows past
   * the cutoff may still remain for this (project, table) unit. False
   * when the loop stopped because a batch came back partial (the table
   * is fully caught up) or because there was nothing to delete at all.
   */
  hitBatchCap: boolean;
}

/**
 * Batched DELETE_ROWS reclaim for one retention policy's table, scoped
 * to a single project.
 *
 * Mirrors `deleteWebhookEventsOlderThan`'s batching shape
 * (webhook-events.ts): a bounded subselect, looping until a batch comes
 * back partial, capped at `maxBatches` as a safety brake against a
 * single long table-wide lock, WAL spike, or OOM'd `.returning()`.
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
  projectId: string,
  cutoff: Date,
  terminalStatuses: readonly string[] | undefined,
  batchSize: number,
  maxBatches: number,
): Promise<DeleteRetentionRowsResult> {
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

  const conditions: SQL[] = [
    sql`${column} < ${cutoff}`,
    projectScopeCondition(entry.projectScope, projectId),
  ];
  if (hasTerminalStatuses && entry.statusColumn) {
    // `sql.param` is required here, not plain `${...}` interpolation:
    // drizzle expands a bare array interpolation into a comma-separated
    // list of individual bind params (producing a record literal, not
    // an array literal) — `sql.param` is what forces it to bind as one
    // parameter, which is what `= ANY($n::text[])` needs. The status
    // column itself is cast to `::text` because it's a Postgres enum
    // (e.g. `outgoing_webhook_status`), and `enum = ANY(text[])` has no
    // operator without casting one side.
    conditions.push(
      sql`${entry.statusColumn}::text = ANY(${sql.param([...terminalStatuses!])}::text[])`,
    );
  }
  const whereClause = sql.join(conditions, sql` AND `);

  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await db.execute(sql`
      DELETE FROM ${entry.table}
      WHERE ${entry.idColumn} IN (
        SELECT ${entry.idColumn} FROM ${entry.table}
        WHERE ${whereClause}
        ORDER BY ${column} ASC
        LIMIT ${batchSize}
      )
    `);
    // node-postgres returns rowCount on Result; drizzle's execute
    // returns the underlying QueryResult. Both expose `rowCount`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = Number((result as any)?.rowCount ?? 0);
    deleted += n;
    if (n < batchSize) {
      return { deleted, hitBatchCap: false };
    }
  }
  // Every one of the `maxBatches` iterations came back a full batch:
  // the cap, not an empty table, is why the loop stopped.
  return { deleted, hitBatchCap: true };
}
