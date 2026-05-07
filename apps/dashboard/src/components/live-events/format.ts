export const formatClockTime = (d: Date): string => {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const formatRelative = (d: Date, now: Date = new Date()): string => {
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (seconds < 2) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

export const formatAmount = (amount: number | null): string => {
  if (amount == null) return "—";
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
};
