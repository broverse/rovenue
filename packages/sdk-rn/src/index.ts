// @rovenue/sdk-rn — public surface.
//
// Imperative API:    Rovenue.configure(...), Rovenue.identify(...), ...
// React hooks:       useCurrentUser, useEntitlement, useEntitlements, useCreditBalance
// Error classes:     RovenueError + 17 subclasses

export { SDK_VERSION } from "./version";

export {
  EVENT_WIRE_VERSION,
  serializeEnvelope,
  stripUndefined,
} from "./events";
export type { EventEnvelope, IdentityContext } from "./events";

export type {
  User,
  Entitlement,
  ProductType,
  StoreProduct,
  Package,
  Offering,
  Offerings,
  PurchaseResult,
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
  PurchaseCancelledError,
  PurchasePendingError,
  ProductNotAvailableError,
  StoreProblemError,
  InternalError,
} from "./errors";

export { useCurrentUser } from "./hooks/useCurrentUser";
export { useEntitlement } from "./hooks/useEntitlement";
export { useEntitlements } from "./hooks/useEntitlements";
export { useCreditBalance } from "./hooks/useCreditBalance";

import { configure } from "./api/configure";
import { currentUser, identify, logOut } from "./api/identity";
import { entitlement, entitlementsAll, refreshEntitlements } from "./api/entitlements";
import { creditBalance, refreshCredits, consumeCredits } from "./api/credits";
import { getOfferings, purchase, restorePurchases } from "./api/purchases";
import { setForeground, shutdown } from "./api/lifecycle";
import { getAppAccountToken } from "./api/accountToken";
import { SDK_VERSION } from "./version";
import { getEmitter } from "./core/native";
import { setLogHandler } from "./api/log";

export const Rovenue = {
  configure,
  getVersion: () => SDK_VERSION,
  currentUser,
  identify,
  logOut,
  entitlement,
  entitlementsAll,
  refreshEntitlements,
  creditBalance,
  refreshCredits,
  consumeCredits,
  getOfferings,
  purchase,
  restorePurchases,
  getAppAccountToken,
  setForeground,
  shutdown,
  setLogHandler,
  addChangeListener: (cb: (event: import("./types").ChangeEvent) => void): (() => void) => {
    const sub = getEmitter().addListener("onChange", (payload: { event: string }) => {
      cb(payload.event as import("./types").ChangeEvent);
    });
    return () => sub.remove();
  },
} as const;

export type { RovenueConfig } from "./api/configure";
export type { LogEntry } from "./api/log";
