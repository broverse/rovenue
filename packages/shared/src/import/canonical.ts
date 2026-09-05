// Canonical row contract for the RevenueCat/Adapty data-import tool.
//
// Every vendor-specific column mapper (later tasks) normalizes onto these
// field names. Getting the names right here matters more than being clever:
// four other tasks compile against this contract.
//
// Deliberately absent: a raw local-price field. RevenueCat's raw-currency
// column is unconfirmed in our research, and the import spec forbids
// stamping a guessed currency onto an amount of unknown denomination. Do
// not add one on speculation.
export const CANONICAL_FIELDS = [
  { key: "subscriberExternalId", required: true, label: "Subscriber ID" },
  { key: "subscriberAliasId", required: false, label: "Subscriber alias" },
  { key: "store", required: true, label: "Store" },
  { key: "storeTransactionId", required: false, label: "Store transaction ID" },
  { key: "originalTransactionId", required: false, label: "Original transaction ID" },
  { key: "googlePurchaseToken", required: false, label: "Google purchase token" },
  { key: "stripeSubscriptionId", required: false, label: "Stripe subscription ID" },
  { key: "productIdentifier", required: true, label: "Product identifier" },
  { key: "productDisplayName", required: false, label: "Product display name" },
  { key: "purchaseDate", required: true, label: "Purchase date" },
  { key: "expiresDate", required: false, label: "Expiry date" },
  { key: "effectiveEndDate", required: false, label: "Effective end date" },
  { key: "gracePeriodEndDate", required: false, label: "Grace period end" },
  { key: "refundedAt", required: false, label: "Refunded at" },
  { key: "unsubscribeDetectedAt", required: false, label: "Unsubscribe detected at" },
  { key: "priceUsd", required: false, label: "Price (USD)" },
  { key: "isTrial", required: false, label: "Is trial" },
  { key: "isIntroOffer", required: false, label: "Is intro offer" },
  { key: "isSandbox", required: false, label: "Is sandbox" },
  { key: "isAutoRenewable", required: false, label: "Is auto-renewable" },
  { key: "renewalNumber", required: false, label: "Renewal number" },
  { key: "ownershipType", required: false, label: "Ownership type" },
  { key: "entitlementIdentifiers", required: false, label: "Entitlement identifiers" },
  { key: "country", required: false, label: "Country" },
  { key: "customAttributes", required: false, label: "Custom attributes" },
  { key: "updatedAt", required: false, label: "Source updated at" },
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]["key"];

export type CanonicalRow = Partial<Record<CanonicalField, string>>;

/**
 * An import job's kind decides which canonical fields it must have.
 *
 * A history import creates purchases, so it needs enough to describe
 * one. An enrichment import creates nothing — it patches a token onto
 * rows a previous import already wrote — so demanding `store` and
 * `purchaseDate` of it is demanding data its source file cannot
 * contain. That mismatch is the whole reason the
 * `revenuecat_google_token` preset was detectable but never importable.
 *
 * Keyed by kind rather than derived from a `required` flag so that
 * adding a kind without declaring its required fields is a compile
 * error, not a silent inheritance of the wrong set.
 */
export type ImportJobKind = "HISTORY" | "GOOGLE_TOKEN_ENRICHMENT";

export const HISTORY_REQUIRED_FIELDS = CANONICAL_FIELDS.filter((f) => f.required).map(
  (f) => f.key,
) as readonly CanonicalField[];

export const GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS = [
  "subscriberExternalId",
  "productIdentifier",
  "googlePurchaseToken",
] as const satisfies readonly CanonicalField[];

export const REQUIRED_FIELDS_BY_KIND: Record<ImportJobKind, readonly CanonicalField[]> = {
  HISTORY: HISTORY_REQUIRED_FIELDS,
  GOOGLE_TOKEN_ENRICHMENT: GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS,
};
