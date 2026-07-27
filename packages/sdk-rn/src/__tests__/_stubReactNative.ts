// Vitest stub for `react-native`. The real package uses Flow syntax
// that vite-node cannot parse. The sessionTracker module's runtime
// `require("react-native")` resolves here; individual tests override
// the AppState behaviour via `vi.mock("react-native", ...)` when they
// need to drive lifecycle events.

export type AppStateStatus = "active" | "background" | "inactive";

const listeners: Array<(s: AppStateStatus) => void> = [];

export const AppState = {
  addEventListener(_evt: "change", cb: (s: AppStateStatus) => void) {
    listeners.push(cb);
    return {
      remove: () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  },
  currentState: "active" as AppStateStatus,
  // Test-only helper: drive a state change from a test that doesn't use
  // vi.mock (kept so callers can simulate transitions if needed).
  __trigger(state: AppStateStatus) {
    listeners.forEach((cb) => cb(state));
  },
};

export type NativeEventSubscription = { remove: () => void };

// Minimal `Platform.OS` stand-in for the paywall-ui visibility gate
// (RovenuePaywallView reads it directly, the way it would on a real
// device). Fixed to "ios" — tests that need to exercise the other
// branch of the gate use a visibility rule targeting "android"/"web"
// rather than flipping this value, keeping the stub static like AppState
// isn't required to be here.
export const Platform = { OS: "ios" as const };

// Minimal `StyleSheet.create` stand-in: the real one returns opaque style
// IDs on native, but no consumer in this test environment reads through
// it — it only needs to hand back an object shaped like the input.
export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
};
