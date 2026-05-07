import { cn } from "../../lib/cn";

type UsageRowProps = {
  name: string;
  description?: string;
  capLabel?: string;
  current: number;
  limit: number;
};

/**
 * Single bar-and-percentage row used in the Usage tab. Bar tint shifts to
 * warning at >75% and danger at >90% of the configured limit.
 */
export function UsageRow({ name, description, capLabel, current, limit }: UsageRowProps) {
  const pct = limit === 0 ? 0 : (current / limit) * 100;
  const tone = pct > 90 ? "bg-rv-danger" : pct > 75 ? "bg-rv-warning" : "bg-rv-accent-500";

  return (
    <div className="grid items-center gap-3.5 border-b border-white/5 py-2.5 last:border-b-0 grid-cols-[200px_1fr_80px] max-[720px]:grid-cols-1 max-[720px]:gap-1.5">
      <div className="min-w-0">
        <div className="text-[12px] text-rv-mute-700">{name}</div>
        {description || capLabel ? (
          <div className="mt-0.5 text-[11px] text-rv-mute-500">
            {description}
            {capLabel ? <span className="text-rv-mute-700"> · {capLabel}</span> : null}
          </div>
        ) : null}
      </div>
      <div>
        <div className="h-1.5 overflow-hidden rounded-[3px] bg-rv-c3">
          <div
            className={cn("h-full rounded-[3px]", tone)}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
          {current.toLocaleString()} / {limit.toLocaleString()}
        </div>
      </div>
      <div className="text-right font-rv-mono text-[12px] tabular-nums">
        {pct.toFixed(1)}%
      </div>
    </div>
  );
}
