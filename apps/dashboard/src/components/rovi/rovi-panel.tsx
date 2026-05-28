import { useParams } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useRovi } from "../../lib/hooks/useRovi";
import { useRoviChat } from "../../lib/hooks/useRoviChat";
import { RoviConversation } from "./rovi-conversation";
import { RoviEmptyState } from "./rovi-empty-state";
import { RoviHeader } from "./rovi-header";
import { RoviMissingConfig } from "./rovi-missing-config";
import { RoviPromptInput, type RoviPromptInputHandle } from "./rovi-prompt-input";
import { RoviUsageBar } from "./rovi-usage-bar";

export function RoviPanel() {
  const { open, setOpen, currentThreadId } = useRovi();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  // `useRoviChat` returns null when no `projectId` is in scope (e.g.
  // the panel is mounted at app-root before the user has entered a
  // project). Gate on that before reading `messages`.
  const chat = useRoviChat({ threadId: currentThreadId });
  const messages = chat?.messages ?? [];
  const status = chat?.status;
  const busy = status === "streaming" || status === "submitted";
  const errorText = chat?.error instanceof Error ? chat.error.message : "";
  const notConfigured =
    status === "error" && /ROVI_NOT_CONFIGURED|412/i.test(errorText);
  // Surface generic stream errors as a retry banner inline; suppress
  // the not-configured case because `RoviMissingConfig` already owns
  // that UX.
  const inlineError =
    status === "error" && !notConfigured ? errorText || "Stream failed" : null;

  const send = useCallback(
    (text: string) => {
      void chat?.sendMessage({ text });
    },
    [chat],
  );

  const promptRef = useRef<RoviPromptInputHandle | null>(null);
  // Empty-state chips: clicking one auto-sends the prompt AND mirrors
  // the text into the composer briefly so the user sees what fired.
  const pickPrompt = useCallback(
    (prompt: string) => {
      if (!chat) return;
      promptRef.current?.setText(prompt);
      // small delay so the input flashes the chosen prompt before
      // submitMessage clears it — feels less magical/spooky
      requestAnimationFrame(() => {
        promptRef.current?.setText("");
        send(prompt);
      });
    },
    [chat, send],
  );

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
          "md:w-[420px] lg:w-[460px] " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <RoviHeader />
        {notConfigured && projectId ? (
          <RoviMissingConfig projectId={projectId} />
        ) : messages.length === 0 ? (
          <RoviEmptyState onPickPrompt={chat ? pickPrompt : undefined} />
        ) : (
          <RoviConversation
            messages={messages}
            status={status}
            errorMessage={inlineError}
            onRetry={() => void chat?.regenerate()}
          />
        )}
        <RoviPromptInput
          ref={promptRef}
          disabled={!chat || notConfigured}
          busy={busy}
          onSubmit={send}
          onStop={() => chat?.stop()}
        />
        <RoviUsageBar />
      </aside>
    </>
  );
}
