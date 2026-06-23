// RovenueModule — TypeScript shape of the native Expo module. Mirrors
// the M3 Swift / M4 Kotlin public surfaces exactly. Used only for
// typechecking; the runtime instance is fetched via
// `requireNativeModule('Rovenue')`.

export type UserDTO = {
  rovenueId: string;
  appUserId: string | null;
};

export type EntitlementDTO = {
  id: string;
  active: boolean;
  expiresAt: string | null;
  productId: string | null;
};

export type ProductTypeDTO = "subscription" | "consumable" | "non_consumable";

export type ProductCategoryDTO = "subscription" | "nonSubscription";
export type PeriodUnitDTO = "day" | "week" | "month" | "year";
export type PaymentModeDTO = "freeTrial" | "payAsYouGo" | "payUpFront";
export type DiscountTypeDTO = "introductory" | "promotional" | "winBack";
export type RecurrenceModeDTO = "infiniteRecurring" | "finiteRecurring" | "nonRecurring";
export type PackageTypeDTO =
  | "unknown" | "custom" | "lifetime" | "annual"
  | "sixMonth" | "threeMonth" | "twoMonth" | "monthly" | "weekly";

export type PeriodDTO = { value: number; unit: PeriodUnitDTO; iso8601: string };

export type IntroPriceDTO = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  period: PeriodDTO; cycles: number; paymentMode: PaymentModeDTO;
};

export type DiscountDTO = {
  identifier: string | null; price: number | null; priceString: string | null;
  currencyCode: string | null; period: PeriodDTO; numberOfPeriods: number;
  paymentMode: PaymentModeDTO; type: DiscountTypeDTO;
};

export type PricingPhaseDTO = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  billingPeriod: PeriodDTO; billingCycleCount: number | null;
  recurrenceMode: RecurrenceModeDTO; paymentMode: PaymentModeDTO | null;
};

export type SubscriptionOptionDTO = {
  id: string; basePlanId: string | null; offerId: string | null; tags: string[];
  isBasePlan: boolean; isPrepaid: boolean; pricingPhases: PricingPhaseDTO[];
  freePhase: PricingPhaseDTO | null; introPhase: PricingPhaseDTO | null; fullPricePhase: PricingPhaseDTO | null;
};

export type StoreProductDTO = {
  id: string;
  type: ProductTypeDTO;
  productCategory: ProductCategoryDTO;
  displayName: string;
  description: string | null;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
  subscriptionPeriod: PeriodDTO | null;
  subscriptionGroupIdentifier: string | null;
  isFamilyShareable: boolean;
  introPrice: IntroPriceDTO | null;
  discounts: DiscountDTO[];
  isEligibleForIntroOffer: boolean | null;
  subscriptionOptions: SubscriptionOptionDTO[] | null;
  defaultOption: SubscriptionOptionDTO | null;
  pricePerWeek: number | null;
  pricePerMonth: number | null;
  pricePerYear: number | null;
  pricePerWeekString: string | null;
  pricePerMonthString: string | null;
  pricePerYearString: string | null;
};

export type PackageDTO = {
  identifier: string;
  packageType?: PackageTypeDTO;
  product: StoreProductDTO;
};

export type OfferingDTO = {
  identifier: string;
  isDefault: boolean;
  packages: PackageDTO[];
};

export type OfferingsDTO = {
  current: string | null;
  offerings: OfferingDTO[];
};

export type ExperimentAssignmentDTO = {
  experimentId: string;
  key: string;
  variantId: string;
  variantName: string;
  /** Variant payload serialized as a JSON string (parsed on the JS side). */
  valueJson: string;
};

export type PurchaseResultDTO = {
  entitlements: EntitlementDTO[];
  virtualCurrencies: Record<string, number>;
  productId: string;
  storeTransactionId: string;
  isDeferred: boolean;
};

export type LogEntryDTO = {
  level: "off" | "error" | "warn" | "info" | "debug" | "trace";
  message: string;
  fields: Record<string, string>;
};

export interface RovenueModuleSpec {
  // Lifecycle
  //
  // appVersion is optional from JS. When undefined the native modules
  // auto-read the host bundle / packageManager value at the bridge
  // boundary before calling into the Rust core.
  //
  // environment selects the Remote Config bucket (prod/staging/development);
  // undefined lets the backend default to prod.
  configure(
    apiKey: string,
    baseUrl: string | undefined,
    logLevel: "off" | "error" | "warn" | "info" | "debug" | "trace",
    appVersion?: string,
    environment?: string,
  ): void;
  shutdown(): void;
  setForeground(foreground: boolean): void;
  getVersion(): string;

  // Identity
  currentUser(): Promise<UserDTO>;
  identify(appUserId: string): Promise<void>;
  logOut(): Promise<void>;

  // Entitlements
  entitlement(id: string): Promise<EntitlementDTO | null>;
  entitlementsAll(): Promise<EntitlementDTO[]>;
  refreshEntitlements(): Promise<void>;

  // Virtual currencies (multi-currency; reads only — spend is server-side)
  virtualCurrencies(): Promise<Record<string, number>>;
  virtualCurrency(code: string): Promise<number>;
  refreshVirtualCurrencies(): Promise<void>;

  // Purchases
  getOfferings(): Promise<OfferingsDTO>;
  purchase(productId: string, productType: ProductTypeDTO, promotionalOfferId?: string): Promise<PurchaseResultDTO>;
  restorePurchases(): Promise<PurchaseResultDTO>;

  // Remote Config — feature flags + experiment assignments. Typed getters
  // resolve a single key with a fallback; remoteConfigAllJson returns the whole
  // `{ flags, experiments }` bundle as a JSON string (backs the reactive hook).
  refreshRemoteConfig(): Promise<void>;
  remoteConfigBool(key: string, fallback: boolean): Promise<boolean>;
  remoteConfigString(key: string, fallback: string): Promise<string>;
  remoteConfigInt(key: string, fallback: number): Promise<number>;
  remoteConfigDouble(key: string, fallback: number): Promise<number>;
  remoteConfigJson(key: string): Promise<string | null>;
  remoteConfigKeys(): Promise<string[]>;
  remoteConfigAllJson(): Promise<string>;
  experiment(key: string): Promise<ExperimentAssignmentDTO | null>;
  experimentsAll(): Promise<ExperimentAssignmentDTO[]>;

  // Refund Shield — stable per-subscriber app-account token (UUID).
  getAppAccountToken(): Promise<string>;

  // Refund Shield — per-app-session telemetry (open/background/close).
  recordSessionEvent(
    kind: "open" | "background" | "close",
    occurredAt: string,
    durationMs?: number,
  ): Promise<void>;
  flushSessionEvents(): Promise<number>;

  // Funnel attribution claim
  claimFunnelToken(token: string): Promise<{ subscriberId: string; funnelAnswersJson: string }>;
  claimInstall(params: { platform?: string; locale?: string; timezone?: string; screenDims?: string; deviceModel?: string; installReferrer?: string }): Promise<{ subscriberId: string; funnelAnswersJson: string } | null>;
  claimViaEmail(email: string): Promise<void>;
  claimFromClipboard(): Promise<{ subscriberId: string; funnelAnswersJson: string } | null>;
  installId(): Promise<string>;
  hasResolvedFunnelClaim(): Promise<boolean>;

  // Generic event emission (`POST /v1/events`).
  track(envelopeJson: string): Promise<void>;

  // Subscriber attributes — batch set + reserved-key setters + durable flush.
  setAttributes(attributes: Record<string, string | null>): Promise<void>;
  setEmail(email: string | null): Promise<void>;
  setDisplayName(name: string | null): Promise<void>;
  setPhoneNumber(phone: string | null): Promise<void>;
  setPushToken(token: string | null): Promise<void>;
  flushAttributes(): Promise<number>;

  // NativeEventEmitter bookkeeping hooks. On Expo SDK 51 (expo-modules-core
  // 1.x) the legacy `new EventEmitter(nativeModule)` wrapper calls these on
  // subscribe/unsubscribe — Expo's runtime checks they exist. On SDK 52+
  // the module itself is the emitter and exposes a real 2-arg
  // `addListener(name, listener)`; see core/native.ts for how getEmitter()
  // picks the right path. Our mock implements them as no-ops because emit
  // routing happens through __addChangeListener / __emit on the mock state.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}
