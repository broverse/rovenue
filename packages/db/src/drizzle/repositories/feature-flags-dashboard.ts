import { asc, count, eq } from "drizzle-orm";
import type { Db } from "../client";
import { featureFlags, type FeatureFlag } from "../schema";
import { featureFlagType } from "../enums";

type DbOrTx = Db;
type FeatureFlagType = (typeof featureFlagType.enumValues)[number];

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

// =============================================================
// Writes
// =============================================================

export interface CreateFeatureFlagInput {
  projectId: string;
  key: string;
  type: FeatureFlagType;
  defaultValue: unknown;
  rules: unknown;
  isEnabled?: boolean;
  description?: string | null;
}

export async function createFeatureFlag(
  db: DbOrTx,
  input: CreateFeatureFlagInput,
): Promise<FeatureFlag> {
  const rows = await db
    .insert(featureFlags)
    .values({
      projectId: input.projectId,
      key: input.key,
      type: input.type,
      defaultValue:
        input.defaultValue as typeof featureFlags.$inferInsert.defaultValue,
      rules: input.rules as typeof featureFlags.$inferInsert.rules,
      isEnabled: input.isEnabled ?? true,
      description: input.description ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create feature flag");
  return row;
}

export interface UpdateFeatureFlagInput {
  key?: string;
  defaultValue?: unknown;
  rules?: unknown;
  isEnabled?: boolean;
  description?: string | null;
}

export async function updateFeatureFlag(
  db: DbOrTx,
  id: string,
  patch: UpdateFeatureFlagInput,
): Promise<FeatureFlag | null> {
  const data: Partial<typeof featureFlags.$inferInsert> = {};
  if (patch.key !== undefined) data.key = patch.key;
  if (patch.defaultValue !== undefined) {
    data.defaultValue =
      patch.defaultValue as typeof featureFlags.$inferInsert.defaultValue;
  }
  if (patch.rules !== undefined) {
    data.rules = patch.rules as typeof featureFlags.$inferInsert.rules;
  }
  if (patch.isEnabled !== undefined) data.isEnabled = patch.isEnabled;
  if (patch.description !== undefined) data.description = patch.description;
  if (Object.keys(data).length === 0) return null;
  const rows = await db
    .update(featureFlags)
    .set(data)
    .where(eq(featureFlags.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteFeatureFlag(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db.delete(featureFlags).where(eq(featureFlags.id, id));
}
