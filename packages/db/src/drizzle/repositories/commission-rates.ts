import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  projectStoreCommissionRates,
  type ProjectStoreCommissionRate,
} from "../schema";
import { store as storeEnum } from "../enums";

/**
 * The transaction proxy Drizzle hands `db.transaction(cb)`, derived from
 * `Db` itself so it cannot drift from the client's version.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Every function here takes `Db` OR a caller's transaction, and both are
 * real call sites: the dashboard route runs the rate write and its audit
 * chain entry in ONE transaction (see
 * apps/api/src/routes/dashboard/commission-rates.ts), so a rolled-back
 * rate change cannot leave an audit row claiming it happened. Spelling
 * the union out means that caller does not have to cast its tx back to
 * `Db` to satisfy the signature.
 */
type DbOrTx = Db | Tx;
type Store = (typeof storeEnum.enumValues)[number];

// =============================================================
// project_store_commission_rates — Drizzle repository
// =============================================================
//
// Config-only table (Task 4): stores the customer's own statement of the
// commission a store takes, per project per store. Never derived from
// revenue — see the table comment in schema.ts and
// apps/api/src/services/metrics/proceeds.ts for the query-time consumer.
// No row for a (projectId, store) pair means "no rate configured"; callers
// must treat that as "no proceeds estimate available", never as 0%.

/**
 * Fetch the configured commission rate for one project+store.
 * Returns `null` when nothing has been configured (the caller's
 * signal to render "no estimate available", not a silent 0%).
 */
export async function getCommissionRate(
  db: DbOrTx,
  projectId: string,
  store: Store,
): Promise<ProjectStoreCommissionRate | null> {
  const [row] = await db
    .select()
    .from(projectStoreCommissionRates)
    .where(
      and(
        eq(projectStoreCommissionRates.projectId, projectId),
        eq(projectStoreCommissionRates.store, store),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * List every configured rate for a project (one row per store that has
 * been given a rate; stores with no row are simply absent).
 */
export async function listCommissionRates(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectStoreCommissionRate[]> {
  return db
    .select()
    .from(projectStoreCommissionRates)
    .where(eq(projectStoreCommissionRates.projectId, projectId));
}

export interface UpsertCommissionRateInput {
  projectId: string;
  store: Store;
  /** Fraction in [0, 1] (0.15 == 15%), as a decimal string. */
  rate: string;
}

/**
 * Set (or replace) the configured rate for a project+store. The
 * (projectId, store) primary key means a second call for the same pair
 * overwrites rather than duplicates — a rate change is a config update,
 * not a new fact appended to history (unlike `revenue_events`).
 */
export async function upsertCommissionRate(
  db: DbOrTx,
  input: UpsertCommissionRateInput,
): Promise<ProjectStoreCommissionRate> {
  const [row] = await db
    .insert(projectStoreCommissionRates)
    .values({
      projectId: input.projectId,
      store: input.store,
      rate: input.rate,
    })
    .onConflictDoUpdate({
      target: [
        projectStoreCommissionRates.projectId,
        projectStoreCommissionRates.store,
      ],
      set: {
        rate: input.rate,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("upsertCommissionRate: insert/update returned no rows");
  }
  return row;
}

/**
 * Remove a configured rate, reverting the project+store back to
 * "no estimate available".
 */
export async function deleteCommissionRate(
  db: DbOrTx,
  projectId: string,
  store: Store,
): Promise<void> {
  await db
    .delete(projectStoreCommissionRates)
    .where(
      and(
        eq(projectStoreCommissionRates.projectId, projectId),
        eq(projectStoreCommissionRates.store, store),
      ),
    );
}
