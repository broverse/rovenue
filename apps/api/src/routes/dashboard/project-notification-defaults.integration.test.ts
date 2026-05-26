// =============================================================
// /dashboard/projects/:projectId/notification-defaults — tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { projectNotificationDefaultsRoute } from "./project-notification-defaults";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route(
    "/projects/:projectId/notification-defaults",
    projectNotificationDefaultsRoute,
  );
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `pndroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pnd";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `nd-${suffix}` },
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
  const id = `prj_pnd_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
) {
  await db
    .insert(schema.projectMembers)
    .values({ projectId, userId, role });
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard project-notification-defaults", () => {
  it("GET as any member returns the current defaults (or empty)", async () => {
    const { userId, cookie } = await createUserAndSession("get_member");
    const projectId = await seedProject("get_member");
    await addMember(projectId, userId, "DEVELOPER");

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      { method: "GET", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { projectId: string; defaults: Record<string, boolean> };
    };
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.defaults).toEqual({});
  });

  it("GET as non-member returns 403", async () => {
    const { cookie } = await createUserAndSession("get_nonmember");
    const projectId = await seedProject("get_nonmember");
    // no membership added
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      { method: "GET", headers: { cookie } },
    );
    expect(res.status).toBe(403);
  });

  it("PATCH as OWNER persists + merges into the existing JSONB", async () => {
    const { userId, cookie } = await createUserAndSession("patch_owner");
    const projectId = await seedProject("patch_owner");
    await addMember(projectId, userId, "OWNER");

    const app = buildApp();
    // First write seeds the row.
    let res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { "revenue.digest.daily": false },
        }),
      },
    );
    expect(res.status).toBe(200);

    // Second write must not clobber the first.
    res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { "billing.refund.detected": true },
        }),
      },
    );
    expect(res.status).toBe(200);

    const merged = await drizzle.notificationPreferencesRepo.getProjectDefaults(
      db,
      projectId,
    );
    expect(merged["revenue.digest.daily"]).toBe(false);
    expect(merged["billing.refund.detected"]).toBe(true);
  });

  it("PATCH as DEVELOPER returns 403 (capability project:settings:write)", async () => {
    const { userId, cookie } = await createUserAndSession("patch_dev");
    const projectId = await seedProject("patch_dev");
    await addMember(projectId, userId, "DEVELOPER");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { "revenue.digest.daily": false },
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("PATCH on a forced-channel event returns 400 FORCED_EVENT", async () => {
    const { userId, cookie } = await createUserAndSession("patch_forced");
    const projectId = await seedProject("patch_forced");
    await addMember(projectId, userId, "OWNER");

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/notification-defaults`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          // team.member.invited has forcedChannels:["email"]
          defaults: { "team.member.invited": false },
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { message?: string };
    };
    expect(body.error?.message).toMatch(/FORCED_EVENT/);
  });
});
