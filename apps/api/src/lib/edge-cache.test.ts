import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The helper reads `env` (parsed once at import) and the api-key repo,
// and POSTs to the Cloudflare edge-cache Worker. We mock all three so
// the unit test exercises only the branching + request shape.

// vi.mock factories are hoisted above imports, so the shared mock
// state must be created via vi.hoisted (also hoisted) to be in scope.
const { envMock, listActiveApiKeys } = vi.hoisted(() => ({
  envMock: {} as {
    EDGE_CACHE_PURGE_URL?: string;
    EDGE_CACHE_PURGE_SECRET?: string;
  },
  listActiveApiKeys: vi.fn(),
}));

vi.mock("./env", () => ({ env: envMock }));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@rovenue/db", () => ({
  drizzle: { db: {}, apiKeyRepo: { listActiveApiKeys } },
}));

import { purgeProjectCatalogCache } from "./edge-cache";

// Lets the test await the fire-and-forget microtasks the helper spawns.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("purgeProjectCatalogCache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    listActiveApiKeys.mockReset();
    delete envMock.EDGE_CACHE_PURGE_URL;
    delete envMock.EDGE_CACHE_PURGE_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops when the purge endpoint is unconfigured", async () => {
    purgeProjectCatalogCache("proj_1");
    await flush();
    expect(listActiveApiKeys).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("purges once per active public key with the secret header and key body", async () => {
    envMock.EDGE_CACHE_PURGE_URL = "https://edge.rovenue.io/__edge/purge";
    envMock.EDGE_CACHE_PURGE_SECRET = "s3cr3t";
    listActiveApiKeys.mockResolvedValue([
      { keyPublic: "rov_pub_a" },
      { keyPublic: "rov_pub_b" },
    ]);

    purgeProjectCatalogCache("proj_1");
    await flush();

    expect(listActiveApiKeys).toHaveBeenCalledWith({}, "proj_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://edge.rovenue.io/__edge/purge");
    expect(init.method).toBe("POST");
    expect(init.headers["x-edge-purge-secret"]).toBe("s3cr3t");
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse(c[1].body as string).key,
    );
    expect(bodies).toEqual(["rov_pub_a", "rov_pub_b"]);
  });

  it("swallows fetch errors (best-effort)", async () => {
    envMock.EDGE_CACHE_PURGE_URL = "https://edge.rovenue.io/__edge/purge";
    envMock.EDGE_CACHE_PURGE_SECRET = "s3cr3t";
    listActiveApiKeys.mockResolvedValue([{ keyPublic: "rov_pub_a" }]);
    fetchMock.mockRejectedValue(new Error("network down"));

    // Must not throw / reject.
    expect(() => purgeProjectCatalogCache("proj_1")).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
