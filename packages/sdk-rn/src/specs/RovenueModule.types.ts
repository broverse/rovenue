// RovenueModule — TypeScript shape of the native Expo module. Mirrors
// the M3 Swift / M4 Kotlin public surfaces exactly. Used only for
// typechecking; the runtime instance is fetched via
// `requireNativeModule('Rovenue')`.

export type UserDTO = {
  anonId: string;
  knownUserId: string | null;
};

export type EntitlementDTO = {
  id: string;
  active: boolean;
  expiresAt: string | null;
  productId: string | null;
};

export type ReceiptResultDTO = {
  ok: boolean;
  entitlementsRefreshed: boolean;
  creditsRefreshed: boolean;
};

export type LogEntryDTO = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

export interface RovenueModuleSpec {
  // Lifecycle
  configure(apiKey: string, baseUrl: string, debug: boolean): void;
  shutdown(): void;
  setForeground(foreground: boolean): void;
  getVersion(): string;

  // Identity
  currentUser(): Promise<UserDTO>;
  identify(knownUserId: string): Promise<void>;

  // Entitlements
  entitlement(id: string): Promise<EntitlementDTO | null>;
  entitlementsAll(): Promise<EntitlementDTO[]>;
  refreshEntitlements(): Promise<void>;

  // Credits
  creditBalance(): Promise<number>;
  refreshCredits(): Promise<void>;
  consumeCredits(amount: number, description: string | null): Promise<number>;

  // Receipts
  postAppleReceipt(jws: string, productId: string): Promise<ReceiptResultDTO>;
  postGoogleReceipt(receipt: string, productId: string): Promise<ReceiptResultDTO>;

  // Required by `new EventEmitter(nativeModule)` — Expo's runtime checks
  // these exist; our mock implements them as no-ops because emit routing
  // happens through __addChangeListener / __emit on the mock state.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}
