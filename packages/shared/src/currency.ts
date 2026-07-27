/**
 * How many minor units STRIPE scales `unit_amount` by — which is not
 * always how the currency is written.
 *
 * CLDR (what `Intl` exposes) describes presentation; Stripe defines the
 * scaling of `unit_amount`, and for two currencies they disagree. ISK
 * and UGX both became zero-decimal in ISO 4217, and Intl duly reports 0
 * fraction digits for each — but Stripe still requires them as
 * two-decimal values for backwards compatibility: "to charge 5 ISK,
 * provide an `amount` value of `500`", and the same sentence verbatim
 * for UGX (https://docs.stripe.com/currencies — Special cases). An
 * Intl-derived divisor would render that 5 ISK charge as "ISK 500":
 * displayed price a hundred times the money actually taken.
 *
 * HUF and TWD also have special-case rows, but those constrain PAYOUTS
 * only ("Stripe treats HUF as a zero-decimal currency for payouts, even
 * though you can charge two-decimal amounts") — as charge currencies
 * they are ordinary two-decimal, which the default already gives.
 *
 * Only the DIVISOR comes from this table. Intl still decides how the
 * divided number is written, which is why ISK 5 prints as "ISK 5".
 */
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
  // UGX is deliberately NOT here. Stripe lists it among the
  // zero-decimal currencies and then overrides itself in the
  // special-cases table; the override is the one that governs
  // `unit_amount`, so UGX falls through to the default of 2.
]);

const STRIPE_THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

export function stripeMinorUnitExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (STRIPE_THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  return 2;
}

export function decimalToMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** stripeMinorUnitExponent(currency));
}
