// =============================================================
// /dashboard/projects/:projectId/commission-rates — tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { commissionRatesRoute } from "./commission-rates";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/projects/:projectId/commission-rates", commissionRatesRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `cmrroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!cmr";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `cmr-${suffix}` },
  });
  if (!signUp?.user) throw new Error("signUp failed");
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("no set-cookie");
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

const seededProjectIds: string[] = [];
async function seedProject(suffix: string) {
  const id = `prj_cmr_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
) {
  await db.insert(schema.projectMembers).values({ projectId, userId, role });
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard commission-rates", () => {
  it("GET as any member returns [] when nothing is configured — never a synthesized 0%", async () => {
    const { userId, cookie } = await createUserAndSession("get_member");
    const projectId = await seedProject("get_member");
    await addMember(projectId, userId, "DEVELOPER");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/commission-rates`, {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rates: Array<{ store: string; rate: number }> };
    };
    expect(body.data.rates).toEqual([]);
  });

  it("GET as non-member returns 403", async () => {
    const { cookie } = await createUserAndSession("get_nonmember");
    const projectId = await seedProject("get_nonmember");
    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/commission-rates`, {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it("PUT as OWNER upserts, and a second PUT for the same store overwrites (not duplicates)", async () => {
    const { userId, cookie } = await createUserAndSession("put_owner");
    const projectId = await seedProject("put_owner");
    await addMember(projectId, userId, "OWNER");

    const app = buildApp();
    let res = await app.request(
      `/projects/${projectId}/commission-rates/APP_STORE`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rate: 0.3 }),
      },
    );
    expect(res.status).toBe(200);
    let body = (await res.json()) as { data: { store: string; rate: number } };
    expect(body.data.rate).toBeCloseTo(0.3, 8);

    // Customer re-qualifies for the Small Business Program.
    res = await app.request(
      `/projects/${projectId}/commission-rates/APP_STORE`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rate: 0.15 }),
      },
    );
    expect(res.status).toBe(200);
    body = (await res.json()) as { data: { store: string; rate: number } };
    expect(body.data.rate).toBeCloseTo(0.15, 8);

    const rows = await drizzle.commissionRateRepo.listCommissionRates(
      db,
      projectId,
    );
    expect(rows.filter((r) => r.store === "APP_STORE")).toHaveLength(1);
  });

  it("PUT as DEVELOPER returns 403 (capability project:settings:write)", async () => {
    const { userId, cookie } = await createUserAndSession("put_dev");
    const projectId = await seedProject("put_dev");
    await addMember(projectId, userId, "DEVELOPER");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/commission-rates/APP_STORE`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rate: 0.3 }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("PUT with a rate outside [0, 1] returns 400 before touching Postgres", async () => {
    const { userId, cookie } = await createUserAndSession("put_badrate");
    const projectId = await seedProject("put_badrate");
    await addMember(projectId, userId, "OWNER");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/commission-rates/APP_STORE`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rate: 1.5 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("DELETE as OWNER reverts a store to unconfigured", async () => {
    const { userId, cookie } = await createUserAndSession("delete_owner");
    const projectId = await seedProject("delete_owner");
    await addMember(projectId, userId, "OWNER");
    const app = buildApp();

    await app.request(`/projects/${projectId}/commission-rates/STRIPE`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rate: 0.029 }),
    });
    expect(
      await drizzle.commissionRateRepo.getCommissionRate(db, projectId, "STRIPE"),
    ).not.toBeNull();

    const res = await app.request(
      `/projects/${projectId}/commission-rates/STRIPE`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(
      await drizzle.commissionRateRepo.getCommissionRate(db, projectId, "STRIPE"),
    ).toBeNull();
  });
});
