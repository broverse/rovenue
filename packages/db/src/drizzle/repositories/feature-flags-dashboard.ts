import { asc, count, eq } from "drizzle-orm";
import type { Db } from "../client";
import { featureFlags, type FeatureFlag } from "../schema";

export async function countFeatureFlags(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(featureFlags)
    .where(eq(featureFlags.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}

// =============================================================
// Dashboard feature flag reads — single-project list + lookup
// =============================================================
//
// Sister module to repositories/feature-flags.ts which holds the
// evaluation-layer lookups. Separating by use case keeps the
// dashboard's ordering/paging concerns out of the SDK hot path.

export async function listFeatureFlags(
  db: Db,
  projectId: string,
): Promise<FeatureFlag[]> {
  return db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.projectId, projectId))
    .orderBy(asc(featureFlags.key));
}

export async function findFeatureFlagById(
  db: Db,
  id: string,
): Promise<FeatureFlag | null> {
  const rows = await db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.id, id))
    .limit(1);
  return rows[0] ?? null;
}
