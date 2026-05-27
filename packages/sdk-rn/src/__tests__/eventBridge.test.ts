import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { startEventBridge, stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { makeMockNative, MockNative } from "./_mockNative";

describe("eventBridge", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
    store.clear();
  });
  afterEach(() => {
    stopEventBridge();
    _setNativeForTesting(null);
    store.clear();
  });

  it("IDENTITY_CHANGED refreshes user in store", async () => {
    startEventBridge();
    native.__state.user = { anonId: "anon_xyz", knownUserId: "user_42" };
    native.__emit("IDENTITY_CHANGED");
    // The handler awaits native.currentUser(), so flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get("user")).toEqual({ anonId: "anon_xyz", knownUserId: "user_42" });
  });

  it("ENTITLEMENTS_CHANGED refreshes entitlementsAll + per-id slots", async () => {
    startEventBridge();
    native.__state.entitlements.set("pro", {
      id: "pro", active: true, expiresAt: null, productId: null,
    });
    native.__state.entitlements.set("plus", {
      id: "plus", active: false, expiresAt: null, productId: null,
    });
    native.__emit("ENTITLEMENTS_CHANGED");
    await new Promise((r) => setTimeout(r, 0));
    const all = store.get<Array<{ id: string }>>("entitlementsAll");
    expect(all?.map((e) => e.id).sort()).toEqual(["plus", "pro"]);
    expect(store.get<{ active: boolean }>("entitlement:pro")?.active).toBe(true);
    expect(store.get<{ active: boolean }>("entitlement:plus")?.active).toBe(false);
  });

  it("CREDIT_BALANCE_CHANGED refreshes creditBalance", async () => {
    startEventBridge();
    native.__state.creditBalance = 99;
    native.__emit("CREDIT_BALANCE_CHANGED");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get<number>("creditBalance")).toBe(99);
  });

  it("startEventBridge is idempotent (second call is no-op)", () => {
    startEventBridge();
    startEventBridge();
    expect(native.addChangeListener).toHaveBeenCalledTimes(1);
  });

  it("stopEventBridge unregisters and allows restart", () => {
    startEventBridge();
    stopEventBridge();
    startEventBridge();
    expect(native.addChangeListener).toHaveBeenCalledTimes(2);
  });

  it("unknown events are ignored without throwing", async () => {
    startEventBridge();
    expect(() => native.__emit("SOMETHING_ELSE")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    // Store untouched
    expect(store.get("user")).toBeUndefined();
  });
});
