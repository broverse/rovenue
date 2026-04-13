// Static FX rates for revenue reporting. Replace with a live feed
// (OpenExchangeRates, fixer.io, ECB) for finance-grade accuracy — these
// rates drift over time and are only suitable for rough MRR dashboards.
//
// Rates snapshot date: 2026-04.
const USD_RATES: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0068,
  CNY: 0.14,
  KRW: 0.00074,
  INR: 0.012,
  TRY: 0.03,
  BRL: 0.2,
  MXN: 0.058,
  CAD: 0.74,
  AUD: 0.66,
  CHF: 1.13,
  SEK: 0.096,
  NOK: 0.094,
  DKK: 0.145,
  PLN: 0.25,
  CZK: 0.043,
  HUF: 0.0028,
  RUB: 0.011,
  ZAR: 0.054,
  SGD: 0.74,
  HKD: 0.128,
  NZD: 0.61,
  ILS: 0.27,
  AED: 0.272,
  SAR: 0.267,
};

/**
 * Convert an amount in `currency` to USD using the static rate table.
 * Unknown currencies fall through 1:1 so values are never silently zeroed.
 */
export function convertToUsd(amount: number, currency: string): number {
  const rate = USD_RATES[currency.toUpperCase()];
  if (rate === undefined) return amount;
  return amount * rate;
}
