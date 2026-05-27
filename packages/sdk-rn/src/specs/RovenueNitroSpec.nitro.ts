// RovenueNitroSpec — HybridObject interface for Nitrogen. Method
// signatures mirror the M3 Swift `Rovenue` and M4 Kotlin `Rovenue`
// public surfaces verbatim.
//
// IMPORTANT: this file is the Nitrogen input. Nitrogen is NOT wired
// into the build in M5 (M6 packaging plan handles that). For M5 we
// hand-import this type for vitest typechecking only; the actual
// native module is created via `NitroModules.createHybridObject` at
// runtime, and `createHybridObject` returns `any` so we don't need
// Nitrogen-generated code paths.

import type { HybridObject } from "react-native-nitro-modules";

// DTOs — the wire shapes. Identical to the public types in ../types.ts;
// kept separate so Nitrogen can generate native structs from this file
// without leaking RN-only types into the public API.

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

export interface RovenueNitroSpec
  extends HybridObject<{ ios: "swift"; android: "kotlin" }> {
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

  // Observer — returns an unsubscribe function
  addChangeListener(cb: (event: string) => void): () => void;
}
