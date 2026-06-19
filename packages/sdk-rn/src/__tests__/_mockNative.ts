// Shared mock for RovenueModuleSpec — every test that touches the
// native layer uses this. Provides:
//   - All 15 façade methods as vi.fn() with reasonable default behaviour
//   - addListener / removeListeners (Expo EventEmitter wire methods,
//     no-ops since the stub's EventEmitter delegates to __addChangeListener)
//   - __addChangeListener(cb) / __emit(event)         — change-event channel
//   - __addLogListener(cb) / __emitLog(entry)         — log-event channel
//   - __state — mutable test fixture state

import { vi } from "vitest";
import type {
  EntitlementDTO,
  LogEntryDTO,
  RovenueModuleSpec,
  UserDTO,
} from "../specs/RovenueModule.types";

export type MockNative = RovenueModuleSpec & {
  __state: {
    user: UserDTO;
    entitlements: Map<string, EntitlementDTO>;
    creditBalance: number;
    remoteConfig: {
      flags: Record<string, unknown>;
      experiments: Record<string, unknown>;
    };
    changeListeners: Array<(payload: { event: string }) => void>;
    logListeners: Array<(entry: LogEntryDTO) => void>;
  };
  __emit(event: string): void;
  __emitLog(entry: LogEntryDTO): void;
  __addChangeListener(cb: (payload: { event: string }) => void): () => void;
  __addLogListener(cb: (entry: LogEntryDTO) => void): () => void;
};

export function makeMockNative(): MockNative {
  const state = {
    user: { rovenueId: "anon_test", appUserId: null } as UserDTO,
    entitlements: new Map<string, EntitlementDTO>(),
    creditBalance: 0,
    remoteConfig: {
      flags: {} as Record<string, unknown>,
      experiments: {} as Record<string, unknown>,
    },
    changeListeners: [] as Array<(payload: { event: string }) => void>,
    logListeners: [] as Array<(entry: LogEntryDTO) => void>,
  };

  const mock: MockNative = {
    __state: state,
    __emit(event: string) {
      state.changeListeners.forEach((cb) => cb({ event }));
    },
    __emitLog(entry: LogEntryDTO) {
      state.logListeners.forEach((cb) => cb(entry));
    },
    __addChangeListener(cb: (payload: { event: string }) => void) {
      state.changeListeners.push(cb);
      return () => {
        const i = state.changeListeners.indexOf(cb);
        if (i >= 0) state.changeListeners.splice(i, 1);
      };
    },
    __addLogListener(cb: (entry: LogEntryDTO) => void) {
      state.logListeners.push(cb);
      return () => {
        const i = state.logListeners.indexOf(cb);
        if (i >= 0) state.logListeners.splice(i, 1);
      };
    },
    configure: vi.fn(),
    shutdown: vi.fn(),
    setForeground: vi.fn(),
    getVersion: vi.fn(() => "0.1.0"),
    currentUser: vi.fn(async () => state.user),
    identify: vi.fn(async (appUserId: string) => {
      state.user = { ...state.user, appUserId };
      mock.__emit("IDENTITY_CHANGED");
    }),
    logOut: vi.fn(async () => {
      state.user = { rovenueId: "anon_new", appUserId: null };
      mock.__emit("IDENTITY_CHANGED");
    }),
    entitlement: vi.fn(async (id: string) => state.entitlements.get(id) ?? null),
    entitlementsAll: vi.fn(async () => Array.from(state.entitlements.values())),
    refreshEntitlements: vi.fn(async () => {
      mock.__emit("ENTITLEMENTS_CHANGED");
    }),
    creditBalance: vi.fn(async () => state.creditBalance),
    refreshCredits: vi.fn(async () => {
      mock.__emit("CREDIT_BALANCE_CHANGED");
    }),
    consumeCredits: vi.fn(async (amount: number) => {
      if (state.creditBalance < amount) {
        const err: any = new Error("insufficient");
        err.code = "InsufficientCredits";
        err.extras = { available: state.creditBalance };
        throw err;
      }
      state.creditBalance -= amount;
      mock.__emit("CREDIT_BALANCE_CHANGED");
      return state.creditBalance;
    }),
    getOfferings: vi.fn(async () => ({ current: null, offerings: [] })),
    purchase: vi.fn(async () => ({ entitlements: [], creditBalance: 0, productId: "", storeTransactionId: "" })),
    restorePurchases: vi.fn(async () => ({ entitlements: [], creditBalance: 0, productId: "", storeTransactionId: "" })),
    refreshRemoteConfig: vi.fn(async () => {
      mock.__emit("REMOTE_CONFIG_CHANGED");
    }),
    remoteConfigBool: vi.fn(async (key: string, fallback: boolean) => {
      const v = state.remoteConfig.flags[key];
      return typeof v === "boolean" ? v : fallback;
    }),
    remoteConfigString: vi.fn(async (key: string, fallback: string) => {
      const v = state.remoteConfig.flags[key];
      return typeof v === "string" ? v : fallback;
    }),
    remoteConfigInt: vi.fn(async (key: string, fallback: number) => {
      const v = state.remoteConfig.flags[key];
      return typeof v === "number" ? Math.trunc(v) : fallback;
    }),
    remoteConfigDouble: vi.fn(async (key: string, fallback: number) => {
      const v = state.remoteConfig.flags[key];
      return typeof v === "number" ? v : fallback;
    }),
    remoteConfigJson: vi.fn(async (key: string) => {
      const v = state.remoteConfig.flags[key];
      return v === undefined ? null : JSON.stringify(v);
    }),
    remoteConfigKeys: vi.fn(async () => Object.keys(state.remoteConfig.flags)),
    remoteConfigAllJson: vi.fn(async () => {
      const experiments: Record<string, unknown> = {};
      for (const [k, dto] of Object.entries(state.remoteConfig.experiments)) {
        const e = dto as {
          experimentId: string;
          key: string;
          variantId: string;
          variantName: string;
          valueJson: string;
        };
        experiments[k] = {
          experimentId: e.experimentId,
          key: e.key,
          variantId: e.variantId,
          variantName: e.variantName,
          value: JSON.parse(e.valueJson),
        };
      }
      return JSON.stringify({ flags: state.remoteConfig.flags, experiments });
    }),
    experiment: vi.fn(async (key: string) => state.remoteConfig.experiments[key] ?? null),
    experimentsAll: vi.fn(async () => Object.values(state.remoteConfig.experiments)),
    getAppAccountToken: vi.fn(async () => "00000000-0000-0000-0000-000000000001"),
    recordSessionEvent: vi.fn(
      async (
        _kind: "open" | "background" | "close",
        _occurredAt: string,
        _durationMs?: number,
      ) => undefined,
    ),
    flushSessionEvents: vi.fn(async () => 0),
    setAttributes: vi.fn(async (_attributes: Record<string, string | null>) => undefined),
    setEmail: vi.fn(async (_email: string | null) => undefined),
    setDisplayName: vi.fn(async (_name: string | null) => undefined),
    setPhoneNumber: vi.fn(async (_phone: string | null) => undefined),
    setPushToken: vi.fn(async (_token: string | null) => undefined),
    flushAttributes: vi.fn(async () => 0),
    // Expo EventEmitter wire methods — no-op (stub's EventEmitter
    // delegates to __addChangeListener/__addLogListener instead).
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  } as unknown as MockNative;

  return mock;
}
