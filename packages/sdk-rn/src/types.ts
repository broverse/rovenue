// Public types — these are intentionally plain object shapes so they
// serialise across the Nitro bridge without custom converters.

export type User = {
  rovenueId: string;
  appUserId: string | null;
};

export type Entitlement = {
  id: string;
  active: boolean;
  expiresAt: string | null;  // ISO-8601 or null
  productId: string | null;
};

export type ProductType = 'subscription' | 'consumable' | 'non_consumable';

export type ProductCategory = 'subscription' | 'nonSubscription';
export type PeriodUnit = 'day' | 'week' | 'month' | 'year';
export type PaymentMode = 'freeTrial' | 'payAsYouGo' | 'payUpFront';
export type DiscountType = 'introductory' | 'promotional' | 'winBack';
export type RecurrenceMode = 'infiniteRecurring' | 'finiteRecurring' | 'nonRecurring';
export type PackageType =
  | 'unknown' | 'custom' | 'lifetime' | 'annual'
  | 'sixMonth' | 'threeMonth' | 'twoMonth' | 'monthly' | 'weekly';

export type Period = { value: number; unit: PeriodUnit; iso8601: string };

export type IntroPrice = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  period: Period; cycles: number; paymentMode: PaymentMode;
};

export type Discount = {
  identifier: string | null; price: number | null; priceString: string | null;
  currencyCode: string | null; period: Period; numberOfPeriods: number;
  paymentMode: PaymentMode; type: DiscountType;
};

export type PricingPhase = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  billingPeriod: Period; billingCycleCount: number | null;
  recurrenceMode: RecurrenceMode; paymentMode: PaymentMode | null;
};

export type SubscriptionOption = {
  id: string; basePlanId: string | null; offerId: string | null; tags: string[];
  isBasePlan: boolean; isPrepaid: boolean; pricingPhases: PricingPhase[];
  freePhase: PricingPhase | null; introPhase: PricingPhase | null; fullPricePhase: PricingPhase | null;
};

export type StoreProduct = {
  id: string;
  type: ProductType;
  productCategory: ProductCategory;
  displayName: string;
  description: string | null;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
  subscriptionPeriod: Period | null;
  subscriptionGroupIdentifier: string | null;
  isFamilyShareable: boolean;
  introPrice: IntroPrice | null;
  discounts: Discount[];
  isEligibleForIntroOffer: boolean | null;
  subscriptionOptions: SubscriptionOption[] | null;
  defaultOption: SubscriptionOption | null;
  pricePerWeek: number | null;
  pricePerMonth: number | null;
  pricePerYear: number | null;
  pricePerWeekString: string | null;
  pricePerMonthString: string | null;
  pricePerYearString: string | null;
};

export type Package = {
  identifier: string;
  packageType: PackageType;
  product: StoreProduct;
};

export type Offering = {
  identifier: string;
  isDefault: boolean;
  packages: Package[];
};

export type Offerings = {
  current: Offering | null;
  all: Record<string, Offering>;
};

/** Paywall-attribution snapshot for the paywall a `getPaywall(placementId)`
 *  call resolved. Round-tripped opaquely into the purchase attribution
 *  path, and the source `logPaywallShown(paywall)` builds its
 *  `paywall_view` event from. */
export type PresentedContext = {
  placementId: string;
  paywallId: string;
  variantId: string | null;
  experimentKey: string | null;
  revision: number;
};

/** A resolved placement: either a direct paywall assignment or the winning
 *  variant of a client-drawn PAYWALL experiment. The SDK ships no renderer
 *  (Adapty remote-config model, Phase A) — read `remoteConfig` and build
 *  your own UI, then call `logPaywallShown(paywall)` once it's on screen. */
export type Paywall = {
  placementIdentifier: string;
  placementRevision: number;
  paywallIdentifier: string | null;
  paywallName: string | null;
  configFormatVersion: number;
  /** Parsed from the native side's raw `remoteConfigJson` string. `null`
   *  when the paywall has no remote config for the resolved locale, or the
   *  JSON fails to parse as an object. */
  remoteConfig: Record<string, unknown> | null;
  remoteConfigLocale: string | null;
  offering: Offering | null;
  presentedContext: PresentedContext | null;
};

export type PurchaseResult = {
  entitlements: Entitlement[];
  virtualCurrencies: Record<string, number>;
  productId: string;
  storeTransactionId: string;
  /** True when the purchase is pending external approval (parental controls etc.).
   *  Mirrors Swift `PurchaseResult.isDeferred` and Kotlin `PurchaseResult.isDeferred`. */
  isDeferred: boolean;
};

export type ChangeEvent =
  | 'ENTITLEMENTS_CHANGED'
  | 'IDENTITY_CHANGED'
  | 'VIRTUAL_CURRENCIES_CHANGED'
  | 'REMOTE_CONFIG_CHANGED';

// Remote Config — feature flags + experiment assignments, evaluated
// server-side for the current subscriber and cached locally so reads are
// synchronous and survive offline.

export type ExperimentAssignment = {
  experimentId: string;
  key: string;
  variantId: string;
  variantName: string;
  /** Variant payload (already JSON-parsed). */
  value: unknown;
};

export type RemoteConfig = {
  /** Flag key → evaluated value (boolean / number / string / object). */
  flags: Record<string, unknown>;
  /** Experiment key → the subscriber's assignment. */
  experiments: Record<string, ExperimentAssignment>;
};
