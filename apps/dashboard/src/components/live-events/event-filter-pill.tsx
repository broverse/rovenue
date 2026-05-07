import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  count?: number | string;
};

const baseClass =
  "inline-flex h-[26px] cursor-pointer select-none items-center gap-1 rounded-full border px-2.5 text-[12px] transition";

const inactiveClass = "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:border-rv-c4";

const activeClass =
  "border-rv-accent-500/35 bg-rv-accent-500/15 text-rv-accent-400 hover:border-rv-accent-500/50";

const countBaseClass =
  "rounded-full px-1.5 py-px font-rv-mono text-[10px] tabular-nums";

const countInactive = "bg-rv-c4 text-rv-mute-600";
const countActive = "bg-rv-accent-500/25 text-rv-accent-400";

/**
 * Pill chip used in the live-events filter row — toggles a category,
 * platform, or active type filter. Dropdown-style count badge optional.
 */
export function EventFilterPill({ active, onClick, children, count }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      className={cn(baseClass, active ? activeClass : inactiveClass)}
    >
      <span>{children}</span>
      {count != null && (
        <span className={cn(countBaseClass, active ? countActive : countInactive)}>{count}</span>
      )}
    </button>
  );
}
