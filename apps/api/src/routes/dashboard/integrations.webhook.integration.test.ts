// =============================================================
// Webhook connection routes — create / rotate / reveal
// =============================================================
//
// Covers Task 8 of the integrations-foundation-webhook-v2 plan: the
// CUSTOM_WEBHOOK-specific create branching (server-generated secret,
// per-project endpoint cap), rotate-secret, and reveal-secret routes.
// Real Postgres (per-worker DB) — mirrors the auth/seeding pattern used
// by integrations.test.ts and api-keys.integration.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher } from "undici";
import { getDb, drizzle, projects } from "@rovenue/db";
import { decrypt } from "@rovenue/shared/crypto";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import {
  integrationsRoute,
  MAX_WEBHOOK_ENDPOINTS_PER_PROJECT,
  WEBHOOK_SECRET_GRACE_MS,
} from "./integrations";
import { WEBHOOK_SECRET_PREFIX } from "../../lib/svix-sign";
import { parseWebhookCredentials } from "../../services/integrations/providers/custom-webhook";

const RUN_ID = Date.now();
const db = getDb();
const TEST_ENC_KEY = process.env.ENCRYPTION_KEY!;

function buildApp() {
  const app = new Hono();
  app.route("/projects/:projectId/integrations", integrationsRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `webhookroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!webhookroute";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `webhookroute-${suffix}` },
  });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

const seededProjectIds: string[] = [];
async function seedProject(suffix: string) {
  const id = `prj_webhookroute_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
) {
  await db.insert(drizzle.schema.projectMembers).values({ projectId, userId, role });
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    // integration_connections cascade off the project FK; audit_logs
    // rows are set-null on delete rather than removed, so they simply
    // become orphaned — no explicit cleanup needed either way.
    await db.delete(projects).where(eq(projects.id, id));
  }
});

async function createWebhook(
  app: Hono,
  projectId: string,
  cookie: string,
  url = "https://example.com/hook",
  displayName = "My Webhook",
) {
  return app.request(`/projects/${projectId}/integrations`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "CUSTOM_WEBHOOK",
      displayName,
      credentials: { url },
    }),
  });
}

// =============================================================
// (a) create
// =============================================================

describe.sequential("POST /projects/:projectId/integrations — CUSTOM_WEBHOOK create", () => {
  it("returns a whsec_-prefixed secret and the row decrypts to { url, secrets }", async () => {
    const { userId, cookie } = await createUserAndSession("create_ok");
    const projectId = await seedProject("create_ok");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await createWebhook(app, projectId, cookie, "https://example.com/hook-ok");
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as {
      data: { connection: Record<string, unknown>; secret: string };
    };
    expect(data.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(data.connection).not.toHaveProperty("credentialsCipher");
    expect(data.connection["providerId"]).toBe("CUSTOM_WEBHOOK");

    const [row] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, data.connection["id"] as string));
    expect(row).toBeTruthy();

    const decrypted = JSON.parse(decrypt(row!.credentialsCipher, TEST_ENC_KEY)) as {
      url: string;
      secrets: string;
    };
    expect(decrypted.url).toBe("https://example.com/hook-ok");
    const { secrets } = parseWebhookCredentials(decrypted);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.key).toBe(data.secret);
  });

  it("rejects a client-supplied secrets field on create (strict credentials shape)", async () => {
    const { userId, cookie } = await createUserAndSession("create_strict");
    const projectId = await seedProject("create_strict");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/integrations`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "CUSTOM_WEBHOOK",
        displayName: "Sneaky",
        credentials: { url: "https://example.com/hook", secrets: "client-supplied" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("11th webhook connection on one project → 409 endpoint_limit_reached", async () => {
    const { userId, cookie } = await createUserAndSession("create_cap");
    const projectId = await seedProject("create_cap");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_PROJECT; i += 1) {
      const res = await createWebhook(
        app,
        projectId,
        cookie,
        `https://example.com/hook-${i}`,
        `Webhook ${i}`,
      );
      expect(res.status).toBe(201);
    }

    const overflow = await createWebhook(
      app,
      projectId,
      cookie,
      "https://example.com/hook-overflow",
      "Overflow",
    );
    expect(overflow.status).toBe(409);
    const body = (await overflow.json()) as { error: { code: string } };
    expect(body.error.code).toBe("endpoint_limit_reached");
  });

  it("second META_CAPI connection → 409 connection_exists (unique-violation mapped, not 500)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_dup/, method: "GET" })
      .reply(200, '{"id":"px_dup"}')
      .persist();

    const { userId, cookie } = await createUserAndSession("create_dup");
    const projectId = await seedProject("create_dup");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const body = JSON.stringify({
      providerId: "META_CAPI",
      displayName: "Meta Pixel",
      credentials: { access_token: "tok_test_dup", pixel_id: "px_dup" },
    });

    const first = await app.request(`/projects/${projectId}/integrations`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/projects/${projectId}/integrations`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    await agent.close();

    expect(second.status).toBe(409);
    const errBody = (await second.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("connection_exists");
  });
});

// =============================================================
// Real concurrency — the reviewer-flagged race
// =============================================================
//
// A `SELECT ... FOR UPDATE` precheck alone does not close this race: under
// READ COMMITTED it only blocks on rows that already exist, so with zero
// (or few) pre-existing rows there's nothing to lock, and a transaction
// blocked on an existing row never re-scans for a sibling's newly-inserted
// row. Two genuinely concurrent Postgres transactions (not mocked, not
// sequential awaits) is the only thing that actually exercises the
// `pg_advisory_xact_lock` fix — `Promise.all` against the real `app.request`
// handler opens two real connections from the shared pg pool (max: 10, see
// packages/db/src/drizzle/pool.ts) and lets Postgres itself decide who
// blocks on whom.
describe.sequential("POST /projects/:projectId/integrations — CUSTOM_WEBHOOK cap race", () => {
  it("two concurrent creates at the cap: exactly one 201, one 409, final count == cap", async () => {
    const { userId, cookie } = await createUserAndSession("create_race");
    const projectId = await seedProject("create_race");
    await addMember(projectId, userId, "ADMIN");

    // Seed MAX-1 existing webhook connections directly (bypassing the
    // route — a sequential seed loop wouldn't exercise the race we're
    // trying to prove).
    const seedNow = new Date();
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_PROJECT - 1; i += 1) {
      await db.insert(drizzle.schema.integrationConnections).values({
        id: `conn_race_${RUN_ID}_${i}`,
        projectId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: `Seed ${i}`,
        credentialsCipher: "v1:enc:seed",
        credentialsHint: "seed",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
        isEnabled: false,
        createdAt: seedNow,
        updatedAt: seedNow,
      });
    }

    const app = buildApp();
    // Fired together (no await between them) so both requests are in
    // flight before either's transaction reaches the advisory lock.
    const [resA, resB] = await Promise.all([
      createWebhook(app, projectId, cookie, "https://example.com/race-a", "Race A"),
      createWebhook(app, projectId, cookie, "https://example.com/race-b", "Race B"),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const loser = resA.status === 409 ? resA : resB;
    const loserBody = (await loser.json()) as { error: { code: string } };
    expect(loserBody.error.code).toBe("endpoint_limit_reached");

    const rows = await db
      .select({ id: drizzle.schema.integrationConnections.id })
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          eq(drizzle.schema.integrationConnections.providerId, "CUSTOM_WEBHOOK"),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );
    expect(rows).toHaveLength(MAX_WEBHOOK_ENDPOINTS_PER_PROJECT);
  });
});

// =============================================================
// (d) rotate
// =============================================================

describe.sequential("POST /projects/:projectId/integrations/:id/rotate-secret", () => {
  it("returns a new secret; old secret stays present until it ages past the grace window", async () => {
    const { userId, cookie } = await createUserAndSession("rotate_ok");
    const projectId = await seedProject("rotate_ok");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const created = await createWebhook(app, projectId, cookie, "https://example.com/rotate");
    const { data: createData } = (await created.json()) as {
      data: { connection: { id: string }; secret: string };
    };
    const connectionId = createData.connection.id;
    const originalSecret = createData.secret;

    const rotateRes = await app.request(
      `/projects/${projectId}/integrations/${connectionId}/rotate-secret`,
      { method: "POST", headers: { cookie } },
    );
    expect(rotateRes.status).toBe(200);
    const { data: rotateData } = (await rotateRes.json()) as { data: { secret: string } };
    expect(rotateData.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(rotateData.secret).not.toBe(originalSecret);

    const [row] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, connectionId));
    const decrypted = JSON.parse(decrypt(row!.credentialsCipher, TEST_ENC_KEY)) as {
      url: string;
      secrets: string;
    };
    const { secrets } = parseWebhookCredentials(decrypted);
    expect(secrets.map((s) => s.key)).toContain(originalSecret);
    expect(secrets.map((s) => s.key)).toContain(rotateData.secret);

    // Fake the original entry's createdAt beyond the grace window, then
    // rotate again — the original should be pruned, the newest kept.
    const staleAt = new Date(Date.now() - WEBHOOK_SECRET_GRACE_MS - 60_000).toISOString();
    const agedSecrets = secrets.map((s) =>
      s.key === originalSecret ? { ...s, createdAt: staleAt } : s,
    );
    const agedCreds = { url: decrypted.url, secrets: JSON.stringify(agedSecrets) };
    const { encrypt } = await import("@rovenue/shared/crypto");
    await db
      .update(drizzle.schema.integrationConnections)
      .set({ credentialsCipher: encrypt(JSON.stringify(agedCreds), TEST_ENC_KEY) })
      .where(eq(drizzle.schema.integrationConnections.id, connectionId));

    const rotateAgain = await app.request(
      `/projects/${projectId}/integrations/${connectionId}/rotate-secret`,
      { method: "POST", headers: { cookie } },
    );
    expect(rotateAgain.status).toBe(200);
    const { data: rotateAgainData } = (await rotateAgain.json()) as {
      data: { secret: string };
    };

    const [row2] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, connectionId));
    const decrypted2 = JSON.parse(decrypt(row2!.credentialsCipher, TEST_ENC_KEY)) as {
      url: string;
      secrets: string;
    };
    const { secrets: secrets2 } = parseWebhookCredentials(decrypted2);
    const keys2 = secrets2.map((s) => s.key);
    expect(keys2).not.toContain(originalSecret);
    expect(keys2).toContain(rotateAgainData.secret);
  });

  it("audits integration.webhook.secret.rotated", async () => {
    const { userId, cookie } = await createUserAndSession("rotate_audit");
    const projectId = await seedProject("rotate_audit");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const created = await createWebhook(app, projectId, cookie, "https://example.com/rotate-audit");
    const { data } = (await created.json()) as { data: { connection: { id: string } } };

    const res = await app.request(
      `/projects/${projectId}/integrations/${data.connection.id}/rotate-secret`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);

    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, data.connection.id));
    expect(
      auditRows.some((r) => r.action === "integration.webhook.secret.rotated"),
    ).toBe(true);
  });
});

// =============================================================
// (e) reveal
// =============================================================

describe.sequential("GET /projects/:projectId/integrations/:id/secret", () => {
  it("requires ADMIN — CUSTOMER_SUPPORT gets 403", async () => {
    const owner = await createUserAndSession("reveal_owner");
    const support = await createUserAndSession("reveal_support");
    const projectId = await seedProject("reveal_role");
    await addMember(projectId, owner.userId, "ADMIN");
    await addMember(projectId, support.userId, "CUSTOMER_SUPPORT");

    const app = buildApp();
    const created = await createWebhook(app, projectId, owner.cookie, "https://example.com/reveal");
    const { data } = (await created.json()) as { data: { connection: { id: string } } };

    const res = await app.request(
      `/projects/${projectId}/integrations/${data.connection.id}/secret`,
      { headers: { cookie: support.cookie } },
    );
    expect(res.status).toBe(403);
  });

  it("ADMIN reveal returns the newest secret and writes an audit row", async () => {
    const { userId, cookie } = await createUserAndSession("reveal_ok");
    const projectId = await seedProject("reveal_ok");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const created = await createWebhook(app, projectId, cookie, "https://example.com/reveal-ok");
    const { data: createData } = (await created.json()) as {
      data: { connection: { id: string }; secret: string };
    };

    const res = await app.request(
      `/projects/${projectId}/integrations/${createData.connection.id}/secret`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { secret: string } };
    expect(data.secret).toBe(createData.secret);

    const auditRows = await db
      .select()
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, createData.connection.id));
    expect(
      auditRows.some((r) => r.action === "integration.webhook.secret.revealed"),
    ).toBe(true);
  });
});
