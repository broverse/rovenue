// =============================================================
// Dashboard access catalog CRUD integration tests — identifier immutability
//
// Mirrors the pattern of offerings.integration.test.ts:
// minimal Hono app, real Postgres seeded inline, real Better Auth
// session cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { accessRoute } from "./access";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/access", accessRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `accessroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!accessroute";
  const name = `Access Route User ${suffix}`;

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
  const id = `prj_accroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Access Route Project ${RUN_ID}${suffix}`,
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

describe("PATCH /projects/:projectId/access/:id — identifier immutability", () => {
  it("400s when PATCH tries to change the access identifier", async () => {
    const { userId, cookie } = await createUserAndSession("immut-acc");
    const project = await seedProject("immut-acc");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();

    // Create access (returns 201)
    const createRes = await app.request(`/projects/${project.id}/access`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "premium",
        displayName: "Premium Access",
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: createData } = await createRes.json() as { data: { id: string } };
    const accessId = createData.id;

    // Attempt to rename identifier → must be 400
    const patchRes = await app.request(`/projects/${project.id}/access/${accessId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "premium-renamed" }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json() as { error: { message: string } };
    expect(body.error.message).toContain("immutable");
  });

  it("200 when PATCH sends the SAME access identifier (no-op)", async () => {
    const { userId, cookie } = await createUserAndSession("immut-same-acc");
    const project = await seedProject("immut-same-acc");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const app = buildApp();

    // Create access
    const createRes = await app.request(`/projects/${project.id}/access`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        identifier: "standard",
        displayName: "Standard Access",
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: createData } = await createRes.json() as { data: { id: string } };
    const accessId = createData.id;

    // PATCH with same identifier — must succeed
    const patchRes = await app.request(`/projects/${project.id}/access/${accessId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifier: "standard", displayName: "Standard Access Updated" }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = await patchRes.json() as { data: { displayName: string } };
    expect(data.displayName).toBe("Standard Access Updated");
  });
});
