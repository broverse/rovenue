// =============================================================
// M8.1 — Boot-time smoke test: full integrations pipeline
// =============================================================
//
// Exercises the end-to-end path that matters most in production:
//   1. Authenticated user creates a connection (POST /integrations).
//   2. User sends a test-event on that connection (POST /test-event).
//   3. The provider HTTP endpoint (Meta CAPI) is hit exactly once.
//   4. Both routes return the expected shapes.
//
// The BullMQ deliver worker is NOT booted here — the test-event path
// is synchronous (see M5.7) and requires no worker. This intentionally
// avoids a Redis/Redpanda dependency and keeps the suite fast while
// still exercising the real Hono router + DB + encrypted credentials
// + provider HTTP adapter in-process.
//
// Run:
//   DATABASE_URL='postgresql://rovenue:rovenue@localhost:5433/rovenue' \
//   REDIS_URL='redis://localhost:6380' \
//   pnpm --filter @rovenue/api test -- src/integrations.boot.integration.test.ts
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher } from "undici";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "./lib/auth";
import { integrationsRoute } from "./routes/dashboard/integrations";

// =============================================================
// Helpers — mirror the pattern from integrations.test.ts (M5)
// =============================================================

const RUN_ID = `boot_${Date.now()}`;

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/integrations",
    integrationsRoute,
  );
}

async function createUserAndSession(suffix: string) {
  const email = `boot_smoke_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!bootsmoke";
  const name = `Boot Smoke User ${suffix}`;

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
  const id = `prj_boot_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Boot Smoke Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedMember({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "ADMIN",
  });
}

// Track seeded IDs for cleanup
const seededProjectIds: string[] = [];
const seededConnectionIds: string[] = [];

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

// =============================================================
// Boot smoke: create connection → send test-event
// =============================================================

describe("Integrations pipeline boot smoke", () => {
  it(
    "creates a Meta CAPI connection then successfully sends a test-event to the provider",
    async () => {
      // --- 1. Stub Meta CAPI: validate pixel (GET) + test-event delivery (POST) ---
      const agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);

      const fbPool = agent.get("https://graph.facebook.com");

      // Pixel validation endpoint (called during POST /integrations)
      fbPool
        .intercept({ path: /\/v18\.0\/px_boot/, method: "GET" })
        .reply(200, '{"id":"px_boot"}');

      // CAPI events endpoint (called during POST /:id/test-event)
      fbPool
        .intercept({ path: /\/v18\.0\/px_boot\/events/, method: "POST" })
        .reply(200, '{"events_received":1}');

      // --- 2. Seed user + project ---
      const owner = await createUserAndSession("smoke_owner");
      const project = await seedProject("_smoke");
      seededProjectIds.push(project.id);
      await seedMember({ projectId: project.id, userId: owner.userId });

      const app = buildApp();

      // --- 3. POST /integrations — create the connection ---
      const createRes = await app.request(
        `/projects/${project.id}/integrations`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "META_CAPI",
            displayName: "Boot Smoke Meta Connection",
            credentials: {
              access_token: "tok_boot_1234abcd",
              pixel_id: "px_boot",
            },
          }),
        },
      );

      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as {
        data: {
          connection: {
            id: string;
            isEnabled: boolean;
            credentialsHint: string;
          };
        };
      };
      const conn = createBody.data.connection;
      expect(conn).toBeDefined();
      expect(conn.id).toBeTruthy();
      expect(conn).not.toHaveProperty("credentialsCipher");
      expect(conn.credentialsHint).toMatch(/^Pixel /);
      // Newly created connections start disabled
      expect(conn.isEnabled).toBe(false);

      seededConnectionIds.push(conn.id);

      // --- 4. PATCH to add testEventCode ---
      const patchRes = await app.request(
        `/projects/${project.id}/integrations/${conn.id}`,
        {
          method: "PATCH",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ testEventCode: "BOOT_SMOKE_001" }),
        },
      );
      expect(patchRes.status).toBe(200);

      // --- 5. POST /:id/test-event — provider HTTP must be hit ---
      const testEventRes = await app.request(
        `/projects/${project.id}/integrations/${conn.id}/test-event`,
        {
          method: "POST",
          headers: {
            cookie: owner.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      await agent.close();

      expect(testEventRes.status).toBe(200);
      const teBody = (await testEventRes.json()) as {
        data: { ok: boolean; httpStatus: number | null; responseBody: string | null };
      };

      // Provider was reached — httpStatus reflects the mock's 200 reply
      expect(teBody.data.httpStatus).toBe(200);

      // Verify audit trail for test-event
      const db = getDb();
      const auditRows = await db
        .select()
        .from(drizzle.schema.auditLogs)
        .where(eq(drizzle.schema.auditLogs.resourceId, conn.id));
      const testAudit = auditRows.find(
        (r) => r.action === "integration.test_event.sent",
      );
      expect(testAudit).toBeDefined();
      expect(JSON.stringify(testAudit?.after)).toContain("BOOT_SMOKE_001");
    },
    30_000, // 30 s budget for DB + HTTP stubs
  );
});
