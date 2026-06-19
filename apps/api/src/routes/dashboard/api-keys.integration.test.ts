// =============================================================
// /dashboard/projects/:id/api-keys — create + revoke
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
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
  const email = `apikey_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!apikey";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `apikey-${suffix}` },
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
  const id = `prj_apikey_${RUN_ID}_${suffix}`;
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

describe.sequential("dashboard api-keys — create", () => {
  it("ADMIN can create a key; secret hashes back and is Production", async () => {
    const { userId, cookie } = await createUserAndSession("create_ok");
    const projectId = await seedProject("create_ok");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "backend" }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { apiKey: { id: string; label: string; publicKey: string; environment: string }; secretKey: string };
    };
    expect(data.apiKey.label).toBe("backend");
    expect(data.apiKey.environment).toBe("PRODUCTION");
    expect(data.apiKey.publicKey.startsWith("rov_pub_")).toBe(true);
    expect(data.secretKey.startsWith(`rov_sec_${data.apiKey.id}_`)).toBe(true);

    const rows = await db
      .select({ hash: schema.apiKeys.keySecretHash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, data.apiKey.id));
    expect(rows[0]).toBeTruthy();
    expect(await bcrypt.compare(data.secretKey, rows[0]!.hash)).toBe(true);
  });

  it("rejects a blank label with 400", async () => {
    const { userId, cookie } = await createUserAndSession("create_blank");
    const projectId = await seedProject("create_blank");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("forbids a DEVELOPER (below ADMIN) with 403", async () => {
    const { userId, cookie } = await createUserAndSession("create_dev");
    const projectId = await seedProject("create_dev");
    await addMember(projectId, userId, "DEVELOPER");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});
