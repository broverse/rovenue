// Vendor export presets for the RevenueCat/Adapty data-import tool.
//
// A preset is a hard-coded source-column → canonical-field table for one
// documented vendor export shape. `detectPreset` fingerprints an
// uploaded file's header against every known preset and proposes the
// best-matching one; it never claims a full match it can't back up, and
// it never invents a mapping for a column it doesn't recognize — those
// are always left for the customer to map by hand via the generic
// mapper (see mapping.ts).
//
// Source of truth for every column name below:
// docs/superpowers/research/2026-08-31-rc-adapty-export-formats.md
import type { CanonicalField } from "./canonical";

export const REVENUECAT_TRANSACTIONS_PRESET_ID = "revenuecat_transactions";
export const REVENUECAT_GOOGLE_TOKEN_PRESET_ID = "revenuecat_google_token";

/** Minimum number of matched columns before a preset is proposed at all. */
const MIN_MATCHED_COLUMNS = 1;

const REVENUECAT_TRANSACTIONS_COLUMNS: Record<string, CanonicalField> = {
  rc_original_app_user_id: "subscriberExternalId",
  rc_last_seen_app_user_id_alias: "subscriberAliasId",
  store: "store",
  // NOT in the confirmed column table the research captured — included
  // only on the strength of RevenueCat's own documented guidance that
  // `store_transaction_id + renewal_number` is the transaction row's
  // unique key. If a customer's export lacks this column, detectPreset
  // simply won't match it and the mapper reports it unresolved; do not
  // upgrade this to "confirmed" without re-verifying against RC docs.
  store_transaction_id: "storeTransactionId",
  product_identifier: "productIdentifier",
  product_display_name: "productDisplayName",
  start_time: "purchaseDate",
  end_time: "expiresDate",
  effective_end_time: "effectiveEndDate",
  grace_period_end_time: "gracePeriodEndDate",
  refunded_at: "refundedAt",
  unsubscribe_detected_at: "unsubscribeDetectedAt",
  price_in_usd: "priceUsd",
  is_trial_period: "isTrial",
  is_in_intro_offer_period: "isIntroOffer",
  is_sandbox: "isSandbox",
  is_auto_renewable: "isAutoRenewable",
  renewal_number: "renewalNumber",
  ownership_type: "ownershipType",
  entitlement_identifiers: "entitlementIdentifiers",
  country: "country",
  custom_subscriber_attributes: "customAttributes",
  updated_at: "updatedAt",
};

// The three-column file RevenueCat support hand-delivers on request,
// documented by Adapty's migration guide as the only way to recover
// Google Play purchase tokens (not present in the standard Transactions
// export at all).
const REVENUECAT_GOOGLE_TOKEN_COLUMNS: Record<string, CanonicalField> = {
  user_id: "subscriberExternalId",
  google_purchase_token: "googlePurchaseToken",
  google_product_id: "productIdentifier",
};

// Deliberately no Adapty preset (spec §3): Adapty's own export column
// table could not be confirmed from first-party docs this session.
// Shipping a guessed table would be fabrication; Adapty users go
// through the generic mapper instead.

export type ImportPreset = {
  presetId: string;
  columns: Record<string, CanonicalField>;
};

export const IMPORT_PRESETS: ImportPreset[] = [
  { presetId: REVENUECAT_TRANSACTIONS_PRESET_ID, columns: REVENUECAT_TRANSACTIONS_COLUMNS },
  { presetId: REVENUECAT_GOOGLE_TOKEN_PRESET_ID, columns: REVENUECAT_GOOGLE_TOKEN_COLUMNS },
];

export type PresetDetection = {
  presetId: string;
  mapping: Record<string, CanonicalField>;
  matched: number;
  total: number;
};

/**
 * Fingerprints an uploaded file's header against every known preset and
 * returns the best match, or null if no preset shares even one column
 * name with the header. The returned mapping only ever contains columns
 * that are BOTH in the header and in the chosen preset's column table —
 * unrecognized header columns (e.g. a customer's own extra fields) are
 * never included, and never guessed at.
 */
export function detectPreset(header: string[]): PresetDetection | null {
  const headerSet = new Set(header);

  let best: { preset: ImportPreset; matched: number } | undefined;
  for (const preset of IMPORT_PRESETS) {
    const matched = Object.keys(preset.columns).filter((col) => headerSet.has(col)).length;
    if (matched < MIN_MATCHED_COLUMNS) continue;
    if (!best || matched > best.matched) {
      best = { preset, matched };
    }
  }

  if (!best) return null;

  const mapping: Record<string, CanonicalField> = {};
  for (const [column, field] of Object.entries(best.preset.columns)) {
    if (headerSet.has(column)) {
      mapping[column] = field;
    }
  }

  return {
    presetId: best.preset.presetId,
    mapping,
    matched: best.matched,
    total: Object.keys(best.preset.columns).length,
  };
}
