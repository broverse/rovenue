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
          // Enter submits; Shift+Enter inserts newline. We must call
          // preventDefault() ourselves — a plain <textarea> would
          // otherwise both send AND insert a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
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
