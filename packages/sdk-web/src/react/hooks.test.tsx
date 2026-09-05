// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure, type Rovenue } from "../index";
import { createMemoryStorage } from "../storage";
import { RovenueProvider, useEntitlements, useRovenue } from "./index";

// The two failures this layer actually produces in the wild:
//
//   1. a hook whose dependency array recreates the client each render, so the
//      SDK fetches on every paint. It looks fine locally and shows up as a
//      request storm in production.
//   2. a first paint that shows the paywall to someone who has already paid,
//      because the hook waited for the network instead of serving the cache
//      the SDK already holds.

// Testing Library's automatic cleanup only registers when vitest runs with
// `globals: true`, which this package deliberately does not. Without an
// explicit cleanup each render leaks into the next test, and the symptom is
// "Found multiple elements" in whichever test happens to query by testid.
afterEach(cleanup);

const API = "https://api.example";
const PK = "rov_pub_react";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function entitlementsResponse(entitlements: Record<string, unknown>) {
  return new Response(JSON.stringify({ data: { entitlements } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sdkWith(fetchImpl: unknown, storage = createMemoryStorage()): Rovenue {
  return configure({
    apiKey: PK,
    apiUrl: API,
    storage,
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function Entitlements() {
  const { entitlements, isLoading } = useEntitlements();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="value">{JSON.stringify(entitlements)}</span>
    </div>
  );
}

describe("useEntitlements", () => {
  it("serves the cache before the network resolves", async () => {
    const storage = createMemoryStorage();
    // Prime the cache through a completed fetch, then hold the next one open.
    const primed = sdkWith(
      vi.fn(async () => entitlementsResponse({ pro: true })),
      storage,
    );
    await primed.getEntitlements();

    const pending = deferred<Response>();
    const sdk = sdkWith(
      vi.fn(() => pending.promise),
      storage,
    );

    render(
      <RovenueProvider client={sdk}>
        <Entitlements />
      </RovenueProvider>,
    );

    // Cached value is on screen while the request is still in flight — this
    // is what stops a paying subscriber seeing a flash of the paywall.
    await waitFor(() =>
      expect(screen.getByTestId("value").textContent).toBe('{"pro":true}'),
    );
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await act(async () => {
      pending.resolve(entitlementsResponse({ pro: true, plus: true }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("value").textContent).toBe(
        '{"pro":true,"plus":true}',
      ),
    );
  });

  it("fetches once, not once per render", async () => {
    const fetchImpl = vi.fn(async () => entitlementsResponse({ pro: true }));
    const sdk = sdkWith(fetchImpl);

    const { rerender } = render(
      <RovenueProvider client={sdk}>
        <Entitlements />
      </RovenueProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false"),
    );

    for (let i = 0; i < 5; i++) {
      rerender(
        <RovenueProvider client={sdk}>
          <Entitlements />
        </RovenueProvider>,
      );
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error instead of pretending there are no entitlements", async () => {
    const sdk = sdkWith(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "NOPE", message: "bad key" } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    function WithError() {
      const { error, entitlements } = useEntitlements();
      return (
        <div>
          <span data-testid="err">{error ? "yes" : "no"}</span>
          <span data-testid="val">{JSON.stringify(entitlements)}</span>
        </div>
      );
    }

    render(
      <RovenueProvider client={sdk}>
        <WithError />
      </RovenueProvider>,
    );

    // An empty object here would read as "this person has nothing", which is
    // a different claim from "we could not find out".
    await waitFor(() =>
      expect(screen.getByTestId("err").textContent).toBe("yes"),
    );
    expect(screen.getByTestId("val").textContent).toBe("null");
  });

  it("refetches when asked", async () => {
    const fetchImpl = vi.fn(async () => entitlementsResponse({ pro: true }));
    const sdk = sdkWith(fetchImpl);

    function WithRefresh() {
      const { refresh, isLoading } = useEntitlements();
      return (
        <button type="button" onClick={() => void refresh()}>
          {String(isLoading)}
        </button>
      );
    }

    render(
      <RovenueProvider client={sdk}>
        <WithRefresh />
      </RovenueProvider>,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole("button").click();
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });
});

describe("provider", () => {
  it("names itself when a hook is used outside it", () => {
    // The default React error for a missing context is `undefined is not an
    // object`, which sends a developer looking in the wrong file.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useRovenue();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/RovenueProvider/);
    spy.mockRestore();
  });

  it("exposes the client it was given", async () => {
    const sdk = sdkWith(vi.fn(async () => entitlementsResponse({})));
    function ShowsId() {
      return <span data-testid="id">{useRovenue().rovenueId()}</span>;
    }
    render(
      <RovenueProvider client={sdk}>
        <ShowsId />
      </RovenueProvider>,
    );
    expect(screen.getByTestId("id").textContent).toBe(sdk.rovenueId());
  });
});
