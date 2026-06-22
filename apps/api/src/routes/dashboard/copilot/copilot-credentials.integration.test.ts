// =============================================================
// Rovi copilot credentials route — integration test
//
// Infrastructure notes:
//   - Uses Better Auth's email+password flow (enabled in NODE_ENV=test)
//     to mint real session cookies so requireDashboardAuth + assertProjectAccess
//     are exercised without mocks.
//   - Tests run against the dev Postgres configured in apps/api/tests/setup.ts
//     (docker-compose host port 5433).
//   - Each test run uses a unique RUN_ID to avoid collisions.
//
// Scenarios:
//   1. PUT requires OWNER role — a CUSTOMER_SUPPORT user receives 403.
//   2. PUT + GET round-trip — OWNER stores a secret API key; subsequent GET
//      reports hasKey: true but the plaintext key never appears in the JSON.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// HOST_MODE: BYOK credential CRUD is self-host-only; run the whole suite as
// HOST_MODE=self so PUT/GET/test succeed.  Restore original in afterAll.
// ---------------------------------------------------------------------------

const origHostMode = env.HOST_MODE;

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
let csUserId: string;
let ownerCookie: string;
let csCookie: string;

// ---------------------------------------------------------------------------
// beforeAll: sign up both users, seed project + memberships
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = getDb();

  // ---- Owner user ----
  const ownerEmail = `rovi_cred_owner_${RUN_ID}@rovenue.test`;
  const ownerPassword = "Test1234!credowner";
  const ownerName = `Rovi Cred Owner ${RUN_ID}`;

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

  // ---- CS user ----
  const csEmail = `rovi_cred_cs_${RUN_ID}@rovenue.test`;
  const csPassword = "Test1234!credcs";
  const csName = `Rovi Cred CS ${RUN_ID}`;

  const csSignUp = await auth.api.signUpEmail({
    body: { email: csEmail, password: csPassword, name: csName },
  });
  if (!csSignUp?.user) {
    throw new Error("CS signUpEmail failed — is Postgres reachable at port 5433?");
  }
  csUserId = csSignUp.user.id;

  const csSignIn = await auth.api.signInEmail({
    body: { email: csEmail, password: csPassword },
    asResponse: true,
  });
  const csSetCookie = csSignIn.headers.get("set-cookie");
  if (!csSetCookie) {
    throw new Error("CS signInEmail did not return set-cookie");
  }
  csCookie = csSetCookie.split(";")[0] ?? "";

  // ---- Seed project ----
  const projId = `prj_cred_${RUN_ID}`;
  await db.insert(projects).values({
    id: projId,
    name: `Rovi Cred Test ${RUN_ID}`,
    settings: {},
  });
  projectId = projId;

  // ---- Seed memberships ----
  await db.insert(drizzle.schema.projectMembers).values([
    { projectId, userId: ownerUserId, role: "OWNER" },
    { projectId, userId: csUserId, role: "CUSTOMER_SUPPORT" },
  ]);

  // BYOK credential CRUD is self-host-only; switch to self mode after seeding
  // (registration must be open during sign-up above, then guard must pass
  // during the actual route calls below).
  env.HOST_MODE = "self";
});

// ---------------------------------------------------------------------------
// afterAll: clean up all seeded rows
// ---------------------------------------------------------------------------

afterAll(async () => {
  env.HOST_MODE = origHostMode;

  const db = getDb();
  // project ON DELETE CASCADE removes copilot_credentials and project_members.
  if (projectId) {
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  const { user: userTable } = drizzle.schema;
  if (csUserId) {
    await db.delete(userTable).where(eq(userTable.id, csUserId));
  }
  if (ownerUserId) {
    await db.delete(userTable).where(eq(userTable.id, ownerUserId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("copilot credentials route", () => {
  it("PUT requires OWNER — CUSTOMER_SUPPORT receives 403", async () => {
    const app = buildApp();

    const res = await app.request(
      `/projects/${projectId}/copilot/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: csCookie },
        body: JSON.stringify({
          provider: "openai",
          apiKey: "sk-cs-attempt-should-be-denied",
          defaultModel: "gpt-4o-mini",
        }),
      },
    );

    expect(
      res.status,
      `PUT should return 403 for CUSTOMER_SUPPORT user, got ${res.status}`,
    ).toBe(403);
  });

  it("PUT + GET round-trip: hasKey is true and plaintext key is absent", async () => {
    const app = buildApp();

    // OWNER stores a credential
    const put = await app.request(
      `/projects/${projectId}/copilot/credentials`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({
          provider: "openai",
          apiKey: "sk-the-secret-value-roundtrip",
          defaultModel: "gpt-4o-mini",
        }),
      },
    );
    expect(
      put.status,
      `PUT should return 200 for OWNER, got ${put.status}`,
    ).toBe(200);

    // OWNER reads back — key must be masked
    const get = await app.request(
      `/projects/${projectId}/copilot/credentials`,
      { headers: { cookie: ownerCookie } },
    );
    expect(
      get.status,
      `GET should return 200, got ${get.status}`,
    ).toBe(200);

    const body = await get.json();
    expect(body.data.hasKey).toBe(true);
    expect(body.data.provider).toBe("openai");
    expect(body.data.defaultModel).toBe("gpt-4o-mini");

    // Plaintext key must NEVER appear anywhere in the serialised response
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("sk-the-secret-value-roundtrip");
  });
});
