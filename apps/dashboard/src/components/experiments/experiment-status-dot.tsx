import { cn } from "../../lib/cn";
import type { ExperimentStatus } from "./types";

type Props = {
  status: ExperimentStatus;
  className?: string;
};

/**
 * 7px round status indicator. Running adds a pulsing accent halo so the
 * dot reads as "live" in dense list rows; the other statuses are solid.
 */
export function ExperimentStatusDot({ status, className }: Props) {
  return (
    <span className={cn("relative inline-flex size-[7px] flex-shrink-0", className)}>
      <span
        className={cn(
          "size-[7px] rounded-full",
          status === "running" && "bg-rv-accent-500",
          status === "completed" && "bg-rv-success",
          status === "stopped" && "bg-rv-danger",
          status === "draft" && "bg-rv-mute-400",
          status === "paused" && "bg-rv-warning",
        )}
      />
      {status === "running" && (
        <span
          aria-hidden
          className="absolute inset-0 -m-[3px] rounded-full bg-rv-accent-500/20"
          style={{ animation: "var(--animate-rv-pulse)" }}
        />
      )}
    </span>
  );
}
