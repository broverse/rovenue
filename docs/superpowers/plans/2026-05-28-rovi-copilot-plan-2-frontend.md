# Rovi Copilot — Plan 2: Dashboard Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-28-rovi-copilot-design.md` (§2, §10, Appendix A)
**Predecessor plans:** Plan 1 (`2026-05-28-rovi-copilot-backend.md`) + Plan 1.5 (`2026-05-28-rovi-copilot-plan-1-5.md`), both merged.
**Backend API surface:** stable, fully tested.

**Goal:** Ship the dashboard side of Rovi — a topbar `Sparkles` button, a floating-drawer chat panel built with the Vercel AI SDK + ai-sdk Elements, tool-call UI renderers (subscriber/metric cards + approval card + navigate card), per-project BYOK settings, and a usage bar — all consuming the existing `/api/dashboard/projects/:projectId/copilot/*` endpoints.

**Architecture:** Right-side floating drawer mounted only inside `_authed/projects/$projectId/route.tsx`. Open-state lives in a small React context (`RoviProvider`) with `localStorage` persistence and a `⌘.` global keybind. The chat hook is the v6 `useChat` from `@ai-sdk/react`, pointed at our SSE chat endpoint. Tool calls render via a switch on `toolName` inside the assistant message. Approval cards POST to `/intents/:id/execute` or `/reject`. Settings page for BYOK lives at `/projects/:id/settings/rovi`.

**Tech Stack:** React, TypeScript, Vite, TanStack Router, TanStack Query, HeroUI, Tailwind, lucide-react icons, `ai@^6`, `@ai-sdk/react@^2`, ai-sdk Elements (`@ai-sdk-tools/elements`).

**Out of scope:** Voice input, custom DOM-injection tools, cross-project queries, anything in spec §15 "Deferred to v2".

---

## Conventions (from observed repo state)

- Component dir: `apps/dashboard/src/components/rovi/`.
- Hooks dir: `apps/dashboard/src/lib/hooks/` (file naming `useXxx.ts`).
- API client: `apps/dashboard/src/lib/api.ts` exposes a `fetch` wrapper with `credentials: "include"` — use it for non-streaming endpoints. For SSE, use `useChat`'s built-in fetch.
- UI primitives: `apps/dashboard/src/ui/` exports `Button`, `Card`, `Input`, `Chip`, etc. Style with Tailwind tokens (`rv-mute-600`, `rv-c2`, `rv-divider`, etc.) — see existing topbar/sidebar code.
- Route files: TanStack `createFileRoute(...)({ component })`. Settings tabs are siblings under `_authed/projects/$projectId/settings/`.
- i18n: `useTranslation()` + `t("rovi.xxx")` strings; new entries go in `apps/dashboard/src/locales/{en,tr}.json`. (Discover the actual i18n setup before adding entries; if too disruptive, hard-code English strings in v1 and follow up.)

---

## File Structure

### New files

**Components — `apps/dashboard/src/components/rovi/`:**
- `rovi-provider.tsx` — React context + provider; `open`, `toggle()`, `currentThreadId`, `setThread()`.
- `topbar-rovi-button.tsx` — Sparkles icon button.
- `rovi-panel.tsx` — drawer container; renders Header, Conversation, PromptInput, UsageBar.
- `rovi-header.tsx` — title, thread switcher dropdown, close button.
- `rovi-conversation.tsx` — wraps `<Conversation><Message/></Conversation>` from ai-sdk-elements.
- `rovi-prompt-input.tsx` — wraps `<PromptInput/>`.
- `rovi-usage-bar.tsx` — small progress bar at the bottom.
- `rovi-tool-ui.tsx` — switch on `toolName` → routes to specific renderer.
- `rovi-empty-state.tsx` — shown when there's no current thread.
- `rovi-missing-config.tsx` — CTA shown when `/chat` returns 412 ROVI_NOT_CONFIGURED.
- `tools/subscriber-card.tsx` — `query.subscribers.get` result renderer.
- `tools/subscriber-list.tsx` — `query.subscribers.search` result renderer.
- `tools/metrics-chart.tsx` — `query.metrics.mrr` result (chart) — churn/conversion get "not implemented" placeholder UI.
- `tools/approval-card.tsx` — for any `action.*` tool — shows preview fields + Approve / Cancel.
- `tools/navigate-card.tsx` — for `ui.navigate` / `ui.openSubscriber`.

**Hooks — `apps/dashboard/src/lib/hooks/`:**
- `useRovi.ts` — context consumer.
- `useRoviChat.ts` — wraps `useChat` from `@ai-sdk/react`; configures URL + body + onError.
- `useRoviUsage.ts` — `useQuery` for `GET /usage`.
- `useRoviCredentials.ts` — `useQuery` + mutation for credentials route.
- `useRoviIntents.ts` — `mutation` for execute / reject.

**Route — `apps/dashboard/src/routes/_authed/projects/$projectId/settings/`:**
- `rovi.tsx` — BYOK settings page (provider + apiKey + model + base URL + test).

**Modifications:**
- `apps/dashboard/src/components/dashboard/topbar.tsx` — insert `<TopbarRoviButton/>` before `<TopbarUserMenu/>`.
- `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx` — wrap children in `<RoviProvider>` and mount `<RoviPanel/>` at top level.
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/route.tsx` — add a "Rovi" tab.
- `apps/dashboard/package.json` — add `ai`, `@ai-sdk/react`, `@ai-sdk-tools/elements` (verify exact package name during install).

---

## Tasks

### Task 1: Install dashboard AI SDK dependencies

**Files:**
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Discover the actual ai-sdk-elements package name**

The spec references `elements.ai-sdk.dev` for the UI library. The npm package is usually `@ai-sdk-tools/elements` but verify:

```bash
npm view @ai-sdk-tools/elements name version 2>&1 | head -5
npm view @ai-sdk/elements name version 2>&1 | head -5
```

Pick whichever resolves to a real published package. Note the exact name.

- [ ] **Step 2: Install**

From the worktree root:

```bash
pnpm --filter @rovenue/dashboard add ai@^6 @ai-sdk/react@^2 <elements-package>@latest
```

- [ ] **Step 3: Verify install + typecheck**

```bash
pnpm --filter @rovenue/dashboard list ai @ai-sdk/react
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: deps listed, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "chore(dashboard): add AI SDK + ai-sdk-elements for Rovi panel"
```

---

### Task 2: Rovi context provider + useRovi hook

**Files:**
- Create: `apps/dashboard/src/components/rovi/rovi-provider.tsx`
- Create: `apps/dashboard/src/lib/hooks/useRovi.ts`

- [ ] **Step 1: Write the provider**

`apps/dashboard/src/components/rovi/rovi-provider.tsx`:

```tsx
import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

export type RoviContextValue = {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
  currentThreadId: string | null;
  setCurrentThreadId: (id: string | null) => void;
};

export const RoviContext = createContext<RoviContextValue | null>(null);

const STORAGE_KEY = "rovi:open";

export function RoviProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    }
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘ . (period) — toggle
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        toggle();
      }
      // Esc — close
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, open, setOpen]);

  const value = useMemo<RoviContextValue>(
    () => ({ open, toggle, setOpen, currentThreadId, setCurrentThreadId }),
    [open, toggle, setOpen, currentThreadId],
  );

  return <RoviContext.Provider value={value}>{children}</RoviContext.Provider>;
}
```

- [ ] **Step 2: Write the hook**

`apps/dashboard/src/lib/hooks/useRovi.ts`:

```ts
import { useContext } from "react";
import { RoviContext } from "../../components/rovi/rovi-provider";

export function useRovi() {
  const ctx = useContext(RoviContext);
  if (!ctx) {
    throw new Error("useRovi must be used inside <RoviProvider>");
  }
  return ctx;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/rovi/rovi-provider.tsx \
        apps/dashboard/src/lib/hooks/useRovi.ts
git commit -m "feat(rovi): provider context + useRovi hook (open-state + ⌘. kbd)"
```

---

### Task 3: Topbar Sparkles button

**Files:**
- Create: `apps/dashboard/src/components/rovi/topbar-rovi-button.tsx`
- Modify: `apps/dashboard/src/components/dashboard/topbar.tsx`

- [ ] **Step 1: Write the button**

`apps/dashboard/src/components/rovi/topbar-rovi-button.tsx`:

```tsx
import { Sparkles } from "lucide-react";
import { useRovi } from "../../lib/hooks/useRovi";

export function TopbarRoviButton() {
  const { open, toggle } = useRovi();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={open ? "Close Rovi" : "Open Rovi"}
      aria-pressed={open}
      title="Open Rovi (⌘.)"
      className={
        "hidden size-8 items-center justify-center rounded-md transition sm:inline-flex " +
        (open
          ? "bg-rv-c4 text-foreground"
          : "text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground")
      }
    >
      <Sparkles size={16} />
    </button>
  );
}
```

- [ ] **Step 2: Insert into topbar**

Edit `apps/dashboard/src/components/dashboard/topbar.tsx`. Find the line `<TopbarUserMenu />` and insert the Rovi button + a divider IMMEDIATELY before it:

```tsx
<TopbarRoviButton />
<span className="mx-0.5 hidden h-5 w-px bg-rv-divider sm:inline-block" aria-hidden="true" />
<TopbarUserMenu />
```

Add the import at the top alongside `TopbarUserMenu`:

```tsx
import { TopbarRoviButton } from "../rovi/topbar-rovi-button";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: clean. (Will error at runtime because RoviProvider isn't mounted yet; that's Task 5.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/rovi/topbar-rovi-button.tsx \
        apps/dashboard/src/components/dashboard/topbar.tsx
git commit -m "feat(rovi): topbar Sparkles button (⌘. toggle)"
```

---

### Task 4: RoviPanel drawer shell

**Files:**
- Create: `apps/dashboard/src/components/rovi/rovi-panel.tsx`
- Create: `apps/dashboard/src/components/rovi/rovi-header.tsx`
- Create: `apps/dashboard/src/components/rovi/rovi-empty-state.tsx`

This task creates the visual shell — drawer animation, header, empty state — without any chat logic yet.

- [ ] **Step 1: Header**

`apps/dashboard/src/components/rovi/rovi-header.tsx`:

```tsx
import { X } from "lucide-react";
import { useRovi } from "../../lib/hooks/useRovi";

export function RoviHeader({ providerLabel, modelLabel }: { providerLabel?: string; modelLabel?: string }) {
  const { setOpen } = useRovi();
  return (
    <div className="flex h-12 items-center gap-2 border-b border-rv-divider px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">Rovi</span>
        {providerLabel && modelLabel ? (
          <span className="truncate rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rv-mute-600">
            {providerLabel} · {modelLabel}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close Rovi"
        className="ml-auto flex size-7 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Empty state**

`apps/dashboard/src/components/rovi/rovi-empty-state.tsx`:

```tsx
export function RoviEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 rounded-full bg-rv-c2 p-3 text-rv-mute-600">
        <span className="text-lg" aria-hidden="true">✨</span>
      </div>
      <p className="text-sm font-medium text-foreground">Ask Rovi</p>
      <p className="mt-1 max-w-[260px] text-xs text-rv-mute-600">
        Subscribers, products, audiences, experiments — ask a question or kick off an
        action. Mutations always ask for your approval first.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Panel shell**

`apps/dashboard/src/components/rovi/rovi-panel.tsx`:

```tsx
import { useRovi } from "../../lib/hooks/useRovi";
import { RoviHeader } from "./rovi-header";
import { RoviEmptyState } from "./rovi-empty-state";

export function RoviPanel() {
  const { open, setOpen } = useRovi();

  return (
    <>
      {/* Mobile backdrop */}
      {open ? (
        <button
          type="button"
          aria-label="Close Rovi"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      ) : null}

      {/* Drawer */}
      <aside
        role="complementary"
        aria-label="Rovi"
        className={
          "dark fixed right-0 top-0 z-50 flex h-screen w-full flex-col border-l border-rv-divider bg-rv-bg shadow-2xl transition-transform duration-200 ease-out " +
          "md:w-[380px] lg:w-[420px] " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <RoviHeader />
        <div className="flex flex-1 flex-col overflow-hidden">
          <RoviEmptyState />
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/rovi/rovi-panel.tsx \
        apps/dashboard/src/components/rovi/rovi-header.tsx \
        apps/dashboard/src/components/rovi/rovi-empty-state.tsx
git commit -m "feat(rovi): floating drawer shell (header + empty state)"
```

---

### Task 5: Mount RoviProvider + RoviPanel in project route

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx`

- [ ] **Step 1: Read the current route**

```bash
cat apps/dashboard/src/routes/_authed/projects/\$projectId/route.tsx
```

It currently wraps `<Outlet/>` in `<DashboardShell>`. We add `<RoviProvider>` around that AND mount `<RoviPanel/>` as a sibling so it floats over the whole shell.

- [ ] **Step 2: Update**

The component body becomes:

```tsx
return (
  <RoviProvider>
    <DashboardShell projectId={project.id} projectName={project.name} current={current}>
      <Outlet />
    </DashboardShell>
    <RoviPanel />
  </RoviProvider>
);
```

Add imports at the top:

```tsx
import { RoviProvider } from "../../../../components/rovi/rovi-provider";
import { RoviPanel } from "../../../../components/rovi/rovi-panel";
```

- [ ] **Step 3: Manual smoke**

Start the dashboard dev server:

```bash
pnpm --filter @rovenue/dashboard dev
```

Open a project route in the browser. Click the Sparkles in the topbar → drawer slides in from the right with the empty state. Press `⌘.` → toggles. Press `Esc` while open → closes.

Verify on a `< md` viewport: backdrop appears and full-screen takeover.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/route.tsx
git commit -m "feat(rovi): mount RoviProvider + drawer in project route shell"
```

---

### Task 6: useRoviChat hook

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useRoviChat.ts`

This hook wraps `useChat` from `@ai-sdk/react` and configures the endpoint, headers, and body shape we need.

- [ ] **Step 1: Verify the v6 useChat surface**

```bash
node -e "const x = require('@ai-sdk/react'); console.log(Object.keys(x).filter(k => /chat|use/i.test(k)).sort().join(' '))"
```

Confirm `useChat` is exported.

- [ ] **Step 2: Write the hook**

```ts
import { useChat } from "@ai-sdk/react";
import { useLocation, useParams } from "@tanstack/react-router";
import { useMemo } from "react";

export function useRoviChat(args: { threadId: string | null }) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const location = useLocation();

  const api = useMemo(
    () =>
      projectId
        ? `/api/dashboard/projects/${projectId}/copilot/chat`
        : undefined,
    [projectId],
  );

  const chat = useChat({
    api,
    credentials: "include",
    body: {
      threadId: args.threadId ?? "",
      context: { route: location.pathname },
    },
    streamProtocol: "data", // v6 default; explicit for clarity
  });

  return chat;
}
```

If the v6 `useChat` config keys are named differently (e.g. `transport` instead of `api`), adapt.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useRoviChat.ts
git commit -m "feat(rovi): useRoviChat hook around @ai-sdk/react useChat"
```

---

### Task 7: RoviConversation rendering

**Files:**
- Create: `apps/dashboard/src/components/rovi/rovi-conversation.tsx`
- Create: `apps/dashboard/src/components/rovi/rovi-tool-ui.tsx`

This renders the message stream from `useRoviChat`. ai-sdk Elements provides `<Conversation>` and `<Message>` primitives, but we render `<RoviToolUI/>` for tool calls.

- [ ] **Step 1: Inspect ai-sdk Elements exports**

```bash
node -e "const x = require('<elements-package>'); console.log(Object.keys(x).sort().join(' '))"
```

(Replace `<elements-package>` with what Task 1 installed.) Note the component names — likely `Conversation`, `Message`, `ConversationContent`, `MessagePart`, etc. Adapt the imports below to whatever's exported.

- [ ] **Step 2: Placeholder ToolUI switch**

`apps/dashboard/src/components/rovi/rovi-tool-ui.tsx`:

```tsx
import type { ReactNode } from "react";

export type ToolPart = {
  type: `tool-${string}` | string;
  toolName?: string;
  state?: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
};

export function RoviToolUI({ part }: { part: ToolPart }): ReactNode {
  // For Task 7 just render JSON; later tasks replace each case with a card.
  return (
    <pre className="overflow-auto rounded-md border border-rv-divider bg-rv-c2 p-2 text-[11px] text-rv-mute-700">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 3: Conversation**

`apps/dashboard/src/components/rovi/rovi-conversation.tsx`:

```tsx
import type { UIMessage } from "ai";
import { RoviToolUI, type ToolPart } from "./rovi-tool-ui";

export function RoviConversation({ messages }: { messages: UIMessage[] }) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <article
          key={m.id}
          className={
            m.role === "user"
              ? "rounded-md bg-rv-c2 px-3 py-2 text-sm text-foreground"
              : "text-sm text-foreground"
          }
        >
          {m.parts?.map((p, i) => {
            if (p.type === "text") {
              return <p key={i} className="whitespace-pre-wrap leading-relaxed">{p.text}</p>;
            }
            if (typeof p.type === "string" && p.type.startsWith("tool-")) {
              return <RoviToolUI key={i} part={p as unknown as ToolPart} />;
            }
            return null;
          })}
        </article>
      ))}
    </div>
  );
}
```

If `UIMessage` from `ai` v6 has different shape (`parts` vs `content`), adapt — probe with:

```bash
node -e "const t = require('ai'); console.log(Object.keys(t).filter(k => /Message/.test(k)).join(' '))"
```

- [ ] **Step 4: Wire into RoviPanel**

Edit `rovi-panel.tsx` to use chat + conversation. Replace the body block with:

```tsx
import { useRovi } from "../../lib/hooks/useRovi";
import { useRoviChat } from "../../lib/hooks/useRoviChat";
import { RoviHeader } from "./rovi-header";
import { RoviEmptyState } from "./rovi-empty-state";
import { RoviConversation } from "./rovi-conversation";

export function RoviPanel() {
  const { open, setOpen, currentThreadId } = useRovi();
  const { messages } = useRoviChat({ threadId: currentThreadId });

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close Rovi"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      ) : null}
      <aside
        role="complementary"
        aria-label="Rovi"
        className={
          "dark fixed right-0 top-0 z-50 flex h-screen w-full flex-col border-l border-rv-divider bg-rv-bg shadow-2xl transition-transform duration-200 ease-out " +
          "md:w-[380px] lg:w-[420px] " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <RoviHeader />
        {messages.length === 0 ? (
          <RoviEmptyState />
        ) : (
          <RoviConversation messages={messages} />
        )}
      </aside>
    </>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/rovi/rovi-conversation.tsx \
        apps/dashboard/src/components/rovi/rovi-tool-ui.tsx \
        apps/dashboard/src/components/rovi/rovi-panel.tsx
git commit -m "feat(rovi): conversation renderer with tool-call placeholder switch"
```

---

### Task 8: RoviPromptInput

**Files:**
- Create: `apps/dashboard/src/components/rovi/rovi-prompt-input.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-panel.tsx`

- [ ] **Step 1: Write**

```tsx
import { Send } from "lucide-react";
import { useState, type FormEvent } from "react";

export function RoviPromptInput({
  disabled,
  onSubmit,
}: {
  disabled?: boolean;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSubmit(t);
    setText("");
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 border-t border-rv-divider px-3 py-2"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            submit();
          }
        }}
        rows={1}
        placeholder="Ask Rovi…"
        disabled={disabled}
        className="min-h-[36px] max-h-[160px] flex-1 resize-none rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2 text-sm text-foreground placeholder:text-rv-mute-500 focus:border-rv-c4 focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || text.trim().length === 0}
        aria-label="Send"
        className="flex size-9 items-center justify-center rounded-md bg-rv-c4 text-foreground transition hover:opacity-90 disabled:opacity-40"
      >
        <Send size={15} />
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Wire into RoviPanel**

Replace the panel body region to include the input. The new panel body becomes:

```tsx
const { messages, sendMessage, status } = useRoviChat({ threadId: currentThreadId });
const busy = status === "streaming" || status === "submitted";
```

…and at the bottom of the aside:

```tsx
{messages.length === 0 ? <RoviEmptyState /> : <RoviConversation messages={messages} />}
<RoviPromptInput
  disabled={busy}
  onSubmit={(t) => sendMessage({ text: t })}
/>
```

If v6's `useChat` exposes `append` / `input` / `handleSubmit` instead of `sendMessage` / `status`, use whichever the installed API provides. The names changed across v5 → v6; probe before pasting.

- [ ] **Step 3: Typecheck + smoke**

Typecheck. Open the dashboard, set up a project, ensure BYOK is configured (will come from Task 14), send a message — should stream a reply.

If BYOK isn't configured the API returns 412 and the v6 useChat raises an error; that surfaces in Task 10's missing-config CTA.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/rovi/rovi-prompt-input.tsx \
        apps/dashboard/src/components/rovi/rovi-panel.tsx
git commit -m "feat(rovi): prompt input (Enter to send, Shift+Enter newline)"
```

---

### Task 9: Usage hook + bar

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useRoviUsage.ts`
- Create: `apps/dashboard/src/components/rovi/rovi-usage-bar.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-panel.tsx`

- [ ] **Step 1: Hook**

```ts
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { apiFetch } from "../api"; // discover the actual export name in apps/dashboard/src/lib/api.ts

export type RoviUsage = {
  tier: "free" | "team" | "business" | "enterprise";
  unlimited: boolean;
  period: { start: string; end: string; daysLeft: number };
  messages: { used: number; limit: number | null; percent: number };
  tokens: { input: { used: number; limit: number | null }; output: { used: number; limit: number | null } };
  resetAt: string;
};

export function useRoviUsage() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  return useQuery({
    enabled: Boolean(projectId),
    queryKey: ["rovi-usage", projectId],
    queryFn: async () => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/copilot/usage`);
      const body = await res.json();
      return body.data as RoviUsage;
    },
    staleTime: 60_000,
  });
}
```

If `apiFetch` is named differently, look it up:

```bash
grep -nE "export (const|function) (apiFetch|fetch|request|api)" apps/dashboard/src/lib/api.ts
```

- [ ] **Step 2: Bar**

```tsx
import { useRoviUsage } from "../../lib/hooks/useRoviUsage";

export function RoviUsageBar() {
  const { data, isLoading } = useRoviUsage();
  if (isLoading || !data) return null;
  if (data.unlimited) {
    return (
      <div className="flex items-center justify-end gap-2 border-t border-rv-divider px-3 py-1.5 text-[10px] text-rv-mute-500">
        <span>Unlimited</span>
      </div>
    );
  }
  const pct = Math.min(100, data.messages.percent);
  const tone =
    pct >= 100 ? "bg-rv-danger" : pct >= 80 ? "bg-rv-warning" : "bg-rv-c4";
  return (
    <div className="border-t border-rv-divider px-3 py-1.5 text-[10px] text-rv-mute-600">
      <div className="flex items-center justify-between">
        <span>
          {data.messages.used.toLocaleString()} / {(data.messages.limit ?? 0).toLocaleString()} messages
        </span>
        <span>resets in {data.period.daysLeft}d</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-rv-c2">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
```

If `rv-danger` / `rv-warning` tokens don't exist in tailwind config, swap for nearest equivalents (`bg-red-500`, `bg-amber-500`).

- [ ] **Step 3: Wire into panel**

Append `<RoviUsageBar/>` after `<RoviPromptInput/>` in `rovi-panel.tsx`.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/lib/hooks/useRoviUsage.ts \
        apps/dashboard/src/components/rovi/rovi-usage-bar.tsx \
        apps/dashboard/src/components/rovi/rovi-panel.tsx
git commit -m "feat(rovi): usage bar at the bottom of the drawer"
```

---

### Task 10: Missing-config CTA (412 handling)

**Files:**
- Create: `apps/dashboard/src/components/rovi/rovi-missing-config.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-panel.tsx`

When `/chat` returns 412 `ROVI_NOT_CONFIGURED`, show a setup CTA instead of the empty state / conversation.

- [ ] **Step 1: Component**

```tsx
import { Link } from "@tanstack/react-router";

export function RoviMissingConfig({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-foreground">Rovi needs an API key</p>
      <p className="mt-1 max-w-[280px] text-xs text-rv-mute-600">
        Add a provider API key (OpenAI, Anthropic, Mistral, or local Ollama) to use
        Rovi in this project.
      </p>
      {isOwner ? (
        <Link
          to="/projects/$projectId/settings/rovi"
          params={{ projectId }}
          className="mt-4 inline-flex h-8 items-center rounded-md bg-rv-c4 px-3 text-xs font-medium text-foreground transition hover:opacity-90"
        >
          Add API key
        </Link>
      ) : (
        <p className="mt-4 text-[11px] text-rv-mute-500">Ask a project Owner to enable Rovi.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Detect ROVI_NOT_CONFIGURED in panel**

Edit `rovi-panel.tsx`. Add error handling from `useRoviChat`:

```tsx
const { messages, sendMessage, status, error } = useRoviChat({ threadId: currentThreadId });
const notConfigured = error?.message?.includes("ROVI_NOT_CONFIGURED");
```

Or — better — handle in `useRoviChat` by parsing the response in an `onError` callback and setting a flag. v6 `useChat` may expose error differently; probe and adapt.

Render branch:

```tsx
{notConfigured ? (
  <RoviMissingConfig projectId={projectId!} isOwner={/* derive from useProject().data.userRole */} />
) : messages.length === 0 ? (
  <RoviEmptyState />
) : (
  <RoviConversation messages={messages} />
)}
```

`isOwner` derivation — check the dashboard's existing `useProject` hook to see whether it returns the current user's role.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/rovi/rovi-missing-config.tsx \
        apps/dashboard/src/components/rovi/rovi-panel.tsx
git commit -m "feat(rovi): missing-config CTA when API returns ROVI_NOT_CONFIGURED"
```

---

### Task 11: ApprovalCard tool UI

**Files:**
- Create: `apps/dashboard/src/components/rovi/tools/approval-card.tsx`
- Create: `apps/dashboard/src/lib/hooks/useRoviIntents.ts`
- Modify: `apps/dashboard/src/components/rovi/rovi-tool-ui.tsx`

- [ ] **Step 1: Intents hook**

```ts
import { useMutation } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { apiFetch } from "../api";

export function useRoviIntents() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };

  const execute = useMutation({
    mutationFn: async (intentId: string) => {
      const res = await apiFetch(
        `/api/dashboard/projects/${projectId}/copilot/intents/${intentId}/execute`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "execute failed");
      return body.data;
    },
  });

  const reject = useMutation({
    mutationFn: async (intentId: string) => {
      const res = await apiFetch(
        `/api/dashboard/projects/${projectId}/copilot/intents/${intentId}/reject`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "reject failed");
      return body.data;
    },
  });

  return { execute, reject };
}
```

- [ ] **Step 2: ApprovalCard**

```tsx
import { useState } from "react";
import { useRoviIntents } from "../../../lib/hooks/useRoviIntents";

type IntentPayload = {
  intentId: string;
  toolName: string;
  requiresRole: string;
  preview: {
    title: string;
    fields: Array<{ label: string; before?: string | number | null; after: string | number | null }>;
  };
  expiresAt: string;
};

export function ApprovalCard({ intent }: { intent: IntentPayload }) {
  const { execute, reject } = useRoviIntents();
  const [decision, setDecision] = useState<"none" | "approved" | "rejected" | "failed">("none");
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    try {
      await execute.mutateAsync(intent.intentId);
      setDecision("approved");
    } catch (e) {
      setError((e as Error).message);
      setDecision("failed");
    }
  }
  async function cancel() {
    try {
      await reject.mutateAsync(intent.intentId);
      setDecision("rejected");
    } catch {
      // ignore reject failures
      setDecision("rejected");
    }
  }

  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <p className="mb-2 text-[11px] uppercase tracking-wide text-rv-mute-500">
        {intent.toolName} · requires {intent.requiresRole}
      </p>
      <p className="mb-2 text-sm font-medium text-foreground">{intent.preview.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-rv-mute-700">
        {intent.preview.fields.map((f, i) => (
          <div key={i} className="contents">
            <dt className="text-rv-mute-500">{f.label}</dt>
            <dd>
              {f.before !== undefined && f.before !== null ? (
                <>
                  <span className="text-rv-mute-500 line-through">{String(f.before)}</span>
                  {" → "}
                </>
              ) : null}
              <span className="text-foreground">{f.after === null ? "—" : String(f.after)}</span>
            </dd>
          </div>
        ))}
      </dl>

      {decision === "none" ? (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="h-7 rounded-md border border-rv-divider px-2.5 text-rv-mute-700 transition hover:bg-rv-c4 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={execute.isPending}
            className="h-7 rounded-md bg-rv-c4 px-2.5 text-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {execute.isPending ? "Running…" : "Approve & Run"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-rv-mute-600">
          {decision === "approved" && "Approved and executed."}
          {decision === "rejected" && "Cancelled."}
          {decision === "failed" && (error ?? "Execution failed.")}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Route action.* in RoviToolUI**

Edit `rovi-tool-ui.tsx`. Replace placeholder switch:

```tsx
import { ApprovalCard } from "./tools/approval-card";

export function RoviToolUI({ part }: { part: ToolPart }) {
  const name = part.toolName ?? "";
  if (name.startsWith("action.") && part.output && typeof part.output === "object") {
    return <ApprovalCard intent={part.output as never} />;
  }
  return (
    <pre className="overflow-auto rounded-md border border-rv-divider bg-rv-c2 p-2 text-[11px] text-rv-mute-700">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/rovi/tools/approval-card.tsx \
        apps/dashboard/src/lib/hooks/useRoviIntents.ts \
        apps/dashboard/src/components/rovi/rovi-tool-ui.tsx
git commit -m "feat(rovi): approval card for action.* tool calls"
```

---

### Task 12: Subscriber + Metrics tool renderers

**Files:**
- Create: `apps/dashboard/src/components/rovi/tools/subscriber-card.tsx`
- Create: `apps/dashboard/src/components/rovi/tools/subscriber-list.tsx`
- Create: `apps/dashboard/src/components/rovi/tools/metrics-chart.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-tool-ui.tsx`

These are query.* result renderers. Subscriber renderers fetch PII separately (sterilize keeps it out of LLM context).

- [ ] **Step 1: SubscriberCard**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { apiFetch } from "../../../lib/api";

export function SubscriberCard({ id, plan, status }: { id: string; plan?: string; status?: string }) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const { data } = useQuery({
    enabled: Boolean(projectId && id),
    queryKey: ["subscriber", projectId, id],
    queryFn: async () => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/subscribers/${id}`);
      const body = await res.json();
      return body.data;
    },
    staleTime: 30_000,
  });
  const email = data?.subscriber?.email ?? "—";
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <p className="text-[10px] uppercase tracking-wide text-rv-mute-500">{id}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{email}</p>
      <div className="mt-1 flex gap-3 text-rv-mute-600">
        {plan ? <span>plan: {plan}</span> : null}
        {status ? <span>status: {status}</span> : null}
      </div>
    </div>
  );
}
```

If the existing subscriber-detail endpoint path differs, look it up:

```bash
grep -nE "GET.*subscribers/:|subscribers/:id" apps/api/src/routes/dashboard/subscribers.ts | head
```

- [ ] **Step 2: SubscriberList**

```tsx
import type { ReactNode } from "react";
import { SubscriberCard } from "./subscriber-card";

export function SubscriberList({ subscribers }: { subscribers: Array<{ id: string; plan?: string; status?: string }> }): ReactNode {
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    return <p className="text-xs text-rv-mute-600">No subscribers match.</p>;
  }
  return (
    <div className="space-y-2">
      {subscribers.slice(0, 10).map((s) => (
        <SubscriberCard key={s.id} {...s} />
      ))}
      {subscribers.length > 10 ? (
        <p className="text-[11px] text-rv-mute-500">+{subscribers.length - 10} more</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: MetricsChart (mrr-only; churn/conversion shows "not implemented")**

```tsx
type MrrPayload = { series: Array<{ t: string; mrr: number }>; delta?: number; currency?: string };

export function MetricsChart({ name, output }: { name: string; output: unknown }) {
  if (name === "query.metrics.mrr") {
    const o = output as MrrPayload;
    const last = o.series?.[o.series.length - 1];
    return (
      <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
        <p className="text-[10px] uppercase tracking-wide text-rv-mute-500">MRR</p>
        <p className="mt-0.5 text-sm font-medium text-foreground">
          {last ? `${(last.mrr / 100).toLocaleString()} ${o.currency ?? ""}` : "—"}
        </p>
        {/* Simple inline sparkline — proper chart could come later */}
        <SparklineRow points={o.series?.map((s) => s.mrr) ?? []} />
      </div>
    );
  }
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs text-rv-mute-600">
      {name} is not implemented yet.
    </div>
  );
}

function SparklineRow({ points }: { points: number[] }) {
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  return (
    <div className="mt-2 flex h-6 items-end gap-0.5">
      {points.map((p, i) => (
        <div
          key={i}
          className="w-1 rounded-sm bg-rv-c4"
          style={{ height: `${Math.max(2, (p / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire into RoviToolUI**

```tsx
import { ApprovalCard } from "./tools/approval-card";
import { SubscriberCard } from "./tools/subscriber-card";
import { SubscriberList } from "./tools/subscriber-list";
import { MetricsChart } from "./tools/metrics-chart";

export function RoviToolUI({ part }: { part: ToolPart }) {
  const name = part.toolName ?? "";

  if (name.startsWith("action.") && part.output && typeof part.output === "object") {
    return <ApprovalCard intent={part.output as never} />;
  }
  if (name === "query.subscribers.get" && part.output && typeof part.output === "object") {
    return <SubscriberCard {...(part.output as { id: string; plan?: string; status?: string })} />;
  }
  if (name === "query.subscribers.search" && part.output && typeof part.output === "object") {
    const o = part.output as { subscribers?: Array<{ id: string; plan?: string; status?: string }> };
    return <SubscriberList subscribers={o.subscribers ?? []} />;
  }
  if (name.startsWith("query.metrics.")) {
    return <MetricsChart name={name} output={part.output} />;
  }
  return (
    <pre className="overflow-auto rounded-md border border-rv-divider bg-rv-c2 p-2 text-[11px] text-rv-mute-700">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/rovi/tools/subscriber-card.tsx \
        apps/dashboard/src/components/rovi/tools/subscriber-list.tsx \
        apps/dashboard/src/components/rovi/tools/metrics-chart.tsx \
        apps/dashboard/src/components/rovi/rovi-tool-ui.tsx
git commit -m "feat(rovi): subscriber + metrics tool-call renderers"
```

---

### Task 13: NavigateCard + ui.filter pass-through

**Files:**
- Create: `apps/dashboard/src/components/rovi/tools/navigate-card.tsx`
- Modify: `apps/dashboard/src/components/rovi/rovi-tool-ui.tsx`

- [ ] **Step 1: NavigateCard**

```tsx
import { useNavigate } from "@tanstack/react-router";

const ROUTE_MAP: Record<string, string> = {
  overview: "/projects/$projectId",
  subscribers: "/projects/$projectId/subscribers",
  subscriptions: "/projects/$projectId/subscriptions",
  products: "/projects/$projectId/products",
  audiences: "/projects/$projectId/audiences",
  experiments: "/projects/$projectId/experiments",
  featureFlags: "/projects/$projectId/feature-flags",
  transactions: "/projects/$projectId/transactions",
};

export function NavigateCard({
  projectId,
  output,
}: {
  projectId: string;
  output: { uiAction: "navigate" | "openSubscriber" | string; to?: string; id?: string };
}) {
  const navigate = useNavigate();

  function go() {
    if (output.uiAction === "openSubscriber" && output.id) {
      navigate({
        to: "/projects/$projectId/subscribers/$id",
        params: { projectId, id: output.id },
      });
      return;
    }
    if (output.uiAction === "navigate" && output.to) {
      const to = ROUTE_MAP[output.to];
      if (to) {
        navigate({ to: to as never, params: { projectId } });
      }
    }
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <span className="text-foreground">
        Go to <span className="font-medium">{output.to ?? output.id}</span>
      </span>
      <button
        type="button"
        onClick={go}
        className="h-7 rounded-md bg-rv-c4 px-2.5 text-foreground transition hover:opacity-90"
      >
        Open
      </button>
    </div>
  );
}
```

If the subscriber-detail route name in the dashboard differs from `/projects/$projectId/subscribers/$id`, look it up:

```bash
find apps/dashboard/src/routes -path "*subscribers*" -name "*.tsx" | head
```

- [ ] **Step 2: Route into RoviToolUI**

Add to the switch in `rovi-tool-ui.tsx` (insert before the JSON fallback):

```tsx
import { useParams } from "@tanstack/react-router";
import { NavigateCard } from "./tools/navigate-card";

// inside RoviToolUI:
const { projectId } = useParams({ strict: false }) as { projectId?: string };

if ((name === "ui.navigate" || name === "ui.openSubscriber") && projectId && part.output) {
  return <NavigateCard projectId={projectId} output={part.output as never} />;
}
```

(Don't add hooks conditionally; lift the `useParams` call to the top of `RoviToolUI`.)

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/rovi/tools/navigate-card.tsx \
        apps/dashboard/src/components/rovi/rovi-tool-ui.tsx
git commit -m "feat(rovi): navigate card for ui.* client-handled tools"
```

---

### Task 14: BYOK credentials hook

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useRoviCredentials.ts`

- [ ] **Step 1: Write**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { apiFetch } from "../api";

export type RoviCredentials = {
  provider: "openai" | "anthropic" | "mistral" | "ollama" | null;
  defaultModel: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  updatedAt: string | null;
};

export function useRoviCredentials() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const qc = useQueryClient();
  const queryKey = ["rovi-credentials", projectId];

  const query = useQuery({
    enabled: Boolean(projectId),
    queryKey,
    queryFn: async (): Promise<RoviCredentials> => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/copilot/credentials`);
      const body = await res.json();
      return body.data;
    },
    staleTime: 30_000,
  });

  const upsert = useMutation({
    mutationFn: async (input: {
      provider: "openai" | "anthropic" | "mistral" | "ollama";
      apiKey: string;
      defaultModel: string;
      baseUrl?: string;
    }) => {
      const res = await apiFetch(
        `/api/dashboard/projects/${projectId}/copilot/credentials`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `${res.status} ${res.statusText}`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const test = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(
        `/api/dashboard/projects/${projectId}/copilot/credentials/test`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "test failed");
      return body.data;
    },
  });

  return { query, upsert, test };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/lib/hooks/useRoviCredentials.ts
git commit -m "feat(rovi): credentials hook (get / upsert / test)"
```

---

### Task 15: BYOK settings page + sidebar tab

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/rovi.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/route.tsx`

- [ ] **Step 1: Add the tab**

In `settings/route.tsx`'s `TABS` array, add an entry right after `general` or wherever it sorts naturally:

```tsx
{
  id: "rovi",
  labelKey: "settings.tabs.rovi",
  icon: Sparkles,
  to: "/projects/$projectId/settings/rovi" as const,
  match: (id: string) => id.endsWith("/settings/rovi"),
},
```

Add `Sparkles` to the lucide-react import at top.

- [ ] **Step 2: Settings page**

`apps/dashboard/src/routes/_authed/projects/$projectId/settings/rovi.tsx`:

```tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useRoviCredentials } from "../../../../../lib/hooks/useRoviCredentials";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/rovi",
)({
  component: RoviSettingsRoute,
});

const PROVIDERS = ["openai", "anthropic", "mistral", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  mistral: "mistral-small",
  ollama: "llama3.1",
};

function RoviSettingsRoute() {
  useParams({ from: "/_authed/projects/$projectId/settings/rovi" });
  const { query, upsert, test } = useRoviCredentials();
  const existing = query.data;

  const [provider, setProvider] = useState<Provider>(
    (existing?.provider as Provider | null) ?? "openai",
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(existing?.defaultModel ?? DEFAULT_MODELS.openai);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function onProviderChange(next: Provider) {
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
  }

  async function save() {
    setSaveError(null);
    try {
      await upsert.mutateAsync({
        provider,
        apiKey,
        defaultModel: model,
        baseUrl: baseUrl || undefined,
      });
      setApiKey("");
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  async function runTest() {
    setTestResult(null);
    try {
      const result = await test.mutateAsync();
      setTestResult(`OK — ${result.model}`);
    } catch (e) {
      setTestResult(`Failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-2">
        <Sparkles size={18} className="text-rv-mute-600" />
        <h1 className="text-lg font-semibold text-foreground">Rovi</h1>
      </header>
      <p className="max-w-prose text-sm text-rv-mute-600">
        Bring your own API key so Rovi can run on your provider account. Keys are
        encrypted at rest (AES-256-GCM). Owners only.
      </p>

      <div className="space-y-4 rounded-md border border-rv-divider bg-rv-c1 p-4">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            Provider
          </label>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as Provider)}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground focus:border-rv-c4 focus:outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            API key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing?.hasKey ? "•••••••• (saved)" : "sk-…"}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground placeholder:text-rv-mute-500 focus:border-rv-c4 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-rv-mute-500">
            Leave blank to keep the existing key.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
            Default model
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground focus:border-rv-c4 focus:outline-none"
          />
        </div>

        {provider === "ollama" ? (
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-rv-mute-500">
              Base URL
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-sm text-foreground placeholder:text-rv-mute-500 focus:border-rv-c4 focus:outline-none"
            />
          </div>
        ) : null}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={save}
            disabled={upsert.isPending || (!apiKey && !existing?.hasKey)}
            className="h-9 rounded-md bg-rv-c4 px-3 text-sm font-medium text-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {upsert.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={!existing?.hasKey || test.isPending}
            className="h-9 rounded-md border border-rv-divider px-3 text-sm text-rv-mute-700 transition hover:bg-rv-c2 hover:text-foreground disabled:opacity-40"
          >
            {test.isPending ? "Testing…" : "Test"}
          </button>
          {testResult ? (
            <span className="text-xs text-rv-mute-600">{testResult}</span>
          ) : null}
          {saveError ? (
            <span className="text-xs text-red-500">{saveError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

If the `route.tsx` for settings filters which tabs are visible by role, ensure the Rovi tab is shown to OWNER and ADMIN at minimum, hidden for CUSTOMER_SUPPORT. Discover the role check in the existing settings tabs.

- [ ] **Step 3: Smoke**

```bash
pnpm --filter @rovenue/dashboard dev
```

Open `/projects/<id>/settings/rovi`, set a fake key, click Save → API should accept; click Test → returns success or provider error.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/rovi.tsx \
        apps/dashboard/src/routes/_authed/projects/\$projectId/settings/route.tsx
git commit -m "feat(rovi): settings → Rovi tab with BYOK upsert + test"
```

---

### Task 16: Plan 2 wrap

**Files:** none new.

- [ ] **Step 1: Final typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Build check**

```bash
pnpm --filter @rovenue/dashboard build
```

Expected: build succeeds (Vite + tsc bundle).

- [ ] **Step 3: Manual end-to-end smoke**

Run `pnpm dev` (api + dashboard). In a logged-in project:
- Topbar Sparkles → drawer opens, empty state.
- Settings → Rovi → paste a real OpenAI key, Save, Test → "OK — gpt-4o-mini".
- Drawer → send "show me MRR for the last 30 days" → assistant streams text, calls `query.metrics.mrr`, the MetricsChart renders.
- "find all subscribers on free plan" → SubscriberList renders.
- "create an audience for power users" → ApprovalCard renders → Approve → 200 + executed.
- Verify usage bar updates after a few messages.

- [ ] **Step 4: Write execution report**

Create `docs/superpowers/plans/2026-05-28-rovi-copilot-plan-2-frontend-execution-report.md` with:
- One-line goal recap.
- Per-task SHA + status.
- Notable v6 / ai-sdk-elements API surface adaptations.
- "Still deferred" list (anything from spec §15 that wasn't shipped).
- Smoke results.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-28-rovi-copilot-plan-2-frontend-execution-report.md
git commit -m "docs(rovi): plan 2 execution report"
```

---

## Self-Review

**1. Spec coverage:**
- §2 Topbar Sparkles + ⌘. + drawer + mobile takeover → Tasks 3, 4, 5.
- §2 Conversation, PromptInput, UsageBar → Tasks 7, 8, 9.
- §2 Tool UI renderers (SubscriberCard, SubscriberList, MetricsChart, ApprovalCard, NavigateCard) → Tasks 11, 12, 13.
- §2 RoviProvider context + useRovi hook → Task 2.
- §10 Missing-credentials CTA → Task 10.
- §10 BYOK per-project settings → Tasks 14, 15.
- API endpoints all consumed via hooks: `/copilot/chat` (Task 6), `/copilot/usage` (Task 9), `/copilot/intents/:id/{execute,reject}` (Task 11), `/copilot/credentials` (Task 14).

**2. Placeholder scan:**
- "Probe and adapt" notes in Tasks 1, 6, 7, 8 are deliberate fallbacks for v6 API name drift — not placeholder content. Each names the specific functions to inspect and what to substitute.
- Each component has complete JSX. No "render here later" stubs.

**3. Type consistency:**
- `RoviContextValue` defined in Task 2 is consumed unchanged in Tasks 3, 4, 5, 8, 10.
- `ToolPart` defined in Task 7 is the input shape for Tasks 11, 12, 13.
- `RoviUsage` (Task 9), `RoviCredentials` (Task 14), and `IntentPayload` (Task 11) match the backend response shapes documented in the spec §8.
