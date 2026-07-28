import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// copilotChatRoute — ToolContext + system-prompt context threading (unit)
// =============================================================
//
// Task 3 (P8 AI-FAB, §6.15) added route-gated paywall tools to
// `loadTools`, which only fire when `ToolContext.route` is set. This
// pins that `chat.ts` actually threads the request's `context.route`
// (and `context.paywallId`/`context.focusedEntityId` — Task 5's
// review-fix, §6.15) through — everything else in the route (auth,
// quota, provider resolution, persistence, streaming) is mocked out so
// this stays a fast unit test, not a DB-backed integration test (see
// `copilot-chat.integration.test.ts` for that).
// =============================================================

const { drizzleMock, loadToolsMock, buildSystemPromptMock, streamTextMock } = vi.hoisted(() => {
  const thread = { id: "th_new", projectId: "prj_1", userId: "u_1", provider: "openai", model: "gpt-4o-mini" };
  const drizzleMock = {
    db: {},
    copilotThreadRepo: {
      getThread: vi.fn(async () => null),
      createThread: vi.fn(async () => thread),
      touchThread: vi.fn(async () => undefined),
    },
    copilotMessageRepo: {
      appendMessage: vi.fn(async () => ({ id: "msg_1" })),
      recentMessages: vi.fn(async () => []),
    },
    copilotUsageRepo: { bumpUsage: vi.fn(async () => undefined) },
    projectRepo: { findProjectById: vi.fn(async () => ({ id: "prj_1", name: "Test Project" })) },
  };
  const loadToolsMock = vi.fn(() => ({}));
  const buildSystemPromptMock = vi.fn(() => "system prompt");
  const streamTextMock = vi.fn(() => ({
    toUIMessageStreamResponse: () => new Response(JSON.stringify({ ok: true })),
  }));
  return { drizzleMock, loadToolsMock, buildSystemPromptMock, streamTextMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, drizzle: { ...actual.drizzle, ...drizzleMock }, currentYearMonth: () => "2026-07" };
});

vi.mock("@rovenue/shared/crypto", () => ({ decrypt: vi.fn(() => "decrypted-key") }));

vi.mock("../../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u_1" });
    await next();
  },
}));

vi.mock("../../../middleware/rovi-quota-guard", () => ({
  roviQuotaGuard: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../../lib/project-access", () => ({
  assertProjectAccess: vi.fn(async () => ({ id: "mem_1", role: "ADMIN" })),
}));

vi.mock("../../../services/copilot/providers", () => ({
  resolveProviderForProject: vi.fn(async () => ({ provider: "openai", model: "gpt-4o-mini" })),
  buildAiSdkModel: vi.fn(() => ({})),
  RoviConfigError: class RoviConfigError extends Error {},
}));

vi.mock("../../../services/copilot/pseudonymize", () => ({
  pseudonymizeMessage: vi.fn(async ({ input }: { input: string }) => ({ text: input })),
}));

vi.mock("../../../services/copilot/tools", () => ({ loadTools: loadToolsMock }));
vi.mock("../../../services/copilot/system-prompt", () => ({ buildSystemPrompt: buildSystemPromptMock }));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: streamTextMock };
});

import { copilotChatRoute } from "./chat";

function buildApp() {
  return new Hono().route("/projects/:projectId/copilot/chat", copilotChatRoute);
}

describe("copilotChatRoute — context threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.copilotThreadRepo.getThread.mockResolvedValue(null);
    drizzleMock.copilotThreadRepo.createThread.mockResolvedValue({
      id: "th_new",
      projectId: "prj_1",
      userId: "u_1",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    drizzleMock.copilotMessageRepo.appendMessage.mockResolvedValue({ id: "msg_1" });
    drizzleMock.copilotMessageRepo.recentMessages.mockResolvedValue([]);
    drizzleMock.projectRepo.findProjectById.mockResolvedValue({ id: "prj_1", name: "Test Project" });
  });

  it("threads context.route into the ToolContext passed to loadTools", async () => {
    const app = buildApp();
    const res = await app.request("/projects/prj_1/copilot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "insert a timeline node",
        context: { route: "/projects/prj_1/paywalls/pw_1/builder", focusedEntityId: "pw_1" },
      }),
    });

    expect(res.status).toBe(200);
    expect(loadToolsMock).toHaveBeenCalledTimes(1);
    expect(loadToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "prj_1",
        userId: "u_1",
        role: "ADMIN",
        route: "/projects/prj_1/paywalls/pw_1/builder",
      }),
    );
  });

  it("threads context.paywallId and context.focusedEntityId into buildSystemPrompt alongside route", async () => {
    const app = buildApp();
    await app.request("/projects/prj_1/copilot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "insert a timeline node",
        context: {
          route: "/projects/prj_1/paywalls/pw_1/builder",
          paywallId: "pw_1",
          focusedEntityId: "node_42",
        },
      }),
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/projects/prj_1/paywalls/pw_1/builder",
        paywallId: "pw_1",
        focusedEntityId: "node_42",
      }),
    );
  });

  it("threads context.paywallId alone (no selection) into buildSystemPrompt", async () => {
    const app = buildApp();
    await app.request("/projects/prj_1/copilot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "insert a timeline node",
        context: { route: "/projects/prj_1/paywalls/pw_1/builder", paywallId: "pw_1" },
      }),
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/projects/prj_1/paywalls/pw_1/builder",
        paywallId: "pw_1",
        focusedEntityId: undefined,
      }),
    );
  });

  it("passes route through as undefined-safe when paywallId/focusedEntityId are absent (non-builder route)", async () => {
    const app = buildApp();
    await app.request("/projects/prj_1/copilot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "how many active subscribers",
        context: { route: "/projects/prj_1/subscribers" },
      }),
    });

    expect(loadToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/projects/prj_1/subscribers" }),
    );
    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/projects/prj_1/subscribers",
        paywallId: undefined,
        focusedEntityId: undefined,
      }),
    );
  });
});
