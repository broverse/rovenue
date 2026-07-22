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

// -------------------------------------------------------------
// Minimal host-component stand-ins for the paywall-ui renderer
// tests (@testing-library/react + happy-dom). They map the RN
// props the renderer actually uses onto DOM equivalents: testID →
// data-testid, onPress → onClick, disabled → disabled/aria.
// -------------------------------------------------------------
import { createElement, type ReactNode, type CSSProperties } from "react";

type StubProps = {
  children?: ReactNode;
  testID?: string;
  style?: CSSProperties | CSSProperties[];
  onPress?: () => void;
  disabled?: boolean;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  source?: { uri?: string };
  accessibilityLabel?: string;
};

function domProps(p: StubProps): Record<string, unknown> {
  return {
    "data-testid": p.testID,
    "aria-selected": p.accessibilityState?.selected,
    "aria-label": p.accessibilityLabel,
  };
}

export function View(p: StubProps) {
  return createElement("div", domProps(p), p.children);
}
export function Text(p: StubProps) {
  return createElement("span", domProps(p), p.children);
}
export function Pressable(p: StubProps) {
  return createElement(
    "button",
    { ...domProps(p), onClick: p.disabled ? undefined : p.onPress, disabled: p.disabled },
    p.children,
  );
}
export function Image(p: StubProps) {
  return createElement("img", { ...domProps(p), src: p.source?.uri });
}
