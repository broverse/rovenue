import { sql } from "drizzle-orm";
import type { Db } from "../client";

// Accepts the top-level db or a tx handle; advisory xact locks are
// held for the duration of the surrounding transaction.
type DbOrTx = Db;

// =============================================================
// Postgres advisory locks — Drizzle wrappers
// =============================================================
//
// `pg_advisory_xact_lock(bigint)` queues the caller until the key
// is free, then auto-releases at COMMIT/ROLLBACK. The key is derived
// from a stable string via `hashtextextended` so callers don't need
// to manage an integer-key registry.
//
// Every lock call MUST run inside a Drizzle db.transaction — outside
// one, the "xact" variant degrades to a session lock and the
// auto-release guarantee is gone.

/**
 * Acquire one advisory xact lock keyed by `key`. Hash collisions are
 * possible but benign for this use case (serialises two unrelated
 * keys briefly) and the 64-bit hash space makes them vanishingly
 * rare in practice.
 */
export async function advisoryXactLock(
  db: DbOrTx,
  key: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/**
 * Acquire two advisory xact locks in a single round trip. The caller
 * should sort `keys` to avoid ordering-induced deadlocks with
 * concurrent callers that lock the same pair.
 */
export async function advisoryXactLock2(
  db: DbOrTx,
  keyA: string,
  keyB: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${keyA}, 0)),
               pg_advisory_xact_lock(hashtextextended(${keyB}, 0))`,
  );
}
