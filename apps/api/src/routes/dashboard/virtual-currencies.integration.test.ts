// =============================================================
// /projects/:projectId/virtual-currencies — dashboard CRUD route
//
// Mirrors the pattern of credits.integration.test.ts:
// minimal Hono app mounted on the same path, real Postgres seeded
// inline, real Better Auth session cookie so requireDashboardAuth
// runs unmocked.
// =============================================================

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { virtualCurrenciesDashboardRoute } from "./virtual-currencies";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/virtual-currencies",
    virtualCurrenciesDashboardRoute,
  );
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `vcroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!vcroute";
  const name = `VC Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = cookieHeader.split(";")[0] ?? "";

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_vcroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `VC Route Project ${RUN_ID}${suffix}`,
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
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
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

describe("GET /projects/:projectId/virtual-currencies", () => {
  it("lists currencies for the project (including archived)", async () => {
    const { userId, cookie } = await createUserAndSession("list");
    const project = await seedProject("list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    // Seed two currencies via repo
    const c1 = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
      drizzle.db,
      { projectId: project.id, code: "GLD", name: "Gold" },
    );
    const c2 = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
      drizzle.db,
      { projectId: project.id, code: "GEM", name: "Gem" },
    );
    // Archive one
    await drizzle.virtualCurrencyRepo.archiveVirtualCurrency(
      drizzle.db,
      project.id,
      c2.id,
    );

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { currencies: Array<{ id: string; archivedAt: string | null }> };
    };
    const ids = body.data.currencies.map((c) => c.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id); // archived but still returned
    const archived = body.data.currencies.find((c) => c.id === c2.id);
    expect(archived?.archivedAt).not.toBeNull();
  });
});

describe("POST /projects/:projectId/virtual-currencies", () => {
  it("creates a currency and returns it", async () => {
    const { userId, cookie } = await createUserAndSession("create");
    const project = await seedProject("create");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ code: "EMR", name: "Zümrüt" }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { currency: { id: string; code: string; name: string } };
    };
    expect(body.data.currency.code).toBe("EMR");
    expect(body.data.currency.name).toBe("Zümrüt");
    expect(body.data.currency.id).toBeTruthy();
  });

  it("409s on duplicate code within the same project", async () => {
    const { userId, cookie } = await createUserAndSession("dup");
    const project = await seedProject("dup");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    // Pre-seed a currency with the same code
    await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
      projectId: project.id,
      code: "DUP",
      name: "Duplicate",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ code: "DUP", name: "Another" }),
      },
    );

    expect(res.status).toBe(409);
  });

  it("403s when caller lacks credits:write capability (GROWTH role)", async () => {
    const { userId, cookie } = await createUserAndSession("noperm");
    const project = await seedProject("noperm");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "GROWTH" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ code: "XYZ", name: "No access" }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("422s when active currency count is at the 50-currency cap", async () => {
    const { userId, cookie } = await createUserAndSession("cap");
    const project = await seedProject("cap");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    // Bulk-create 50 active currencies (codes C00..C49, all start with a letter)
    for (let i = 0; i < 50; i++) {
      const code = `C${String(i).padStart(2, "0")}`;
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: project.id,
        code,
        name: `Cap Currency ${i}`,
      });
    }

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ code: "C50", name: "One Too Many" }),
      },
    );

    expect(res.status).toBe(422);
  });
});

describe("PATCH /projects/:projectId/virtual-currencies/:id", () => {
  it("renames a currency", async () => {
    const { userId, cookie } = await createUserAndSession("rename");
    const project = await seedProject("rename");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const created = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
      drizzle.db,
      { projectId: project.id, code: "RNM", name: "OldName" },
    );

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "NewName" }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { currency: { id: string; name: string } };
    };
    expect(body.data.currency.name).toBe("NewName");
    expect(body.data.currency.id).toBe(created.id);
  });

  it("404s when id does not belong to the project", async () => {
    const { userId, cookie } = await createUserAndSession("rename404");
    const project = await seedProject("rename404");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies/nonexistent-id`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Ghost" }),
      },
    );

    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:projectId/virtual-currencies/:id", () => {
  it("archives a currency", async () => {
    const { userId, cookie } = await createUserAndSession("archive");
    const project = await seedProject("archive");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const created = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
      drizzle.db,
      { projectId: project.id, code: "ARC", name: "ToArchive" },
    );

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies/${created.id}`,
      {
        method: "DELETE",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { currency: { id: string; archivedAt: string | null } };
    };
    expect(body.data.currency.id).toBe(created.id);
    expect(body.data.currency.archivedAt).not.toBeNull();
  });

  it("404s when id does not belong to the project", async () => {
    const { userId, cookie } = await createUserAndSession("archive404");
    const project = await seedProject("archive404");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/virtual-currencies/nonexistent-id`,
      {
        method: "DELETE",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(404);
  });
});

// Repo-layer smoke test (always runs, no HTTP auth required)
describe("virtualCurrenciesDashboardRoute — module smoke", () => {
  it("is exported and defined", () => {
    expect(virtualCurrenciesDashboardRoute).toBeDefined();
  });
});
