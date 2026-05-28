// =============================================================
// Rovi intent-execute route — integration test
//
// Infrastructure notes:
//   - Uses Better Auth's email+password flow (enabled in NODE_ENV=test)
//     to mint a real session cookie so requireDashboardAuth is exercised
//     without mocks.
//   - Tests run against the dev Postgres configured in apps/api/tests/setup.ts
//     (docker-compose host port 5433).
//   - Each test run uses a unique RUN_ID to avoid collisions.
//   - The audiences.create handler is used because it is the simplest
//     wired handler (creates a new audience; no destructive multi-step).
//
// Verified: HANDLERS is a Map<> so registerIntentHandler uses .set() — safe
// to call multiple times (idempotent per key).
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle, getDb, projects, auditLogs } from "@rovenue/db";
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
let userId: string;
let threadId: string;
let messageId: string;
let cookie: string;

// ---------------------------------------------------------------------------
// beforeAll: register handlers, sign up user, seed project + membership
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // HANDLERS is a Map — .set() is idempotent; safe to call in test env even
  // if app.ts startup already called this.
  registerAllIntentHandlers();

  const email = `rovi_intent_${RUN_ID}@rovenue.test`;
  const password = "Test1234!intentintegration";
  const name = `Rovi Intent Test ${RUN_ID}`;

  // 1. Register via Better Auth (email+password enabled in NODE_ENV=test)
  const signUpRes = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  if (!signUpRes?.user) {
    throw new Error("signUpEmail failed — is Postgres reachable at port 5433?");
  }
  userId = signUpRes.user.id;

  // 2. Sign in to get a session cookie
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookieHeader = signInRes.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error("signInEmail did not return set-cookie");
  }
  cookie = setCookieHeader.split(";")[0] ?? "";

  // 3. Seed a project
  const db = getDb();
  const projId = `prj_intenttest_${RUN_ID}`;
  await db.insert(projects).values({
    id: projId,
    name: `Rovi Intent Test ${RUN_ID}`,
    settings: {},
  });
  projectId = projId;

  // 4. Seed membership (OWNER satisfies DEVELOPER role-rank check)
  await db.insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "OWNER",
  });

  // 5. Seed a thread and a message so the FK constraints on copilot_intents
  //    are satisfied.
  const thread = await drizzle.copilotThreadRepo.createThread(db, {
    projectId,
    userId,
    title: "intent integration test thread",
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
  // project ON DELETE CASCADE removes threads, messages, intents, audiences,
  // audit_logs, and project_members.
  if (projectId) {
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  // User is not cascade-deleted by the project removal.
  if (userId) {
    const { user: userTable } = drizzle.schema;
    await db.delete(userTable).where(eq(userTable.id, userId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /projects/:projectId/copilot/intents/:id/execute (integration)", () => {
  it("runs the audiences.create handler, writes an audit row, and marks intent as executed", async () => {
    const app = buildApp();
    const db = getDb();

    // Manufacture a pending intent directly via the repo (bypasses the LLM).
    const intent = await drizzle.copilotIntentRepo.createIntent(db, {
      projectId,
      userId,
      threadId,
      messageId,
      toolName: "action.audiences.create",
      payload: {
        name: `Rovi Test Audience ${RUN_ID}`,
        description: "from integration test",
        rules: [],
      },
      preview: { title: "Create audience", fields: [] },
      requiresRole: "DEVELOPER",
    });

    // POST to the execute endpoint via the Hono test app.
    const res = await app.request(
      `/projects/${projectId}/copilot/intents/${intent.id}/execute`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status, `execute returned ${res.status}`).toBe(200);

    const body = (await res.json()) as {
      data: { intent: { status: string }; result: unknown };
    };

    // 1. Status must be "executed".
    expect(body.data.intent.status).toBe("executed");

    // 2. Result must be present (audiences.create returns the new audience row).
    expect(body.data.result).toBeTruthy();

    // 3. At least one audit row should exist for this project (the handler
    //    calls audit() inside the transaction before committing).
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, projectId));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
