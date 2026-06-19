import { Loader2 } from "lucide-react";

type Props = {
  /** Extra height to match the chart-sized empty state. */
  large?: boolean;
  className?: string;
};

/**
 * Centered loading spinner for panels that don't have data yet. Shares the
 * min-height with {@link EmptyStateCard} so the layout doesn't jump when a
 * load resolves into an empty state.
 */
export function LoadingState({ large, className = "" }: Props) {
  return (
    <div
      className={`flex flex-1 items-center justify-center ${large ? "min-h-[360px]" : "min-h-[320px]"} ${className}`}
    >
      <Loader2 size={20} className="animate-spin text-rv-mute-500" />
    </div>
  );
}
