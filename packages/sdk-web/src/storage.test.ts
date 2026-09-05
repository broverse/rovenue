import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorage } from "./storage";

// `localStorage` fails in three different ways, and only one of them is the
// obvious one:
//
//   1. absent — server-side rendering. A module-scope access throws at import
//      time, before any consumer can guard it.
//   2. present but THROWING on use — Safari private mode and browsers with
//      site data blocked. A `typeof` check passes and the first write throws.
//   3. present and full — a quota error on write, long after the probe said
//      everything was fine.
//
// Only the first is caught by "is localStorage defined". The SDK must keep
// working in all three: an entitlement cache is a convenience, and losing it
// must never take the application down with it.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createStorage", () => {
  it("uses localStorage when it works", () => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
    });

    const store = createStorage();
    store.set("k", "v");
    expect(backing.get("k")).toBe("v");
    expect(store.get("k")).toBe("v");
  });

  it("falls back to memory when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    const store = createStorage();
    store.set("k", "v");
    expect(store.get("k")).toBe("v");
  });

  it("falls back to memory when localStorage throws on read", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    });

    const store = createStorage();
    expect(() => store.set("k", "v")).not.toThrow();
    expect(store.get("k")).toBe("v");
  });

  it("survives a write that throws AFTER the probe succeeded", () => {
    // Quota exhaustion looks exactly like this: the probe wrote fine, and a
    // later, larger write fails. Dropping the value is correct; taking the
    // caller down with it is not.
    let allowWrites = true;
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (!allowWrites) throw new Error("QuotaExceededError");
        backing.set(k, v);
      },
      removeItem: (k: string) => backing.delete(k),
    });

    const store = createStorage();
    store.set("a", "1");
    allowWrites = false;
    expect(() => store.set("b", "2")).not.toThrow();
    // The earlier value is still readable — one failed write does not
    // invalidate the store.
    expect(store.get("a")).toBe("1");
  });

  it("removes a key", () => {
    vi.stubGlobal("localStorage", undefined);
    const store = createStorage();
    store.set("k", "v");
    store.remove("k");
    expect(store.get("k")).toBeNull();
  });

  it("does not probe at import time", async () => {
    // The module must be importable with no globals at all. If the probe ran
    // at module scope, this import would throw before the test body runs.
    vi.stubGlobal("localStorage", {
      get getItem(): never {
        throw new Error("touched at import time");
      },
    });
    await expect(import("./storage")).resolves.toBeTruthy();
  });
});

describe("a full localStorage", () => {
  it("reads back what the write fell back to memory with", () => {
    // A FULL store refuses writes while getItem returns null WITHOUT
    // throwing. A try/catch alone therefore makes the memory copy
    // unreachable, and the event queue silently drops what it thought it had
    // persisted — in the module that documents at-least-once delivery.
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k.startsWith("rovenue.__probe")) {
          backing.set(k, v);
          return;
        }
        throw new Error("QuotaExceededError");
      },
      removeItem: (k: string) => backing.delete(k),
    });

    const store = createStorage();
    store.set("rovenue.events", "[1]");
    expect(store.get("rovenue.events")).toBe("[1]");
  });

  it("prefers the real store when it has the value", () => {
    const backing = new Map<string, string>([["k", "from-store"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
    });
    expect(createStorage().get("k")).toBe("from-store");
  });
});
