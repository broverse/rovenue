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
  packageType?: PackageType;
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

export type PurchaseResult = {
  entitlements: Entitlement[];
  virtualCurrencies: Record<string, number>;
  productId: string;
  storeTransactionId: string;
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
