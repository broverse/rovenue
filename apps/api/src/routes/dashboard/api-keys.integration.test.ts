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

describe.sequential("dashboard api-keys — revoke", () => {
  async function createKey(app: Hono, projectId: string, cookie: string, label: string) {
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const { data } = (await res.json()) as { data: { apiKey: { id: string } } };
    return data.apiKey.id;
  }

  it("ADMIN revokes a key; it leaves no active row and 404s on re-revoke", async () => {
    const { userId, cookie } = await createUserAndSession("revoke_ok");
    const projectId = await seedProject("revoke_ok");
    await addMember(projectId, userId, "ADMIN");
    const app = buildApp();
    const keyId = await createKey(app, projectId, cookie, "to-revoke");

    const res = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const active = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, keyId), isNull(schema.apiKeys.revokedAt)));
    expect(active).toHaveLength(0);

    const again = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(again.status).toBe(404);
  });

  it("cannot revoke a key belonging to another project (404)", async () => {
    const { userId, cookie } = await createUserAndSession("revoke_foreign");
    const projectA = await seedProject("revoke_foreign_a");
    const projectB = await seedProject("revoke_foreign_b");
    await addMember(projectA, userId, "ADMIN");
    await addMember(projectB, userId, "ADMIN");
    const app = buildApp();
    const keyInA = await createKey(app, projectA, cookie, "lives-in-a");

    const res = await app.request(`/projects/${projectB}/api-keys/${keyInA}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("forbids a DEVELOPER from revoking (403)", async () => {
    const owner = await createUserAndSession("revoke_owner");
    const dev = await createUserAndSession("revoke_dev");
    const projectId = await seedProject("revoke_role");
    await addMember(projectId, owner.userId, "ADMIN");
    await addMember(projectId, dev.userId, "DEVELOPER");
    const app = buildApp();
    const keyId = await createKey(app, projectId, owner.cookie, "guarded");

    const res = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie: dev.cookie },
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================
// PATCH /:id/api-keys/:keyId/allowed-origins
// =============================================================
//
// The allow-list decides whose JavaScript may use a public key inside a
// visitor's browser, so the API validates it with the same parser the form
// uses. A rule enforced only in the form is a suggestion: these tests call
// the API directly, which is what a script would do.

describe.sequential("dashboard api-keys — allowed origins", () => {
  async function setup(suffix: string) {
    const { userId, cookie } = await createUserAndSession(suffix);
    const projectId = await seedProject(suffix);
    await addMember(projectId, userId, "ADMIN");
    const app = buildApp();
    const created = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "web" }),
    });
    const { data } = (await created.json()) as {
      data: { apiKey: { id: string } };
    };
    return { app, cookie, projectId, keyId: data.apiKey.id };
  }

  function patch(
    app: Hono,
    projectId: string,
    keyId: string,
    cookie: string,
    allowedOrigins: string[],
  ) {
    return app.request(
      `/projects/${projectId}/api-keys/${keyId}/allowed-origins`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ allowedOrigins }),
      },
    );
  }

  it("stores a normalised list", async () => {
    const { app, cookie, projectId, keyId } = await setup("origins_ok");
    const res = await patch(app, projectId, keyId, cookie, [
      "https://app.example.com/",
      "http://localhost:3000",
    ]);
    expect(res.status).toBe(200);

    const rows = await db
      .select({ origins: schema.apiKeys.allowedOrigins })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId));
    // The trailing slash is gone: the stored value must be in the shape a
    // browser's Origin header arrives in, or the exact match never fires.
    expect(rows[0]?.origins).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it.each([
    ["https://*.example.com", "wildcard"],
    ["https://app.example.com/admin", "path"],
    ["app.example.com", "no scheme"],
    ["javascript:alert(1)", "javascript scheme"],
  ])("rejects %s (%s) at the API, not just in the form", async (origin) => {
    const { app, cookie, projectId, keyId } = await setup(
      `origins_bad_${origin.replace(/\W/g, "")}`.slice(0, 40),
    );
    const res = await patch(app, projectId, keyId, cookie, [origin]);
    expect(res.status).toBe(400);

    const rows = await db
      .select({ origins: schema.apiKeys.allowedOrigins })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId));
    expect(rows[0]?.origins).toEqual([]);
  });

  it("clears the list, which disables browser use", async () => {
    const { app, cookie, projectId, keyId } = await setup("origins_clear");
    await patch(app, projectId, keyId, cookie, ["https://app.example.com"]);
    const res = await patch(app, projectId, keyId, cookie, []);
    expect(res.status).toBe(200);

    const rows = await db
      .select({ origins: schema.apiKeys.allowedOrigins })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId));
    expect(rows[0]?.origins).toEqual([]);
  });

  it("404s for a key belonging to another project", async () => {
    const { app, cookie, projectId } = await setup("origins_foreign");
    const other = await setup("origins_foreign_other");
    const res = await patch(app, projectId, other.keyId, cookie, [
      "https://app.example.com",
    ]);
    expect(res.status).toBe(404);
  });

  it("refuses a member below ADMIN", async () => {
    const { cookie: adminCookie, projectId, keyId } = await setup("origins_role");
    const viewer = await createUserAndSession("origins_role_viewer");
    await addMember(projectId, viewer.userId, "DEVELOPER");
    const app = buildApp();
    const res = await patch(app, projectId, keyId, viewer.cookie, [
      "https://app.example.com",
    ]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(adminCookie).toBeTruthy();
  });
});
