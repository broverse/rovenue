import { useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";

type TagInputProps = {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
};

/**
 * Comma- and Enter-delimited tag input. Tags are normalized to lowercase
 * and de-duplicated. The trailing input grows to fill remaining width.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
      setDraft("");
    } else if (event.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 p-1.5 transition focus-within:border-rv-accent-500 focus-within:ring-2 focus-within:ring-rv-accent-500/30",
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded border border-rv-divider bg-rv-c3 px-2 py-0.5 font-rv-mono text-[11px] text-foreground"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((existing) => existing !== tag))}
            className="text-rv-mute-500 transition hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft) {
            commit(draft);
            setDraft("");
          }
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        className="min-w-[120px] flex-1 bg-transparent px-1.5 py-0.5 text-[13px] text-foreground placeholder:text-rv-mute-500 focus:outline-none"
      />
    </div>
  );
}
