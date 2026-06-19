import { cn } from "../../lib/cn";

type UsageRowProps = {
  name: string;
  description?: string;
  capLabel?: string;
  current: number | null;
  limit: number | null; // null = unlimited
  unit?: "usd" | "count"; // default "count"
  unavailable?: boolean;
  unavailableLabel?: string;
};

const fmtNumber = (n: number) => n.toLocaleString();
const fmtValue = (n: number, unit?: "usd" | "count") =>
  unit === "usd" ? `$${fmtNumber(Math.round(n))}` : fmtNumber(n);

/**
 * Single bar-and-percentage row used in the Usage tab. Bar tint shifts to
 * warning at >75% and danger at >90% of the configured limit.
 *
 * When `unavailable` is true, or `current`/`limit` is null (unlimited or
 * data not yet available), the bar renders in a muted/neutral state with no
 * fill and no percentage label.
 */
export function UsageRow({
  name,
  description,
  capLabel,
  current,
  limit,
  unit,
  unavailable,
  unavailableLabel,
}: UsageRowProps) {
  const isUnavailable = unavailable || current === null;
  const isUnlimited = !isUnavailable && limit === null;

  // Compute percentage only when we have both values and a non-zero limit.
  const pct =
    !isUnavailable && !isUnlimited && limit !== null && limit > 0
      ? Math.min(100, Math.round((current! / limit) * 1000) / 10)
      : null;

  const tone =
    pct !== null
      ? pct > 90
        ? "bg-rv-danger"
        : pct > 75
          ? "bg-rv-warning"
          : "bg-rv-accent-500"
      : ""; // no fill when unavailable/unlimited

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3.5 gap-y-1.5 border-b border-white/5 py-2.5 last:border-b-0 sm:grid-cols-[200px_1fr_80px] sm:gap-3.5">
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <div className="text-[12px] text-rv-mute-700">{name}</div>
        {description || capLabel ? (
          <div className="mt-0.5 text-[11px] text-rv-mute-500">
            {description}
            {capLabel ? <span className="text-rv-mute-700"> · {capLabel}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="h-1.5 overflow-hidden rounded-[3px] bg-rv-c3">
          {pct !== null ? (
            <div
              className={cn("h-full rounded-[3px]", tone)}
              style={{ width: `${pct}%` }}
            />
          ) : null}
        </div>
        <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
          {isUnavailable ? (
            <span className="text-rv-mute-400">{unavailableLabel ?? "—"}</span>
          ) : isUnlimited ? (
            <span>
              {fmtValue(current!, unit)} / ∞
            </span>
          ) : (
            <span>
              {fmtValue(current!, unit)} / {fmtValue(limit!, unit)}
            </span>
          )}
        </div>
      </div>
      <div className="text-right font-rv-mono text-[12px] tabular-nums">
        {pct !== null ? `${pct.toFixed(1)}%` : null}
      </div>
    </div>
  );
}
