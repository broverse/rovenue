// Shared mock for RovenueNitroSpec — every test that touches the
// native layer should use this so we have one place to maintain
// the mock's behaviour.

import { vi } from "vitest";
import type {
  EntitlementDTO,
  ReceiptResultDTO,
  RovenueNitroSpec,
  UserDTO,
} from "../specs/RovenueNitroSpec.nitro";

export type MockNative = RovenueNitroSpec & {
  __state: {
    user: UserDTO;
    entitlements: Map<string, EntitlementDTO>;
    creditBalance: number;
    listeners: Array<(event: string) => void>;
  };
  __emit(event: string): void;
};

export function makeMockNative(): MockNative {
  const state = {
    user: { anonId: "anon_test", knownUserId: null } as UserDTO,
    entitlements: new Map<string, EntitlementDTO>(),
    creditBalance: 0,
    listeners: [] as Array<(event: string) => void>,
  };

  const mock: MockNative = {
    __state: state,
    __emit(event: string) {
      state.listeners.forEach((cb) => cb(event));
    },
    configure: vi.fn(),
    shutdown: vi.fn(),
    setForeground: vi.fn(),
    getVersion: vi.fn(() => "0.0.2"),
    currentUser: vi.fn(async () => state.user),
    identify: vi.fn(async (knownUserId: string) => {
      state.user = { ...state.user, knownUserId };
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
    postAppleReceipt: vi.fn(async (): Promise<ReceiptResultDTO> => ({
      ok: true,
      entitlementsRefreshed: true,
      creditsRefreshed: false,
    })),
    postGoogleReceipt: vi.fn(async (): Promise<ReceiptResultDTO> => ({
      ok: true,
      entitlementsRefreshed: true,
      creditsRefreshed: false,
    })),
    addChangeListener: vi.fn((cb: (event: string) => void) => {
      state.listeners.push(cb);
      return () => {
        const i = state.listeners.indexOf(cb);
        if (i >= 0) state.listeners.splice(i, 1);
      };
    }),
  } as unknown as MockNative;

  return mock;
}
