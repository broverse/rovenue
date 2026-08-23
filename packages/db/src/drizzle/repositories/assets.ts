import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
  /**
   * Optional explicit id. `paywall_assets.id` defaults via `$defaultFn`
   * (a fresh cuid2) when omitted — but the upload routes need the id
   * BEFORE the row exists, to embed it in the storage key/public URL
   * (`buildStorageKey(projectId, assetId, kind)`) so the object can be
   * written to the bucket before the row is inserted ("object first, row
   * second"). A caller that pre-generates that id and does NOT also pass
   * it here gets a row whose real `id` silently diverges from the id
   * baked into its own public URL — `parseAssetUrl` on that URL then
   * resolves to an id that matches no row, which breaks the asset usage
   * index (Task 10) at best and violates `paywall_asset_usages`' FK to
   * `paywall_assets.id` at worst. Every upload route MUST pass the same
   * id it used to build the storage key.
   */
  id?: string;
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

/**
 * The subset of `ids` that exist as LIVE (not soft-deleted) assets of
 * `projectId` — the publish-time existence check (2026-08-23 Task 9):
 * the publish route resolves every asset URL in the tree being
 * published to an id and refuses to publish when any id is missing
 * from this set, because the S3 object behind a soft-deleted row is
 * already gone. Returned as a Set for O(1) membership tests against
 * the (URL, assetId) pairs the caller holds.
 */
export async function findLiveAssetIds(
  db: Db,
  projectId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: paywallAssets.id })
    .from(paywallAssets)
    .where(
      and(
        eq(paywallAssets.projectId, projectId),
        inArray(paywallAssets.id, ids),
        isNull(paywallAssets.deletedAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
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

/**
 * Published paywalls referencing this asset — the honest boundary
 * (design spec §7) is that this joins on a paywall's CURRENT
 * `publishedVersionId`, not every version that ever referenced the
 * asset. A paywall whose published version no longer references this
 * asset (rolled back, or the asset was only ever used in a draft)
 * correctly returns nothing here, even though a `paywall_asset_usages`
 * row for an older/draft version still exists — the warning this
 * powers is "does deleting this asset break something LIVE right now",
 * not "was this asset ever used". Rows are written at publish time
 * (Task 10); before that ships, this always returns [].
 */
export async function listPublishedUsage(
  db: Db,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT "paywalls"."id" AS id, "paywalls"."name" AS name
    FROM "paywall_asset_usages"
    JOIN "paywalls"
      ON "paywalls"."id" = "paywall_asset_usages"."paywallId"
     AND "paywalls"."publishedVersionId" = "paywall_asset_usages"."versionId"
    WHERE "paywall_asset_usages"."assetId" = ${assetId}
  `);
  return (rows as unknown as { rows: { id: string; name: string }[] }).rows;
}

// The sweeper (Task 9) reads live storage keys with its own query
// rather than through this repository — it needs a `Set` of keys
// across all projects, which is not a shape any other caller wants.
// No speculative `listOrphanCandidates` helper here for it.
