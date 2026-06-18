// =============================================================
// /dashboard/projects — webhookEventCategories PATCH tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { projectsRoute } from "./projects";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/projects", projectsRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `proj_wh_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!proj";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `proj-${suffix}` },
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
  const id = `prj_wh_${RUN_ID}_${suffix}`;
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

describe.sequential("dashboard projects — webhookEventCategories", () => {
  it("PATCH accepts and persists webhookEventCategories", async () => {
    const { userId, cookie } = await createUserAndSession("wh_cats");
    const projectId = await seedProject("wh_cats");
    await addMember(projectId, userId, "OWNER");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookEventCategories: ["purchase", "renewal"] }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { project: { webhookEventCategories: string[] } };
    };
    expect(data.project.webhookEventCategories).toEqual(["purchase", "renewal"]);
  });

  it("PATCH rejects an unknown category", async () => {
    const { userId, cookie } = await createUserAndSession("wh_cats_bad");
    const projectId = await seedProject("wh_cats_bad");
    await addMember(projectId, userId, "OWNER");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ webhookEventCategories: ["not_a_category"] }),
    });
    expect(res.status).toBe(400);
  });
});
