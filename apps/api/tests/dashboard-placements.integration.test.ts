// =============================================================
// Dashboard placements CRUD integration tests
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

// Spy on the edge-cache purge — same call pattern offerings.ts uses.
// vi.hoisted: vi.mock factories run before this module's top-level
// statements, so the spy referenced inside must be created via
// vi.hoisted rather than a plain `const`.
const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: (projectId: string) => purgeSpy(projectId),
}));

const { placementsDashboardRoute } = await import("../src/routes/dashboard/placements");

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/placements", placementsDashboardRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `placementsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!placementsroute";
  const name = `Placements Route User ${suffix}`;

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
  const id = `prj_plroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Placements Route Project ${RUN_ID}${suffix}`,
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

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({ projectId, identifier: `offering_${RUN_ID}${suffix}`, packages: [] })
    .returning();
  return { id: row!.id };
}

async function seedPaywall(projectId: string, offeringId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `paywall_${RUN_ID}${suffix}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: { title: "x" } } },
    })
    .returning();
  return { id: row!.id };
}

async function seedAudience(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.audiences)
    .values({ projectId, name: `Audience ${RUN_ID}${suffix}`, rules: {} })
    .returning();
  return { id: row!.id };
}

async function seedExperiment(
  projectId: string,
  audienceId: string,
  type: "PAYWALL" | "FLAG",
  suffix = "",
) {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.experiments)
    .values({
      projectId,
      name: `Experiment ${suffix}`,
      type,
      key: `exp_${RUN_ID}${suffix}`,
      audienceId,
      status: "RUNNING",
      variants: [
        { id: "a", name: "A", value: { x: 1 }, weight: 0.5 },
        { id: "b", name: "B", value: { x: 2 }, weight: 0.5 },
      ],
    })
    .returning();
  return { id: row!.id };
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

describe("POST /projects/:projectId/placements — create placement", () => {
  it("creates a placement with an all-users none-target row", async () => {
    const { userId, cookie } = await createUserAndSession("create");
    const project = await seedProject("create");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "onboarding-placement",
        name: "Onboarding Placement",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { placement: Record<string, unknown> } };
    expect(data.placement.identifier).toBe("onboarding-placement");
    expect(data.placement.revision).toBe(1);
    expect(purgeSpy).toHaveBeenCalledWith(project.id);
  });

  it("creates a placement referencing an owned paywall row", async () => {
    const { userId, cookie } = await createUserAndSession("create-pw");
    const project = await seedProject("create-pw");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-pw");
    const paywall = await seedPaywall(project.id, offering.id, "create-pw");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "paywall-placement",
        name: "Paywall Placement",
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: paywall.id } }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("400s INVALID_ROW_REF when paywallId belongs to another project", async () => {
    const { userId, cookie } = await createUserAndSession("foreign-pw");
    const project = await seedProject("foreign-pw");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const otherProject = await seedProject("foreign-pw-other");
    trackProject(otherProject.id);
    const otherOffering = await seedOffering(otherProject.id, "foreign-pw-other");
    const otherPaywall = await seedPaywall(otherProject.id, otherOffering.id, "foreign-pw-other");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "foreign-paywall-placement",
        name: "Foreign Paywall Placement",
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: otherPaywall.id } }],
      }),
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("INVALID_ROW_REF");
  });

  it("400s INVALID_ROW_REF when experimentId belongs to another project", async () => {
    const { userId, cookie } = await createUserAndSession("foreign-exp");
    const project = await seedProject("foreign-exp");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const otherProject = await seedProject("foreign-exp-other");
    trackProject(otherProject.id);
    const otherAudience = await seedAudience(otherProject.id, "foreign-exp-other");
    const otherExperiment = await seedExperiment(
      otherProject.id,
      otherAudience.id,
      "PAYWALL",
      "foreign-exp-other",
    );

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "foreign-experiment-placement",
        name: "Foreign Experiment Placement",
        rows: [
          { audienceId: null, target: { type: "experiment", experimentId: otherExperiment.id } },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("INVALID_ROW_REF");
  });

  it("400s INVALID_ROW_REF when the experiment target is not type=PAYWALL", async () => {
    const { userId, cookie } = await createUserAndSession("flag-exp");
    const project = await seedProject("flag-exp");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const audience = await seedAudience(project.id, "flag-exp");
    const flagExperiment = await seedExperiment(project.id, audience.id, "FLAG", "flag-exp");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "flag-experiment-placement",
        name: "Flag Experiment Placement",
        rows: [
          { audienceId: null, target: { type: "experiment", experimentId: flagExperiment.id } },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("INVALID_ROW_REF");
  });

  it("400s INVALID_ROW_REF when audienceId does not belong to the project", async () => {
    const { userId, cookie } = await createUserAndSession("foreign-aud");
    const project = await seedProject("foreign-aud");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const otherProject = await seedProject("foreign-aud-other");
    trackProject(otherProject.id);
    const otherAudience = await seedAudience(otherProject.id, "foreign-aud-other");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "foreign-audience-placement",
        name: "Foreign Audience Placement",
        rows: [{ audienceId: otherAudience.id, target: { type: "none" } }],
      }),
    });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("INVALID_ROW_REF");
  });

  it("403s when caller has CUSTOMER_SUPPORT role (no products:write)", async () => {
    const { userId, cookie } = await createUserAndSession("403");
    const project = await seedProject("403");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "blocked-placement",
        name: "Blocked",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /projects/:projectId/placements — list placements", () => {
  it("returns created placements", async () => {
    const { userId, cookie } = await createUserAndSession("list");
    const project = await seedProject("list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "list-test-placement",
        name: "List Test",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });

    const res = await app.request(`/projects/${project.id}/placements`, {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { placements: Array<Record<string, unknown>> } };
    expect(data.placements.some((p) => p.identifier === "list-test-placement")).toBe(true);
  });
});

describe("PATCH /projects/:projectId/placements/:id — update placement rows", () => {
  it("bumps revision when rows change and calls purge", async () => {
    const { userId, cookie } = await createUserAndSession("patch");
    const project = await seedProject("patch");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "patch");
    const paywall = await seedPaywall(project.id, offering.id, "patch");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "patch-test-placement",
        name: "Patch Test",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });
    const { data: createData } = (await createRes.json()) as {
      data: { placement: { id: string; revision: number } };
    };
    expect(createData.placement.revision).toBe(1);
    const placementId = createData.placement.id;

    purgeSpy.mockClear();
    const patchRes = await app.request(`/projects/${project.id}/placements/${placementId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        rows: [{ audienceId: null, target: { type: "paywall", paywallId: paywall.id } }],
      }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as { data: { placement: Record<string, unknown> } };
    expect(data.placement.revision).toBe(2);
    expect(purgeSpy).toHaveBeenCalledWith(project.id);
  });

  it("400s INVALID_ROW_REF when PATCH references a foreign experiment", async () => {
    const { userId, cookie } = await createUserAndSession("patch-foreign");
    const project = await seedProject("patch-foreign");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const otherProject = await seedProject("patch-foreign-other");
    trackProject(otherProject.id);
    const otherAudience = await seedAudience(otherProject.id, "patch-foreign-other");
    const otherExperiment = await seedExperiment(
      otherProject.id,
      otherAudience.id,
      "PAYWALL",
      "patch-foreign-other",
    );

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "patch-foreign-placement",
        name: "Patch Foreign",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { placement: { id: string } } };
    const placementId = createData.placement.id;

    const patchRes = await app.request(`/projects/${project.id}/placements/${placementId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        rows: [
          { audienceId: null, target: { type: "experiment", experimentId: otherExperiment.id } },
        ],
      }),
    });
    expect(patchRes.status).toBe(400);
    const text = JSON.stringify(await patchRes.json());
    expect(text).toContain("INVALID_ROW_REF");
  });

  it("400s when trying to change identifier", async () => {
    const { userId, cookie } = await createUserAndSession("patch-immutable");
    const project = await seedProject("patch-immutable");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "immutable-test-placement",
        name: "Immutable Test",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { placement: { id: string } } };
    const placementId = createData.placement.id;

    const patchRes = await app.request(`/projects/${project.id}/placements/${placementId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "changed-identifier" }),
    });
    expect(patchRes.status).toBe(400);
    const { error } = (await patchRes.json()) as { error: { message: string } };
    expect(error.message).toContain("immutable");
  });
});

describe("DELETE /projects/:projectId/placements/:id — delete placement", () => {
  it("deletes a placement", async () => {
    const { userId, cookie } = await createUserAndSession("del");
    const project = await seedProject("del");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/placements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "delete-test-placement",
        name: "Delete Test",
        rows: [{ audienceId: null, target: { type: "none" } }],
      }),
    });
    const { data: createData } = (await createRes.json()) as { data: { placement: { id: string } } };
    const placementId = createData.placement.id;

    const delRes = await app.request(`/projects/${project.id}/placements/${placementId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(delRes.status).toBe(200);
  });
});
