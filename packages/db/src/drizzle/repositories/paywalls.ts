import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { collectMediaUrls, type BuilderConfig } from "@rovenue/shared/paywall";
import type { Db } from "../client";
import {
  experiments,
  paywallAssetUsages,
  paywalls,
  placements,
  type NewPaywall,
  type Paywall,
} from "../schema";

// =============================================================
// Paywall catalog — Drizzle repository
// =============================================================
//
// A paywall is a named, versioned remote-config document rendered
// by the SDK against a specific offering. `deletePaywall` refuses
// to delete a paywall that is still referenced — either directly by
// a placement row's `target.paywallId`, or indirectly through a
// PAYWALL-type experiment variant's `value.paywallId` — so callers
// always get a clear error instead of a dangling reference.

export async function listPaywalls(
  db: Db,
  projectId: string,
): Promise<Paywall[]> {
  return db
    .select()
    .from(paywalls)
    .where(eq(paywalls.projectId, projectId))
    .orderBy(paywalls.identifier);
}

export async function findPaywallById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Paywall | null> {
  const rows = await db
    .select()
    .from(paywalls)
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPaywallsByIds(
  db: Db,
  projectId: string,
  ids: string[],
): Promise<Paywall[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(paywalls)
    .where(and(eq(paywalls.projectId, projectId), inArray(paywalls.id, ids)));
}

/**
 * Every paywall of `projectId` that has a current DRAFT builder config
 * (`paywalls.builderConfig` IS the draft — see the publish route's
 * versioning comment), projected down to the three columns the asset
 * DELETE route's in-use guard (2026-08-23 Task 9) actually walks.
 * Drafts have no `paywall_asset_usages` rows until they are published,
 * so `listPublishedUsage` alone cannot see them — the guard collects
 * each draft's media URLs itself. Null-config paywalls (remote-config-
 * only) are filtered in SQL: they cannot reference an asset and their
 * configs are the bulk of the payload this projection avoids.
 */
export async function listDraftBuilderConfigs(
  db: Db,
  projectId: string,
): Promise<{ id: string; name: string; builderConfig: unknown }[]> {
  return db
    .select({
      id: paywalls.id,
      name: paywalls.name,
      builderConfig: paywalls.builderConfig,
    })
    .from(paywalls)
    .where(
      and(
        eq(paywalls.projectId, projectId),
        isNotNull(paywalls.builderConfig),
      ),
    );
}

export async function findPaywallByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<Paywall | null> {
  const rows = await db
    .select()
    .from(paywalls)
    .where(
      and(
        eq(paywalls.projectId, projectId),
        eq(paywalls.identifier, identifier),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createPaywall(
  db: Db,
  input: NewPaywall,
): Promise<Paywall> {
  const [row] = await db.insert(paywalls).values(input).returning();
  return row!;
}

export interface UpdatePaywallInput {
  identifier?: string;
  name?: string;
  offeringId?: string;
  remoteConfig?: unknown;
  configFormatVersion?: number;
  builderConfig?: unknown;
  isActive?: boolean;
  status?: "draft" | "published" | "archived";
  publishedVersionId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Optimistic-concurrency counter for `builderConfig` — pass
   * `BUMP_DRAFT_REVISION` to invalidate any builder tab (or other draft
   * writer) holding the pre-write revision, without a compare-and-swap.
   * For routes that overwrite the draft outright (revert, discard-draft)
   * rather than racing another writer over the SAME edit — see
   * `updatePaywallDraft` for the CAS path new builder-tab writes use.
   */
  draftRevision?: SQL<unknown>;
}

/**
 * A raw `draftRevision + 1` SQL expression, reusable across statements
 * (it's a query fragment, not a value). Every write that replaces
 * `builderConfig` must move this counter — CAS writes via
 * `updatePaywallDraft` bump it as part of their own `.set()`; a
 * server-initiated rewrite that goes through `updatePaywall` instead
 * (revert, discard-draft) passes this as its `draftRevision` field so a
 * concurrent builder tab's next autosave 409s instead of clobbering the
 * rewrite.
 */
export const BUMP_DRAFT_REVISION: SQL<unknown> = sql`${paywalls.draftRevision} + 1`;

export async function updatePaywall(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdatePaywallInput,
): Promise<Paywall | null> {
  const [row] = await db
    .update(paywalls)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Draft write with optimistic concurrency. Returns null when
 * `expectedRevision` does not match the stored value — the caller turns
 * that into a 409. The revision bump and the config write are one
 * statement, so two concurrent callers cannot both succeed.
 *
 * `configFormatVersion` is supplied by the caller rather than recomputed
 * here — the single source of truth for how a `builderConfig` value maps
 * to a format version is the two named constants in apps/api's
 * `services/paywall-ai/validate-config.ts`
 * (`BUILDER_CONFIG_EMPTY_FORMAT_VERSION` / `BUILDER_CONFIG_TREE_FORMAT_VERSION`),
 * which both `routes/dashboard/paywalls.ts`'s `prepareBuilderConfigPatch`
 * and `services/copilot/intent-handlers.ts`'s `action_paywall_editTree`
 * handler import from — this function just persists whatever the caller
 * already decided.
 */
export async function updatePaywallDraft(
  db: Db,
  projectId: string,
  id: string,
  expectedRevision: number,
  patch: { builderConfig: unknown; configFormatVersion: number },
): Promise<Paywall | null> {
  const [row] = await db
    .update(paywalls)
    .set({
      builderConfig: patch.builderConfig,
      configFormatVersion: patch.configFormatVersion,
      draftRevision: BUMP_DRAFT_REVISION,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paywalls.projectId, projectId),
        eq(paywalls.id, id),
        eq(paywalls.draftRevision, expectedRevision),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Delete a paywall, rejecting when it is still referenced by:
 *   (a) a placement row whose `target.paywallId` points at it, or
 *   (b) a PAYWALL-type experiment whose `variants` array contains a
 *       variant with `value.paywallId` pointing at it.
 *
 * Both checks scan JSONB arrays with `jsonb_array_elements` rather
 * than a `@>` containment query — the paywallId can appear nested at
 * different depths/shapes across placement row targets and experiment
 * variants, which `@>` can't express reliably.
 */
export async function deletePaywall(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const referencedByPlacement = await db.execute(sql`
    SELECT 1 FROM ${placements}
    WHERE "placements"."projectId" = ${projectId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements("placements"."rows") r
        WHERE r->'target'->>'paywallId' = ${id}
      )
    LIMIT 1
  `);
  if ((referencedByPlacement as unknown as { rows: unknown[] }).rows.length > 0) {
    throw new Error(
      `Cannot delete paywall ${id}: referenced by one or more placement rows`,
    );
  }

  const referencedByExperiment = await db.execute(sql`
    SELECT 1 FROM ${experiments}
    WHERE "experiments"."projectId" = ${projectId}
      AND "experiments"."type" = 'PAYWALL'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements("experiments"."variants") v
        WHERE v->'value'->>'paywallId' = ${id}
      )
    LIMIT 1
  `);
  if (
    (referencedByExperiment as unknown as { rows: unknown[] }).rows.length > 0
  ) {
    throw new Error(
      `Cannot delete paywall ${id}: referenced by a PAYWALL experiment variant`,
    );
  }

  const rows = await db
    .delete(paywalls)
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .returning({ id: paywalls.id });
  return rows.length > 0;
}

export interface AssetUsageInput {
  /** The published version's builder config, already parsed/validated by
   *  the caller (e.g. the publish route's `builderConfigSchema.safeParse`
   *  result) — this repo does not re-fetch or re-validate it. */
  config: BuilderConfig | null | undefined;
  /**
   * Resolves a media URL back to a `paywall_assets.id`, or `null` when the
   * URL isn't ours (an external image, say) — those are skipped rather
   * than stored as null-id rows. This lives in the API layer
   * (`AssetStore.parseAssetUrl` in `apps/api/src/lib/asset-store.ts`)
   * because `@rovenue/db` cannot import from `apps/api`; passing the
   * resolver in as a parameter keeps the dependency pointed the right way
   * instead of inverting it or duplicating the URL-parsing logic here.
   */
  resolveAssetUrl: (url: string) => string | null;
}

/**
 * Replaces — never appends — the `paywall_asset_usages` rows for one
 * `(paywallId, versionId)` pair with `assetIds`. Delete-then-insert, so a
 * republish of the same version never inflates its usage count, and an
 * asset the new tree no longer references has its row cleared (otherwise
 * the deletion warning would keep reporting stale usage forever).
 */
export async function replaceUsageForVersion(
  db: Db,
  {
    paywallId,
    versionId,
    assetIds,
  }: { paywallId: string; versionId: string; assetIds: string[] },
): Promise<void> {
  await db
    .delete(paywallAssetUsages)
    .where(eq(paywallAssetUsages.versionId, versionId));
  if (assetIds.length === 0) return;
  await db
    .insert(paywallAssetUsages)
    .values(assetIds.map((assetId) => ({ assetId, paywallId, versionId })));
}

/**
 * Point a paywall at a published version. Also flips `status` to
 * `published` — the two always move together, so callers can't leave a
 * paywall claiming `draft` while serving a version.
 *
 * When `assetUsage` is passed, the version's media URLs are collected
 * (`collectMediaUrls`), resolved through `assetUsage.resolveAssetUrl`, and
 * that versionId's `paywall_asset_usages` rows are replaced — all inside
 * the same transaction as the `publishedVersionId` flip, so the usage
 * index and what's actually live never disagree. Omitting `assetUsage`
 * (existing callers that only care about the pointer, e.g. most
 * integration test fixtures) leaves the usage index untouched.
 */
export async function setPublishedVersion(
  db: Db,
  projectId: string,
  paywallId: string,
  versionId: string,
  assetUsage?: AssetUsageInput,
): Promise<Paywall | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(paywalls)
      .set({ publishedVersionId: versionId, status: "published", updatedAt: new Date() })
      .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, paywallId)))
      .returning();

    if (assetUsage) {
      // Deduped twice over: `collectMediaUrls` already dedups URLs, but
      // two distinct URLs (e.g. a light/dark pair) could resolve to the
      // same assetId, and the table's primary key is (assetId, versionId)
      // — a duplicate insert would violate it.
      const assetIds = [
        ...new Set(
          collectMediaUrls(assetUsage.config)
            .map(assetUsage.resolveAssetUrl)
            .filter((assetId): assetId is string => assetId !== null),
        ),
      ];
      await replaceUsageForVersion(tx, { paywallId, versionId, assetIds });
    }

    return row ?? null;
  });
}
