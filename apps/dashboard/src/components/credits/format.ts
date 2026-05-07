export const formatCount = (n: number): string => n.toLocaleString();

export const formatCompact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

export const formatDelta = (n: number): string =>
  n > 0 ? `+${formatCount(n)}` : formatCount(n);

export const initials = (name: string): string =>
  name
    .split(" ")
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("");

export const sparkSeries = (seed: number, length = 14): number[] => {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const wave = Math.sin((i + seed) / 2.1) * 0.3;
    const noise = ((Math.sin(seed * 9.31 + i * 1.7) + 1) / 2) * 0.2;
    out.push(0.4 + wave + noise);
  }
  return out;
};
