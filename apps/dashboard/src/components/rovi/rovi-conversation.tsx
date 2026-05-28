import type { UIMessage } from "ai";
import { RotateCcw, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { RoviToolUI, type ToolPart } from "./rovi-tool-ui";

// Running transcript for `useRoviChat`. Layout follows the Vercel
// ai-chatbot / v0.dev pattern:
//
//   • assistant turns — no bubble, full-column flowing text, a small
//     Sparkles glyph on the left as a turn anchor.
//   • user turns — right-aligned pill bubble, narrower than the column.
//   • tool parts (from `RoviToolUI`) slot inline within the assistant
//     turn's body so an `action_*` approval card / metrics card lives
//     visually beneath the model's prose.
//
// Streaming affordances:
//
//   • `status === 'submitted'` (request sent, no first byte yet) — we
//     show a TypingIndicator turn so the user immediately sees Rovi
//     "thinking" instead of dead air.
//   • `status === 'streaming'` — the last assistant text part gets a
//     blinking caret appended so it's obvious bytes are still arriving
//     (the text itself updates per chunk because v6 useChat rewrites
//     `messages` on every delta).
//
// Auto-scroll: we keep a sentinel `<div>` at the bottom and scroll it
// into view ONLY when the user was already near the bottom — never
// yank them up if they've scrolled back to read older context.
export function RoviConversation({
  messages,
  status,
  errorMessage,
  onRetry,
}: {
  messages: UIMessage[];
  status: "ready" | "submitted" | "streaming" | "error" | string | undefined;
  errorMessage?: string | null;
  onRetry?: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user is "near the bottom". We update this on every
  // scroll event so the auto-scroll effect can decide whether it's polite
  // to follow new content.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 100;
  }, []);

  // Compute a content fingerprint that changes for every new message AND
  // every new chunk inside the last message — so streaming deltas
  // re-trigger the auto-scroll effect, not just whole new turns.
  const last = messages[messages.length - 1];
  const lastTextLen = last
    ? (last.parts ?? []).reduce(
        (n, p) => (p.type === "text" ? n + (p.text?.length ?? 0) : n),
        0,
      )
    : 0;

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, lastTextLen, status]);

  // First mount + thread switch: jump (not smooth) to the bottom so the
  // user lands at the live edge of the transcript.
  useEffect(() => {
    sentinelRef.current?.scrollIntoView({ block: "end" });
    stickToBottomRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isStreaming = status === "streaming";
  const isSubmitted = status === "submitted";
  // Show the typing indicator only when we're between user-sent and
  // first-byte. Once any assistant text/tool part arrives we let the
  // streaming caret take over.
  const showTypingTurn =
    isSubmitted && (!last || last.role === "user");

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto scroll-smooth"
    >
      <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-4 py-6">
        {messages.map((m, mi) => {
          const isUser = m.role === "user";
          const isLast = mi === messages.length - 1;
          return (
            <Turn key={m.id} role={isUser ? "user" : "assistant"}>
              {isUser ? (
                <UserBubble>
                  {m.parts?.map((p, i) =>
                    p.type === "text" ? (
                      <span key={i} className="whitespace-pre-wrap">
                        {p.text}
                      </span>
                    ) : null,
                  )}
                </UserBubble>
              ) : (
                <AssistantBody
                  parts={m.parts ?? []}
                  streaming={isLast && isStreaming}
                />
              )}
            </Turn>
          );
        })}

        {showTypingTurn ? (
          <Turn role="assistant">
            <TypingIndicator />
          </Turn>
        ) : null}

        {status === "error" && errorMessage && onRetry ? (
          <ErrorBanner message={errorMessage} onRetry={onRetry} />
        ) : null}

        <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
      </div>
    </div>
  );
}

// ---------- internals ----------

function Turn({
  role,
  children,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div
      aria-hidden="true"
      className="relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c1 text-rv-mute-700 shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset]"
    >
      <Sparkles size={12} strokeWidth={2} />
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl rounded-br-sm border border-rv-divider bg-rv-c3 px-3.5 py-2 text-[13px] leading-relaxed text-foreground">
      {children}
    </div>
  );
}

function AssistantBody({
  parts,
  streaming,
}: {
  parts: NonNullable<UIMessage["parts"]>;
  streaming: boolean;
}) {
  // Index of the last text part — only that one gets the blinking caret
  // (we don't want a caret on a paragraph that already finished).
  let lastTextIdx = -1;
  parts.forEach((p, i) => {
    if (p.type === "text") lastTextIdx = i;
  });

  return (
    <div className="space-y-3 text-[13.5px] leading-[1.65] text-rv-mute-800">
      {parts.map((p, i) => {
        if (p.type === "text") {
          const isLastText = i === lastTextIdx;
          return (
            <p key={i} className="whitespace-pre-wrap">
              {p.text}
              {streaming && isLastText ? <Caret /> : null}
            </p>
          );
        }
        if (typeof p.type === "string" && p.type.startsWith("tool-")) {
          return (
            <div key={i} className="my-1">
              <RoviToolUI part={p as unknown as ToolPart} />
            </div>
          );
        }
        return null;
      })}
      {/* Edge case: tool-only turn with no text yet but we're still
          streaming — show the caret alone so we don't render an empty
          assistant turn during a tool round-trip. */}
      {streaming && lastTextIdx === -1 ? (
        <p className="m-0">
          <Caret />
        </p>
      ) : null}
    </div>
  );
}

function Caret() {
  // Inline blink — `animate-[...]` with arbitrary keyframes so we don't
  // have to touch the global stylesheet. 1.1s cadence matches macOS
  // Terminal & feels less frantic than a 0.6s blink.
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[2px] -mb-[2px] translate-y-[3px] bg-rv-mute-800 align-baseline animate-[rv-caret_1.1s_steps(1)_infinite]"
      style={{
        // Inject the keyframe lazily — Tailwind's JIT won't generate
        // arbitrary `animate-[name]` rules without the @keyframes
        // existing somewhere. Defining it via a sibling <style> keeps
        // the component self-contained.
      }}
    />
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <Dot delay={0} />
      <Dot delay={160} />
      <Dot delay={320} />
      <span className="ml-1.5 text-[11px] uppercase tracking-[0.14em] text-rv-mute-500">
        Thinking
      </span>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[5px] rounded-full bg-rv-mute-600 animate-[rv-dot_1.2s_ease-in-out_infinite]"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  // Trim noisy provider/HTTP prefixes so we surface something human in
  // the banner — falls back to the raw message when nothing matches.
  const [showFull, setShowFull] = useState(false);
  const short =
    message.replace(/^Error:\s*/i, "").slice(0, 180) +
    (message.length > 180 ? "…" : "");
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rv-danger/40 bg-rv-danger/[0.06] px-3 py-2.5 text-[12px] text-rv-mute-800">
      <div className="flex-1">
        <p className="font-medium text-foreground">Something went wrong</p>
        <p className="mt-0.5 text-rv-mute-600">
          {showFull ? message : short}
        </p>
        {message.length > short.length ? (
          <button
            type="button"
            onClick={() => setShowFull((v) => !v)}
            className="mt-1 text-[11px] uppercase tracking-wide text-rv-mute-500 hover:text-rv-mute-700"
          >
            {showFull ? "Show less" : "Show details"}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-[11px] font-medium text-foreground transition hover:bg-rv-c3"
      >
        <RotateCcw size={12} />
        Retry
      </button>
    </div>
  );
}
