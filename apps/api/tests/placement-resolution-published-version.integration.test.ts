// =============================================================
// /v1/placements must serve the PUBLISHED snapshot, never the draft.
//
// This is the regression guard for the P0 defect: before the
// draft/publish split, `paywalls.builderConfig` was both the builder's
// autosave target and the document shipped to devices, so an
// in-progress edit went live as soon as the edge cache expired.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, offerings, drizzle } from "@rovenue/db";
import { resolvePlacement } from "../src/lib/placement-resolution";

const RUN_ID = Date.now();
const db = getDb();

let projectId: string;
let offeringId: string;
let paywallId: string;
let placement: Awaited<ReturnType<typeof drizzle.placementRepo.findPlacementByIdentifier>>;

const PUBLISHED_CONFIG = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title: "Published", cta: "Buy" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "title", role: "title" },
      { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
      { type: "purchaseButton", id: "pb", labelKey: "cta" },
    ],
  },
};

const DRAFT_CONFIG = {
  ...PUBLISHED_CONFIG,
  localizations: { en: { title: "WORK IN PROGRESS", cta: "Buy" } },
};

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: `plres-${RUN_ID}` })
    .returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      name: "Default",
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;

  const paywall = await drizzle.paywallRepo.createPaywall(db, {
    projectId,
    identifier: `pw-${RUN_ID}`,
    name: "Resolution paywall",
    offeringId,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "published" } } },
    builderConfig: PUBLISHED_CONFIG,
    configFormatVersion: 2,
  });
  paywallId = paywall.id;

  // Publish v1 from the published config, then dirty the draft.
  const version = await drizzle.paywallVersionRepo.insert(db, {
    paywallId,
    versionNo: 1,
    builderConfig: PUBLISHED_CONFIG,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "published" } } },
    offeringId,
    configFormatVersion: 2,
  });
  await drizzle.paywallRepo.setPublishedVersion(db, projectId, paywallId, version.id);
  await drizzle.paywallRepo.updatePaywall(db, projectId, paywallId, {
    builderConfig: DRAFT_CONFIG,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "draft" } } },
  });

  await drizzle.placementRepo.createPlacement(db, {
    projectId,
    identifier: `pl-${RUN_ID}`,
    name: "Onboarding",
    rows: [{ audienceId: null, target: { type: "paywall", paywallId } }],
  });
  placement = await drizzle.placementRepo.findPlacementByIdentifier(
    db,
    projectId,
    `pl-${RUN_ID}`,
  );
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("resolvePlacement", () => {
  it("serves the published builderConfig, not the draft", async () => {
    const resolved = await resolvePlacement(projectId, placement!, {});
    expect(resolved.paywall).not.toBeNull();
    expect(resolved.paywall!.builderConfig).toEqual(PUBLISHED_CONFIG);
    expect(
      (resolved.paywall!.builderConfig as typeof PUBLISHED_CONFIG).localizations.en!.title,
    ).toBe("Published");
  });

  it("serves the published remoteConfig, not the draft", async () => {
    const resolved = await resolvePlacement(projectId, placement!, {});
    expect(resolved.paywall!.remoteConfig).toEqual({
      locale: "en",
      data: { theme: "published" },
    });
  });

  it("resolves to null when nothing has been published", async () => {
    const unpublished = await drizzle.paywallRepo.createPaywall(db, {
      projectId,
      identifier: `pw-unpub-${RUN_ID}`,
      name: "Never published",
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      builderConfig: DRAFT_CONFIG,
      configFormatVersion: 2,
    });
    await drizzle.placementRepo.createPlacement(db, {
      projectId,
      identifier: `pl-unpub-${RUN_ID}`,
      name: "Unpublished placement",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId: unpublished.id } }],
    });
    const p = await drizzle.placementRepo.findPlacementByIdentifier(
      db,
      projectId,
      `pl-unpub-${RUN_ID}`,
    );
    const resolved = await resolvePlacement(projectId, p!, {});
    expect(resolved.paywall).toBeNull();
  });
});
