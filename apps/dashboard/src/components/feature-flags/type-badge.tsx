import { cn } from "../../lib/cn";
import type { FlagType } from "./types";

type Props = {
  type: FlagType;
  size?: "sm" | "md";
  className?: string;
};

const SYMBOL: Record<FlagType, string> = {
  bool: "B",
  string: "S",
  number: "#",
  json: "{}",
};

const TONE: Record<FlagType, string> = {
  bool: "border-rv-accent-500/30 bg-rv-accent-500/15 text-rv-accent-400",
  string: "border-rv-success/30 bg-rv-success/15 text-rv-success",
  number: "border-rv-warning/30 bg-rv-warning/15 text-rv-warning",
  json: "border-rv-violet/30 bg-rv-violet/15 text-rv-violet",
};

/**
 * Square type badge — bool/string/number/json mapped to a one-glyph monogram.
 * `sm` (22px) for list rows, `md` (32px) for the detail-panel header.
 */
export function TypeBadge({ type, size = "sm", className }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border font-rv-mono font-bold",
        size === "md"
          ? "size-8 text-[12px]"
          : "size-[22px] text-[10px]",
        TONE[type],
        className,
      )}
    >
      {SYMBOL[type]}
    </span>
  );
}
