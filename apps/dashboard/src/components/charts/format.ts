export const formatCurrencyCompact = (n: number): string => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs}`;
};

export const formatCount = (n: number): string => n.toLocaleString();

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
