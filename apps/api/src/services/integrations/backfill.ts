// =============================================================
// Backfill — re-enqueue outbox events on integration enable
// =============================================================
//
// M4.2 — basic implementation with 7-day default window.
// M4.3 — chunked cursor-pagination loop (bound memory at 10 000/page).
//
// Called when an integration connection transitions from
// `isEnabled = false` to `isEnabled = true`. Queries the
// `outbox_events` table for REVENUE_EVENT and BILLING events
// from the last `windowDays` days and enqueues each one into
// the integrations-deliver BullMQ queue tagged `isBackfill: true`.
//
// The `jobId = connectionId|outboxEventId` separator ensures that
// realtime and backfill jobs co-deduplicate (BullMQ v5 reserves `:`,
// so we use `|` — see queues/integrations.ts).

import type { Queue } from "bullmq";
import type { ProviderId, RovenueEventEnvelope } from "./types";
import {
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";

// =============================================================
// Constants
// =============================================================

const PAGE_SIZE = 10_000;
const DEFAULT_WINDOW_DAYS = 7;

// =============================================================
// Types
// =============================================================

export interface EnqueueBackfillArgs {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  windowDays?: number;
}

/**
 * A minimal DB interface for the backfill query.
 * We use raw SQL via db.execute so any Drizzle-compatible DB
 * object with an `execute` method is sufficient.
 */
export interface BackfillDb {
  execute(query: { queryChunks: unknown[]; sql: string; params: unknown[] }): Promise<{ rows: OutboxRow[] }>;
}

/**
 * The simplified audit wrapper used by backfill.
 * This is intentionally different from the `AuditEntry`-based `audit()`
 * in lib/audit.ts — it uses actorId/actorType/metadata instead of
 * userId/before/after, because backfill is a system-initiated action.
 * The API layer (M5.4) will adapt the real audit() to this shape.
 */
export interface BackfillAuditInput {
  projectId: string;
  actorId: string;
  actorType: "system" | "user";
  action: string;
  resource: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

export interface EnqueueBackfillDeps {
  db: {
    execute(sql: { sql: string; params: unknown[] }): Promise<{ rows: OutboxRow[] }>;
  };
  queue: Queue<IntegrationsDeliverJob>;
  audit: (input: BackfillAuditInput) => Promise<void>;
}

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

export interface EnqueueBackfillResult {
  eventCount: number;
}

// =============================================================
// Implementation
// =============================================================

/**
 * Re-enqueues outbox events from the last `windowDays` days for the given
 * project into the integrations-deliver queue, tagged `isBackfill: true`.
 *
 * Uses cursor-based pagination to avoid loading >10 000 rows into memory at once.
 */
export async function enqueueBackfillForConnection(
  args: EnqueueBackfillArgs,
  deps: EnqueueBackfillDeps,
): Promise<EnqueueBackfillResult> {
  const { connectionId, projectId, providerId } = args;
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;

  let eventCount = 0;
  let cursor: string | null = null; // ISO timestamp of last processed row

  while (true) {
    // Build SQL — raw because Drizzle doesn't support JSONB operator in WHERE
    // easily without extra casting, and a raw sql template keeps the logic clear.
    let sqlStr: string;
    let params: unknown[];

    if (cursor === null) {
      sqlStr = `
        SELECT id, "aggregateType" AS aggregate_type, "eventType" AS event_type,
               payload, "createdAt" AS created_at
        FROM outbox_events
        WHERE payload->>'projectId' = $1
          AND "createdAt" > NOW() - INTERVAL '${windowDays} days'
          AND "aggregateType" IN ('REVENUE_EVENT', 'BILLING')
        ORDER BY "createdAt" ASC
        LIMIT ${PAGE_SIZE}
      `;
      params = [projectId];
    } else {
      sqlStr = `
        SELECT id, "aggregateType" AS aggregate_type, "eventType" AS event_type,
               payload, "createdAt" AS created_at
        FROM outbox_events
        WHERE payload->>'projectId' = $1
          AND "createdAt" > NOW() - INTERVAL '${windowDays} days'
          AND "createdAt" > $2::timestamptz
          AND "aggregateType" IN ('REVENUE_EVENT', 'BILLING')
        ORDER BY "createdAt" ASC
        LIMIT ${PAGE_SIZE}
      `;
      params = [projectId, cursor];
    }

    const result = await deps.db.execute({ sql: sqlStr, params });
    const rows: OutboxRow[] = result.rows;

    if (rows.length === 0) break;

    // Enqueue each row as a backfill job
    for (const row of rows) {
      const jobId = buildIntegrationsDeliverJobId(connectionId, row.id);
      const envelope = row.payload as unknown as RovenueEventEnvelope;
      await deps.queue.add(
        "deliver",
        {
          connectionId,
          projectId,
          providerId,
          envelope,
          isBackfill: true,
        },
        {
          jobId,
          priority: 10,
        },
      );
    }

    eventCount += rows.length;

    // Advance cursor to last row's created_at
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      cursor =
        lastRow.created_at instanceof Date
          ? lastRow.created_at.toISOString()
          : String(lastRow.created_at);
    }

    // Stop if we got fewer than a full page (no more rows)
    if (rows.length < PAGE_SIZE) break;
  }

  await deps.audit({
    projectId,
    actorId: "system",
    actorType: "system",
    action: "integration.backfill.started",
    resource: "integration_connection",
    resourceId: connectionId,
    metadata: { windowDays, eventCount },
  });

  return { eventCount };
}
