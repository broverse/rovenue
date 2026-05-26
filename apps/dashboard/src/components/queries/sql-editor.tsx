import { useMemo, type ChangeEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

/**
 * Editable SQL pane — line numbers gutter on the left, a synced
 * monospace textarea on the right. ⌘/Ctrl + Enter calls `onSubmit`.
 */
export function SqlEditor({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const lineCount = useMemo(
    () => Math.max(1, value.split("\n").length),
    [value],
  );
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1),
    [lineCount],
  );

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div className="relative grid max-h-80 min-h-[280px] grid-cols-[44px_1fr] overflow-auto bg-rv-bg font-rv-mono text-[13px] leading-[1.7]">
      <div
        aria-hidden
        className="select-none pt-3.5 pr-3.5 text-right text-rv-mute-500 opacity-50"
      >
        {lineNumbers.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        placeholder={placeholder ?? t("queries.editor.placeholder")}
        aria-label={ariaLabel ?? t("queries.editor.aria")}
        disabled={disabled}
        className={cn(
          "block min-h-full w-full resize-none border-0 bg-transparent py-3.5 pr-3.5 font-rv-mono text-[13px] leading-[1.7] text-foreground outline-none placeholder:text-rv-mute-500",
          "whitespace-pre",
        )}
        style={{
          // Keep the textarea sized to its content so the gutter scrolls in lock-step.
          minHeight: `${lineCount * 1.7}em`,
        }}
      />
    </div>
  );
}
