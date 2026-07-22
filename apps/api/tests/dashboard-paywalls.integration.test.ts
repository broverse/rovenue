// =============================================================
// Dashboard paywalls CRUD integration tests
//
// Mirrors the pattern of dashboard/offerings.integration.test.ts:
// minimal Hono app mounted on the same path the production tree
// uses, real Postgres seeded inline, real Better Auth session
// cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";

// Spy on the edge-cache purge so mutation tests can assert every
// create/patch/delete purges the /v1/placements catalog cache —
// mirrors the same purgeProjectCatalogCache call pattern offerings.ts
// uses. purgeProjectCatalogCache no-ops without env config so this is
// safe to leave un-mocked in behavior; we only spy on the call.
// vi.hoisted: vi.mock factories run before this module's top-level
// statements, so the spy referenced inside must be created via
// vi.hoisted rather than a plain `const`.
const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: (projectId: string) => purgeSpy(projectId),
}));

const { paywallsDashboardRoute } = await import("../src/routes/dashboard/paywalls");

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `paywallsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!paywallsroute";
  const name = `Paywalls Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_pwroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Paywalls Route Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedOffering(
  projectId: string,
  suffix = "",
  packages: unknown[] = [],
) {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `offering_${RUN_ID}${suffix}`,
      packages,
    })
    .returning();
  return { id: row!.id };
}

const validRemoteConfig = {
  defaultLocale: "en",
  locales: { en: { title: "Go Pro" } },
};

// Minimal offering package slot — validateBuilderConfig only needs the
// `identifier` field; productId doesn't need to resolve to a real product.
const monthlyPackageSlot = {
  identifier: "pkg_monthly",
  productId: "prod_monthly",
  order: 0,
  isPromoted: false,
};

function validBuilderConfig() {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title: "Go Pro", buy: "Buy Now" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "title", key: "title", role: "title" },
        {
          type: "packageList",
          id: "pkgs",
          packageIds: ["pkg_monthly"],
          cellLayout: "column",
        },
        { type: "purchaseButton", id: "buy", labelKey: "buy" },
      ],
    },
  };
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("POST /projects/:projectId/paywalls — create paywall", () => {
  it("creates a paywall with a valid remoteConfig", async () => {
    const { userId, cookie } = await createUserAndSession("create");
    const project = await seedProject("create");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "onboarding-paywall",
        name: "Onboarding Paywall",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { paywall: Record<string, unknown> } };
    expect(data.paywall.identifier).toBe("onboarding-paywall");
    expect(data.paywall.offeringId).toBe(offering.id);
    expect(purgeSpy).toHaveBeenCalledWith(project.id);
  });

  it("400s when identifier fails the slug regex", async () => {
    const { userId, cookie } = await createUserAndSession("badslug");
    const project = await seedProject("badslug");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "badslug");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "Not A Slug!",
        name: "Bad Slug",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when defaultLocale is not a key of locales", async () => {
    const { userId, cookie } = await createUserAndSession("badlocale");
    const project = await seedProject("badlocale");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "badlocale");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bad-locale-paywall",
        name: "Bad Locale",
        offeringId: offering.id,
        remoteConfig: { defaultLocale: "fr", locales: { en: { title: "x" } } },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when offeringId does not belong to the project (cross-project)", async () => {
    const { userId, cookie } = await createUserAndSession("crossoffering");
    const project = await seedProject("crossoffering");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const otherProject = await seedProject("crossoffering-other");
    trackProject(otherProject.id);
    const otherOffering = await seedOffering(otherProject.id, "crossoffering-other");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "cross-offering-paywall",
        name: "Cross Offering",
        offeringId: otherOffering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("409s when paywall identifier is already in use", async () => {
    const { userId, cookie } = await createUserAndSession("dup");
    const project = await seedProject("dup");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "dup");

    const app = buildApp();
    const body = JSON.stringify({
      identifier: "dup-paywall",
      name: "Dup Paywall",
      offeringId: offering.id,
      remoteConfig: validRemoteConfig,
    });
    const headers = { "content-type": "application/json", cookie };
    await app.request(`/projects/${project.id}/paywalls`, { method: "POST", headers, body });
    const res2 = await app.request(`/projects/${project.id}/paywalls`, { method: "POST", headers, body });
    expect(res2.status).toBe(409);
  });

  it("403s when caller has CUSTOMER_SUPPORT role (no products:write)", async () => {
    const { userId, cookie } = await createUserAndSession("403");
    const project = await seedProject("403");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
    const offering = await seedOffering(project.id, "403");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "blocked-paywall",
        name: "Blocked",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /projects/:projectId/paywalls — list paywalls", () => {
  it("returns created paywalls", async () => {
    const { userId, cookie } = await createUserAndSession("list");
    const project = await seedProject("list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "list");

    const app = buildApp();
    await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "list-test-paywall",
        name: "List Test",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });

    const res = await app.request(`/projects/${project.id}/paywalls`, {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { paywalls: Array<Record<string, unknown>> } };
    expect(Array.isArray(data.paywalls)).toBe(true);
    expect(data.paywalls.some((p) => p.identifier === "list-test-paywall")).toBe(true);
  });
});

describe("PATCH /projects/:projectId/paywalls/:id — update paywall", () => {
  it("updates name and remoteConfig", async () => {
    const { userId, cookie } = await createUserAndSession("patch");
    const project = await seedProject("patch");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "patch");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "patch-test-paywall",
        name: "Patch Test",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Patched Name" }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(data.paywall.name).toBe("Patched Name");
  });

  it("400s when trying to change identifier", async () => {
    const { userId, cookie } = await createUserAndSession("patch-immutable");
    const project = await seedProject("patch-immutable");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "patch-immutable");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "immutable-test-paywall",
        name: "Immutable Test",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "changed-identifier" }),
    });
    expect(patchRes.status).toBe(400);
    const { error } = (await patchRes.json()) as { error: { message: string } };
    expect(error.message).toContain("immutable");
  });
});

describe("PATCH /projects/:projectId/paywalls/:id — builderConfig", () => {
  it("accepts a valid builderConfig and sets configFormatVersion to 2", async () => {
    const { userId, cookie } = await createUserAndSession("bc-valid");
    const project = await seedProject("bc-valid");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "bc-valid", [monthlyPackageSlot]);

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bc-valid-paywall",
        name: "Builder Config Valid",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: validBuilderConfig() }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as {
      data: { paywall: Record<string, unknown> };
    };
    expect(data.paywall.configFormatVersion).toBe(2);
    expect(data.paywall.builderConfig).toEqual(validBuilderConfig());
  });

  it("400s with INVALID_BUILDER_CONFIG + issues when a packageList references a foreign packageId", async () => {
    const { userId, cookie } = await createUserAndSession("bc-foreign");
    const project = await seedProject("bc-foreign");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "bc-foreign", [monthlyPackageSlot]);

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bc-foreign-paywall",
        name: "Builder Config Foreign",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const badConfig = validBuilderConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (badConfig.root.children[1] as any).packageIds = ["pkg_unknown"];

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: badConfig }),
    });
    expect(patchRes.status).toBe(400);
    const { error } = (await patchRes.json()) as { error: { message: string } };
    const parsed = JSON.parse(error.message) as { code: string; issues: Array<{ code: string }> };
    expect(parsed.code).toBe("INVALID_BUILDER_CONFIG");
    expect(parsed.issues.some((i) => i.code === "FOREIGN_PACKAGE_ID")).toBe(true);
  });

  it("accepts a config whose only issues are LOCALE_KEY_GAP warnings", async () => {
    const { userId, cookie } = await createUserAndSession("bc-gap");
    const project = await seedProject("bc-gap");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "bc-gap", [monthlyPackageSlot]);

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bc-gap-paywall",
        name: "Builder Config Gap",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const gapConfig = validBuilderConfig();
    gapConfig.localizations = { ...gapConfig.localizations, tr: {} };

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: gapConfig }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(data.paywall.configFormatVersion).toBe(2);
  });

  it("clears builderConfig and reverts configFormatVersion to 1 when builderConfig: null", async () => {
    const { userId, cookie } = await createUserAndSession("bc-clear");
    const project = await seedProject("bc-clear");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "bc-clear", [monthlyPackageSlot]);

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bc-clear-paywall",
        name: "Builder Config Clear",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const setRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: validBuilderConfig() }),
    });
    expect(setRes.status).toBe(200);
    const { data: setData } = (await setRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(setData.paywall.configFormatVersion).toBe(2);

    const clearRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: null }),
    });
    expect(clearRes.status).toBe(200);
    const { data: clearData } = (await clearRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(clearData.paywall.builderConfig).toBeNull();
    expect(clearData.paywall.configFormatVersion).toBe(1);
  });

  it("ignores a client-supplied configFormatVersion — server derives it", async () => {
    const { userId, cookie } = await createUserAndSession("bc-ignoreversion");
    const project = await seedProject("bc-ignoreversion");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "bc-ignoreversion", [monthlyPackageSlot]);

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "bc-ignoreversion-paywall",
        name: "Builder Config Ignore Version",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: validBuilderConfig(), configFormatVersion: 99 }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(data.paywall.configFormatVersion).toBe(2);
  });
});

describe("DELETE /projects/:projectId/paywalls/:id — delete paywall", () => {
  it("deletes an unreferenced paywall", async () => {
    const { userId, cookie } = await createUserAndSession("del");
    const project = await seedProject("del");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "del");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "delete-test-paywall",
        name: "Delete Test",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    purgeSpy.mockClear();
    const delRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(delRes.status).toBe(200);
    expect(purgeSpy).toHaveBeenCalledWith(project.id);
  });

  it("409s with PAYWALL_IN_USE when referenced by a placement row", async () => {
    const { userId, cookie } = await createUserAndSession("delinuse");
    const project = await seedProject("delinuse");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "delinuse");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/paywalls`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "referenced-paywall",
        name: "Referenced",
        offeringId: offering.id,
        remoteConfig: validRemoteConfig,
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { paywall: { id: string } } };
    const paywallId = createData.paywall.id;

    const db = getDb();
    await db.insert(drizzle.schema.placements).values({
      projectId: project.id,
      identifier: `blocking-placement-${RUN_ID}`,
      name: "Blocking Placement",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId } }],
    });

    const delRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(delRes.status).toBe(409);
    const text = JSON.stringify(await delRes.json());
    expect(text).toContain("PAYWALL_IN_USE");

    await db
      .delete(drizzle.schema.placements)
      .where(eq(drizzle.schema.placements.projectId, project.id));
  });
});
