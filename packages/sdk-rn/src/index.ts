// @rovenue/sdk-rn — public surface.
//
// Imperative API:    Rovenue.configure(...), Rovenue.identify(...), ...
// React hooks:       useCurrentUser, useEntitlement, useEntitlements, useVirtualCurrencies
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
  RemoteConfig,
  ExperimentAssignment,
} from "./types";

export {
  RovenueError,
  InvalidApiKeyError,
  InvalidArgumentError,
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
export { useVirtualCurrencies, useVirtualCurrency } from "./hooks/useVirtualCurrencies";
export {
  useRemoteConfig,
  useFlag,
  useExperiment,
} from "./hooks/useRemoteConfig";

import { configure } from "./api/configure";
import { currentUser, identify, logOut } from "./api/identity";
import { entitlement, entitlementsAll, refreshEntitlements } from "./api/entitlements";
import { virtualCurrencies, virtualCurrency, refreshVirtualCurrencies } from "./api/virtualCurrencies";
import { getOfferings, purchase, restorePurchases } from "./api/purchases";
import {
  refreshRemoteConfig,
  getRemoteConfig,
  getFlag,
  getExperiment,
  getExperiments,
} from "./api/remoteConfig";
import { setForeground, shutdown } from "./api/lifecycle";
import { getAppAccountToken } from "./api/accountToken";
import {
  setAttributes,
  setEmail,
  setDisplayName,
  setPhoneNumber,
  setPushToken,
  flushAttributes,
} from "./api/attributes";
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
  virtualCurrencies,
  virtualCurrency,
  refreshVirtualCurrencies,
  getOfferings,
  purchase,
  restorePurchases,
  refreshRemoteConfig,
  getRemoteConfig,
  getFlag,
  getExperiment,
  getExperiments,
  getAppAccountToken,
  setForeground,
  shutdown,
  setLogHandler,
  setAttributes,
  setEmail,
  setDisplayName,
  setPhoneNumber,
  setPushToken,
  flushAttributes,
  addChangeListener: (cb: (event: import("./types").ChangeEvent) => void): (() => void) => {
    const sub = getEmitter().addListener("onChange", (payload: { event: string }) => {
      cb(payload.event as import("./types").ChangeEvent);
    });
    return () => sub.remove();
  },
} as const;

export type { RovenueConfig } from "./api/configure";
export type { LogEntry } from "./api/log";
