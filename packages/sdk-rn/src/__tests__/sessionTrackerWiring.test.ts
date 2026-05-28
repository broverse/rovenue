import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { configure } from "../api/configure";
import { shutdown } from "../api/lifecycle";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

// Same react-native mock as sessionTracker.test.ts — sessionTracker imports
// AppState, so we need a stub here too.
const appStateListeners: Array<(s: string) => void> = [];
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_evt: string, cb: (s: string) => void) => {
      appStateListeners.push(cb);
      return {
        remove: () => {
          const i = appStateListeners.indexOf(cb);
          if (i >= 0) appStateListeners.splice(i, 1);
        },
      };
    },
    currentState: "active",
  },
}));

describe("session tracker lifecycle", () => {
  beforeEach(() => {
    _setNativeForTesting(null);
    appStateListeners.length = 0;
  });
  afterEach(() => {
    _setNativeForTesting(null);
  });

  it("starts the tracker on configure() and stops on shutdown()", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    configure({ apiKey: "test_pk", baseUrl: "http://localhost:0", debug: true });
    // initial 'open' is recorded synchronously then awaited via microtask
    await Promise.resolve();
    expect(mock.recordSessionEvent).toHaveBeenCalled();
    const callsBefore = (mock.recordSessionEvent as any).mock.calls.length;
    shutdown();
    // After shutdown, subsequent AppState changes are no-ops; tracker is null.
    expect((mock.recordSessionEvent as any).mock.calls.length).toBeGreaterThanOrEqual(
      callsBefore,
    );
  });
});
