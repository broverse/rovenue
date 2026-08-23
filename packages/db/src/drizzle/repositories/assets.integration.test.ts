// =============================================================
// assetRepo — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling fonts.integration.test.ts suite (barrel
// import + real inserts, no mocking).
//
// Covers:
//   - create + read back an asset
//   - findLiveAssetByHash finds a live row
//   - the partial unique index on (projectId, contentHash) WHERE
//     deletedAt IS NULL rejects a second live row at the same hash,
//     but frees the hash again once the earlier row is soft-deleted
//   - soft-deleted assets are hidden from list and hash lookup
//   - project scoping on findAssetById

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { getDb } from "../client";
import * as drizzleRepos from "../index";
import { offerings, paywallAssetUsages, paywalls, projects } from "../schema";
import type { CreateAssetInput } from "./assets";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_assets_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_assets_other_${RUN_ID}`;
const db = getDb();

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: `Assets ${RUN_ID}` });
  await db
    .insert(projects)
    .values({ id: OTHER_PROJECT_ID, name: `Assets Other ${RUN_ID}` });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
});

function input(overrides: Partial<CreateAssetInput> = {}): CreateAssetInput {
  const id = createId();
  return {
    projectId: PROJECT_ID,
    kind: "image",
    name: "hero.png",
    storageKey: `${PROJECT_ID}/${id}.webp`,
    contentHash: createId().padEnd(64, "a"),
    contentType: "image/webp",
    byteSize: 1234,
    width: 800,
    height: 600,
    sourceFormat: "png",
    sourceWidth: 1600,
    sourceHeight: 1200,
    policyVersion: 1,
    ...overrides,
  };
}

describe("assetRepo", () => {
  it("creates and reads back an asset", async () => {
    const created = await drizzleRepos.assetRepo.createAsset(db, input());
    const found = await drizzleRepos.assetRepo.findAssetById(
      db,
      PROJECT_ID,
      created.id,
    );
    expect(found?.id).toBe(created.id);
    expect(found?.byteSize).toBe(1234);
    expect(found?.sourceWidth).toBe(1600);
  });

  it("finds a live asset by content hash", async () => {
    const hash = createId().padEnd(64, "b");
    const created = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: hash }),
    );
    const found = await drizzleRepos.assetRepo.findLiveAssetByHash(
      db,
      PROJECT_ID,
      hash,
    );
    expect(found?.id).toBe(created.id);
  });

  it("rejects a second live row with the same (projectId, contentHash)", async () => {
    const hash = createId().padEnd(64, "c");
    await drizzleRepos.assetRepo.createAsset(db, input({ contentHash: hash }));
    await expect(
      drizzleRepos.assetRepo.createAsset(db, input({ contentHash: hash })),
    ).rejects.toThrow();
  });

  // The unique index is partial on `deleted_at is null`, so this must
  // succeed — otherwise deleting an asset would permanently burn its
  // bytes' hash for that project.
  it("allows re-uploading a hash whose earlier row was soft-deleted", async () => {
    const hash = createId().padEnd(64, "d");
    const first = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: hash }),
    );
    await drizzleRepos.assetRepo.softDeleteAsset(db, PROJECT_ID, first.id);
    const second = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: hash }),
    );
    expect(second.id).not.toBe(first.id);
  });

  it("hides soft-deleted assets from list and hash lookup", async () => {
    const hash = createId().padEnd(64, "e");
    const created = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: hash }),
    );
    await drizzleRepos.assetRepo.softDeleteAsset(db, PROJECT_ID, created.id);
    expect(
      await drizzleRepos.assetRepo.findLiveAssetByHash(db, PROJECT_ID, hash),
    ).toBeNull();
    const listed = await drizzleRepos.assetRepo.listAssets(db, PROJECT_ID);
    expect(listed.map((a) => a.id)).not.toContain(created.id);
  });

  it("does not return another project's asset", async () => {
    const created = await drizzleRepos.assetRepo.createAsset(db, input());
    expect(
      await drizzleRepos.assetRepo.findAssetById(db, OTHER_PROJECT_ID, created.id),
    ).toBeNull();
  });
});

// =============================================================
// listPublishedUsage (Task 7) — the honest boundary (design spec §7)
// =============================================================
//
// The route mocks this repo function (apps/api/tests/routes/dashboard/
// assets.test.ts), so it has no coverage of the actual JOIN or its
// column names against a real schema — a mistake here (e.g. joining on
// a paywall's id instead of its CURRENT publishedVersionId, or a wrong
// column-name guess in the mixed camelCase/snake_case schema, see the
// task brief) would pass every mocked test while silently reporting
// nothing for every asset. `paywall_asset_usages` rows are written at
// publish time by Task 10, which hasn't shipped yet, so these tests
// insert the rows directly to exercise the query ahead of that.
describe("listPublishedUsage", () => {
  let usagePaywallId: string;
  let publishedVersionId: string;
  let draftVersionId: string;
  let usageAssetId: string;

  beforeAll(async () => {
    const [offering] = await db
      .insert(offerings)
      .values({
        projectId: PROJECT_ID,
        identifier: `off-usage-${RUN_ID}`,
        packages: [{ identifier: "monthly", productId: null }],
      })
      .returning();

    const [paywall] = await db
      .insert(paywalls)
      .values({
        projectId: PROJECT_ID,
        identifier: `pw-usage-${RUN_ID}`,
        name: "Usage paywall",
        offeringId: offering!.id,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      })
      .returning();
    usagePaywallId = paywall!.id;

    const published = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usagePaywallId,
      versionNo: 1,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: offering!.id,
      configFormatVersion: 1,
    });
    publishedVersionId = published.id;

    const draft = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usagePaywallId,
      versionNo: 2,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: offering!.id,
      configFormatVersion: 1,
    });
    draftVersionId = draft.id;

    // Points the paywall's CURRENT publishedVersionId at version 1 —
    // version 2 stays a draft (no paywall ever points at it).
    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usagePaywallId,
      publishedVersionId,
    );

    const created = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: createId().padEnd(64, "f") }),
    );
    usageAssetId = created.id;
  });

  it("returns the paywall when a usage row references the CURRENT published version", async () => {
    await db.insert(paywallAssetUsages).values({
      assetId: usageAssetId,
      paywallId: usagePaywallId,
      versionId: publishedVersionId,
    });

    const rows = await drizzleRepos.assetRepo.listPublishedUsage(db, usageAssetId);
    expect(rows).toEqual([{ id: usagePaywallId, name: "Usage paywall" }]);
  });

  it("returns an empty list when the only usage row references a draft (non-published) version", async () => {
    // A fresh asset with no usage against the published version at
    // all — only the draft. This is the deliberate boundary: the row
    // genuinely exists, it just does not satisfy the JOIN's
    // publishedVersionId predicate, so it must not appear.
    const draftOnlyAsset = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: createId().padEnd(64, "g") }),
    );
    await db.insert(paywallAssetUsages).values({
      assetId: draftOnlyAsset.id,
      paywallId: usagePaywallId,
      versionId: draftVersionId,
    });

    const rows = await drizzleRepos.assetRepo.listPublishedUsage(
      db,
      draftOnlyAsset.id,
    );
    expect(rows).toEqual([]);
  });

  it("returns an empty list for an asset with no usage rows at all", async () => {
    const created = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: createId().padEnd(64, "h") }),
    );
    expect(await drizzleRepos.assetRepo.listPublishedUsage(db, created.id)).toEqual(
      [],
    );
  });
});

// =============================================================
// setPublishedVersion — asset usage index (Task 10)
// =============================================================
//
// `resolveAssetUrl` here stands in for `AssetStore.parseAssetUrl`
// (apps/api/src/lib/asset-store.ts) — `@rovenue/db` cannot import from
// `apps/api`, so the real repository takes the resolver as a parameter
// (design spec §7) and these tests supply a trivial one keyed off a
// URL->assetId map, exactly like a real caller would.
function usageBuilderConfig(urls: string[]): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: {} },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: urls.map((url, i) => ({
        type: "image" as const,
        id: `img-${i}`,
        url: { light: url },
      })),
    },
  };
}

describe("setPublishedVersion — asset usage index (Task 10)", () => {
  let usageIndexPaywallId: string;
  let usageIndexOfferingId: string;
  let assetA: string;
  let assetB: string;
  let urlA: string;
  let urlB: string;
  const EXTERNAL_URL = "https://not-ours.example/photo.jpg";

  function resolveAssetUrl(url: string): string | null {
    if (url === urlA) return assetA;
    if (url === urlB) return assetB;
    return null;
  }

  async function usageRowsFor(versionId: string): Promise<string[]> {
    const rows = await db
      .select({ assetId: paywallAssetUsages.assetId })
      .from(paywallAssetUsages)
      .where(eq(paywallAssetUsages.versionId, versionId));
    return rows.map((r) => r.assetId).sort();
  }

  beforeAll(async () => {
    const [offering] = await db
      .insert(offerings)
      .values({
        projectId: PROJECT_ID,
        identifier: `off-usage-index-${RUN_ID}`,
        packages: [{ identifier: "monthly", productId: null }],
      })
      .returning();
    usageIndexOfferingId = offering!.id;

    const [paywall] = await db
      .insert(paywalls)
      .values({
        projectId: PROJECT_ID,
        identifier: `pw-usage-index-${RUN_ID}`,
        name: "Usage index paywall",
        offeringId: usageIndexOfferingId,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      })
      .returning();
    usageIndexPaywallId = paywall!.id;

    const [createdA, createdB] = await Promise.all([
      drizzleRepos.assetRepo.createAsset(
        db,
        input({ contentHash: createId().padEnd(64, "i") }),
      ),
      drizzleRepos.assetRepo.createAsset(
        db,
        input({ contentHash: createId().padEnd(64, "j") }),
      ),
    ]);
    assetA = createdA.id;
    assetB = createdB.id;
    urlA = `https://cdn.test/${assetA}.webp`;
    urlB = `https://cdn.test/${assetB}.webp`;
  });

  it("writes usage rows when a version is published", async () => {
    const version = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usageIndexPaywallId,
      versionNo: 1,
      builderConfig: usageBuilderConfig([urlA, urlB]),
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: usageIndexOfferingId,
      configFormatVersion: 2,
    });

    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      { config: usageBuilderConfig([urlA, urlB]), resolveAssetUrl },
    );

    expect(await usageRowsFor(version.id)).toEqual([assetA, assetB].sort());
  });

  it("replaces, not appends, when the same version is republished", async () => {
    const version = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usageIndexPaywallId,
      versionNo: 2,
      builderConfig: usageBuilderConfig([urlA]),
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: usageIndexOfferingId,
      configFormatVersion: 2,
    });
    const opts = { config: usageBuilderConfig([urlA]), resolveAssetUrl };

    // Publishing the SAME versionId twice must not double the row count —
    // otherwise a usage count inflates every time someone republishes.
    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      opts,
    );
    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      opts,
    );

    expect(await usageRowsFor(version.id)).toEqual([assetA]);
  });

  it("clears rows for an asset the new version no longer references", async () => {
    const version = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usageIndexPaywallId,
      versionNo: 3,
      builderConfig: usageBuilderConfig([urlA, urlB]),
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: usageIndexOfferingId,
      configFormatVersion: 2,
    });

    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      { config: usageBuilderConfig([urlA, urlB]), resolveAssetUrl },
    );
    expect(await usageRowsFor(version.id)).toEqual([assetA, assetB].sort());

    // Same versionId, republished with a tree that dropped assetB — its
    // row must be gone, not just uncounted, so the deletion warning for
    // assetB does not keep reporting this paywall as live usage.
    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      { config: usageBuilderConfig([urlA]), resolveAssetUrl },
    );

    expect(await usageRowsFor(version.id)).toEqual([assetA]);
  });

  it("ignores external URLs that are not ours", async () => {
    const version = await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: usageIndexPaywallId,
      versionNo: 4,
      builderConfig: usageBuilderConfig([urlA, EXTERNAL_URL]),
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId: usageIndexOfferingId,
      configFormatVersion: 2,
    });

    await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      PROJECT_ID,
      usageIndexPaywallId,
      version.id,
      { config: usageBuilderConfig([urlA, EXTERNAL_URL]), resolveAssetUrl },
    );

    // Not two rows, and not a null-id row for the external URL — just
    // the one asset the resolver actually recognised.
    expect(await usageRowsFor(version.id)).toEqual([assetA]);
  });
});

// =============================================================
// Task 9 (2026-08-23 store-billing correctness plan) — the two reads
// the asset referential guard is built on: `findLiveAssetIds` backs
// the publish-time existence check (publish route), and
// `listDraftBuilderConfigs` backs the DELETE route's draft-usage walk.
// =============================================================

describe("findLiveAssetIds (Task 9)", () => {
  it("returns only the live ids among the requested set, scoped to the project", async () => {
    const live = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: createId().padEnd(64, "k") }),
    );
    const deleted = await drizzleRepos.assetRepo.createAsset(
      db,
      input({ contentHash: createId().padEnd(64, "l") }),
    );
    await drizzleRepos.assetRepo.softDeleteAsset(db, PROJECT_ID, deleted.id);
    const foreignId = createId();
    await drizzleRepos.assetRepo.createAsset(
      db,
      input({
        projectId: OTHER_PROJECT_ID,
        id: foreignId,
        storageKey: `${OTHER_PROJECT_ID}/${foreignId}.webp`,
        contentHash: createId().padEnd(64, "m"),
      }),
    );

    const found = await drizzleRepos.assetRepo.findLiveAssetIds(db, PROJECT_ID, [
      live.id,
      deleted.id,
      foreignId,
      createId(), // never existed anywhere
    ]);
    expect(found).toEqual(new Set([live.id]));
  });

  it("returns an empty set for an empty id list without querying", async () => {
    expect(await drizzleRepos.assetRepo.findLiveAssetIds(db, PROJECT_ID, [])).toEqual(
      new Set(),
    );
  });
});

describe("listDraftBuilderConfigs (Task 9)", () => {
  it("returns id/name/builderConfig for this project's paywalls with a draft config, and nothing else", async () => {
    const [offering] = await db
      .insert(offerings)
      .values({
        projectId: PROJECT_ID,
        identifier: `off-draft-cfg-${RUN_ID}`,
        packages: [{ identifier: "monthly", productId: null }],
      })
      .returning();
    const draftConfig = {
      formatVersion: 2,
      root: { type: "image", id: "img", url: { light: "https://cdn.test/x.webp" } },
    };
    const [withConfig] = await db
      .insert(paywalls)
      .values({
        projectId: PROJECT_ID,
        identifier: `pw-draft-cfg-${RUN_ID}`,
        name: "Draft-config paywall",
        offeringId: offering!.id,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
        builderConfig: draftConfig,
      })
      .returning();
    const [withoutConfig] = await db
      .insert(paywalls)
      .values({
        projectId: PROJECT_ID,
        identifier: `pw-no-cfg-${RUN_ID}`,
        name: "Remote-config-only paywall",
        offeringId: offering!.id,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      })
      .returning();
    const [otherOffering] = await db
      .insert(offerings)
      .values({
        projectId: OTHER_PROJECT_ID,
        identifier: `off-draft-cfg-other-${RUN_ID}`,
        packages: [{ identifier: "monthly", productId: null }],
      })
      .returning();
    const [foreign] = await db
      .insert(paywalls)
      .values({
        projectId: OTHER_PROJECT_ID,
        identifier: `pw-draft-cfg-other-${RUN_ID}`,
        name: "Other project's paywall",
        offeringId: otherOffering!.id,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
        builderConfig: draftConfig,
      })
      .returning();

    const rows = await drizzleRepos.paywallRepo.listDraftBuilderConfigs(
      db,
      PROJECT_ID,
    );
    expect(rows).toContainEqual({
      id: withConfig!.id,
      name: "Draft-config paywall",
      builderConfig: draftConfig,
    });
    const ids = rows.map((r) => r.id);
    // A null draft is dead weight to the guard's walk — filtered in SQL,
    // not in JS.
    expect(ids).not.toContain(withoutConfig!.id);
    expect(ids).not.toContain(foreign!.id);
  });
});
