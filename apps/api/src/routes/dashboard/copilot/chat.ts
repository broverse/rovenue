import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamText, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
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
// Input schema — accepts the @ai-sdk/react v6 useChat payload
// (`{ id, messages, trigger, ... }`) plus our custom `threadId` and `context`
// fields. The legacy single-`message` form is also accepted so existing
// integration tests keep working.
// ---------------------------------------------------------------------------
const uiPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

const uiMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(uiPartSchema).default([]),
});

const chatBody = z
  .object({
    /** v6 useChat session id — used as our threadId when none provided. */
    id: z.string().min(1).optional(),
    /** Our copilot thread id. Optional — auto-created from `id` on first use. */
    threadId: z.string().optional(),
    /** v6 useChat sends the full UI message history. We only use the last user message. */
    messages: z.array(uiMessageSchema).optional(),
    /** Legacy single-message shape (kept for integration tests + non-v6 callers). */
    message: z.string().min(1).max(4000).optional(),
    trigger: z.string().optional(),
    context: z.object({
      route: z.string(),
      focusedEntityId: z.string().optional(),
    }),
  })
  .refine((b) => Boolean(b.messages?.length || b.message), {
    message: "Provide either `messages` (v6) or `message`",
    path: ["messages"],
  });

function extractLastUserText(
  body: z.infer<typeof chatBody>,
): string | null {
  if (body.message) return body.message;
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    if (text.trim().length > 0) return text;
  }
  return null;
}

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
    const body = c.req.valid("json");
    const { context } = body;

    const message = extractLastUserText(body);
    if (!message) {
      throw new HTTPException(400, { message: "No user message in payload" });
    }
    if (message.length > 4000) {
      throw new HTTPException(400, {
        message: "Message exceeds 4000 characters",
      });
    }

    // ------------------------------------------------------------------
    // 1. Resolve provider (BYOK > env fallback) — needed up-front so we
    //    can stamp provider/model onto a newly created thread.
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
    // 2. Get-or-create the thread. Prefer `threadId`; fall back to the
    //    v6 useChat `id` so the same chat session keeps the same thread.
    // ------------------------------------------------------------------
    const candidateThreadId =
      (body.threadId && body.threadId.length > 0 ? body.threadId : null) ??
      body.id ??
      null;

    let thread = candidateThreadId
      ? await drizzle.copilotThreadRepo.getThread(drizzle.db, candidateThreadId)
      : null;

    if (thread) {
      if (thread.projectId !== projectId || thread.userId !== user.id) {
        throw new HTTPException(404, { message: "Thread not found" });
      }
    } else {
      thread = await drizzle.copilotThreadRepo.createThread(drizzle.db, {
        id: candidateThreadId ?? undefined,
        projectId,
        userId: user.id,
        title: message.slice(0, 60),
        provider: resolved.provider,
        model: resolved.model,
      });
    }
    const threadId = thread.id;

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
    // 7. Build ModelMessage[] directly from stored parts. Each row's
    //    `parts` holds the v6 ModelMessage `content` array shape (text /
    //    tool-call / tool-result blocks). Skip the empty placeholder row
    //    we created in step 5 — it exists only so action tools can
    //    foreign-key an intent to a real message id before streaming
    //    finishes.
    // ------------------------------------------------------------------
    const modelMessages: ModelMessage[] = recent
      .filter((m) => Array.isArray(m.parts) && (m.parts as unknown[]).length > 0)
      .map(
        (m) =>
          ({
            role: m.role as "user" | "assistant" | "tool",
            content: m.parts as ModelMessage["content"],
          }) as ModelMessage,
      );

    // ------------------------------------------------------------------
    // 8. Stream. `stopWhen: stepCountIs(5)` lets the model emit text
    //    AFTER tool calls — v6's default is a single step, which would
    //    leave the user staring at a tool-result card with no answer.
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
      stopWhen: stepCountIs(5),
      onFinish: async ({ usage, response }) => {
        // Persist every message this turn produced — assistant text /
        // tool-call blocks AND the synthesised tool-role messages
        // containing tool_result blocks. Without the tool-role rows the
        // next request would replay an assistant tool_use with no
        // matching tool_result and Anthropic would 400.
        for (const m of response.messages) {
          await drizzle.copilotMessageRepo.appendMessage(drizzle.db, {
            threadId,
            role: m.role as "user" | "assistant" | "tool",
            parts: m.content as unknown as object,
          });
        }
        await drizzle.copilotUsageRepo.bumpUsage(drizzle.db, {
          projectId,
          yearMonth: currentYearMonth(),
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
        await drizzle.copilotThreadRepo.touchThread(drizzle.db, threadId);
      },
    });

    // v6 useChat (@ai-sdk/react) expects the UI message stream format —
    // `toTextStreamResponse()` emits plain text which the default
    // transport silently ignores. `toUIMessageStreamResponse()` produces
    // the data-stream SSE format the React hook actually parses.
    return result.toUIMessageStreamResponse();
  });
