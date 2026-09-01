// =============================================================
// ELEMENT experiments materialise one patched paywall snapshot per
// variant into the SAME `experiment.variants[].paywall` slot PAYWALL
// experiments already fill — no envelope, SDK, renderer or fixture
// change. See apps/api/src/lib/placement-resolution.ts
// `materializeElementVariants`.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, offerings, drizzle, ExperimentStatus, ExperimentType } from "@rovenue/db";
import { resolvePlacement } from "../src/lib/placement-resolution";
import type { BuilderConfig } from "@rovenue/shared/paywall";

const RUN_ID = Date.now();
const db = getDb();

let projectId: string;
let offeringId: string;
let audienceId: string;

const PUBLISHED_CONFIG: BuilderConfig = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title: "Go Pro" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "title", role: "title" },
      { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
    ],
  },
};

async function createPublishedPaywall(suffix: string) {
  const paywall = await drizzle.paywallRepo.createPaywall(db, {
    projectId,
    identifier: `pw-elem-${RUN_ID}-${suffix}`,
    name: `Element paywall ${suffix}`,
    offeringId,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "x" } } },
    builderConfig: PUBLISHED_CONFIG,
    configFormatVersion: 2,
  });
  const version = await drizzle.paywallVersionRepo.insert(db, {
    paywallId: paywall.id,
    versionNo: 1,
    builderConfig: PUBLISHED_CONFIG,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "x" } } },
    offeringId,
    configFormatVersion: 2,
  });
  await drizzle.paywallRepo.setPublishedVersion(db, projectId, paywall.id, version.id);
  return paywall;
}

async function createRunningElementExperiment(
  key: string,
  variants: Array<{ id: string; weight: number; nodeId: string; props: Record<string, unknown> }>,
  paywallId: string,
) {
  return drizzle.experimentRepo.createExperiment(db, {
    projectId,
    name: `Element experiment ${key}`,
    type: ExperimentType.ELEMENT,
    key,
    audienceId,
    status: ExperimentStatus.RUNNING,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.id,
      weight: v.weight,
      value: { paywallId, nodeId: v.nodeId, props: v.props },
    })),
  });
}

beforeAll(async () => {
  const [project] = await db.insert(projects).values({ name: `plres-elem-${RUN_ID}` }).returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-elem-${RUN_ID}`,
      name: "Default",
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;

  const audience = await drizzle.audienceRepo.createAudience(db, {
    projectId,
    name: "Everyone",
    rules: {},
  });
  audienceId = audience.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("resolvePlacement — ELEMENT experiments", () => {
  it("materialises two independent patched snapshots for two variants patching the same node", async () => {
    const paywall = await createPublishedPaywall("two-variants");
    const experiment = await createRunningElementExperiment(
      `key-two-variants-${RUN_ID}`,
      [
        { id: "control", weight: 0.5, nodeId: "t1", props: { color: { light: "#000000" } } },
        { id: "variant_a", weight: 0.5, nodeId: "t1", props: { color: { light: "#FF0000" } } },
      ],
      paywall.id,
    );
    const placement = await drizzle.placementRepo.createPlacement(db, {
      projectId,
      identifier: `pl-elem-two-${RUN_ID}`,
      name: "Two-variant element placement",
      rows: [{ audienceId: null, target: { type: "experiment", experimentId: experiment.id } }],
    });

    const resolved = await resolvePlacement(projectId, placement, {});

    expect(resolved.paywall).toBeNull();
    expect(resolved.experiment).not.toBeNull();
    expect(resolved.experiment!.id).toBe(experiment.id);
    expect(resolved.experiment!.variants).toHaveLength(2);

    const control = resolved.experiment!.variants.find((v) => v.variantId === "control")!;
    const variantA = resolved.experiment!.variants.find((v) => v.variantId === "variant_a")!;
    expect(control).toBeDefined();
    expect(variantA).toBeDefined();

    const controlRoot = (control.paywall.builderConfig as unknown as BuilderConfig).root;
    const variantARoot = (variantA.paywall.builderConfig as unknown as BuilderConfig).root;
    const controlNode = controlRoot.children.find((n) => n.id === "t1") as { color?: unknown };
    const variantANode = variantARoot.children.find((n) => n.id === "t1") as { color?: unknown };

    // The two snapshots differ in EXACTLY the patched node's patched prop.
    expect(controlNode.color).toEqual({ light: "#000000" });
    expect(variantANode.color).toEqual({ light: "#FF0000" });

    // Every other node is untouched and structurally shared (same
    // reference) between the two independently-patched snapshots.
    const controlPackageList = controlRoot.children.find((n) => n.id === "pl");
    const variantAPackageList = variantARoot.children.find((n) => n.id === "pl");
    expect(controlPackageList).toBe(variantAPackageList);

    // The persisted PUBLISHED snapshot is untouched by either patch —
    // patching happens on an in-memory copy, never in place.
    const persistedVersion = await drizzle.paywallVersionRepo.findById(
      db,
      (await drizzle.paywallRepo.findPaywallById(db, projectId, paywall.id))!.publishedVersionId!,
    );
    expect(persistedVersion!.builderConfig).toEqual(PUBLISHED_CONFIG);
  });

  it("falls through to the next placement row when every variant's nodeId has vanished, never throwing", async () => {
    const paywall = await createPublishedPaywall("vanished-node");
    const experiment = await createRunningElementExperiment(
      `key-vanished-${RUN_ID}`,
      [
        { id: "control", weight: 0.5, nodeId: "no-longer-there", props: {} },
        { id: "variant_a", weight: 0.5, nodeId: "no-longer-there", props: {} },
      ],
      paywall.id,
    );

    const fallbackPaywall = await createPublishedPaywall("vanished-node-fallback");

    const placement = await drizzle.placementRepo.createPlacement(db, {
      projectId,
      identifier: `pl-elem-vanished-${RUN_ID}`,
      name: "Vanished-node element placement",
      rows: [
        { audienceId, target: { type: "experiment", experimentId: experiment.id } },
        { audienceId: null, target: { type: "paywall", paywallId: fallbackPaywall.id } },
      ],
    });

    const resolved = await resolvePlacement(projectId, placement, {});

    // Never throws — falls through to the next row exactly like a
    // dangling reference would.
    expect(resolved.experiment).toBeNull();
    expect(resolved.paywall).not.toBeNull();
    expect(resolved.paywall!.id).toBe(fallbackPaywall.id);
  });

  it("drops only the variant whose nodeId vanished, keeping the rest", async () => {
    const paywall = await createPublishedPaywall("partial-vanished");
    const experiment = await createRunningElementExperiment(
      `key-partial-vanished-${RUN_ID}`,
      [
        { id: "control", weight: 0.5, nodeId: "t1", props: { color: { light: "#111111" } } },
        { id: "variant_a", weight: 0.5, nodeId: "gone", props: {} },
      ],
      paywall.id,
    );
    const placement = await drizzle.placementRepo.createPlacement(db, {
      projectId,
      identifier: `pl-elem-partial-${RUN_ID}`,
      name: "Partially-vanished element placement",
      rows: [{ audienceId: null, target: { type: "experiment", experimentId: experiment.id } }],
    });

    const resolved = await resolvePlacement(projectId, placement, {});

    expect(resolved.experiment).not.toBeNull();
    expect(resolved.experiment!.variants).toHaveLength(1);
    expect(resolved.experiment!.variants[0]!.variantId).toBe("control");
  });
});
