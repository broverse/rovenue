import type { SqlTokenKind } from "./types";

/**
 * Map SQL token kinds to the same VS-Code-ish palette the design uses.
 * Kept inline so the editor doesn't depend on a Prism build at runtime.
 */
export const SQL_TOKEN_COLOR: Readonly<Record<SqlTokenKind, string>> = {
  kw: "text-[#C792EA] font-medium",
  fn: "text-[#82AAFF]",
  st: "text-[#C3E88D]",
  nm: "text-[#F78C6C]",
  cm: "italic text-rv-mute-500",
  pn: "text-[#FFCB6B]",
  op: "text-[#89DDFF]",
  id: "text-foreground",
};

export const formatBytes = (bytes: string): string => bytes;

export const formatRowCount = (n: number | undefined): string =>
  n == null ? "0" : n.toLocaleString();

export const formatNumberCell = (v: string | number): string =>
  typeof v === "number"
    ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : v;
