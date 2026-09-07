// =============================================================
// Draft-isolation invariant — integration test (Task 9, Guard 2)
//
// The property the whole paywall/funnel authoring sub-project rests on:
// authoring is safe because a draft write can never reach live traffic.
// `/v1/placements` (and the fallback-file export) resolve the PUBLISHED
// snapshot from `paywall_versions`, never `paywalls.builderConfig` — see
// `hydratePaywall` vs `hydrateDraftPaywall` in placement-resolution.ts.
//
// This pins that property directly against `resolvePlacement`, the shared
// row-walk both callers use, so a future change to placement resolution
// that starts reading the draft column breaks this test by name rather
// than being caught (or not) by a human reviewing a diff months from now.
//
// Real Postgres (docker-compose's rovenue-db-1 / the per-worker clone
// tests/global-setup.ts builds) — no mocks: the whole point is that the
// DRAFT WRITE actually lands, and the READ actually goes through the
// unmocked resolution path.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { resolvePlacement } from "./placement-resolution";
import { BUILDER_CONFIG_TREE_FORMAT_VERSION } from "../services/paywall-ai/validate-config";

// Not exported from @rovenue/db's barrel — derived from the repo function's
// own return type so this stays in sync with the schema without a
// hand-maintained duplicate.
type PlacementRowResult = Awaited<ReturnType<typeof drizzle.placementRepo.createPlacement>>;

const RUN_ID = Date.now();

// The published tree — what /v1/placements must keep serving no matter
// what happens to the draft afterwards.
const PUBLISHED_TREE = {
  root: { id: "original", type: "stack", children: [] },
};

// The draft edit — deliberately a DIFFERENT tree, so "before === after"
// can only be true because resolution never looked at the draft, not
// because the two trees happened to coincide.
const DRAFT_EDIT_TREE = {
  root: { id: "changed", type: "stack", children: [] },
};

interface SeedResult {
  projectId: string;
  paywallId: string;
  placement: PlacementRowResult;
}

/**
 * Seeds one project with a published paywall (draftRevision 0, one
 * published version snapshotting PUBLISHED_TREE) and one active
 * placement whose single (all-users) row targets it.
 */
async function seedPublishedPaywallWithPlacement(suffix: string): Promise<SeedResult> {
  const db = getDb();
  const projectId = `prj_draftiso_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({
    id: projectId,
    name: `Draft Isolation Project ${RUN_ID}${suffix}`,
  });

  const offering = await drizzle.offeringRepo.createOffering(db, {
    projectId,
    identifier: "default",
    isDefault: true,
    packages: [],
  });

  const paywall = await drizzle.paywallRepo.createPaywall(db, {
    projectId,
    identifier: `draft-iso-${suffix}`,
    name: "Draft Isolation Paywall",
    offeringId: offering.id,
    remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    builderConfig: PUBLISHED_TREE,
    configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
    isActive: true,
  });

  const version = await drizzle.paywallVersionRepo.insert(db, {
    paywallId: paywall.id,
    versionNo: 1,
    builderConfig: paywall.builderConfig,
    remoteConfig: paywall.remoteConfig,
    offeringId: paywall.offeringId,
    configFormatVersion: paywall.configFormatVersion,
  });

  await drizzle.paywallRepo.setPublishedVersion(db, projectId, paywall.id, version.id);

  const placement = await drizzle.placementRepo.createPlacement(db, {
    projectId,
    identifier: `draft-iso-placement-${suffix}`,
    name: "Draft Isolation Placement",
    rows: [{ audienceId: null, target: { type: "paywall", paywallId: paywall.id } }],
    isActive: true,
  });

  return { projectId, paywallId: paywall.id, placement };
}

const seededProjectIds: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("draft-isolation invariant", () => {
  it("editing a draft does not change what /v1/placements serves", async () => {
    const { projectId, paywallId, placement } = await seedPublishedPaywallWithPlacement("basic");
    seededProjectIds.push(projectId);

    const before = await resolvePlacement(projectId, placement, {});

    // Sanity: the invariant is only meaningful if the published tree
    // actually resolved in the first place — otherwise "before === after"
    // would be true trivially because both sides are empty.
    expect(before.paywall).not.toBeNull();
    expect(before.paywall?.builderConfig).toEqual(PUBLISHED_TREE);

    const updated = await drizzle.paywallRepo.updatePaywallDraft(
      drizzle.db,
      projectId,
      paywallId,
      0,
      {
        builderConfig: DRAFT_EDIT_TREE,
        // Required since Task 4; a tree is always the tree format version.
        configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
      },
    );
    // The draft write must have actually landed — otherwise "before ===
    // after" would hold vacuously because nothing happened, not because
    // resolution is isolated from the draft.
    expect(updated).not.toBeNull();
    expect(updated?.builderConfig).toEqual(DRAFT_EDIT_TREE);

    const after = await resolvePlacement(projectId, placement, {});

    expect(after).toEqual(before);
    // Extra belt-and-braces: explicitly confirm the served tree is still
    // the PUBLISHED one, not the just-written draft.
    expect(after.paywall?.builderConfig).toEqual(PUBLISHED_TREE);
    expect(after.paywall?.builderConfig).not.toEqual(DRAFT_EDIT_TREE);
  });
});
