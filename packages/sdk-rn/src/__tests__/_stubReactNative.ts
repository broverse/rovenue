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
