import { describe, expect, it, vi } from "vitest";
import { configure } from "./index";
import { createMemoryStorage } from "./storage";

// When getEntitlements() cannot reach the server, whether to answer from
// cache depends on WHY. Serving stale data through a misconfiguration hides
// it for as long as the cache survives — which is exactly when a developer
// most needs to see it.

const API = "https://api.example";
const PK = "rov_pub_offline";

function ok(entitlements: Record<string, unknown>) {
  return new Response(JSON.stringify({ data: { entitlements } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function httpError(status: number) {
  return new Response(
    JSON.stringify({ error: { code: "NOPE", message: "nope" } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function primed(then: () => Promise<Response> | Response) {
  const storage = createMemoryStorage();
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(ok({ pro: true }))
    .mockImplementation(then);
  const sdk = configure({
    apiKey: PK,
    apiUrl: API,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  await sdk.getEntitlements();
  return sdk;
}

describe("entitlements when the request fails", () => {
  it("serves the cache when the network is unreachable", async () => {
    const sdk = await primed(() => Promise.reject(new Error("offline")));
    await expect(sdk.getEntitlements()).resolves.toEqual({ pro: true });
  });

  it("serves the cache on a 5xx", async () => {
    const sdk = await primed(() => httpError(503));
    await expect(sdk.getEntitlements()).resolves.toEqual({ pro: true });
  });

  it("serves the cache on a 429, where backing off is correct", async () => {
    const sdk = await primed(() => httpError(429));
    await expect(sdk.getEntitlements()).resolves.toEqual({ pro: true });
  });

  it.each([400, 401, 403, 404])(
    "throws on %d rather than hiding a misconfiguration",
    async (status) => {
      const sdk = await primed(() => httpError(status));
      await expect(sdk.getEntitlements()).rejects.toMatchObject({ status });
    },
  );

  it("throws when offline with nothing cached", async () => {
    const sdk = configure({
      apiKey: PK,
      apiUrl: API,
      storage: createMemoryStorage(),
      fetchImpl: (() =>
        Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    await expect(sdk.getEntitlements()).rejects.toThrow("offline");
  });

  it("clears the cache on logOut so the next person sees nothing", async () => {
    const sdk = await primed(() => Promise.reject(new Error("offline")));
    await sdk.logOut();
    expect(sdk.getCachedEntitlements()).toBeNull();
  });
});

// =============================================================
// Findings from the first outside review
// =============================================================

describe("review findings", () => {
  it("retries a rate-limited event instead of dropping it", async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    );
    const sdk = configure({
      apiKey: PK,
      apiUrl: API,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sdk.track({ eventType: "paywall_view" });
    await sdk.flushEvents();

    // Dropping it would lose telemetry exactly when volume is highest.
    expect(
      JSON.parse(storage.get("rovenue.events") ?? "[]"),
    ).toHaveLength(1);
  });

  it("drops an event the server will never accept", async () => {
    const storage = createMemoryStorage();
    const sdk = configure({
      apiKey: PK,
      apiUrl: API,
      storage,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { code: "VALIDATION", message: "bad" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    sdk.track({ eventType: "paywall_view" });
    await sdk.flushEvents();
    // Retaining it forever would block every later event behind it.
    expect(JSON.parse(storage.get("rovenue.events") ?? "[]")).toHaveLength(0);
  });

  it("does not carry a previous identity's events past logOut", async () => {
    const storage = createMemoryStorage();
    const sdk = configure({
      apiKey: PK,
      apiUrl: API,
      storage,
      fetchImpl: (() =>
        Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });

    sdk.track({ eventType: "paywall_view" });
    await sdk.flushEvents();
    expect(JSON.parse(storage.get("rovenue.events") ?? "[]")).toHaveLength(1);

    await sdk.logOut();

    // Headers are built at post time, so an event surviving the rotation
    // would be delivered attributed to whoever logs in next.
    expect(JSON.parse(storage.get("rovenue.events") ?? "[]")).toHaveLength(0);
  });

  it("persists the identity across constructions by default", async () => {
    // The default storage must be the real one. Defaulting to memory mints a
    // new subscriber on every page load and orphans the cache and queue with
    // it — and it is only ever correct for a developer who read the docs and
    // passed `storage` themselves.
    //
    // localStorage is stubbed because this suite runs under node, where
    // createStorage correctly falls back to memory; the behaviour under test
    // is what happens in a BROWSER.
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
      removeItem: (k: string) => backing.delete(k),
    });
    try {
      const first = configure({ apiKey: PK, apiUrl: API }).rovenueId();
      const second = configure({ apiKey: PK, apiUrl: API }).rovenueId();
      expect(second).toBe(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
