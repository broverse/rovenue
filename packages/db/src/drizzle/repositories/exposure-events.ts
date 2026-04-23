import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  exposureEvents,
  type ExposureEvent,
  type NewExposureEvent,
} from "../schema";

// =============================================================
// Exposure event writes — batched insert for the flusher worker
// =============================================================
//
// The ingest endpoint (Phase 6 Task 6.3) pushes rows to a Redis
// buffer; a background flusher drains the buffer every 2s or when
// it reaches 500 rows and calls `insertMany` here. PeerDB then
// replicates into ClickHouse raw_exposures for analytics.

export async function insertMany(
  db: Db,
  rows: NewExposureEvent[],
): Promise<void> {
  if (rows.length === 0) return;
  // Chunked insert to stay under Postgres' 65k parameter limit
  // (8 columns × 8000 rows = 64000; 500 is a safer ceiling that
  // keeps each batch's statement time-bounded).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(exposureEvents).values(rows.slice(i, i + CHUNK));
  }
}

export async function countSince(
  db: Db,
  projectId: string,
  since: Date,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(exposureEvents)
    .where(
      and(
        eq(exposureEvents.projectId, projectId),
        gte(exposureEvents.exposedAt, since),
      ),
    );
  return Number(result[0]?.count ?? 0);
}

export type { ExposureEvent, NewExposureEvent };
