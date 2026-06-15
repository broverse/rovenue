export const formatCurrencyCompact = (n: number): string => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs}`;
};

export const formatCount = (n: number): string => n.toLocaleString();

export const seededSeries = (
  seed: number,
  base: number,
  growth: number,
  jitter: number,
  length = 12,
): number[] => {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const trend = base * Math.pow(1 + growth, i);
    const wave = Math.sin((i + seed) / 1.6) * jitter;
    const noise = ((Math.sin(seed * 9.31 + i * 1.7) + 1) / 2 - 0.5) * jitter;
    out.push(Math.round(trend + wave + noise));
  }
  return out;
};

export const heatColor = (v: number): string => {
  const a = 0.05 + Math.min(1, Math.max(0, v)) * 0.85;
  return `oklch(0.65 0.16 240 / ${a})`;
};

export function fmtMoney(v: string | number | null | undefined, loading = false): string {
  return loading || v == null ? "—" : formatCurrencyCompact(Number(v));
}

export function fmtPct(v: number | null | undefined, loading = false): string {
  return loading || v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
