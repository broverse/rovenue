import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "./identity";
import { createMemoryStorage } from "./storage";

describe("identity", () => {
  it("persists the rovenueId across constructions", () => {
    const storage = createMemoryStorage();
    const first = createIdentity(storage).rovenueId();
    const second = createIdentity(storage).rovenueId();
    expect(second).toBe(first);
  });

  it("keeps the app scope client-local", () => {
    const identity = createIdentity(createMemoryStorage());
    const wire = identity.rovenueId();
    identity.identify("acct_9");
    expect(identity.appUserScope()).toBe("acct_9");
    // The wire identity is unmoved. This is the property whose absence
    // produced orphan-subscriber routing: merging is a server-side operation
    // through the secret-key transfer endpoint, not something identify() does.
    expect(identity.rovenueId()).toBe(wire);
  });

  it("warns when identify() is handed an email address", () => {
    const warn = vi.fn();
    createIdentity(createMemoryStorage(), warn).identify("a@example.com");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("guessable"));
  });

  it.each(["acct_9f2", "01H8XYZ", "user-1234-abcd"])(
    "does not warn for an opaque id (%s)",
    (id) => {
      const warn = vi.fn();
      createIdentity(createMemoryStorage(), warn).identify(id);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("warns but still accepts — it does not throw", () => {
    const identity = createIdentity(createMemoryStorage(), () => {});
    expect(() => identity.identify("a@example.com")).not.toThrow();
    expect(identity.appUserScope()).toBe("a@example.com");
  });

  it("clears the scope and mints a new rovenueId on logOut", () => {
    const identity = createIdentity(createMemoryStorage());
    identity.identify("acct_9");
    const before = identity.rovenueId();
    identity.logOut();
    expect(identity.appUserScope()).toBeNull();
    expect(identity.rovenueId()).not.toBe(before);
  });

  it("persists the new rovenueId after logOut", () => {
    const storage = createMemoryStorage();
    const identity = createIdentity(storage);
    identity.logOut();
    expect(createIdentity(storage).rovenueId()).toBe(identity.rovenueId());
  });
});
