import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { startSessionTracker, stopSessionTracker } from "../api/sessionTracker";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

// Hoisted AppState mock — must be at module scope per vi.mock semantics.
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

function trigger(state: "active" | "background" | "inactive") {
  appStateListeners.forEach((cb) => cb(state));
}

describe("sessionTracker", () => {
  beforeEach(() => {
    _setNativeForTesting(null);
    appStateListeners.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopSessionTracker();
    vi.useRealTimers();
  });

  it("records 'open' on first start", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    startSessionTracker();
    // microtask flush — initial 'open' is dispatched synchronously
    await Promise.resolve();
    expect(mock.recordSessionEvent).toHaveBeenCalledWith(
      "open",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      undefined,
    );
  });

  it("records 'background' with durationMs when going to background", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    startSessionTracker();
    // advance 5 seconds in the foreground
    await vi.advanceTimersByTimeAsync(5000);
    trigger("background");
    // allow debounce timer to fire (DEBOUNCE_MS = 1000)
    await vi.advanceTimersByTimeAsync(1100);
    const calls = (mock.recordSessionEvent as any).mock.calls as Array<
      [string, string, number | undefined]
    >;
    const bgCall = calls.find((c) => c[0] === "background");
    expect(bgCall).toBeDefined();
    expect(bgCall![2]).toBeGreaterThanOrEqual(4500);
    expect(bgCall![2]).toBeLessThanOrEqual(7000);
  });

  it("debounces sub-1s state transitions", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    startSessionTracker();
    await Promise.resolve();
    const before = (mock.recordSessionEvent as any).mock.calls.length;
    // rapid flap within 1s
    trigger("background");
    trigger("active");
    trigger("background");
    await vi.advanceTimersByTimeAsync(500);
    // should not have recorded the flap yet (debounce timer hasn't elapsed)
    expect((mock.recordSessionEvent as any).mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(600);
    // after debounce settles, exactly one transition recorded
    expect((mock.recordSessionEvent as any).mock.calls.length).toBe(before + 1);
  });

  it("stopSessionTracker removes the listener and stops the flush timer", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    startSessionTracker();
    await Promise.resolve();
    stopSessionTracker();
    trigger("background");
    await vi.advanceTimersByTimeAsync(1100);
    // No further 'background' calls after stop (only 'open' + 'close' on stop).
    const callsAfterStop = (mock.recordSessionEvent as any).mock.calls.filter(
      (c: any[]) => c[0] === "background",
    );
    expect(callsAfterStop.length).toBe(0);
  });
});
