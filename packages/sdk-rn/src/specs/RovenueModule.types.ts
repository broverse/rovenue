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

export type StoreProductDTO = {
  id: string;
  type: ProductTypeDTO;
  displayName: string;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
};

export type PackageDTO = {
  identifier: string;
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

export type PurchaseResultDTO = {
  entitlements: EntitlementDTO[];
  creditBalance: number;
  productId: string;
  storeTransactionId: string;
};

export type LogEntryDTO = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

export interface RovenueModuleSpec {
  // Lifecycle
  //
  // appVersion is optional from JS. When undefined the native modules
  // auto-read the host bundle / packageManager value at the bridge
  // boundary before calling into the Rust core.
  configure(
    apiKey: string,
    baseUrl: string,
    debug: boolean,
    appVersion?: string,
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

  // Credits
  creditBalance(): Promise<number>;
  refreshCredits(): Promise<void>;
  consumeCredits(amount: number, description: string | null): Promise<number>;

  // Purchases
  getOfferings(): Promise<OfferingsDTO>;
  purchase(productId: string, productType: ProductTypeDTO): Promise<PurchaseResultDTO>;
  restorePurchases(): Promise<PurchaseResultDTO>;

  // Refund Shield — stable per-subscriber app-account token (UUID).
  getAppAccountToken(): Promise<string>;

  // Refund Shield — per-app-session telemetry (open/background/close).
  recordSessionEvent(
    kind: "open" | "background" | "close",
    occurredAt: string,
    durationMs?: number,
  ): Promise<void>;
  flushSessionEvents(): Promise<number>;

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
