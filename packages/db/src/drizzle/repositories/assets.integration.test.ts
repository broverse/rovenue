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
