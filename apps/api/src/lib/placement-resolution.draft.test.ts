import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// hydrateDraftPaywall (P9 on-device preview, Task 1)
// =============================================================
//
// Mocking idiom mirrors paywalls.generate.test.ts: mock the
// `@rovenue/db` barrel's `drizzle.offeringRepo` calls so no real DB is
// touched. `hydrateDraftPaywall` reads `paywall.builderConfig` (the
// DRAFT) directly — it never fetches a `paywall_versions` row, unlike
// the private `hydratePaywall` this module also uses via
// `resolvePlacement`.

const findOfferingById = vi.hoisted(() => vi.fn());
const findProductsByIds = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      offeringRepo: {
        ...actual.drizzle.offeringRepo,
        findOfferingById,
        findProductsByIds,
      },
    },
  };
});

import { hydrateDraftPaywall } from "./placement-resolution";

const PROJECT_ID = "proj_1";
const OFFERING_ID = "off_1";

function offeringRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFERING_ID,
    projectId: PROJECT_ID,
    identifier: "default",
    isDefault: true,
    packages: [],
    metadata: {},
    ...overrides,
  };
}

function paywallRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pw_1",
    projectId: PROJECT_ID,
    identifier: "onboarding",
    name: "Onboarding Paywall",
    offeringId: OFFERING_ID,
    remoteConfig: {
      defaultLocale: "en",
      locales: {
        en: { title: "Welcome (draft)" },
        fr: { title: "Bienvenue (draft)" },
      },
    },
    configFormatVersion: 1,
    builderConfig: { nodes: [{ id: "draft-node-1" }] },
    isActive: true,
    status: "draft",
    publishedVersionId: null,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  findOfferingById.mockReset();
  findProductsByIds.mockReset();
  findOfferingById.mockResolvedValue(offeringRow());
  findProductsByIds.mockResolvedValue([]);
});

describe("hydrateDraftPaywall", () => {
  it("reads paywall.builderConfig (not a published version), hydrates the offering, and slices the requested locale", async () => {
    const paywall = paywallRow();

    const result = await hydrateDraftPaywall(PROJECT_ID, paywall as never, "fr");

    expect(result).not.toBeNull();
    expect(result?.id).toBe(paywall.id);
    expect(result?.identifier).toBe(paywall.identifier);
    expect(result?.builderConfig).toEqual(paywall.builderConfig);
    expect(result?.remoteConfig).toEqual({ locale: "fr", data: { title: "Bienvenue (draft)" } });
    expect(findOfferingById).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, OFFERING_ID);
    expect(result?.offering).not.toBeNull();
    expect(result?.offering?.identifier).toBe("default");
  });

  it("returns null when paywall.builderConfig is null", async () => {
    const paywall = paywallRow({ builderConfig: null });

    const result = await hydrateDraftPaywall(PROJECT_ID, paywall as never, null);

    expect(result).toBeNull();
    // Must short-circuit before ever hitting the offering repo.
    expect(findOfferingById).not.toHaveBeenCalled();
  });

  it("divergence pin: returns the DRAFT tree, not the published version's, when they differ", async () => {
    // The draft (paywalls.builderConfig) has moved on from what was
    // last published — this is exactly the scenario P9 exists for
    // (preview an unpublished change before publishing it).
    const draftBuilderConfig = { nodes: [{ id: "draft-node-2-in-progress" }] };
    const publishedBuilderConfig = { nodes: [{ id: "published-node-1" }] };

    const paywall = paywallRow({ builderConfig: draftBuilderConfig });
    // Constructed only to prove divergence — hydrateDraftPaywall must
    // never consult it.
    const publishedVersion = paywallRow({ builderConfig: publishedBuilderConfig });

    const result = await hydrateDraftPaywall(PROJECT_ID, paywall as never, null);

    expect(result?.builderConfig).toEqual(draftBuilderConfig);
    expect(result?.builderConfig).not.toEqual(publishedVersion.builderConfig);
    // Explicit node-id-level pin, on top of the whole-object checks above:
    // the draft's node id must be present, and the published version's
    // node id must not have leaked in.
    const resultNodeIds = (result?.builderConfig as { nodes: { id: string }[] }).nodes.map(
      (n) => n.id,
    );
    expect(resultNodeIds).toContain(draftBuilderConfig.nodes[0]!.id);
    expect(resultNodeIds).not.toContain(publishedBuilderConfig.nodes[0]!.id);
  });
});
