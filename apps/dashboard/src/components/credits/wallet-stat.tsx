import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { sparkSeries } from "./format";

type Props = {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  description?: ReactNode;
  descriptionTone?: "default" | "success" | "warning" | "danger";
  sparkSeed: number;
  sparkColor: string;
  accent?: boolean;
};

/**
 * Wallet stat tile — mono label, large mono value with subdued unit,
 * tiny inline sparkline pinned to the corner. The `accent` variant
 * mixes the brand hue into the surface and shifts the value color so
 * the headline metric (Outstanding balance) stands out.
 */
export function WalletStat({
  label,
  value,
  unit,
  description,
  descriptionTone = "default",
  sparkSeed,
  sparkColor,
  accent = false,
}: Props) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border px-4 py-3.5 transition",
        accent
          ? "border-rv-accent-500/30 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-rv-accent-500)_18%,var(--color-rv-c1)),var(--color-rv-c1))]"
          : "border-rv-divider bg-rv-c1",
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-rv-mono text-[22px] font-medium tabular-nums",
          accent ? "text-rv-accent-400" : "text-foreground",
        )}
      >
        {value}
        {unit ? (
          <span className="ml-1 text-[11px] font-normal text-rv-mute-500">{unit}</span>
        ) : null}
      </div>
      {description ? (
        <div
          className={cn(
            "mt-1 font-rv-mono text-[11px]",
            descriptionTone === "success" && "text-rv-success",
            descriptionTone === "warning" && "text-rv-warning",
            descriptionTone === "danger" && "text-rv-danger",
            descriptionTone === "default" && "text-rv-mute-500",
          )}
        >
          {description}
        </div>
      ) : null}
      <Sparkline seed={sparkSeed} color={sparkColor} />
    </div>
  );
}

function Sparkline({ seed, color }: { seed: number; color: string }) {
  const width = 60;
  const height = 24;
  const points = sparkSeries(seed);
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = (1 - p) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      className="absolute right-3 top-3.5 opacity-70"
    >
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
