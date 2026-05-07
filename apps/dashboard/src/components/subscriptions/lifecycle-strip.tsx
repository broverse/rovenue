import { cn } from "../../lib/cn";

type Props = {
  /** Position along the cycle, 0–100. Drives where the "now" cursor sits. */
  pct: number;
  /** When set, the segment immediately before "now" renders as an issue marker. */
  hasIssue?: boolean;
  segments?: number;
  className?: string;
};

/**
 * 12-segment timeline summarizing where the subscription sits in its
 * billing cycle. Past segments are accent-tinted, the current segment
 * pulses, and future segments are dim.
 */
export function LifecycleStrip({
  pct,
  hasIssue = false,
  segments = 12,
  className,
}: Props) {
  const pastEnd = Math.max(0, Math.min(segments, Math.floor((pct / 100) * segments)));

  return (
    <div
      className={cn(
        "inline-flex h-1.5 w-[160px] items-center gap-px",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: segments }).map((_, i) => {
        const isIssue = hasIssue && i === pastEnd - 1;
        const isPast = i < pastEnd;
        const isNow = i === pastEnd;
        return (
          <span
            key={i}
            className={cn(
              "h-full rounded-[1px]",
              isIssue && "bg-rv-danger/90",
              !isIssue && isPast && "bg-rv-accent-500/80",
              !isIssue && isNow &&
                "bg-rv-accent-400 ring-2 ring-rv-accent-500/25",
              !isIssue && !isPast && !isNow && "bg-rv-c3",
            )}
            style={{ flex: isNow ? 1.5 : 1 }}
          />
        );
      })}
    </div>
  );
}
