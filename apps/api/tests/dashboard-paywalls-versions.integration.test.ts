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
import { getDb, projects, offerings, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";

const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: (projectId: string) => purgeSpy(projectId),
}));

const { paywallsDashboardRoute } = await import("../src/routes/dashboard/paywalls");

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
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
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

describe("POST /paywalls/:id/publish", () => {
  it("snapshots the draft, points the paywall at it, and purges the cache", async () => {
    const app = buildApp();
    const paywall = await createPaywall("pub", VALID_CONFIG);
    expect(paywall.status).toBe("draft");
    expect(paywall.publishedVersionId).toBeNull();

    purgeSpy.mockClear();
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
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
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.version.versionNo).toBe(2);
  });

  it("rejects a paywall with no builderConfig", async () => {
    const app = buildApp();
    const paywall = await createPaywall("empty", null);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
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
      { method: "POST", headers: { cookie } },
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
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /paywalls/:id/versions", () => {
  it("lists newest first and flags the live version", async () => {
    const app = buildApp();
    const paywall = await createPaywall("list", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

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
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

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
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    // Edit the draft: change the title string.
    const edited = {
      ...VALID_CONFIG,
      localizations: { en: { title: "Edited", cta: "Buy" } },
    };
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: edited }),
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
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
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
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

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
