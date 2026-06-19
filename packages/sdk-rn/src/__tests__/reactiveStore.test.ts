import { describe, expect, it, vi } from "vitest";
import { ReactiveStore } from "../store/reactiveStore";

describe("ReactiveStore", () => {
  it("get returns undefined for missing slots", () => {
    const s = new ReactiveStore();
    expect(s.get("user")).toBeUndefined();
  });

  it("set stores and get retrieves", () => {
    const s = new ReactiveStore();
    s.set("virtualCurrencies", 42);
    expect(s.get<number>("virtualCurrencies")).toBe(42);
  });

  it("subscribers fire on set", () => {
    const s = new ReactiveStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.set("user", { rovenueId: "a", appUserId: null });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const s = new ReactiveStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    s.set("user", { rovenueId: "a", appUserId: null });
    unsub();
    s.set("virtualCurrencies", 5);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("multiple subscribers all fire on set", () => {
    const s = new ReactiveStore();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    s.subscribe(cb1);
    s.subscribe(cb2);
    s.set("virtualCurrencies", 1);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("clear empties values and notifies subscribers", () => {
    const s = new ReactiveStore();
    s.set("user", { rovenueId: "a", appUserId: null });
    const cb = vi.fn();
    s.subscribe(cb);
    s.clear();
    expect(s.get("user")).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("supports entitlement:<id> slot pattern", () => {
    const s = new ReactiveStore();
    s.set("entitlement:pro", { id: "pro", active: true, expiresAt: null, productId: null });
    expect(s.get<{ active: boolean }>("entitlement:pro")?.active).toBe(true);
    expect(s.get("entitlement:free")).toBeUndefined();
  });
});
