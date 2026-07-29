import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import { paywallAssets, type PaywallAsset } from "../schema";
import type { AssetKind, ImageSourceFormat } from "@rovenue/shared";

// =============================================================
// Paywall assets — Drizzle repository
// =============================================================
//
// Every read filters `deletedAt is null`, so a deleted asset stops
// resolving everywhere at once. Deleted rows are kept as tombstones
// rather than removed: the audit trail and the usage index both point
// at them, and the bytes are already gone from the bucket by the time
// the row is soft-deleted (design spec §5.8 fixes that ordering).
//
// The partial unique index `paywall_assets_project_hash_key` (on
// `(projectId, contentHash) WHERE deletedAt IS NULL`, migration 0099)
// is what makes a repeat upload of identical bytes idempotent within a
// project while still letting a project re-upload the same bytes after
// deleting the earlier asset — a non-partial index would permanently
// burn that hash for the project the moment the first row was deleted.

export interface CreateAssetInput {
  projectId: string;
  kind: AssetKind;
  name: string;
  storageKey: string;
  contentHash: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sourceFormat: ImageSourceFormat | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  policyVersion: number;
}

export async function createAsset(
  db: Db,
  input: CreateAssetInput,
): Promise<PaywallAsset> {
  const [row] = await db.insert(paywallAssets).values(input).returning();
  return row!;
}

export async function findAssetById(
  db: Db,
  projectId: string,
  id: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .select()
    .from(paywallAssets)
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.id, id),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findLiveAssetByHash(
  db: Db,
  projectId: string,
  contentHash: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .select()
    .from(paywallAssets)
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.contentHash, contentHash),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listAssets(
  db: Db,
  projectId: string,
): Promise<PaywallAsset[]> {
  return db
    .select()
    .from(paywallAssets)
    .where(
      and(eq(paywallAssets.projectId, projectId), isNull(paywallAssets.deletedAt)),
    )
    .orderBy(desc(paywallAssets.createdAt));
}

export async function softDeleteAsset(
  db: Db,
  projectId: string,
  id: string,
): Promise<PaywallAsset | null> {
  const [row] = await db
    .update(paywallAssets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        eq(paywallAssets.id, id),
        isNull(paywallAssets.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

// The sweeper (Task 9) reads live storage keys with its own query
// rather than through this repository — it needs a `Set` of keys
// across all projects, which is not a shape any other caller wants.
// No speculative `listOrphanCandidates` helper here for it.
