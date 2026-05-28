// =============================================================
// Rovi copilot intents — RBAC denial integration test
//
// Infrastructure notes:
//   - Uses Better Auth's email+password flow (enabled in NODE_ENV=test)
//     to mint a real session cookie so requireDashboardAuth is exercised
//     without mocks.
//   - Tests run against the dev Postgres configured in apps/api/tests/setup.ts
//     (docker-compose host port 5433).
//   - Each test run uses a unique RUN_ID to avoid collisions.
//
// Scenario:
//   An OWNER user seeds the project (satisfies FK and membership table).
//   A second user is enrolled as CUSTOMER_SUPPORT.
//   The CS user attempts to execute an intent that requiresRole="DEVELOPER".
//   The route's assertProjectAccess check must return 403.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle, getDb, projects } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { copilotIntentsRoute } from "./intents";
import { registerAllIntentHandlers } from "../../../services/copilot/intent-handlers";

// ---------------------------------------------------------------------------
// Unique run key so parallel re-runs never collide
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Minimal Hono test app — mirrors how dashboardRoute mounts copilotIntentsRoute
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/copilot/intents",
    copilotIntentsRoute,
  );
}

// ---------------------------------------------------------------------------
// State seeded in beforeAll
// ---------------------------------------------------------------------------

let projectId: string;
let ownerUserId: string;
let csUserId: string;
let threadId: string;
let messageId: string;
let csCookie: string;

// ---------------------------------------------------------------------------
// beforeAll: register handlers, sign up both users, seed project + memberships
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // HANDLERS is a Map — .set() is idempotent; safe to call in test env even
  // if app.ts startup already called this.
  registerAllIntentHandlers();

  const db = getDb();

  // ---- Owner user (exists only to satisfy projectMembers FK) ----
  const ownerEmail = `rovi_rbac_owner_${RUN_ID}@rovenue.test`;
  const ownerPassword = "Test1234!rbacowner";
  const ownerName = `Rovi RBAC Owner ${RUN_ID}`;

  const ownerSignUp = await auth.api.signUpEmail({
    body: { email: ownerEmail, password: ownerPassword, name: ownerName },
  });
  if (!ownerSignUp?.user) {
    throw new Error("owner signUpEmail failed — is Postgres reachable at port 5433?");
  }
  ownerUserId = ownerSignUp.user.id;

  // ---- CS user (the one who will be denied) ----
  const csEmail = `rovi_rbac_cs_${RUN_ID}@rovenue.test`;
  const csPassword = "Test1234!rbaccs";
  const csName = `Rovi RBAC CS ${RUN_ID}`;

  const csSignUp = await auth.api.signUpEmail({
    body: { email: csEmail, password: csPassword, name: csName },
  });
  if (!csSignUp?.user) {
    throw new Error("CS signUpEmail failed — is Postgres reachable at port 5433?");
  }
  csUserId = csSignUp.user.id;

  // Sign in as the CS user to obtain a session cookie
  const csSignIn = await auth.api.signInEmail({
    body: { email: csEmail, password: csPassword },
    asResponse: true,
  });
  const setCookieHeader = csSignIn.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error("CS signInEmail did not return set-cookie");
  }
  csCookie = setCookieHeader.split(";")[0] ?? "";

  // ---- Seed project ----
  const projId = `prj_rbac_${RUN_ID}`;
  await db.insert(projects).values({
    id: projId,
    name: `Rovi RBAC Test ${RUN_ID}`,
    settings: {},
  });
  projectId = projId;

  // ---- Seed memberships ----
  // Owner gets OWNER role; CS user gets CUSTOMER_SUPPORT role
  await db.insert(drizzle.schema.projectMembers).values([
    { projectId, userId: ownerUserId, role: "OWNER" },
    { projectId, userId: csUserId, role: "CUSTOMER_SUPPORT" },
  ]);

  // ---- Seed a thread and message so copilot_intents FK constraints are satisfied ----
  const thread = await drizzle.copilotThreadRepo.createThread(db, {
    projectId,
    userId: csUserId,
    title: "rbac denial test thread",
    provider: "openai",
    model: "mock",
  });
  threadId = thread.id;

  const msg = await drizzle.copilotMessageRepo.appendMessage(db, {
    threadId,
    role: "assistant",
    parts: [],
  });
  messageId = msg.id;
});

// ---------------------------------------------------------------------------
// afterAll: clean up all seeded rows
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  // project ON DELETE CASCADE removes threads, messages, intents, and project_members.
  if (projectId) {
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  // Users are not cascade-deleted by project removal.
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

describe("POST /projects/:projectId/copilot/intents/:id/execute — RBAC denial", () => {
  it("returns 403 when a CUSTOMER_SUPPORT user tries to execute a DEVELOPER-required intent", async () => {
    const app = buildApp();
    const db = getDb();

    // Manufacture a pending intent that requires DEVELOPER role.
    const intent = await drizzle.copilotIntentRepo.createIntent(db, {
      projectId,
      userId: csUserId,
      threadId,
      messageId,
      toolName: "action.audiences.create",
      payload: {
        name: `RBAC Denied Audience ${RUN_ID}`,
        description: "this should be blocked by RBAC",
        rules: {},
        reason: "rbac test",
      },
      preview: { title: "Create audience (blocked)", fields: [] },
      requiresRole: "DEVELOPER",
    });

    // POST as the CS user — assertProjectAccess should reject with 403.
    const res = await app.request(
      `/projects/${projectId}/copilot/intents/${intent.id}/execute`,
      { method: "POST", headers: { cookie: csCookie } },
    );

    expect(res.status, `execute should return 403 for CUSTOMER_SUPPORT user, got ${res.status}`).toBe(403);
  });
});
