// =============================================================
// Paywall versioning endpoints — publish / versions / revert /
// discard-draft / label / diff.
//
// Same harness as dashboard-paywalls.integration.test.ts: minimal Hono
// app on the production mount path, real Postgres, real Better Auth
// session cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { getDb, projects, offerings, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";

const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: (projectId: string) => purgeSpy(projectId),
}));

// `lib/env.ts` parses `process.env` at import time (see MEMORY:
// vitest_env_import_hoisting_footgun / apps/api/tests/lib/asset-store.test.ts)
// — a plain top-of-file assignment below the imports would be dead code,
// because the static imports above (which pull in the publish route ->
// lib/asset-store.ts -> lib/env.ts) already run before any non-hoisted
// statement. `vi.hoisted` runs before every import in the file, so this is
// the only place this actually takes effect. Without it, `parseAssetUrl`
// returns null for every URL, and the asset-usage-index tests below would
// pass for the wrong reason: not because the resolver correctly rejects
// external/cross-project URLs, but because it's a no-op for everything.
vi.hoisted(() => {
  process.env.ASSET_PUBLIC_BASE_URL ??= "https://cdn.pwver.test";
});

const { paywallsDashboardRoute } = await import("../src/routes/dashboard/paywalls");
const { buildStorageKey, publicUrl } = await import("../src/lib/asset-store");

const RUN_ID = Date.now();
const db = getDb();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

let projectId: string;
let offeringId: string;
let cookie: string;
let userId: string;
/** A second, unrelated project — exists only so the asset-usage-index
 *  tests below can seed an asset that is real (resolves via
 *  `parseAssetUrl`) but NOT owned by `projectId`, to prove the
 *  cross-project guard in the publish route's `resolveAssetUrl`. */
let otherProjectId: string;

const VALID_CONFIG = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title: "Hello", cta: "Buy" } },
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

beforeAll(async () => {
  const email = `pwver_${RUN_ID}@rovenue.test`;
  const password = "Test1234!pwver";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `PW Ver ${RUN_ID}` },
  });
  userId = signUp!.user!.id;
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;

  // NOTE: `projects` has no `ownerId` column — membership is a separate
  // `project_members` row, not derivable from the project itself (see
  // dashboard-paywalls.integration.test.ts's seedMember helper). The task
  // brief's inline snippet assumed an `ownerId` column; it does not exist,
  // so we seed the project row plus an explicit ADMIN membership below.
  const [project] = await db
    .insert(projects)
    .values({ name: `pwver-${RUN_ID}` })
    .returning();
  projectId = project!.id;

  await db.insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "ADMIN",
  });

  // NOTE: `offerings` has no `name` column (see the sibling repo test
  // packages/db/.../paywalls.integration.test.ts, which seeds
  // `{ projectId, identifier, packages: [] }` with no `name`). The brief's
  // inline snippet included one; dropped here. Also, offering-hydration's
  // packageSchema requires `productId: z.string()` (non-null) — a null
  // productId fails that parse, extractOfferingPackageIds silently falls
  // back to [], and every packageList node then 400s as FOREIGN_PACKAGE_ID.
  // Use a real string id instead of the brief's `productId: null`.
  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      packages: [{ identifier: "monthly", productId: "prod_monthly" }],
    })
    .returning();
  offeringId = offering!.id;

  const [otherProject] = await db
    .insert(projects)
    .values({ name: `pwver-other-${RUN_ID}` })
    .returning();
  otherProjectId = otherProject!.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(projects).where(eq(projects.id, otherProjectId));
});

async function createPaywall(suffix: string, builderConfig: unknown) {
  const app = buildApp();
  const res = await app.request(`/projects/${projectId}/paywalls`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      identifier: `pw-${suffix}-${RUN_ID}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      builderConfig,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.paywall;
}

/**
 * `POST /:id/publish` now requires the `draftRevision` the caller
 * reviewed — a publish stating a stale one 409s instead of snapshotting a
 * concurrent writer's draft into a live version (see the route's
 * `publishBodySchema`). These tests are about the publish behaviour, not
 * the CAS, so each one reads the row's CURRENT revision and states that.
 * A paywall that does not exist reads as null and falls back to the column
 * default, so the route still reaches its 404 rather than 409ing first.
 */
async function publishInit(paywallId: string): Promise<RequestInit> {
  const row = await drizzle.paywallRepo.findPaywallById(db, projectId, paywallId);
  return {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ draftRevision: row?.draftRevision ?? 0 }),
  };
}

// =============================================================
// Asset usage index (Task 10) — the composed resolver, end to end
// =============================================================
//
// `parseAssetUrl` has its own unit tests, and `setPublishedVersion` is
// tested with a stand-in resolver (packages/db/.../assets.integration.
// test.ts) — but the lambda in the publish route that JOINS the two
// (`apps/api/src/routes/dashboard/paywalls.ts`'s `resolveAssetUrl`,
// including the cross-project guard) is what actually runs in
// production, and neither of those suites exercises it. These tests go
// through the REAL publish route with a REAL `ASSET_PUBLIC_BASE_URL`
// and REAL asset rows (via `assetRepo.createAsset`, mirroring exactly
// how the upload route builds a storage key: pre-generate the id,
// build the key from it, pass the SAME id through — see
// `CreateAssetInput.id`'s doc comment for why that pairing matters).

/** Seeds a real `paywall_assets` row under `ownerProjectId` and returns
 *  its id and public URL, built the same way the real upload route
 *  does (`buildStorageKey` from a pre-generated id, `publicUrl` from
 *  the resulting key) — NOT a hand-rolled URL shape. */
async function seedAsset(ownerProjectId: string): Promise<{ assetId: string; url: string }> {
  const assetId = createId();
  const storageKey = buildStorageKey(ownerProjectId, assetId, "image");
  await drizzle.assetRepo.createAsset(db, {
    id: assetId,
    projectId: ownerProjectId,
    kind: "image",
    name: "usage-index-seed.webp",
    storageKey,
    contentHash: createId().padEnd(64, "u"),
    contentType: "image/webp",
    byteSize: 100,
    width: 10,
    height: 10,
    sourceFormat: null,
    sourceWidth: null,
    sourceHeight: null,
    policyVersion: 1,
  });
  return { assetId, url: publicUrl(storageKey) };
}

function configWithImageUrl(url: string) {
  return {
    ...VALID_CONFIG,
    root: {
      ...VALID_CONFIG.root,
      children: [
        { type: "image", id: "img", url: { light: url } },
        ...VALID_CONFIG.root.children,
      ],
    },
  };
}

async function usageAssetIdsFor(versionId: string): Promise<string[]> {
  const rows = await db
    .select({ assetId: drizzle.schema.paywallAssetUsages.assetId })
    .from(drizzle.schema.paywallAssetUsages)
    .where(eq(drizzle.schema.paywallAssetUsages.versionId, versionId));
  return rows.map((r) => r.assetId);
}

describe("POST /paywalls/:id/publish — asset usage index (Task 10)", () => {
  it("writes a usage row for a real asset URL owned by this project", async () => {
    const app = buildApp();
    const { assetId, url } = await seedAsset(projectId);
    const paywall = await createPaywall("asset-own", configWithImageUrl(url));

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(await usageAssetIdsFor(data.version.id)).toEqual([assetId]);
  });

  it("does not record usage for an asset URL owned by a different project", async () => {
    const app = buildApp();
    // A REAL asset row — `parseAssetUrl` resolves this URL to a real
    // assetId — just not one this project owns. Proves the
    // `resolved.projectId !== projectId` guard, not merely that
    // `parseAssetUrl` can fail to parse.
    const { url } = await seedAsset(otherProjectId);
    const paywall = await createPaywall("asset-cross", configWithImageUrl(url));

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(await usageAssetIdsFor(data.version.id)).toEqual([]);
  });

  it("does not record usage for a plain external URL", async () => {
    const app = buildApp();
    const paywall = await createPaywall(
      "asset-ext",
      configWithImageUrl("https://not-ours.example/hero.png"),
    );

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(await usageAssetIdsFor(data.version.id)).toEqual([]);
  });
});

// =============================================================
// Publish-time asset existence check (Task 9, 2026-08-23 store-billing
// correctness plan). The usage index above records what a published
// version references — this check REJECTS the publish outright when
// the tree references one of THIS project's asset URLs whose row is
// soft-deleted or was never created: the S3 object behind such a URL
// is gone (asset delete hard-deletes the object), so publishing would
// ship a tree that 404s on device. External URLs and other projects'
// asset URLs pass untouched — same boundary as the usage resolver.
// =============================================================

describe("POST /paywalls/:id/publish — asset existence check (Task 9)", () => {
  async function publish(paywallId: string) {
    const app = buildApp();
    return app.request(`/projects/${projectId}/paywalls/${paywallId}/publish`, await publishInit(paywallId));
  }

  it("400s with asset_missing when the tree references a soft-deleted asset", async () => {
    const { assetId, url } = await seedAsset(projectId);
    const paywall = await createPaywall("asset-deleted", configWithImageUrl(url));
    await drizzle.assetRepo.softDeleteAsset(db, projectId, assetId);

    const res = await publish(paywall.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("asset_missing");
    // The message names the offending URL so the caller can find the
    // node to fix.
    expect(body.error.message).toContain(url);

    // Nothing was published: no version row, paywall still a draft.
    const [row] = await db
      .select()
      .from(drizzle.schema.paywalls)
      .where(eq(drizzle.schema.paywalls.id, paywall.id));
    expect(row!.publishedVersionId).toBeNull();
    expect(row!.status).toBe("draft");
  });

  it("400s with asset_missing for an asset URL of this project that never existed", async () => {
    const bogusUrl = publicUrl(buildStorageKey(projectId, createId(), "image"));
    const paywall = await createPaywall("asset-bogus", configWithImageUrl(bogusUrl));

    const res = await publish(paywall.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("asset_missing");
    expect(body.error.message).toContain(bogusUrl);
  });

  it("publishes untouched when the only media URL is external", async () => {
    const paywall = await createPaywall(
      "asset-ext-ok",
      configWithImageUrl("https://elsewhere.example/pic.png"),
    );

    const res = await publish(paywall.id);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.version.id).toBeTruthy();
  });
});

describe("POST /paywalls/:id/publish", () => {
  it("snapshots the draft, points the paywall at it, and purges the cache", async () => {
    const app = buildApp();
    const paywall = await createPaywall("pub", VALID_CONFIG);
    expect(paywall.status).toBe("draft");
    expect(paywall.publishedVersionId).toBeNull();

    purgeSpy.mockClear();
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.version.versionNo).toBe(1);
    expect(data.version.builderConfig).toEqual(VALID_CONFIG);
    expect(data.version.offeringId).toBe(offeringId);
    expect(data.paywall.status).toBe("published");
    expect(data.paywall.publishedVersionId).toBe(data.version.id);
    expect(purgeSpy).toHaveBeenCalledWith(projectId);
  });

  it("increments versionNo on the second publish", async () => {
    const app = buildApp();
    const paywall = await createPaywall("pub2", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    const { data } = await res.json();
    expect(data.version.versionNo).toBe(2);
  });

  it("rejects a paywall with no builderConfig", async () => {
    const app = buildApp();
    const paywall = await createPaywall("empty", null);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.parse(body.error.message).code).toBe("PAYWALL_EMPTY_DRAFT");
  });

  it("rejects a draft with blocking issues", async () => {
    // MISSING_PURCHASE_BUTTON: a packageList with no purchaseButton anywhere.
    const app = buildApp();
    const paywall = await createPaywall("blocked", VALID_CONFIG);
    // The create endpoint already blocks this, so seed the row directly.
    await drizzle.paywallRepo.updatePaywall(db, projectId, paywall.id, {
      builderConfig: {
        ...VALID_CONFIG,
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
          ],
        },
      },
      configFormatVersion: 2,
    });
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      await publishInit(paywall.id),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = JSON.parse(body.error.message);
    expect(parsed.code).toBe("PAYWALL_NOT_PUBLISHABLE");
    expect(parsed.issues.some((i: { code: string }) => i.code === "MISSING_PURCHASE_BUTTON")).toBe(true);
  });

  it("404s for a paywall in another project", async () => {
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/paywalls/does-not-exist/publish`,
      // A schema-satisfying body: the publish CAS check runs AFTER the row
      // lookup, so a nonexistent paywall must still 404 rather than 409.
      await publishInit("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /paywalls/:id/versions", () => {
  it("lists newest first and flags the live version", async () => {
    const app = buildApp();
    const paywall = await createPaywall("list", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1]);
    expect(data.versions[0].isLive).toBe(true);
    expect(data.versions[1].isLive).toBe(false);
    expect(data.versions[0].publishedBy).toBe(userId);
    // The list shape carries metadata only.
    expect(data.versions[0].builderConfig).toBeUndefined();
  });

  it("returns an empty array for a never-published paywall", async () => {
    const app = buildApp();
    const paywall = await createPaywall("nover", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.versions).toEqual([]);
  });
});

describe("GET /paywalls/:id/versions/:versionNo", () => {
  it("returns the full snapshot", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.version.versionNo).toBe(1);
    expect(data.version.isLive).toBe(true);
    expect(data.version.builderConfig).toEqual(VALID_CONFIG);
    expect(data.version.remoteConfig).toEqual({ defaultLocale: "en", locales: { en: {} } });
  });

  it("400s on non-canonical numeric segments", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detailcanon", VALID_CONFIG);
    for (const seg of ["1e2", "0x10", "%201%20", "1.5"]) {
      const res = await app.request(
        `/projects/${projectId}/paywalls/${paywall.id}/versions/${seg}`,
        { headers: { cookie } },
      );
      expect(res.status, `segment ${seg} should 400`).toBe(400);
    }
  });

  it("404s on an unknown versionNo", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail404", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/99`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("400s on a non-numeric versionNo", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail400", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/abc`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });
});

describe("revert / discard-draft / label", () => {
  it("revert copies a snapshot back into the draft without republishing", async () => {
    const app = buildApp();
    const paywall = await createPaywall("revert", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));

    // Edit the draft: change the title string.
    const edited = {
      ...VALID_CONFIG,
      localizations: { en: { title: "Edited", cta: "Buy" } },
    };
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ draftRevision: 0, builderConfig: edited }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1/revert`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.paywall.builderConfig).toEqual(VALID_CONFIG);
    // Reverting touches the draft only — the live version is unchanged.
    expect(data.paywall.publishedVersionId).not.toBeNull();
    const versions = await (
      await app.request(`/projects/${projectId}/paywalls/${paywall.id}/versions`, {
        headers: { cookie },
      })
    ).json();
    expect(versions.data.versions).toHaveLength(1);
  });

  it("discard-draft resets the draft to the live version", async () => {
    const app = buildApp();
    const paywall = await createPaywall("discard", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        draftRevision: 0,
        builderConfig: {
          ...VALID_CONFIG,
          localizations: { en: { title: "Scratch", cta: "Buy" } },
        },
      }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/discard-draft`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.paywall.builderConfig).toEqual(VALID_CONFIG);
  });

  it("discard-draft 400s when nothing has been published", async () => {
    const app = buildApp();
    const paywall = await createPaywall("discard-none", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/discard-draft`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.parse(body.error.message).code).toBe("PAYWALL_NO_PUBLISHED_VERSION");
  });

  it("PATCH versions/:n sets and clears the label", async () => {
    const app = buildApp();
    const paywall = await createPaywall("label", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));

    const set = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: "Q3 launch" }),
      },
    );
    expect(set.status).toBe(200);
    expect((await set.json()).data.version.label).toBe("Q3 launch");

    const clear = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: null }),
      },
    );
    expect((await clear.json()).data.version.label).toBeNull();
  });
});

describe("GET /paywalls/:id/diff", () => {
  it("defaults to live-published → draft", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        draftRevision: 0,
        builderConfig: {
          ...VALID_CONFIG,
          localizations: { en: { title: "Changed", cta: "Buy" } },
        },
      }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.from.versionNo).toBe(1);
    expect(data.to.versionNo).toBeNull();
    expect(data.entries).toContainEqual({
      kind: "changed",
      scope: "localization",
      nodeId: null,
      nodeType: null,
      field: "en.title",
      from: '"Hello"',
      to: '"Changed"',
    });
  });

  it("accepts explicit version numbers on both sides", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff2", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        draftRevision: 0,
        builderConfig: { ...VALID_CONFIG, root: { ...VALID_CONFIG.root, spacing: 20 } },
      }),
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, await publishInit(paywall.id));

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff?from=1&to=2`,
      { headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.from.versionNo).toBe(1);
    expect(data.to.versionNo).toBe(2);
    expect(data.entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "root",
      nodeType: "stack",
      field: "spacing",
      from: null,
      to: "20",
    });
  });

  it("returns an empty diff when nothing has been published", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff-none", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff`,
      { headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.from.versionNo).toBeNull();
    // No published side → everything in the draft reads as added.
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries.every((e: { kind: string }) => e.kind === "added")).toBe(true);
  });

  it("404s on an unknown version number", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff404", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff?from=42`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /paywalls/:id/publish — concurrency", () => {
  it("serializes concurrent publishes of one paywall without version collisions", async () => {
    const app = buildApp();
    const paywall = await createPaywall("concurrent", VALID_CONFIG);

    // Fire many publishes of the SAME paywall at once. Without a
    // per-paywall lock, nextVersionNo (read-then-insert) lets two
    // transactions read the same MAX(versionNo) and both insert N+1 —
    // the unique (paywallId, versionNo) index then 500s the loser.
    const N = 10;
    // One init reused across all N: publish does not move draftRevision,
    // so every concurrent request states the same (correct) one — the
    // race under test is the version-number one, not the CAS.
    const init = await publishInit(paywall.id);
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, init),
      ),
    );

    // Every publish must succeed — no unique-index collision surfaced as 500.
    for (const res of results) expect(res.status).toBe(200);

    const bodies = await Promise.all(results.map((r) => r.json()));
    const versionNos = bodies
      .map((b) => b.data.version.versionNo as number)
      .sort((a, b) => a - b);

    // Exactly 1..N, each exactly once — the lock made nextVersionNo monotonic.
    expect(versionNos).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
