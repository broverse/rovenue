import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = {
  /** Signed lift value in percent. 0 renders as "flat" (placeholder). */
  value: number;
  /** Render only the arrow + percent without the surrounding pill. */
  inline?: boolean;
  /** Override the inner content — used for "— baseline" placeholders. */
  children?: ReactNode;
};

/**
 * Up/down/flat lift pill. Mirrors the design's `.lift-pill` — colored
 * by sign with a subtle border, mono font for the percent, lucide arrows
 * instead of unicode triangles.
 */
export function LiftPill({ value, inline, children }: Props) {
  const flat = value === 0;
  const up = value > 0;

  if (children) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-rv-divider bg-rv-c2 px-2 py-px font-rv-mono text-[11px] font-medium text-rv-mute-500">
        {children}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-rv-mono text-[11px] font-medium tabular-nums",
        !inline && "rounded-md border px-2 py-px",
        !inline && flat && "border-rv-divider bg-rv-c2 text-rv-mute-500",
        !inline && up && "border-rv-success/30 bg-rv-success/10 text-rv-success",
        !inline && !flat && !up && "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
        inline && flat && "text-rv-mute-500",
        inline && up && "text-rv-success",
        inline && !flat && !up && "text-rv-danger",
      )}
    >
      {flat ? null : up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {up ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}
