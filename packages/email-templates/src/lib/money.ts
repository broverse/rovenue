export function formatCents(
  cents: number,
  currency: string,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatPercent(
  value: number,
  locale: string,
  fractionDigits = 1,
): string {
  return new Intl.NumberFormat(locale, {
    style: "decimal",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatSignedPercent(
  value: number,
  locale: string,
  fractionDigits = 1,
): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatPercent(Math.abs(value), locale, fractionDigits)}%`;
}
