import type { RetentionMetric } from "./types";

/** Minimal heatmap row shape used only within this module. */
type HeatmapRow = {
  size: number;
  data: ReadonlyArray<number | null>;
};

/** Heatmap cell background — primary-tinted, opacity scales with retention. */
export function retentionCellBackground(value: number | null): string {
  if (value == null) return "transparent";
  if (value === 100) {
    return "color-mix(in srgb, var(--color-rv-accent-700) 50%, transparent)";
  }
  const t = Math.min(1, Math.max(0, value / 100));
  const alpha = 0.08 + t * 0.42;
  return `color-mix(in srgb, var(--color-rv-accent-500) ${Math.round(alpha * 100)}%, transparent)`;
}

/** Cell text color — light foreground above the 45% threshold so values stay legible. */
export function retentionCellText(value: number | null): string {
  if (value == null) return "var(--color-rv-mute-500)";
  return value >= 45 ? "var(--color-foreground)" : "var(--color-rv-mute-500)";
}

/**
 * Resolve the displayed metric value from a row's underlying retention %.
 * `revenue` lifts the curve slightly (revenue retention typically exceeds
 * user retention); `count` projects back to absolute user counts.
 */
export function metricValue(
  row: HeatmapRow,
  weekIndex: number,
  metric: RetentionMetric,
): number | null {
  const base = row.data[weekIndex];
  if (base == null) return null;
  if (metric === "revenue") {
    return Math.min(110, Math.round(base * 1.12));
  }
  if (metric === "count") {
    return Math.round((row.size * base) / 100);
  }
  return base;
}

export function metricSuffix(metric: RetentionMetric): string {
  return metric === "count" ? "" : "%";
}

/** Compact "1.2k" rendering for active-count cells. */
export function formatActiveCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatMetricCellValue(value: number | null, metric: RetentionMetric): string {
  if (value == null) return "·";
  if (metric === "count") return formatActiveCount(value);
  return value + metricSuffix(metric);
}

// Deterministic dot colour from a cohort id.
const DOT_PALETTE = [
  "#22c55e", // green
  "#a855f7", // violet
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#ef4444", // red
  "#14b8a6", // teal
] as const;

export function dotColorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length];
}

export function w4Pct(
  points: ReadonlyArray<{ period: number; pct: number }>,
): number | null {
  return points.find((p) => p.period === 4)?.pct ?? null;
}
