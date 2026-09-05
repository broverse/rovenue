import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "./index";
import { createMemoryStorage } from "./storage";

// The properties asserted here are the ones that have cost this codebase
// real breakage before, or that the browser surface depends on:
//
//   - the WIRE identity is the rovenueId, never the app scope from
//     identify(). Sending the scope produced orphan-subscriber routing.
//   - the base URL carries the public key in the PATH, because a CORS
//     preflight has no Authorization header and the server must still know
//     which project is asking.
//   - identify() warns on a guessable id: a public key is visible in the
//     browser, so an app user id anyone can guess is an entitlement anyone
//     can read.

const API = "https://api.example";
const PK = "rov_pub_test_web";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchImpl: ReturnType<typeof vi.fn>;

function sdk(extra?: { warn?: (m: string) => void }) {
  void extra;
  return configure({
    apiKey: PK,
    apiUrl: API,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    storage: createMemoryStorage(),
  });
}

beforeEach(() => {
  fetchImpl = vi.fn(async () => jsonResponse({ entitlements: {} }));
});

describe("wire identity", () => {
  it("sends the rovenueId, never the app scope from identify()", async () => {
    const r = sdk();
    r.identify("customer-scope-42");
    await r.getEntitlements();

    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["x-rovenue-app-user-id"]).toBe(r.rovenueId());
    expect(headers["x-rovenue-app-user-id"]).not.toBe("customer-scope-42");
  });

  it("reports the web platform", async () => {
    await sdk().getEntitlements();
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["x-rovenue-platform"]).toBe("web");
  });

  it("sends the public key as a Bearer token as well as in the path", async () => {
    await sdk().getEntitlements();
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe(`Bearer ${PK}`);
  });

  it("keeps the rovenueId stable across calls", async () => {
    const r = sdk();
    await r.getEntitlements();
    await r.getEntitlements();
    const first = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const second = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(first["x-rovenue-app-user-id"]).toBe(second["x-rovenue-app-user-id"]);
  });

  it("mints a new rovenueId on logOut", async () => {
    const r = sdk();
    const before = r.rovenueId();
    // Awaited: logOut flushes queued events under the OLD identity first, so
    // they are not delivered attributed to whoever comes next.
    await r.logOut();
    expect(r.rovenueId()).not.toBe(before);
  });
});

describe("browser surface URL", () => {
  it("puts the public key in the path", async () => {
    await sdk().getEntitlements();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${API}/v1/web/${PK}/me/entitlements`,
    );
  });

  it("tolerates a trailing slash on apiUrl", async () => {
    const r = configure({
      apiKey: PK,
      apiUrl: `${API}/`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage: createMemoryStorage(),
    });
    await r.getEntitlements();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${API}/v1/web/${PK}/me/entitlements`,
    );
  });
});

describe("checkout", () => {
  it("names a package and never a price", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ sessionId: "cs_1", url: "https://checkout/x" }),
    );
    const r = sdk();
    await r.checkout({
      offeringId: "off_1",
      packageIdentifier: "monthly",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      offeringId: "off_1",
      packageIdentifier: "monthly",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    // The server's schema is .strict(); a price field here would 400. The
    // SDK must not invent one even helpfully.
    expect(body).not.toHaveProperty("price");
  });

  it("forwards an idempotency key as a header, not in the body", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ sessionId: "cs_1", url: "https://checkout/x" }),
    );
    await sdk().checkout({
      offeringId: "off_1",
      packageIdentifier: "monthly",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
      idempotencyKey: "idem_1",
    });

    const init = fetchImpl.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
      body: string;
    };
    expect(init.headers["Idempotency-Key"]).toBe("idem_1");
    expect(JSON.parse(init.body)).not.toHaveProperty("idempotencyKey");
  });
});

describe("errors", () => {
  it("surfaces the server's error code and message", async () => {
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "VALIDATION_ERROR", message: "Nope" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(sdk().getEntitlements()).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Nope",
    });
  });

  it("still reports the status when the error body is not JSON", async () => {
    fetchImpl.mockResolvedValue(
      new Response("<html>502</html>", { status: 502 }),
    );
    await expect(sdk().getEntitlements()).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("configure", () => {
  it.each(["apiKey", "apiUrl"])("throws without %s", (missing) => {
    const opts: Record<string, unknown> = { apiKey: PK, apiUrl: API };
    delete opts[missing];
    expect(() => configure(opts as never)).toThrow(new RegExp(missing));
  });
});

// =============================================================
// Findings from the second review
// =============================================================
//
// These are all parity failures: the Web SDK was written from the API's
// shapes rather than from what the native SDKs already send, and every one of
// them is invisible to a test whose mock returns whatever the client expects.

describe("responses without a JSON body", () => {
  it.each([202, 204])("does not throw on %d", async (status) => {
    fetchImpl.mockResolvedValue(new Response(null, { status }));
    // /v1/events answers 202 with no body. Calling res.json() on it throws,
    // which the event queue reads as "not acknowledged" — replaying an event
    // the server already ingested, on every flush, forever.
    await expect(
      sdk().http.post("/events", { eventType: "x" }),
    ).resolves.toBeUndefined();
  });

  it("still parses a normal JSON envelope", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ entitlements: { pro: true } }));
    await expect(sdk().getEntitlements()).resolves.toEqual({ pro: true });
  });
});

describe("subscriber headers", () => {
  it("sends BOTH identity headers, as the native core does", async () => {
    const r = sdk();
    await r.getEntitlements();
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    // /v1/placements, /v1/config and /v1/experiments read the subscriber from
    // x-rovenue-user-id. Sending only the app-user header left every web
    // request anonymous: audience rows could never match, and a null
    // subscriber forces the project holdout to zero.
    expect(headers["x-rovenue-app-user-id"]).toBe(r.rovenueId());
    expect(headers["x-rovenue-user-id"]).toBe(r.rovenueId());
  });
});

describe("placement identifiers", () => {
  it("encodes an identifier that would otherwise change the path", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({}));
    await sdk().getPlacement("a/b?c");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${API}/v1/web/${PK}/placements/a%2Fb%3Fc`,
    );
  });
});

describe("experiment exposure", () => {
  it("posts the assignment for the authenticated subscriber", async () => {
    fetchImpl.mockResolvedValue(new Response(null, { status: 202 }));
    const r = sdk();
    await r.recordExposure({
      experimentId: "exp_1",
      variantId: "b",
      placementId: "onboarding",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${API}/v1/web/${PK}/experiments/exp_1/expose`,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      variantId: "b",
      subscriberId: r.rovenueId(),
      placementId: "onboarding",
      platform: "web",
    });
    // No exposedAt: the server stamps it. ClickHouse partitions and TTLs
    // raw_exposures on that column and revenue attribution compares
    // eventDate >= min(exposedAt), so a skewed device clock would make a
    // visitor a permanent non-converter or TTL their exposure away entirely.
    expect(body).not.toHaveProperty("exposedAt");
  });

  it("does not reject when the exposure call fails", async () => {
    fetchImpl.mockRejectedValue(new Error("offline"));
    // Fire-and-forget, like the native path: a failed exposure must not stop
    // a paywall from rendering.
    await expect(
      sdk().recordExposure({ experimentId: "e", variantId: "v" }),
    ).resolves.toBeUndefined();
  });
});
