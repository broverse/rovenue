// =============================================================
// Dashboard offerings CRUD integration tests
//
// Mirrors the pattern of credits.integration.test.ts:
// minimal Hono app mounted on the same path the production tree
// uses, real Postgres seeded inline, real Better Auth session
// cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { offeringsDashboardRoute } from "./offerings";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/offerings",
    offeringsDashboardRoute,
  );
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `offeringsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!offeringsroute";
  const name = `Offerings Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  // Extract the session cookie value (first segment before ';')
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_offrroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Offerings Route Project ${RUN_ID}${suffix}`,
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

async function seedProduct(projectId: string, suffix = "") {
  const db = getDb();
  const id = `prod_offrroute_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.products).values({
    id,
    projectId,
    identifier: `com.rovenue.test.monthly_${RUN_ID}${suffix}`,
    displayName: `Test Monthly ${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
  });
  return { id };
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

describe("POST /projects/:projectId/offerings — create offering", () => {
  it("creates an offering with packages and no accessId", async () => {
    const { userId, cookie } = await createUserAndSession("create");
    const project = await seedProject("create");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const product = await seedProduct(project.id, "create");

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/offerings`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          identifier: "default",
          isDefault: true,
          packages: [
            {
              identifier: "$rov_monthly",
              productId: product.id,
              order: 0,
              isPromoted: false,
            },
          ],
        }),
      },
    );

    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { offering: Record<string, unknown> } };
    expect(data.offering.packages).toBeInstanceOf(Array);
    expect((data.offering.packages as Array<{ identifier: string }>)[0]?.identifier).toBe("$rov_monthly");
    expect(data.offering.accessId).toBeUndefined();
  });

  it("409s when offering identifier is already in use", async () => {
    const { userId, cookie } = await createUserAndSession("dup");
    const project = await seedProject("dup");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const product = await seedProduct(project.id, "dup");

    const app = buildApp();
    const body = JSON.stringify({
      identifier: "dup-offering",
      packages: [{ identifier: "custom_pkg", productId: product.id, order: 0, isPromoted: false }],
    });
    const headers = { "content-type": "application/json", cookie };

    await app.request(`/projects/${project.id}/offerings`, { method: "POST", headers, body });
    const res2 = await app.request(`/projects/${project.id}/offerings`, { method: "POST", headers, body });
    expect(res2.status).toBe(409);
  });

  it("403s when caller has CUSTOMER_SUPPORT role (no products:write)", async () => {
    const { userId, cookie } = await createUserAndSession("403");
    const project = await seedProject("403");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/offerings`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ identifier: "blocked", packages: [] }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /projects/:projectId/offerings — list offerings", () => {
  it("returns offerings with packages array", async () => {
    const { userId, cookie } = await createUserAndSession("list");
    const project = await seedProject("list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const product = await seedProduct(project.id, "list");

    const app = buildApp();
    // Create one offering first
    await app.request(`/projects/${project.id}/offerings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "list-test",
        packages: [{ identifier: "$rov_annual", productId: product.id, order: 0, isPromoted: false }],
      }),
    });

    const res = await app.request(`/projects/${project.id}/offerings`, {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { offerings: Array<Record<string, unknown>> } };
    expect(Array.isArray(data.offerings)).toBe(true);
    const offering = data.offerings[0];
    expect(offering).toBeDefined();
    expect(Array.isArray(offering!.packages)).toBe(true);
    expect(offering!.accessId).toBeUndefined();
  });
});

describe("PATCH /projects/:projectId/offerings/:id — update offering", () => {
  it("updates packages and returns no accessId", async () => {
    const { userId, cookie } = await createUserAndSession("patch");
    const project = await seedProject("patch");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const product = await seedProduct(project.id, "patch");

    const app = buildApp();
    const createRes = await app.request(`/projects/${project.id}/offerings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "patch-test",
        packages: [{ identifier: "$rov_monthly", productId: product.id, order: 0, isPromoted: false }],
      }),
    });
    const { data: createData } = await createRes.json() as { data: { offering: { id: string } } };
    const offeringId = createData.offering.id;

    const patchRes = await app.request(`/projects/${project.id}/offerings/${offeringId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        packages: [
          { identifier: "$rov_monthly", productId: product.id, order: 0, isPromoted: true },
          { identifier: "$rov_annual", productId: product.id, order: 1, isPromoted: false },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = await patchRes.json() as { data: { offering: Record<string, unknown> } };
    expect((data.offering.packages as Array<{ isPromoted: boolean }>)[0]?.isPromoted).toBe(true);
    expect(data.offering.accessId).toBeUndefined();
  });
});
