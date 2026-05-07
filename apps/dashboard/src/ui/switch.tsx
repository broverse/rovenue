import { cn } from "../lib/cn";

export type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
};

/**
 * Track-and-thumb toggle. Animates the thumb on state change. Click handler
 * mirrors the underlying boolean — caller owns persistence.
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  className,
  disabled,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-rv-bg disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-rv-accent-500" : "bg-rv-c4",
        className,
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 size-4 rounded-full bg-white transition-transform duration-200 ease-out",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
