// =============================================================
// Rovi copilot chat route — integration test
//
// Infrastructure notes:
//   - Uses Better Auth's email+password flow (enabled in NODE_ENV=test)
//     to mint a real session cookie so requireDashboardAuth is exercised
//     without mocks.
//   - Tests run against the dev Postgres configured in apps/api/tests/setup.ts
//     (docker-compose host port 5433).
//   - Each test run uses a unique RUN_ID to avoid collisions.
//   - The LLM call is intercepted via __setRoviModelFactoryForTests so no
//     real OpenAI/Anthropic credentials are required.
//
// v6 mock surface probe result:
//   `ai/test` exports MockLanguageModelV3 + simulateReadableStream (V3, not V2).
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import {
  getDb,
  projects,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { copilotChatRoute } from "./chat";
import {
  __setRoviModelFactoryForTests,
  __resetRoviModelFactoryForTests,
} from "./chat";

// ---------------------------------------------------------------------------
// Unique run key so parallel re-runs never collide
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Minimal Hono test app — mirrors how dashboardRoute mounts copilotChatRoute
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/copilot/chat",
    copilotChatRoute,
  );
}

// ---------------------------------------------------------------------------
// State seeded in beforeAll
// ---------------------------------------------------------------------------

let projectId: string;
let userId: string;
let cookie: string;

// ---------------------------------------------------------------------------
// beforeAll: sign up user, seed project + membership, install mock factory
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const email = `rovi_chat_${RUN_ID}@rovenue.test`;
  const password = "Test1234!chatintegration";
  const name = `Rovi Chat Test ${RUN_ID}`;

  // 1. Register via Better Auth (email+password, enabled in NODE_ENV=test)
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
  const projId = `prj_chattest_${RUN_ID}`;
  await db.insert(projects).values({
    id: projId,
    name: `Rovi Chat Test ${RUN_ID}`,
    settings: {},
  });
  projectId = projId;

  // 4. Seed membership (OWNER)
  await db.insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "OWNER",
  });

  // 5. Install mock model factory — intercepts buildAiSdkModel so no real
  //    credentials are needed. The factory ignores the ResolvedProvider arg
  //    and returns a MockLanguageModelV3 that streams "Hello from Rovi!".
  // Build a correctly-typed stream result for MockLanguageModelV3.
  // LanguageModelV3FinishReason is { unified: ..., raw: string | undefined }
  // LanguageModelV3Usage.inputTokens / outputTokens are objects, not scalars.
  const mockStreamResult = {
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: "text-start" as const, id: "t0" },
        { type: "text-delta" as const, id: "t0", delta: "Hello " },
        { type: "text-delta" as const, id: "t0", delta: "from Rovi!" },
        { type: "text-end" as const, id: "t0" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" as string | undefined },
          usage: {
            inputTokens: {
              total: 10 as number | undefined,
              noCache: 10 as number | undefined,
              cacheRead: 0 as number | undefined,
              cacheWrite: undefined as number | undefined,
            },
            outputTokens: {
              total: 5 as number | undefined,
              text: 5 as number | undefined,
              reasoning: undefined as number | undefined,
            },
          },
        },
      ],
    }),
    warnings: [] as never[],
  };

  __setRoviModelFactoryForTests(
    () =>
      new MockLanguageModelV3({
        doStream: mockStreamResult,
      }),
  );

  // Note: ROVI_DEFAULT_PROVIDER/MODEL/API_KEY are set in tests/setup.ts so
  // that resolveProviderForProject doesn't throw RoviConfigError before the
  // mock factory intercepts buildAiSdkModel.
});

// ---------------------------------------------------------------------------
// afterAll: reset mock and clean up DB rows
// ---------------------------------------------------------------------------

afterAll(async () => {
  __resetRoviModelFactoryForTests();

  // Delete cascades to copilot_threads, copilot_messages, copilot_usage,
  // copilot_credentials, and project_members via FK ON DELETE CASCADE.
  const db = getDb();
  if (projectId) {
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  // Remove the test user (not cascade-deleted by the project removal).
  if (userId) {
    const { user: userTable } = drizzle.schema;
    await db.delete(userTable).where(eq(userTable.id, userId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /projects/:projectId/copilot/chat (integration)", () => {
  it("creates a thread, streams the assistant reply, and persists both messages", async () => {
    const app = buildApp();
    const db = getDb();

    // Seed a thread directly through the repo (bypasses the threads route).
    const thread = await drizzle.copilotThreadRepo.createThread(db, {
      projectId,
      userId,
      title: "integration test thread",
      provider: "openai",
      model: "mock",
    });

    const res = await app.request(
      `/projects/${projectId}/copilot/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          threadId: thread.id,
          message: "hello rovi",
          context: { route: "/overview" },
        }),
      },
    );

    expect(res.status).toBe(200);

    // Drain the SSE/text stream so that onFinish fires before we query the DB.
    const text = await res.text();
    expect(text).toContain("Rovi");

    // Both the user message and the assistant reply should be persisted.
    const messages = await drizzle.copilotMessageRepo.listMessages(db, thread.id);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.role === "user")).toBe(true);
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
  });
});
