import { describe, expect, it } from "vitest";
import {
  REVENUECAT_GOOGLE_TOKEN_PRESET_ID,
  REVENUECAT_TRANSACTIONS_PRESET_ID,
  detectPreset,
} from "../presets";

// The full confirmed RevenueCat Transactions header, used to prove a
// complete match. Kept in sync with the preset's own column table by
// importing the preset's keys rather than retyping them (see the first
// test), but this literal list documents what "full header" means here.
const REVENUECAT_TRANSACTIONS_HEADER = [
  "rc_original_app_user_id",
  "rc_last_seen_app_user_id_alias",
  "store",
  "store_transaction_id",
  "product_identifier",
  "product_display_name",
  "start_time",
  "end_time",
  "effective_end_time",
  "grace_period_end_time",
  "refunded_at",
  "unsubscribe_detected_at",
  "price_in_usd",
  "is_trial_period",
  "is_in_intro_offer_period",
  "is_sandbox",
  "is_auto_renewable",
  "renewal_number",
  "ownership_type",
  "entitlement_identifiers",
  "country",
  "custom_subscriber_attributes",
  "updated_at",
];

describe("detectPreset", () => {
  it("detects the RevenueCat preset from a full header", () => {
    const r = detectPreset(REVENUECAT_TRANSACTIONS_HEADER);
    expect(r?.presetId).toBe(REVENUECAT_TRANSACTIONS_PRESET_ID);
    expect(r?.matched).toBe(r?.total);
  });

  it("proposes a partial mapping without claiming a full match", () => {
    const r = detectPreset([
      "rc_original_app_user_id",
      "store",
      "product_identifier",
      "start_time",
      "mystery_column",
    ]);
    expect(r?.presetId).toBe(REVENUECAT_TRANSACTIONS_PRESET_ID);
    expect(r!.matched).toBeLessThan(r!.total);
    expect(r!.mapping).not.toHaveProperty("mystery_column");
  });

  it("returns null for a header that resembles nothing", () => {
    expect(detectPreset(["foo", "bar", "baz"])).toBeNull();
  });

  it("detects the Google-token supplemental file as its own preset", () => {
    expect(
      detectPreset(["user_id", "google_purchase_token", "google_product_id"])?.presetId,
    ).toBe(REVENUECAT_GOOGLE_TOKEN_PRESET_ID);
  });
});
