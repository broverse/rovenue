// =============================================================
// Store commission-rate presets — single source of truth
// =============================================================
//
// This is the ONLY place these numbers and their citations are
// written down. `apps/api/src/services/metrics/proceeds.ts` re-exports
// `COMMISSION_RATE_PRESETS` from here rather than declaring its own
// copy, and `apps/dashboard`'s commission-rate settings form
// (`components/projects/SettingsForm.tsx`) imports both exports from
// here directly. Two copies of a commission rate — one that computes
// proceeds and one that renders a button — is exactly the drift this
// module exists to prevent: if a rate ever changes, there is exactly
// one number and one citation to update, and both surfaces move
// together.
//
// The rate itself is always the customer's own statement of their
// situation (see `packages/db/src/drizzle/schema.ts`'s
// `projectStoreCommissionRates` comment and `proceeds.ts`'s header) —
// nothing here is ever applied automatically. Offering a preset is not
// configuring one: a UI that pre-fills an input from
// `COMMISSION_RATE_PRESET_OPTIONS` must still require an explicit
// write before a rate counts as configured.

export const COMMISSION_RATE_PRESETS = {
  /**
   * App Store Small Business Program: 15% commission (85% net revenue)
   * for developers who earned ≤$1M USD in proceeds account-wide in the
   * prior calendar year (re-qualifies annually).
   * Source: https://developer.apple.com/app-store/small-business-program/
   * ("a reduced commission rate of 15% on paid apps and In-App
   * Purchases") and https://developer.apple.com/app-store/subscriptions/
   * ("If you're currently enrolled in the App Store Small Business
   * Program, you receive 85% of the subscription price at each billing
   * cycle... regardless of whether or not the subscription has
   * accumulated one year of paid service."). Fetched 2026-09-01.
   */
  APPLE_SMALL_BUSINESS: 0.15,
  /**
   * App Store standard commission: 30% (70% net revenue) during a
   * subscriber's first year of paid service (and the default rate for
   * one-time IAP/paid apps outside the Small Business Program).
   * Source: https://developer.apple.com/app-store/subscriptions/
   * ("During a subscriber's first year of service, you receive 70% of
   * the subscription price at each billing cycle, minus applicable
   * taxes."). Fetched 2026-09-01. (Apple also drops subscriptions to a
   * 15% rate after a full year of paid service — a THIRD tier this
   * module deliberately does not add a dedicated preset for, matching
   * the brief's "two Apple tiers"; a project in that state uses a
   * CUSTOM rate.)
   */
  APPLE_STANDARD: 0.3,
  /**
   * Google Play service fee for auto-renewing subscriptions: a flat 15%
   * regardless of the developer's annual revenue (unlike Google's
   * non-subscription tiers, which step from 15% to 30% at the $1M/year
   * mark). Chosen as "the Google equivalent" preset because Rovenue is a
   * subscription/credit-management product — this is the rate that
   * applies to the transactions this project actually tracks.
   * Source: https://support.google.com/googleplay/android-developer/answer/112622
   * ("Subscriptions: 15% for automatically renewing subscription
   * products purchased by subscribers, regardless of revenue earned by
   * the developer each year."). Fetched 2026-09-01.
   */
  GOOGLE_STANDARD: 0.15,
} as const;

export type CommissionRatePreset = keyof typeof COMMISSION_RATE_PRESETS;

/** One citation this module is prepared to show verbatim next to a preset. */
export interface CommissionRatePresetSource {
  url: string;
  /** The exact quoted sentence(s) the rate is drawn from — never paraphrased. */
  quote: string;
}

/**
 * A preset an operator can be OFFERED, with the sourcing that lets them
 * judge whether it actually describes their account. `rate` always reads
 * from `COMMISSION_RATE_PRESETS` (never a re-typed literal), so this
 * array cannot drift from the numbers `proceeds.ts` computes with.
 */
export interface CommissionRatePresetOption {
  id: CommissionRatePreset;
  /** The store this preset's citation is describing. */
  store: "APP_STORE" | "PLAY_STORE";
  rate: number;
  label: string;
  /** Plain-language statement of the qualifying condition, NOT a summary of the quote. */
  description: string;
  sources: readonly CommissionRatePresetSource[];
  fetchedOn: string;
}

const FETCHED_ON = "2026-09-01";

export const COMMISSION_RATE_PRESET_OPTIONS: readonly CommissionRatePresetOption[] = [
  {
    id: "APPLE_SMALL_BUSINESS",
    store: "APP_STORE",
    rate: COMMISSION_RATE_PRESETS.APPLE_SMALL_BUSINESS,
    label: "App Store Small Business Program (15%)",
    description:
      "For developers who earned ≤$1M USD in proceeds account-wide in the prior calendar year (re-qualifies annually).",
    sources: [
      {
        url: "https://developer.apple.com/app-store/small-business-program/",
        quote: "a reduced commission rate of 15% on paid apps and In-App Purchases",
      },
      {
        url: "https://developer.apple.com/app-store/subscriptions/",
        quote:
          "If you're currently enrolled in the App Store Small Business Program, you receive 85% of the subscription price at each billing cycle... regardless of whether or not the subscription has accumulated one year of paid service.",
      },
    ],
    fetchedOn: FETCHED_ON,
  },
  {
    id: "APPLE_STANDARD",
    store: "APP_STORE",
    rate: COMMISSION_RATE_PRESETS.APPLE_STANDARD,
    label: "App Store standard commission (30%)",
    description:
      "During a subscriber's first year of paid service, and the default rate for one-time purchases outside the Small Business Program. Apple drops subscriptions to 15% after a full year of paid service — that third tier has no preset here; use a custom rate for it.",
    sources: [
      {
        url: "https://developer.apple.com/app-store/subscriptions/",
        quote:
          "During a subscriber's first year of service, you receive 70% of the subscription price at each billing cycle, minus applicable taxes.",
      },
    ],
    fetchedOn: FETCHED_ON,
  },
  {
    id: "GOOGLE_STANDARD",
    store: "PLAY_STORE",
    rate: COMMISSION_RATE_PRESETS.GOOGLE_STANDARD,
    label: "Google Play subscription service fee (15%)",
    description:
      "Flat 15% on auto-renewing subscriptions regardless of the developer's annual revenue.",
    sources: [
      {
        url: "https://support.google.com/googleplay/android-developer/answer/112622",
        quote:
          "Subscriptions: 15% for automatically renewing subscription products purchased by subscribers, regardless of revenue earned by the developer each year.",
      },
    ],
    fetchedOn: FETCHED_ON,
  },
];
