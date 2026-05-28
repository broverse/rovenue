import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useLocation, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { API_BASE_URL } from "../api";

// Helpers shape returned by `useChat` (so callers don't need to import
// from `@ai-sdk/react` themselves). Note: we intentionally do NOT
// re-export `UIMessage` here — there are two `ai` versions in the
// dependency tree (`ai@6` top-level vs `ai@5` transitively under
// `@ai-sdk/react@2`) and pinning a UI_MESSAGE generic against one
// breaks the other. Letting `useChat`'s default infer keeps both
// sides happy.
export type RoviChat = ReturnType<typeof useChat>;

// Thin wrapper around `useChat` from `@ai-sdk/react` v2 wired to the
// Rovi copilot streaming endpoint:
//
//   POST {API_BASE_URL}/dashboard/projects/:projectId/copilot/chat
//
// In v2 the endpoint + body + credentials live on a transport instance
// (the old `api: string` shorthand was removed from `useChat`). We use
// `DefaultChatTransport` from the core `ai` package, which speaks the
// UI-message-stream protocol the backend already emits (see plan 1.5).
//
// `credentials: "include"` is required because the dashboard runs on a
// different origin than the API in dev (Vite :5173 vs API :3000) and
// Better Auth session cookies need to round-trip.
//
// `body` is a function so each request picks up the latest `threadId`
// (which mutates as the user opens new threads) and the current route
// (so Rovi knows which page the user was on when they asked). The
// backend accepts `{ threadId, messages?, context }`.
export function useRoviChat(args: {
  threadId: string | null;
}): RoviChat | null {
  const params = useParams({ strict: false }) as { projectId?: string };
  const projectId = params.projectId;
  const location = useLocation();
  const pathname = location.pathname;
  const { threadId } = args;

  const transport = useMemo(() => {
    if (!projectId) return undefined;
    return new DefaultChatTransport({
      api: `${API_BASE_URL}/dashboard/projects/${projectId}/copilot/chat`,
      credentials: "include",
      body: () => ({
        threadId: threadId ?? "",
        context: { route: pathname },
      }),
    });
  }, [projectId, threadId, pathname]);

  // `useChat` itself requires a hook call on every render — we can't
  // early-return before it. When there's no projectId in scope (e.g. the
  // panel is mounted at the app root), we still call useChat with an
  // undefined transport and let callers gate on the `null` return.
  //
  // The cast bridges two `ai` package versions in the dep tree
  // (`ai@6` top-level vs `ai@5` transitively under `@ai-sdk/react@2`).
  // The `ChatTransport` interfaces are structurally identical and
  // share the same wire protocol, but TS treats their nominally-named
  // generic types as distinct. The runtime instance from `ai@6` is
  // wire-compatible with what `@ai-sdk/react@2` expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = useChat({ transport: transport as any });

  if (!projectId) return null;
  return chat;
}
