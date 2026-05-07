import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

type CardPickProps = {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  className?: string;
};

/**
 * Radio styled as a card with a selection check pinned to the top-right
 * corner when active. Purely presentational — caller owns selection state.
 */
export function CardPick({
  selected,
  onSelect,
  title,
  description,
  leading,
  className,
}: CardPickProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md border bg-rv-c2 px-4 py-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-rv-bg",
        selected
          ? "border-rv-accent-500 bg-rv-accent-500/10"
          : "border-rv-divider hover:border-rv-divider-strong",
        className,
      )}
    >
      {selected ? (
        <span className="absolute right-3 top-2.5 inline-flex size-[18px] items-center justify-center rounded-full bg-rv-accent-500 text-white">
          <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />
        </span>
      ) : null}
      {leading ? (
        <div className="flex items-center gap-2.5">
          {leading}
          <div className="text-[13px] font-medium text-foreground">{title}</div>
        </div>
      ) : (
        <div className="text-[13px] font-medium text-foreground">{title}</div>
      )}
      {description ? (
        <div className="text-[11px] leading-relaxed text-rv-mute-500">
          {description}
        </div>
      ) : null}
    </button>
  );
}

type CardPickGridProps = {
  columns?: 2 | 3;
  children: ReactNode;
  className?: string;
};

export function CardPickGrid({
  columns = 2,
  children,
  className,
}: CardPickGridProps) {
  return (
    <div
      className={cn(
        "grid gap-2.5",
        columns === 3
          ? "grid-cols-1 sm:grid-cols-3"
          : "grid-cols-1 sm:grid-cols-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
