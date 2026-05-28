// =============================================================
// Rovi copilot quota-guard — integration test
//
// Verifies that a free-tier project whose copilot_usage_monthly.messages
// is already at the cap (50) receives 429 ROVI_QUOTA_EXCEEDED on the
// next POST /chat request.
//
// env-override strategy:
//   The `env` const is parsed+frozen at module-load time via Zod, so
//   mutating process.env after import has no effect. We use vi.mock to
//   replace the entire `../../../lib/env` module with a copy whose
//   ROVI_UNLIMITED is forced to false (and ROVI_TIER is unset) before
//   any test module imports env. Vitest hoists vi.mock() calls above
//   static imports automatically, so this reliably takes effect.
// =============================================================

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// MUST be declared before any import that transitively requires env
// ---------------------------------------------------------------------------
vi.mock("../../../lib/env", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/env")>(
      "../../../lib/env",
    );
  return {
    ...actual,
    env: {
      ...actual.env,
      ROVI_UNLIMITED: false,
      ROVI_TIER: undefined,
    },
  };
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getDb, drizzle, projects, currentYearMonth } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { copilotChatRoute } from "./chat";
import {
  __setRoviModelFactoryForTests,
  __resetRoviModelFactoryForTests,
} from "./chat";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// ---------------------------------------------------------------------------
// Unique run key
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Minimal Hono test app
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/copilot/chat",
    copilotChatRoute,
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projectId: string;
let userId: string;
let cookie: string;

// ---------------------------------------------------------------------------
// beforeAll: sign up, seed project at cap usage, install mock factory
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const email = `rovi_quota_${RUN_ID}@rovenue.test`;
  const password = "Test1234!quotaintegration";
  const name = `Rovi Quota Test ${RUN_ID}`;

  // 1. Register via Better Auth
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

  // 3. Seed a project with rovi_tier: "free" stored in settings/metadata
  const db = getDb();
  projectId = `prj_quotatest_${RUN_ID}`;
  await db.insert(projects).values({
    id: projectId,
    name: `Rovi Quota Test ${RUN_ID}`,
    settings: { rovi_tier: "free" },
  });

  // 4. Seed membership
  await db.insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "OWNER",
  });

  // 5. Pre-fill copilot_usage_monthly to the free-tier cap (50 messages)
  //    so the next /chat POST is immediately blocked.
  const { copilotUsageMonthly } = drizzle.schema;
  const ym = currentYearMonth();
  await db.insert(copilotUsageMonthly).values({
    projectId,
    yearMonth: ym,
    messages: 50,
    inputTokens: 0,
    outputTokens: 0,
  });

  // 6. Install mock LLM factory (quota guard fires BEFORE the model is
  //    reached, but we install it anyway so the route doesn't throw a
  //    config error if somehow the guard is bypassed — cleaner failure mode).
  const mockStreamResult = {
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: "text-start" as const, id: "t0" },
        { type: "text-delta" as const, id: "t0", delta: "Should not reach here" },
        { type: "text-end" as const, id: "t0" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" as string | undefined },
          usage: {
            inputTokens: {
              total: 0 as number | undefined,
              noCache: 0 as number | undefined,
              cacheRead: 0 as number | undefined,
              cacheWrite: undefined as number | undefined,
            },
            outputTokens: {
              total: 0 as number | undefined,
              text: 0 as number | undefined,
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
});

// ---------------------------------------------------------------------------
// afterAll: reset mock, clean up DB rows
// ---------------------------------------------------------------------------

afterAll(async () => {
  __resetRoviModelFactoryForTests();

  const db = getDb();
  if (projectId) {
    // Deletes cascade to copilot_usage_monthly, projectMembers, etc.
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  if (userId) {
    const { user: userTable } = drizzle.schema;
    await db.delete(userTable).where(eq(userTable.id, userId));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /projects/:projectId/copilot/chat quota guard (integration)", () => {
  it("returns 429 ROVI_QUOTA_EXCEEDED when the free-tier message cap is reached", async () => {
    const app = buildApp();
    const db = getDb();

    // Seed a thread so the route has a valid threadId to look up.
    const thread = await drizzle.copilotThreadRepo.createThread(db, {
      projectId,
      userId,
      title: "quota test thread",
      provider: "openai",
      model: "mock",
    });

    const res = await app.request(`/projects/${projectId}/copilot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        threadId: thread.id,
        message: "will this exceed the quota?",
        context: { route: "/overview" },
      }),
    });

    expect(res.status).toBe(429);

    const body = await res.json() as {
      error: { code: string; exceeded: string; tier: string };
    };
    expect(body.error.code).toBe("ROVI_QUOTA_EXCEEDED");
    expect(body.error.exceeded).toBe("messages");
    expect(body.error.tier).toBe("free");
  });
});
