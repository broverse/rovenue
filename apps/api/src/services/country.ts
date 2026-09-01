// =============================================================
// Store-supplied ISO 3166-1 alpha-2 country — Google / Stripe
// =============================================================
//
// Apple's per-transaction country arrives as an alpha-3 storefront code
// and is converted by `appleStorefrontToCountry` (./apple/apple-country).
// Google (`GoogleSubscriptionPurchaseV2.regionCode`,
// `ProductPurchase.regionCode` — both documented by Google as "ISO
// 3166-1 alpha-2 billing country/region code ... at the time the
// subscription/product was granted") and Stripe
// (`Charge.billing_details.address.country`, documented by Stripe as
// "Billing information associated with the payment method AT THE TIME
// OF THE TRANSACTION", see https://docs.stripe.com/api/charges/object)
// already supply the house alpha-2 format, so no alpha-3 conversion is
// needed for either — but the raw value is still store-supplied,
// untrusted input, and must still be validated and fail CLOSED on
// anything that isn't a real ISO 3166-1 alpha-2 code, exactly like the
// Apple path never stores a guess or the raw value for an unrecognised
// storefront.
//
// Reuses `ALPHA2_COUNTRY_CODES` (derived from the SAME alpha-3 ->
// alpha-2 table Apple's conversion uses) as the one source of truth for
// "is this a real code" — never a second, independently-maintained
// list.
import { ALPHA2_COUNTRY_CODES } from "./apple/apple-country";

/**
 * Normalises an already-alpha-2 store-supplied country/region code to
 * the house format. Returns `null` (fail closed) for a missing, blank,
 * or unrecognised code — never the raw input and never a guess.
 * Case-insensitive on the input; output is always upper-case alpha-2.
 */
export function normalizeAlpha2Country(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return ALPHA2_COUNTRY_CODES.has(upper) ? upper : null;
}
