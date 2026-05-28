import { ArrowUp, Square } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

// Vercel ai-chatbot style composer. Pill-rounded container with a
// circular submit/stop button living inside the input on the right.
//
// Keyboard behaviour matches a power-user expectation:
//   • Enter        → submit
//   • Shift+Enter  → newline
//   • Esc          → clear + blur (we stopPropagation so the global
//                    `Esc → close drawer` handler doesn't fire while
//                    the user is mid-typing)
//
// While the chat is mid-flight the send button becomes a stop button
// that calls `onStop()` (which fans out to `chat.stop()` from
// `useRoviChat`). The textarea itself stays editable so the user can
// queue their next prompt — submitting is just disabled until ready.
//
// Autosize: we grow the textarea from one row up to `maxRows` (default
// 6) by measuring scrollHeight on each input. The `min-h` from the
// initial rows attribute caps the floor; CSS handles the overflow
// scroll once we cap out.
export type RoviPromptInputHandle = {
  /** Programmatically set the input value (used by empty-state chips). */
  setText: (next: string) => void;
  /** Focus the textarea. */
  focus: () => void;
};

export const RoviPromptInput = forwardRef<
  RoviPromptInputHandle,
  {
    disabled?: boolean;
    busy?: boolean;
    onSubmit: (text: string) => void;
    onStop?: () => void;
  }
>(function RoviPromptInput({ disabled, busy, onSubmit, onStop }, ref) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      setText: (next: string) => {
        setText(next);
        // defer focus until after the controlled value lands so the
        // caret ends up at the end of the new content
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(next.length, next.length);
        });
      },
      focus: () => taRef.current?.focus(),
    }),
    [],
  );

  // Autosize the textarea between 1 and ~6 lines. We reset height to
  // `auto` first so shrinking works (scrollHeight is sticky otherwise).
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 6 * 22; // 22px ≈ leading-relaxed at 13.5px
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  // Cmd/Ctrl+K → focus the input from anywhere in the drawer. Easier
  // than hunting for the textarea after switching threads.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        taRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled || busy) return;
    onSubmit(t);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter newlines. Default <textarea> would
    // double-fire (send + insert) so we must preventDefault on the
    // send branch.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // Esc clears + blurs. Stop the event so the drawer's global Esc
    // handler doesn't ALSO close the panel out from under us.
    if (e.key === "Escape") {
      if (text.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setText("");
        return;
      }
      // empty input → let Esc bubble to close the drawer
      e.currentTarget.blur();
    }
  }

  const canSend = text.trim().length > 0 && !disabled && !busy;
  const showStop = busy && !!onStop;

  return (
    <form onSubmit={submit} className="px-3 pb-3 pt-1">
      <div
        className={
          "group relative flex items-end gap-2 rounded-2xl border border-rv-divider bg-rv-c1 px-3 py-2.5 " +
          "transition-[border-color,box-shadow,background-color] duration-150 " +
          "focus-within:border-rv-divider-strong focus-within:bg-rv-c2 " +
          "focus-within:shadow-[0_0_0_4px_rgba(255,255,255,0.025)] " +
          (disabled ? "opacity-60" : "")
        }
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={busy ? "Rovi is responding…" : "Ask Rovi anything…"}
          disabled={disabled}
          spellCheck
          // Leave room on the right for the absolutely-positioned send
          // button so long lines don't crash into it.
          className="block w-full resize-none bg-transparent pr-10 text-[13.5px] leading-[22px] text-foreground placeholder:text-rv-mute-500 focus:outline-none disabled:cursor-not-allowed"
          style={{ minHeight: 22, maxHeight: 132 }}
        />

        <button
          type={showStop ? "button" : "submit"}
          onClick={showStop ? onStop : undefined}
          disabled={!showStop && !canSend}
          aria-label={showStop ? "Stop generating" : "Send message"}
          title={showStop ? "Stop" : "Send (Enter)"}
          className={
            "absolute bottom-2 right-2 flex size-7 items-center justify-center rounded-full transition " +
            (showStop
              ? "bg-rv-mute-700 text-rv-bg hover:bg-rv-mute-800"
              : canSend
                ? "bg-foreground text-rv-bg hover:opacity-90"
                : "bg-rv-c3 text-rv-mute-500")
          }
        >
          {showStop ? (
            <Square size={11} fill="currentColor" strokeWidth={0} />
          ) : (
            <ArrowUp size={14} strokeWidth={2.5} />
          )}
        </button>
      </div>

      {/* Footer hint row — kept airy so it doesn't fight the input. */}
      <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-rv-mute-500">
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd>
          <span>send</span>
          <span className="mx-1 text-rv-mute-400">·</span>
          <Kbd>Shift</Kbd>
          <span>+</span>
          <Kbd>Enter</Kbd>
          <span>newline</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>.</Kbd>
          <span>to close</span>
        </span>
      </div>
    </form>
  );
});

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[3px] border border-rv-divider bg-rv-c2 px-[3px] font-rv-mono text-[9px] leading-none text-rv-mute-600">
      {children}
    </kbd>
  );
}
