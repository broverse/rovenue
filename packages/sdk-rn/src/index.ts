// @rovenue/sdk-rn — public surface.
//
// Imperative API:    Rovenue.configure(...), Rovenue.identify(...), ...
// React hooks:       useCurrentUser, useEntitlement, useEntitlements, useCreditBalance
// Error classes:     RovenueError + 13 subclasses

export { SDK_VERSION } from "./version";

export type {
  User,
  Entitlement,
  ReceiptResult,
  ChangeEvent,
} from "./types";

export {
  RovenueError,
  InvalidApiKeyError,
  NotConfiguredError,
  NetworkUnavailableError,
  TimeoutError,
  RateLimitedError,
  ServerError,
  StorageError,
  UserNotFoundError,
  InsufficientCreditsError,
  EntitlementInactiveError,
  DuplicatePurchaseError,
  ReceiptInvalidError,
  InternalError,
} from "./errors";

export { useCurrentUser } from "./hooks/useCurrentUser";
export { useEntitlement } from "./hooks/useEntitlement";
export { useEntitlements } from "./hooks/useEntitlements";
export { useCreditBalance } from "./hooks/useCreditBalance";

import { configure } from "./api/configure";
import { currentUser, identify } from "./api/identity";
import { entitlement, entitlementsAll, refreshEntitlements } from "./api/entitlements";
import { creditBalance, refreshCredits, consumeCredits } from "./api/credits";
import { postAppleReceipt, postGoogleReceipt } from "./api/receipts";
import { setForeground, shutdown } from "./api/lifecycle";
import { SDK_VERSION } from "./version";
import { getNative } from "./core/native";
import { setLogHandler } from "./api/log";

export const Rovenue = {
  configure,
  getVersion: () => SDK_VERSION,
  currentUser,
  identify,
  entitlement,
  entitlementsAll,
  refreshEntitlements,
  creditBalance,
  refreshCredits,
  consumeCredits,
  postAppleReceipt,
  postGoogleReceipt,
  setForeground,
  shutdown,
  setLogHandler,
  addChangeListener: (cb: (event: import("./types").ChangeEvent) => void): (() => void) => {
    return getNative().addChangeListener((e) => cb(e as import("./types").ChangeEvent));
  },
} as const;

export type { RovenueConfig } from "./api/configure";
export type { LogEntry } from "./api/log";
