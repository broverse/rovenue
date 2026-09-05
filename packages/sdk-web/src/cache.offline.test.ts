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
    sdk.logOut();
    expect(sdk.getCachedEntitlements()).toBeNull();
  });
});
