import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = {
  active?: boolean;
  /** Solid (non-dashed) variant — used for the "Add filter" CTA. */
  solid?: boolean;
  children: ReactNode;
  onClick?: () => void;
};

/**
 * Compact dashed-border pill used in the subscribers filter bar. Active
 * state swaps to a solid accent-tinted background with no dash.
 */
export function FilterPill({ active, solid, children, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      className={cn(
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] text-rv-mute-700 transition",
        !active && !solid && "border border-dashed border-rv-divider-strong bg-rv-c2 hover:bg-rv-c3 hover:text-foreground",
        !active && solid && "border border-rv-divider bg-rv-c2 hover:bg-rv-c3 hover:text-foreground",
        active &&
          "border border-rv-accent-500/45 bg-rv-accent-500/15 text-[color-mix(in_srgb,var(--color-rv-accent-400)_80%,white)]",
      )}
    >
      {children}
    </button>
  );
}
