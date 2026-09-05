import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  projectRetentionOverrides,
  type ProjectRetentionOverride,
} from "../schema";

// =============================================================
// project_retention_overrides repository
// =============================================================
//
// A project may ask to keep a table for LESS time than its billing tier
// allows. It may not ask for more: the clamping lives in
// `resolveRetentionWindowDays` (@rovenue/shared/retention), not here, so
// this repository stores what was asked for and the sweep decides what it
// means. That split matters on a tier downgrade — a stored 365 written
// under an enterprise tier is simply ignored once the tier says 180,
// rather than becoming a row that can never be read back.

/**
 * The transaction proxy Drizzle hands `db.transaction(cb)`, derived from
 * `Db` itself so it cannot drift from the client's version. Mirrors the
 * shape `commission-rates.ts` uses for the same reason: a dashboard route
 * that writes an override and its audit-chain entry must be able to do
 * both in one transaction.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type DbOrTx = Db | Tx;

export interface UpsertRetentionOverrideInput {
  projectId: string;
  tableName: string;
  retentionDays: number;
}

/**
 * Every override a project has set, keyed by table name.
 *
 * Returns an EMPTY map for a project with no overrides rather than null
 * or throwing: the sweep merges this against the policy registry, so
 * "this project has configured nothing" is an ordinary answer on the main
 * path, not an exceptional one.
 */
export async function listRetentionOverrides(
  db: DbOrTx,
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      tableName: projectRetentionOverrides.tableName,
      retentionDays: projectRetentionOverrides.retentionDays,
    })
    .from(projectRetentionOverrides)
    .where(eq(projectRetentionOverrides.projectId, projectId));

  return new Map(rows.map((r) => [r.tableName, r.retentionDays]));
}

/**
 * Set a project's window for one table, replacing any existing value.
 *
 * Keyed on the composite primary key, so a repeat write updates in place.
 * Without that key a second call would add a row and the sweep would have
 * two windows to choose between for the same table.
 */
export async function upsertRetentionOverride(
  db: DbOrTx,
  input: UpsertRetentionOverrideInput,
): Promise<ProjectRetentionOverride> {
  const [row] = await db
    .insert(projectRetentionOverrides)
    .values({
      projectId: input.projectId,
      tableName: input.tableName,
      retentionDays: input.retentionDays,
    })
    .onConflictDoUpdate({
      target: [
        projectRetentionOverrides.projectId,
        projectRetentionOverrides.tableName,
      ],
      set: {
        retentionDays: input.retentionDays,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(
      "upsertRetentionOverride: insert/update returned no rows",
    );
  }
  return row;
}

/** Drop a project's override for one table, falling back to its tier. */
export async function deleteRetentionOverride(
  db: DbOrTx,
  projectId: string,
  tableName: string,
): Promise<void> {
  await db
    .delete(projectRetentionOverrides)
    .where(
      and(
        eq(projectRetentionOverrides.projectId, projectId),
        eq(projectRetentionOverrides.tableName, tableName),
      ),
    );
}
