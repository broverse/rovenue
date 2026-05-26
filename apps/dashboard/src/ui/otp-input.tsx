import {
  useMemo,
  useRef,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "../lib/cn";

type OTPInputProps = {
  value: string;
  onChange: (next: string) => void;
  /** Fired the moment all 6 slots hold a digit. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  /** Tells screen readers what the code unlocks (e.g. "Authentication code"). */
  ariaLabel?: string;
  /** Visually highlights all slots red — use when verification just failed. */
  invalid?: boolean;
  className?: string;
};

/**
 * Six-slot numeric one-time-password input with auto-advance,
 * backspace-back, arrow-key navigation, and paste-fills-all.
 *
 * Shared between the security page's enrollment dialog and the
 * sign-in /2fa verify page.
 */
export function OTPInput({
  value,
  onChange,
  onComplete,
  disabled,
  ariaLabel,
  invalid,
  className,
}: OTPInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = useMemo(() => {
    const out = ["", "", "", "", "", ""];
    for (let i = 0; i < Math.min(6, value.length); i++) out[i] = value[i] ?? "";
    return out;
  }, [value]);

  const focus = (i: number) => {
    const el = refs.current[i];
    if (el) {
      el.focus();
      el.select();
    }
  };

  const set = (i: number, ch: string) => {
    const next = digits.slice();
    next[i] = ch;
    const joined = next.join("");
    onChange(joined);
    if (joined.length === 6 && /^\d{6}$/.test(joined)) onComplete?.(joined);
  };

  const handleChange = (i: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, "");
    if (!raw) {
      set(i, "");
      return;
    }
    // Handle paste / fast-type that lands multiple chars in one box.
    if (raw.length > 1) {
      const next = (digits.join("") + raw).replace(/\D/g, "").slice(0, 6);
      onChange(next);
      const land = Math.min(5, next.length);
      focus(land);
      if (next.length === 6) onComplete?.(next);
      return;
    }
    set(i, raw);
    if (i < 5) focus(i + 1);
  };

  const handleKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      focus(i - 1);
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight" && i < 5) {
      e.preventDefault();
      focus(i + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    e.preventDefault();
    onChange(text);
    focus(Math.min(5, text.length - 1));
    if (text.length === 6) onComplete?.(text);
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex justify-center gap-2", className)}
    >
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          value={d}
          disabled={disabled}
          onChange={handleChange(i)}
          onKeyDown={handleKeyDown(i)}
          onPaste={handlePaste}
          aria-label={`Digit ${i + 1}`}
          className={cn(
            "h-12 w-10 rounded-md border bg-rv-c2 text-center font-rv-mono text-[20px] font-semibold text-foreground caret-rv-accent-500 transition focus:outline-none sm:h-14 sm:w-12 sm:text-[24px]",
            invalid
              ? "border-rv-danger/60 focus:border-rv-danger focus:ring-2 focus:ring-rv-danger/30"
              : d
                ? "border-rv-accent-500/60 focus:border-rv-accent-500 focus:ring-2 focus:ring-rv-accent-500/30"
                : "border-rv-divider hover:border-rv-divider-strong focus:border-rv-accent-500 focus:ring-2 focus:ring-rv-accent-500/30",
            disabled && "cursor-not-allowed opacity-60",
          )}
        />
      ))}
    </div>
  );
}
