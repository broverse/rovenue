import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { audiences, featureFlags, type Audience, type FeatureFlag } from "../schema";

// =============================================================
// Feature flag + audience reads — Drizzle repository
// =============================================================
//
// Mirrors the two findMany calls that
// apps/api/src/services/flag-engine.ts#loadBundleFromDb runs in
// parallel. Shadow-reading those surfaces every evaluation so we
// can confirm Drizzle produces byte-identical flag/audience
// bundles before swapping the flag engine's canonical reader.

export async function findFeatureFlagsByProject(
  db: Db,
  projectId: string,
): Promise<FeatureFlag[]> {
  return db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.projectId, projectId));
}

export async function findAudiencesByProject(
  db: Db,
  projectId: string,
): Promise<Audience[]> {
  return db
    .select()
    .from(audiences)
    .where(eq(audiences.projectId, projectId));
}
