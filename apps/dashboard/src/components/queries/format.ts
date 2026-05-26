export const formatBytes = (bytes: string): string => bytes;

export const formatRowCount = (n: number | undefined): string =>
  n == null ? "0" : n.toLocaleString();

export const formatNumberCell = (v: string | number): string =>
  typeof v === "number"
    ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : v;
