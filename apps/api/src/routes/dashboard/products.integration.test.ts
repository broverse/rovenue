// =============================================================
// Dashboard products CRUD integration tests — identifier immutability
// + currency grant persistence
//
// Mirrors the pattern of offerings.integration.test.ts:
// minimal Hono app, real Postgres seeded inline, real Better Auth
// session cookie so requireDashboardAuth runs unmocked.
// =============================================================

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { productsDashboardRoute, createBodySchema } from "./products";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/products", productsDashboardRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `productsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!productsroute";
  const name = `Products Route User ${suffix}`;

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
  const id = `prj_prodroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Products Route Project ${RUN_ID}${suffix}`,
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

describe("PATCH /projects/:projectId/products/:id — identifier immutability", () => {
  it("400s when PATCH tries to change the product identifier", async () => {
    const { userId, cookie } = await createUserAndSession("immut-prod");
    const project = await seedProject("immut-prod");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();

    // Create product (products POST returns 200)
    const createRes = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.original",
        type: "SUBSCRIPTION",
        displayName: "Original Product",
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = await createRes.json() as { data: { product: { id: string } } };
    const productId = createData.product.id;

    // Attempt to rename identifier → must be 400
    const patchRes = await app.request(`/projects/${project.id}/products/${productId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "com.test.renamed" }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json() as { error: { message: string } };
    expect(body.error.message).toContain("immutable");
  });

  it("200 when PATCH sends the SAME product identifier (no-op)", async () => {
    const { userId, cookie } = await createUserAndSession("immut-same-prod");
    const project = await seedProject("immut-same-prod");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();

    // Create product
    const createRes = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.same",
        type: "SUBSCRIPTION",
        displayName: "Same Identifier Product",
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = await createRes.json() as { data: { product: { id: string } } };
    const productId = createData.product.id;

    // PATCH with same identifier — must succeed
    const patchRes = await app.request(`/projects/${project.id}/products/${productId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "com.test.same", displayName: "Updated Name" }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = await patchRes.json() as { data: { product: { displayName: string } } };
    expect(data.product.displayName).toBe("Updated Name");
  });
});

describe("createBodySchema — currencyGrants validation", () => {
  it("accepts currencyGrants in the create schema", () => {
    const r = createBodySchema.safeParse({
      identifier: "pack.1",
      type: "CONSUMABLE",
      displayName: "Pack",
      currencyGrants: [{ currencyId: "vc1", amount: 1000 }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects currencyGrants with non-positive amount", () => {
    const r = createBodySchema.safeParse({
      identifier: "pack.1",
      type: "CONSUMABLE",
      displayName: "Pack",
      currencyGrants: [{ currencyId: "vc1", amount: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects currencyGrants exceeding 20 entries", () => {
    const r = createBodySchema.safeParse({
      identifier: "pack.1",
      type: "CONSUMABLE",
      displayName: "Pack",
      currencyGrants: Array.from({ length: 21 }, (_, i) => ({
        currencyId: `vc${i}`,
        amount: 100,
      })),
    });
    expect(r.success).toBe(false);
  });
});

// =============================================================
// Currency grant persistence — real-DB integration tests
// =============================================================

async function seedVirtualCurrency(projectId: string, code: string) {
  return drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
    projectId,
    code,
    name: `Currency ${code}`,
  });
}

describe("POST /projects/:projectId/products — currencyGrants persistence", () => {
  it("persists currencyGrants and reflects them in the response", async () => {
    const { userId, cookie } = await createUserAndSession("cg-create");
    const project = await seedProject("cg-create");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const vc = await seedVirtualCurrency(project.id, "GEM");

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.cg.pack",
        type: "CONSUMABLE",
        displayName: "Gem Pack",
        currencyGrants: [{ currencyId: vc.id, amount: 500 }],
      }),
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { product: { id: string; currencyGrants: Array<{ currencyId: string; amount: number }> } };
    };
    expect(data.product.currencyGrants).toHaveLength(1);
    expect(data.product.currencyGrants[0]).toMatchObject({
      currencyId: vc.id,
      amount: 500,
    });

    // Verify the grant is persisted in the DB
    const dbGrants = await drizzle.productCurrencyGrantRepo.listProductGrants(
      drizzle.db,
      data.product.id,
    );
    expect(dbGrants).toHaveLength(1);
    expect(dbGrants[0]?.currencyId).toBe(vc.id);
    expect(dbGrants[0]?.amount).toBe(500);
  });

  it("404s when currencyId does not belong to the project", async () => {
    const { userId, cookie } = await createUserAndSession("cg-create-404");
    const project = await seedProject("cg-create-404");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.cg.pack.unknown",
        type: "CONSUMABLE",
        displayName: "Unknown Currency Pack",
        currencyGrants: [{ currencyId: "nonexistent-currency-id", amount: 100 }],
      }),
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /projects/:projectId/products/:id — currencyGrants persistence", () => {
  it("clears grants when PATCH sends currencyGrants: [] (regression for empty-array no-op bug)", async () => {
    const { userId, cookie } = await createUserAndSession("cg-clear");
    const project = await seedProject("cg-clear");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const vc = await seedVirtualCurrency(project.id, "COIN");

    const app = buildApp();

    // Create a product WITH a grant
    const createRes = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.cg.clear",
        type: "CONSUMABLE",
        displayName: "Clearable Pack",
        currencyGrants: [{ currencyId: vc.id, amount: 100 }],
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = (await createRes.json()) as {
      data: { product: { id: string } };
    };
    const productId = createData.product.id;

    // Confirm grant exists before PATCH
    const grantsBefore = await drizzle.productCurrencyGrantRepo.listProductGrants(
      drizzle.db,
      productId,
    );
    expect(grantsBefore).toHaveLength(1);

    // PATCH with empty currencyGrants — must CLEAR existing grants
    const patchRes = await app.request(
      `/projects/${project.id}/products/${productId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ currencyGrants: [] }),
      },
    );
    expect(patchRes.status).toBe(200);
    const { data: patchData } = (await patchRes.json()) as {
      data: { product: { currencyGrants: unknown[] } };
    };
    expect(patchData.product.currencyGrants).toHaveLength(0);

    // Verify the DB is also cleared
    const grantsAfter = await drizzle.productCurrencyGrantRepo.listProductGrants(
      drizzle.db,
      productId,
    );
    expect(grantsAfter).toHaveLength(0);
  });

  it("404s when PATCH currencyGrants references a currency not in the project", async () => {
    const { userId, cookie } = await createUserAndSession("cg-patch-404");
    const project = await seedProject("cg-patch-404");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();

    // Create a product with no grants
    const createRes = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "com.test.cg.patch.unknown",
        type: "CONSUMABLE",
        displayName: "Unknown Patch Pack",
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = (await createRes.json()) as {
      data: { product: { id: string } };
    };
    const productId = createData.product.id;

    // PATCH with a non-existent currencyId
    const patchRes = await app.request(
      `/projects/${project.id}/products/${productId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          currencyGrants: [{ currencyId: "no-such-currency", amount: 999 }],
        }),
      },
    );
    expect(patchRes.status).toBe(404);
  });
});

// =============================================================
// androidBasePlanId / androidOfferId — Task 2
// =============================================================

describe("POST /projects/:projectId/products — androidBasePlanId/androidOfferId", () => {
  it("persists androidBasePlanId/androidOfferId and returns them", async () => {
    const { userId, cookie } = await createUserAndSession("android-fields");
    const project = await seedProject("android-fields");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "pro_a",
        type: "SUBSCRIPTION",
        displayName: "Pro A",
        storeIds: { android: "pro_a" },
        androidBasePlanId: "annual",
        androidOfferId: "promo10",
      }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { product: { androidBasePlanId: string | null; androidOfferId: string | null } };
    };
    expect(data.product.androidBasePlanId).toBe("annual");
    expect(data.product.androidOfferId).toBe("promo10");
  });

  it("rejects androidOfferId without androidBasePlanId", async () => {
    const { userId, cookie } = await createUserAndSession("android-fields-reject");
    const project = await seedProject("android-fields-reject");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "pro_b",
        type: "SUBSCRIPTION",
        displayName: "Pro B",
        storeIds: { android: "pro_b" },
        androidOfferId: "promo10",
      }),
    });
    expect(res.status).toBe(400);
  });
});
