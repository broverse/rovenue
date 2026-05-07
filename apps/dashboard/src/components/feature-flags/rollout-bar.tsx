import { cn } from "../../lib/cn";

type Props = {
  pct: number;
  killed?: boolean;
  className?: string;
};

/**
 * Thin horizontal bar showing the rollout percentage.
 * Switches color when fully rolled out (success) or killed (danger).
 */
export function RolloutBar({ pct, killed = false, className }: Props) {
  const fillWidth = killed ? 100 : Math.max(0, Math.min(100, pct));
  return (
    <div
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-rv-c3",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          killed
            ? "bg-rv-danger"
            : pct >= 100
              ? "bg-rv-success"
              : "bg-rv-accent-500",
        )}
        style={{ width: `${fillWidth}%` }}
      />
    </div>
  );
}
