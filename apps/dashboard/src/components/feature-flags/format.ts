/** Compact "1.2M" / "342k" / "84" rendering for evaluation counts. */
export function formatEvalCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 24-h sparkline series of evaluation density. Deterministic per `seed`. */
export function evalSparkSeries(seed: number): ReadonlyArray<number> {
  const points: number[] = [];
  for (let i = 0; i < 24; i++) {
    points.push(0.5 + Math.sin((i + seed) / 2.2) * 0.35 + ((i * 13 + seed) % 7) / 100);
  }
  return points;
}
