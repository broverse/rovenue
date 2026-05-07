import { evalSparkSeries } from "./format";

type Props = {
  seed: number;
  color: string;
  width?: number;
  height?: number;
};

/**
 * Tiny inline 24-h sparkline used in the flags list to hint at evaluation
 * volume. Colored by the row's status (accent / success / muted / danger).
 */
export function EvalSparkline({ seed, color, width = 80, height = 22 }: Props) {
  const points = evalSparkSeries(seed);
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = (1 - p) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} aria-hidden="true" className="block">
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
