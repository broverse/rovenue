import { riskColor } from "./format";

type Props = { score: number };

/**
 * Inline progress bar + numeric label. The fill width tracks the score
 * 0–100 and the bar/text color flips to amber/danger past 40/70.
 */
export function RiskMeter({ score }: Props) {
  const color = riskColor(score);
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1 w-[60px] overflow-hidden rounded-sm bg-rv-c3">
        <div
          className="h-full rounded-sm"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <span
        className="min-w-[24px] text-right font-rv-mono text-[11px] tabular-nums"
        style={{ color }}
      >
        {score}
      </span>
    </div>
  );
}
