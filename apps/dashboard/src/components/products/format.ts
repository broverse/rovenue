import type { Currency, DurationCode } from "./types";

const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

const DURATION_LABEL: Record<DurationCode, string> = {
  P1W: "weekly",
  P1M: "monthly",
  P1Y: "yearly",
  lifetime: "lifetime",
  consumable: "consumable",
};

export function formatPrice(value: number, currency: Currency = "USD"): string {
  const sym = CURRENCY_SYMBOL[currency] ?? "$";
  return `${sym}${value.toFixed(2)}`;
}

export function formatDuration(code: DurationCode): string {
  return DURATION_LABEL[code] ?? code;
}

/**
 * Two-letter initials from a product name — e.g. "Premium Annual EU" → "PA".
 */
export function productInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}
