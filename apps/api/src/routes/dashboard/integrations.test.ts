// =============================================================
// Integrations route — unit + integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher } from "undici";
import { getDb, drizzle, projects } from "@rovenue/db";
import { encrypt } from "@rovenue/shared/crypto";
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
// Shared helpers
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

// Encryption key for tests — read from env so it matches setup.ts ENCRYPTION_KEY
const TEST_ENC_KEY = process.env.ENCRYPTION_KEY!;

async function seedConnection({
  projectId,
  id,
  providerId = "META_CAPI" as const,
  credentialsCipher = "v1:enc:redacted",
  credentialsHint = "Pixel 1234****",
  deletedAt = null,
  isEnabled = true,
  testEventCode = null,
}: {
  projectId: string;
  id: string;
  providerId?: string;
  credentialsCipher?: string;
  credentialsHint?: string;
  deletedAt?: Date | null;
  isEnabled?: boolean;
  testEventCode?: string | null;
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
      isEnabled,
      deletedAt,
      testEventCode,
    });
}

async function seedDelivery({
  id,
  connectionId,
  projectId,
  status,
  outboxEventId,
}: {
  id: string;
  connectionId: string;
  projectId: string;
  status: "succeeded" | "failed" | "pending" | "skipped" | "dead_letter";
  outboxEventId: string;
}) {
  await getDb()
    .insert(drizzle.schema.integrationDeliveries)
    .values({
      id,
      connectionId,
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providerId: "META_CAPI" as any,
      outboxEventId,
      eventKey: "revenue.INITIAL",
      status,
      attempt: 0,
    });
}

const seededProjectIds: string[] = [];
const seededConnectionIds: string[] = [];
const seededDeliveryIds: string[] = [];

function trackProject(id: string) { seededProjectIds.push(id); return id; }
function trackConnection(id: string) { seededConnectionIds.push(id); return id; }
function trackDelivery(id: string) { seededDeliveryIds.push(id); return id; }

afterAll(async () => {
  const db = getDb();
  // deliveries first (FK → connections)
  for (const id of seededDeliveryIds) {
    await db
      .delete(drizzle.schema.integrationDeliveries)
      .where(eq(drizzle.schema.integrationDeliveries.id, id));
  }
  for (const id of seededConnectionIds) {
    await db
      .delete(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, id));
  }
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// =============================================================
// M5.2 — GET /projects/:projectId/integrations
// =============================================================

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

// =============================================================
// M5.3 — POST /projects/:projectId/integrations
// =============================================================

describe("POST /projects/:projectId/integrations", () => {
  it("creates a connection on valid credentials → 201 + no credentialsCipher", async () => {
    // Mock Meta CAPI pixel endpoint to return 200
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_good/, method: "GET" })
      .reply(200, '{"id":"px_good"}');

    const owner = await createUserAndSession("post_success");
    const project = await seedProject("_post_success");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "META_CAPI",
          displayName: "My Meta Connection",
          credentials: { access_token: "tok_test_1234abcd", pixel_id: "px_good" },
        }),
      },
    );

    await agent.close();

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { connection: Record<string, unknown> } };
    const conn = body.data.connection;

    expect(conn).toBeDefined();
    expect(conn["displayName"]).toBe("My Meta Connection");
    expect(conn).not.toHaveProperty("credentialsCipher");
    expect(conn["credentialsHint"]).toMatch(/^Pixel /);
    expect(conn["isEnabled"]).toBe(false);

    // Track for cleanup
    trackConnection(conn["id"] as string);
  });

  it("returns 400 + no DB row on invalid credentials", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_bad/, method: "GET" })
      .reply(400, '{"error":"bad"}');

    const owner = await createUserAndSession("post_bad_creds");
    const project = await seedProject("_post_bad");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "ADMIN" });

    const db = getDb();
    const countBefore = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.projectId, project.id));

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "META_CAPI",
          displayName: "Bad Connection",
          credentials: { access_token: "bad_tok", pixel_id: "px_bad" },
        }),
      },
    );

    await agent.close();

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_credentials");

    // No new row created
    const countAfter = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.projectId, project.id));
    expect(countAfter.length).toBe(countBefore.length);
  });
});

// =============================================================
// M5.4 — PATCH /projects/:projectId/integrations/:id
// =============================================================

describe("PATCH /projects/:projectId/integrations/:id", () => {
  it("isEnabled false→true writes integration.connection.updated audit", async () => {
    const owner = await createUserAndSession("patch_enable");
    const project = await seedProject("_patch_enable");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "ADMIN" });

    const connId = trackConnection(`conn_${RUN_ID}_patch_enable`);
    const creds = { access_token: "tok_abcdefgh", pixel_id: "px123" };
    const cipher = encrypt(JSON.stringify(creds), TEST_ENC_KEY);
    await seedConnection({
      projectId: project.id,
      id: connId,
      credentialsCipher: cipher,
      credentialsHint: "Pixel abcd…efgh",
      isEnabled: false,
    });

    const app = buildApp();
    // We intentionally DON'T intercept undici here — the PATCH won't
    // re-validate if credentials aren't in the body.
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}`,
      {
        method: "PATCH",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ isEnabled: true }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connection: { isEnabled: boolean } } };
    expect(body.data.connection.isEnabled).toBe(true);

    // Verify audit row written
    const db = getDb();
    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, connId));
    const enableAudit = auditRows.find(
      (r) => r.action === "integration.connection.updated",
    );
    expect(enableAudit).toBeDefined();
  });

  it("credentials rotation writes integration.credentials.rotated audit", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px123/, method: "GET" })
      .reply(200, '{"id":"px123"}');

    const owner = await createUserAndSession("patch_rotate");
    const project = await seedProject("_patch_rotate");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "ADMIN" });

    const connId = trackConnection(`conn_${RUN_ID}_patch_rotate`);
    const oldCreds = { access_token: "old_token_1234", pixel_id: "px123" };
    const cipher = encrypt(JSON.stringify(oldCreds), TEST_ENC_KEY);
    await seedConnection({
      projectId: project.id,
      id: connId,
      credentialsCipher: cipher,
      credentialsHint: "Pixel old_…1234",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}`,
      {
        method: "PATCH",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          credentials: { access_token: "new_token_5678" },
        }),
      },
    );

    await agent.close();

    expect(res.status).toBe(200);

    // Verify rotation audit row
    const db = getDb();
    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, connId));
    const rotateAudit = auditRows.find(
      (r) => r.action === "integration.credentials.rotated",
    );
    expect(rotateAudit).toBeDefined();
    // Audit must NOT contain old_token_5678 raw
    const auditJson = JSON.stringify(rotateAudit);
    expect(auditJson).not.toContain("old_token");
    expect(auditJson).not.toContain("new_token");
  });
});

// =============================================================
// M5.5 — DELETE /projects/:projectId/integrations/:id
// =============================================================

describe("DELETE /projects/:projectId/integrations/:id", () => {
  it("soft-deletes: 204, row has deletedAt set, audit written", async () => {
    const owner = await createUserAndSession("delete_conn");
    const project = await seedProject("_delete_conn");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "ADMIN" });

    const connId = `conn_${RUN_ID}_delete`;
    // Don't track — it will be soft-deleted, not hard-deleted
    await seedConnection({ projectId: project.id, id: connId });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );

    expect(res.status).toBe(204);

    // Verify deletedAt is set
    const db = getDb();
    const [row] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, connId));
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.isEnabled).toBe(false);

    // Verify audit written
    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, connId));
    const deleteAudit = auditRows.find(
      (r) => r.action === "integration.connection.deleted",
    );
    expect(deleteAudit).toBeDefined();

    // Cleanup: hard delete since we didn't track it
    await db
      .delete(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, connId));
  });
});

// =============================================================
// M5.6 — POST /projects/:projectId/integrations/validate
// =============================================================

describe("POST /projects/:projectId/integrations/validate", () => {
  it("returns {ok: true} on valid credentials — no DB row written", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_valid/, method: "GET" })
      .reply(200, '{"id":"px_valid"}');

    const owner = await createUserAndSession("validate_ok");
    const project = await seedProject("_validate_ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "DEVELOPER" });

    const db = getDb();
    const countBefore = (await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.projectId, project.id))
    ).length;

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/validate`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "META_CAPI",
          credentials: { access_token: "tok_valid", pixel_id: "px_valid" },
        }),
      },
    );

    await agent.close();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);

    // No DB row created
    const countAfter = (await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.projectId, project.id))
    ).length;
    expect(countAfter).toBe(countBefore);
  });

  it("rate-limits credential validation per user (over budget → 429)", async () => {
    // P2: /validate makes an outbound third-party credential check on every
    // call. Without a rate limit an authenticated developer can drive
    // unbounded egress/cost. Enforce a per-user endpoint budget.
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_rl/, method: "GET" })
      .reply(200, '{"id":"px_rl"}')
      .persist();

    const owner = await createUserAndSession("validate_rl");
    const project = await seedProject("_validate_rl");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "DEVELOPER" });

    const app = buildApp();
    const call = () =>
      app.request(`/projects/${project.id}/integrations/validate`, {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "META_CAPI",
          credentials: { access_token: "tok_rl", pixel_id: "px_rl" },
        }),
      });

    // The per-user budget for this endpoint.
    const MAX = 20;
    let lastStatus = 0;
    for (let i = 0; i < MAX; i++) {
      lastStatus = (await call()).status;
    }
    // Still within budget — not rate-limited.
    expect(lastStatus).toBe(200);
    // One over the budget within the same window → 429.
    const over = await call();
    expect(over.status).toBe(429);

    await agent.close();
  });

  it("returns {ok: false, reason} with 200 status on invalid credentials", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_invalid/, method: "GET" })
      .reply(400, '{"error":"Invalid OAuth access token"}');

    const owner = await createUserAndSession("validate_fail");
    const project = await seedProject("_validate_fail");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "DEVELOPER" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/validate`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "META_CAPI",
          credentials: { access_token: "bad_tok", pixel_id: "px_invalid" },
        }),
      },
    );

    await agent.close();

    // IMPORTANT: failure must be 200 (not 400) — per plan §M5.6
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean; reason?: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.reason).toBeTruthy();
  });
});

// =============================================================
// M5.7 — POST /projects/:projectId/integrations/:id/test-event
// =============================================================

describe("POST /projects/:projectId/integrations/:id/test-event", () => {
  it("returns 400 when testEventCode is not configured", async () => {
    const owner = await createUserAndSession("test_event_no_code");
    const project = await seedProject("_te_no_code");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "DEVELOPER" });

    const connId = trackConnection(`conn_${RUN_ID}_te_no_code`);
    const creds = { access_token: "tok_test", pixel_id: "px123" };
    await seedConnection({
      projectId: project.id,
      id: connId,
      credentialsCipher: encrypt(JSON.stringify(creds), TEST_ENC_KEY),
      testEventCode: null,
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}/test-event`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("delivers synthetic Subscribe and writes integration.test_event.sent audit", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    // Meta CAPI deliver endpoint
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_te/, method: "POST" })
      .reply(200, '{"events_received":1}');

    const owner = await createUserAndSession("test_event_ok");
    const project = await seedProject("_te_ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "DEVELOPER" });

    const connId = trackConnection(`conn_${RUN_ID}_te_ok`);
    const creds = { access_token: "tok_1234abcd", pixel_id: "px_te" };
    await seedConnection({
      projectId: project.id,
      id: connId,
      credentialsCipher: encrypt(JSON.stringify(creds), TEST_ENC_KEY),
      testEventCode: "TEST123",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}/test-event`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    await agent.close();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ok: boolean; httpStatus: number | null; responseBody: string | null };
    };
    // We got a response from the provider (even if ok=false due to mock, httpStatus is set)
    // The key assertion is that httpStatus matches the mock's 200 reply
    expect(body.data.httpStatus).toBe(200);

    // Verify audit
    const db = getDb();
    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, connId));
    const testAudit = auditRows.find(
      (r) => r.action === "integration.test_event.sent",
    );
    expect(testAudit).toBeDefined();
    // After metadata should reference testEventCode
    expect(JSON.stringify(testAudit?.after)).toContain("TEST123");
  });
});

// =============================================================
// M5.8 — GET /projects/:projectId/integrations/:id/deliveries
// =============================================================

describe("GET /projects/:projectId/integrations/:id/deliveries", () => {
  it("returns deliveries filtered by status with nextCursor:null when no more pages", async () => {
    const owner = await createUserAndSession("deliveries_list");
    const project = await seedProject("_deliveries_list");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "CUSTOMER_SUPPORT" });

    const connId = trackConnection(`conn_${RUN_ID}_dlv`);
    await seedConnection({ projectId: project.id, id: connId });

    // Seed 5 deliveries: 3 succeeded, 2 failed
    for (let i = 0; i < 3; i++) {
      const dlvId = trackDelivery(`dlv_${RUN_ID}_ok_${i}`);
      await seedDelivery({
        id: dlvId,
        connectionId: connId,
        projectId: project.id,
        status: "succeeded",
        outboxEventId: `outbox_ok_${RUN_ID}_${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      const dlvId = trackDelivery(`dlv_${RUN_ID}_fail_${i}`);
      await seedDelivery({
        id: dlvId,
        connectionId: connId,
        projectId: project.id,
        status: "failed",
        outboxEventId: `outbox_fail_${RUN_ID}_${i}`,
      });
    }

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/integrations/${connId}/deliveries?status=failed&limit=10`,
      { headers: { cookie: owner.cookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deliveries: { status: string }[]; nextCursor: string | null };
    };
    expect(body.data.deliveries).toHaveLength(2);
    expect(body.data.deliveries.every((d) => d.status === "failed")).toBe(true);
    expect(body.data.nextCursor).toBeNull();
  });
});
