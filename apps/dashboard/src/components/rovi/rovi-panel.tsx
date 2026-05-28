import { useRovi } from "../../lib/hooks/useRovi";
import { useRoviChat } from "../../lib/hooks/useRoviChat";
import { RoviHeader } from "./rovi-header";
import { RoviEmptyState } from "./rovi-empty-state";
import { RoviConversation } from "./rovi-conversation";
import { RoviPromptInput } from "./rovi-prompt-input";

export function RoviPanel() {
  const { open, setOpen, currentThreadId } = useRovi();
  // `useRoviChat` returns null when no `projectId` is in scope (e.g.
  // the panel is mounted at app-root before the user has entered a
  // project). Gate on that before reading `messages`.
  const chat = useRoviChat({ threadId: currentThreadId });
  const messages = chat?.messages ?? [];
  const busy = chat?.status === "streaming" || chat?.status === "submitted";
  const send = (text: string) => {
    void chat?.sendMessage({ text });
  };

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
        {messages.length === 0 ? (
          <RoviEmptyState />
        ) : (
          <RoviConversation messages={messages} />
        )}
        <RoviPromptInput disabled={busy || !chat} onSubmit={send} />
      </aside>
    </>
  );
}
