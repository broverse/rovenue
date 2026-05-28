// =============================================================
// Integrations route — unit + integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { integrationsRoute } from "./integrations";

// =============================================================
// M5.1 — router scaffold
// =============================================================

describe("integrationsRoute scaffold", () => {
  it("exports a Hono app with a fetch method", () => {
    expect(typeof integrationsRoute.fetch).toBe("function");
  });
});

// =============================================================
// M5.2 — GET /projects/:projectId/integrations
// =============================================================

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/integrations",
    integrationsRoute,
  );
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `integrationsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!integrations";
  const name = `Integrations Route User ${suffix}`;

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
  const id = `prj_integ_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Integrations Test Project ${RUN_ID}${suffix}`,
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

async function seedConnection({
  projectId,
  id,
  providerId = "META_CAPI" as const,
  credentialsCipher = "v1:enc:redacted",
  credentialsHint = "Pixel 1234****",
  deletedAt = null,
}: {
  projectId: string;
  id: string;
  providerId?: string;
  credentialsCipher?: string;
  credentialsHint?: string;
  deletedAt?: Date | null;
}) {
  await getDb()
    .insert(drizzle.schema.integrationConnections)
    .values({
      id,
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providerId: providerId as any,
      displayName: `Test Connection ${id}`,
      credentialsCipher,
      credentialsHint,
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
      isEnabled: true,
      deletedAt,
    });
}

const seededProjectIds: string[] = [];
const seededConnectionIds: string[] = [];

function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

function trackConnection(id: string) {
  seededConnectionIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededConnectionIds) {
    await db
      .delete(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, id));
  }
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("GET /projects/:projectId/integrations", () => {
  it("returns connections without credentialsCipher, with credentialsHint", async () => {
    const owner = await createUserAndSession("list_owner");
    const project = await seedProject("_list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const connId = trackConnection(`conn_${RUN_ID}_list`);
    await seedConnection({
      projectId: project.id,
      id: connId,
      credentialsCipher: "v1:enc:super_secret_access_token",
      credentialsHint: "Pixel 9876****",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations`,
      { headers: { cookie: owner.cookie } },
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { connections: Record<string, unknown>[] };
    };
    expect(body.data.connections).toHaveLength(1);

    const conn = body.data.connections[0]!;
    // credentialsCipher must NOT appear in the response
    expect(conn).not.toHaveProperty("credentialsCipher");
    // credentialsHint must appear
    expect(conn.credentialsHint).toBe("Pixel 9876****");
    // raw JSON must not leak the cipher value
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("super_secret_access_token");
  });

  it("excludes soft-deleted connections from the list", async () => {
    const owner = await createUserAndSession("list_deleted");
    const project = await seedProject("_list_deleted");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const liveId = trackConnection(`conn_${RUN_ID}_live`);
    const deadId = trackConnection(`conn_${RUN_ID}_dead`);

    await seedConnection({ projectId: project.id, id: liveId, providerId: "META_CAPI" });
    await seedConnection({
      projectId: project.id,
      id: deadId,
      providerId: "TIKTOK_EVENTS",
      deletedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations`,
      { headers: { cookie: owner.cookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { connections: { id: string }[] };
    };
    const ids = body.data.connections.map((c) => c.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(deadId);
  });

  it("returns 403 for a non-member", async () => {
    const stranger = await createUserAndSession("stranger");
    const project = await seedProject("_stranger");
    trackProject(project.id);
    // stranger is NOT added as a member

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations`,
      { headers: { cookie: stranger.cookie } },
    );

    expect(res.status).toBe(403);
  });

  it("returns 401 for unauthenticated requests", async () => {
    const app = buildApp();
    const res = await app.request(`/projects/some_project/integrations`);
    expect(res.status).toBe(401);
  });
});
