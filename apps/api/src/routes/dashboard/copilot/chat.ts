import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamText, convertToModelMessages } from "ai";
import type { LanguageModel, UIMessage } from "ai";
import { drizzle, currentYearMonth } from "@rovenue/db";
import { decrypt } from "@rovenue/shared/crypto";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { roviQuotaGuard } from "../../../middleware/rovi-quota-guard";
import {
  resolveProviderForProject,
  buildAiSdkModel,
  RoviConfigError,
  type ResolvedProvider,
} from "../../../services/copilot/providers";
import { buildSystemPrompt } from "../../../services/copilot/system-prompt";
import { pseudonymizeMessage } from "../../../services/copilot/pseudonymize";
import { loadTools } from "../../../services/copilot/tools";
import { env } from "../../../lib/env";

// ---------------------------------------------------------------------------
// Test escape hatch — allows integration tests to inject a mock model factory
// without touching the real provider credentials path.
// ---------------------------------------------------------------------------
let modelFactory: (resolved: ResolvedProvider) => LanguageModel =
  buildAiSdkModel;

export function __setRoviModelFactoryForTests(
  f: (resolved: ResolvedProvider) => LanguageModel,
): void {
  modelFactory = f;
}

export function __resetRoviModelFactoryForTests(): void {
  modelFactory = buildAiSdkModel;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
const chatBody = z.object({
  threadId: z.string().min(1),
  message: z.string().min(1).max(4000),
  context: z.object({
    route: z.string(),
    focusedEntityId: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export const copilotChatRoute = new Hono()
  .use("*", requireDashboardAuth)
  .use("*", roviQuotaGuard())
  .post("/", zValidator("json", chatBody), async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    const membership = await assertProjectAccess(projectId, user.id);
    const { threadId, message, context } = c.req.valid("json");

    // ------------------------------------------------------------------
    // 1. Verify thread ownership.
    // ------------------------------------------------------------------
    const thread = await drizzle.copilotThreadRepo.getThread(
      drizzle.db,
      threadId,
    );
    if (
      !thread ||
      thread.projectId !== projectId ||
      thread.userId !== user.id
    ) {
      throw new HTTPException(404, { message: "Thread not found" });
    }

    // ------------------------------------------------------------------
    // 2. Resolve provider (BYOK > env fallback).
    // ------------------------------------------------------------------
    let resolved: Awaited<ReturnType<typeof resolveProviderForProject>>;
    try {
      resolved = await resolveProviderForProject({
        projectId,
        loadCreds: async (pid) => {
          const row = await drizzle.copilotCredentialRepo.getCredentials(
            drizzle.db,
            pid,
          );
          if (!row) return null;
          const apiKey = decrypt(row.apiKeyEncrypted, env.ENCRYPTION_KEY!);
          return {
            provider: row.provider as
              | "openai"
              | "anthropic"
              | "mistral"
              | "ollama",
            defaultModel: row.defaultModel,
            apiKey,
            baseUrl: row.baseUrl ?? undefined,
          };
        },
        env,
      });
    } catch (e) {
      if (e instanceof RoviConfigError) {
        return c.json(
          { error: { code: "ROVI_NOT_CONFIGURED", message: e.message } },
          412,
        );
      }
      throw e;
    }

    // ------------------------------------------------------------------
    // 3. Pseudonymize user message (replace bare email addresses with
    //    subscriber ids so PII never reaches the model).
    // ------------------------------------------------------------------
    const { text: cleanText } = await pseudonymizeMessage({
      projectId,
      input: message,
      resolveByEmail: async (pid, email) => {
        // Subscriber rows are keyed on (projectId, appUserId).
        // There is no findByEmail — do a best-effort lookup via
        // findSubscriberByAppUserId treating the email as the appUserId
        // (some integrations store the email there).
        const row = await drizzle.subscriberRepo.findSubscriberByAppUserId(
          drizzle.db,
          { projectId: pid, appUserId: email },
        );
        return row?.id ?? null;
      },
    });

    // ------------------------------------------------------------------
    // 4. Persist user message immediately & bump monthly message count.
    // ------------------------------------------------------------------
    await drizzle.copilotMessageRepo.appendMessage(drizzle.db, {
      threadId,
      role: "user",
      parts: [{ type: "text", text: cleanText }],
    });
    await drizzle.copilotUsageRepo.bumpUsage(drizzle.db, {
      projectId,
      yearMonth: currentYearMonth(),
      messages: 1,
    });

    // ------------------------------------------------------------------
    // 5. Reserve an assistant message id so action tools can reference it
    //    before the full response is available.
    // ------------------------------------------------------------------
    const assistantMsg = await drizzle.copilotMessageRepo.appendMessage(
      drizzle.db,
      { threadId, role: "assistant", parts: [] },
    );

    // ------------------------------------------------------------------
    // 6. Load context for system prompt and tool registry.
    // ------------------------------------------------------------------
    const recent = await drizzle.copilotMessageRepo.recentMessages(
      drizzle.db,
      threadId,
      20,
    );
    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      projectId,
    );

    const tools = loadTools({
      projectId,
      userId: user.id,
      role: membership.role,
      threadId,
      messageId: assistantMsg.id,
    });

    // ------------------------------------------------------------------
    // 7. Build UIMessage[] for convertToModelMessages (v6 async API).
    // ------------------------------------------------------------------
    const uiMessages: UIMessage[] = recent.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: typeof m.parts === "string" ? m.parts : "",
      parts: Array.isArray(m.parts)
        ? (m.parts as UIMessage["parts"])
        : [],
      createdAt: m.createdAt,
    }));

    const modelMessages = await convertToModelMessages(uiMessages);

    // ------------------------------------------------------------------
    // 8. Stream.
    // ------------------------------------------------------------------
    const result = streamText({
      model: modelFactory(resolved),
      system: buildSystemPrompt({
        role: membership.role,
        projectName: project!.name,
        projectId,
        route: context.route,
        locale: c.req.header("accept-language")?.slice(0, 2) ?? "en",
      }),
      messages: modelMessages,
      tools,
      maxOutputTokens: 4096,
      onFinish: async ({ usage, content }) => {
        // Persist actual assistant message (replace the empty placeholder).
        await drizzle.copilotMessageRepo.appendMessage(drizzle.db, {
          threadId,
          role: "assistant",
          parts: content,
          tokenIn: usage.inputTokens ?? 0,
          tokenOut: usage.outputTokens ?? 0,
        });
        await drizzle.copilotUsageRepo.bumpUsage(drizzle.db, {
          projectId,
          yearMonth: currentYearMonth(),
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
        await drizzle.copilotThreadRepo.touchThread(drizzle.db, threadId);
      },
    });

    // v6 exposes toTextStreamResponse on the StreamTextResult object.
    return result.toTextStreamResponse();
  });
