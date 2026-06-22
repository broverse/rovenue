// =============================================================
// Rovi BYOK credentials guard — integration test (Task 6)
//
// Verifies that PUT /copilot/credentials and POST /copilot/credentials/test
// are blocked with HTTP 403 { error: { code: "byok_not_allowed" } } when
// HOST_MODE=cloud, and succeed normally when HOST_MODE=self.
//
// Infrastructure notes:
//   - Mirrors the harness from copilot-credentials.integration.test.ts:
//     Better Auth email+password flow, real Postgres at port 5433, unique
//     RUN_ID per run, OWNER session cookie for authenticated requests.
//   - HOST_MODE is mutated per-test on the live `env` object and restored
//     in afterEach — isByokAllowed() reads env live so no restart needed.
// =============================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { env } from "../../../lib/env";
import { copilotCredentialsRoute } from "./credentials";

// ---------------------------------------------------------------------------
// Unique run key so parallel re-runs never collide
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Minimal Hono test app — mirrors how dashboardRoute mounts the route
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/copilot/credentials",
    copilotCredentialsRoute,
  );
}

// ---------------------------------------------------------------------------
// State seeded in beforeAll
// ---------------------------------------------------------------------------

let projectId: string;
let ownerUserId: string;
let ownerCookie: string;

// ---------------------------------------------------------------------------
// Preserve original HOST_MODE across tests
// ---------------------------------------------------------------------------

const origHostMode = env.HOST_MODE;
afterEach(() => {
  env.HOST_MODE = origHostMode;
});

// ---------------------------------------------------------------------------
// beforeAll: sign up owner, seed project + OWNER membership
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = getDb();

  // ---- Owner user ----
  const ownerEmail = `rovi_byok_guard_owner_${RUN_ID}@rovenue.test`;
  const ownerPassword = "Test1234!byokowner";
  const ownerName = `Rovi BYOK Guard Owner ${RUN_ID}`;

  const ownerSignUp = await auth.api.signUpEmail({
    body: { email: ownerEmail, password: ownerPassword, name: ownerName },
  });
  if (!ownerSignUp?.user) {
    throw new Error("owner signUpEmail failed — is Postgres reachable at port 5433?");
  }
  ownerUserId = ownerSignUp.user.id;

  const ownerSignIn = await auth.api.signInEmail({
    body: { email: ownerEmail, password: ownerPassword },
    asResponse: true,
  });
  const ownerSetCookie = ownerSignIn.headers.get("set-cookie");
  if (!ownerSetCookie) {
    throw new Error("owner signInEmail did not return set-cookie");
  }
  ownerCookie = ownerSetCookie.split(";")[0] ?? "";

  // ---- Seed project ----
  const projId = `prj_byok_${RUN_ID}`;
  await db.insert(projects).values({
    id: projId,
    name: `Rovi BYOK Guard Test ${RUN_ID}`,
    settings: {},
  });
  projectId = projId;

  // ---- Seed OWNER membership ----
  await db.insert(drizzle.schema.projectMembers).values([
    { projectId, userId: ownerUserId, role: "OWNER" },
  ]);
});

// ---------------------------------------------------------------------------
// afterAll: clean up all seeded rows
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  if (projectId) {
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  const { user: userTable } = drizzle.schema;
  if (ownerUserId) {
    await db.delete(userTable).where(eq(userTable.id, ownerUserId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BYOK credentials guard", () => {
  it("PUT credentials is rejected in cloud mode → 403 byok_not_allowed", async () => {
    env.HOST_MODE = "cloud";
    const app = buildApp();

    const res = await app.request(
      `/projects/${projectId}/copilot/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({
          provider: "openai",
          apiKey: "sk-x",
          defaultModel: "gpt-4o-mini",
        }),
      },
    );

    expect(
      res.status,
      `PUT should return 403 in cloud mode, got ${res.status}`,
    ).toBe(403);
    const body = await res.json();
    expect(
      body.error.code,
      `body.error.code should be "byok_not_allowed", got "${body.error?.code}"`,
    ).toBe("byok_not_allowed");
  });

  it("PUT credentials succeeds in self-host mode → 200", async () => {
    env.HOST_MODE = "self";
    const app = buildApp();

    const res = await app.request(
      `/projects/${projectId}/copilot/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({
          provider: "openai",
          apiKey: "sk-test-self-host-key",
          defaultModel: "gpt-4o-mini",
        }),
      },
    );

    expect(
      res.status,
      `PUT should return 200 in self mode, got ${res.status}`,
    ).toBe(200);
  });

  it("POST /test credentials is rejected in cloud mode → 403 byok_not_allowed", async () => {
    env.HOST_MODE = "cloud";
    const app = buildApp();

    const res = await app.request(
      `/projects/${projectId}/copilot/credentials/test`,
      {
        method: "POST",
        headers: { cookie: ownerCookie },
      },
    );

    expect(
      res.status,
      `POST /test should return 403 in cloud mode, got ${res.status}`,
    ).toBe(403);
    const body = await res.json();
    expect(
      body.error.code,
      `body.error.code should be "byok_not_allowed", got "${body.error?.code}"`,
    ).toBe("byok_not_allowed");
  });
});
