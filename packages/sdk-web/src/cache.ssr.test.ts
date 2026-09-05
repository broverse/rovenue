// @vitest-environment node
import { describe, expect, it } from "vitest";

// Server-side rendering is not an edge case for a web SDK — Next.js and
// Remix execute this code on the server for every request. There is no
// `window`, no `document` and no `localStorage`, and a module-scope access
// to any of them throws at IMPORT time, before a consumer can guard it with
// a `typeof window` check of their own.
//
// So this file asserts the one thing that cannot be recovered from: that
// importing and constructing the SDK on a server does not throw.

describe("server-side rendering", () => {
  it("has no DOM in this environment", () => {
    expect(typeof globalThis.window).toBe("undefined");
    expect(typeof globalThis.localStorage).toBe("undefined");
  });

  it("imports without touching the DOM", async () => {
    await expect(import("./index")).resolves.toBeTruthy();
  });

  it("constructs and reports an identity", async () => {
    const { configure } = await import("./index");
    const sdk = configure({
      apiKey: "rov_pub_ssr",
      apiUrl: "https://api.example",
    });
    // A real value, not a placeholder: the id has to be stable within the
    // render even though it cannot be persisted anywhere.
    expect(sdk.rovenueId()).toMatch(/\w+/);
  });

  it("serves the cache without a network call", async () => {
    const { configure } = await import("./index");
    const { createMemoryStorage } = await import("./storage");
    const storage = createMemoryStorage();

    const sdk = configure({
      apiKey: "rov_pub_ssr",
      apiUrl: "https://api.example",
      storage,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { entitlements: { pro: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });

    await sdk.getEntitlements();
    const cached = sdk.getCachedEntitlements();
    expect(cached).toEqual({ pro: true });
  });

  it("returns null from the cache before anything has been fetched", async () => {
    const { configure } = await import("./index");
    const { createMemoryStorage } = await import("./storage");
    const sdk = configure({
      apiKey: "rov_pub_ssr",
      apiUrl: "https://api.example",
      storage: createMemoryStorage(),
    });
    expect(sdk.getCachedEntitlements()).toBeNull();
  });
});
