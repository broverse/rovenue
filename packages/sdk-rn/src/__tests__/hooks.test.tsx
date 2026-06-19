// @vitest-environment happy-dom
//
// Hooks are platform-agnostic: useSyncExternalStore works in any
// React 18 renderer. We test in DOM because @testing-library/react
// is lighter than @testing-library/react-native and the mock native
// module makes the platform layer irrelevant for these tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import * as React from "react";
import { _setNativeForTesting } from "../core/native";
import { startEventBridge, stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { makeMockNative, MockNative } from "./_mockNative";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useEntitlement } from "../hooks/useEntitlement";
import { useEntitlements } from "../hooks/useEntitlements";
import { useRemoteConfig, useFlag, useExperiment } from "../hooks/useRemoteConfig";
import { useCreditBalance } from "../hooks/useCreditBalance";

describe("Rovenue hooks", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
    store.clear();
    startEventBridge();
  });
  afterEach(() => {
    // @testing-library/react's vitest auto-cleanup only fires when
    // vitest is run with globals: true. We don't, so unmount manually.
    cleanup();
    stopEventBridge();
    _setNativeForTesting(null);
    store.clear();
  });

  it("useCurrentUser warms up on mount then renders", async () => {
    native.__state.user = { rovenueId: "anon_1", appUserId: null };
    function App() {
      const user = useCurrentUser();
      return <span data-testid="u">{user?.rovenueId ?? "loading"}</span>;
    }
    render(<App />);
    // Initial render: warm-up is in-flight, store empty.
    expect(screen.getByTestId("u").textContent).toBe("loading");
    // Flush microtasks for the warm-up Promise.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("u").textContent).toBe("anon_1");
  });

  it("useCurrentUser updates on IDENTITY_CHANGED event", async () => {
    function App() {
      const user = useCurrentUser();
      return <span data-testid="u">{user?.appUserId ?? "anon"}</span>;
    }
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("u").textContent).toBe("anon");
    await act(async () => {
      native.__state.user = { rovenueId: "anon_1", appUserId: "user_42" };
      native.__emit("IDENTITY_CHANGED");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("u").textContent).toBe("user_42");
  });

  it("useEntitlement returns null when entitlement missing", async () => {
    function App() {
      const ent = useEntitlement("pro");
      return <span data-testid="e">{ent?.active ? "active" : "inactive"}</span>;
    }
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("e").textContent).toBe("inactive");
  });

  it("useEntitlement renders cached active state", async () => {
    native.__state.entitlements.set("pro", {
      id: "pro", active: true, expiresAt: null, productId: null,
    });
    function App() {
      const ent = useEntitlement("pro");
      return <span data-testid="e">{ent?.active ? "active" : "inactive"}</span>;
    }
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("e").textContent).toBe("active");
  });

  it("useEntitlements lists all", async () => {
    native.__state.entitlements.set("pro", {
      id: "pro", active: true, expiresAt: null, productId: null,
    });
    native.__state.entitlements.set("plus", {
      id: "plus", active: false, expiresAt: null, productId: null,
    });
    function App() {
      const all = useEntitlements();
      return <span data-testid="a">{all.map((e) => e.id).sort().join(",")}</span>;
    }
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("a").textContent).toBe("plus,pro");
  });

  it("useCreditBalance returns 0 when uncached", () => {
    function App() {
      const b = useCreditBalance();
      return <span data-testid="b">{b}</span>;
    }
    render(<App />);
    expect(screen.getByTestId("b").textContent).toBe("0");
  });

  it("useCreditBalance updates on CREDIT_BALANCE_CHANGED", async () => {
    function App() {
      const b = useCreditBalance();
      return <span data-testid="b">{b}</span>;
    }
    render(<App />);
    await act(async () => {
      native.__state.creditBalance = 25;
      native.__emit("CREDIT_BALANCE_CHANGED");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("b").textContent).toBe("25");
  });

  it("useFlag warms up on mount then renders the flag value", async () => {
    native.__state.remoteConfig.flags = { new_paywall: true };
    function App() {
      const on = useFlag("new_paywall", false);
      return <span data-testid="f">{on ? "on" : "off"}</span>;
    }
    render(<App />);
    // Initial render: warm-up in-flight, fallback shown.
    expect(screen.getByTestId("f").textContent).toBe("off");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("f").textContent).toBe("on");
  });

  it("useRemoteConfig + useExperiment update on REMOTE_CONFIG_CHANGED", async () => {
    function App() {
      const config = useRemoteConfig();
      const exp = useExperiment("checkout_test");
      return (
        <span data-testid="x">
          {String(config.flags.max_items ?? "none")}:{exp?.variantName ?? "unassigned"}
        </span>
      );
    }
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId("x").textContent).toBe("none:unassigned");

    await act(async () => {
      native.__state.remoteConfig.flags = { max_items: 7 };
      native.__state.remoteConfig.experiments = {
        checkout_test: {
          experimentId: "exp_1",
          key: "checkout_test",
          variantId: "var_b",
          variantName: "Treatment",
          valueJson: "{}",
        },
      };
      native.__emit("REMOTE_CONFIG_CHANGED");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("x").textContent).toBe("7:Treatment");
  });
});
