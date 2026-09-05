// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure, type Rovenue } from "../index";
import { createMemoryStorage } from "../storage";
import { RovenueProvider } from "../react/index";
import { RovenuePaywall } from "./index";

// The renderer itself is tested in its own package. What is tested here is
// the wiring only, and specifically the three things this component owns:
// which paywall gets chosen when an experiment is in play, that a view is
// recorded once rather than per render, and that a retired placement renders
// nothing instead of throwing.

vi.mock("@rovenue/paywall-renderer", () => ({
  PaywallRenderer: (props: {
    config: { marker?: string };
    onPurchase: (pkg: string) => void;
    onClose?: () => void;
  }) => (
    <div>
      <div data-testid="rendered">{props.config?.marker ?? "no-marker"}</div>
      <button type="button" onClick={() => props.onPurchase("monthly")}>
        buy
      </button>
      <button type="button" onClick={() => props.onClose?.()}>
        close
      </button>
    </div>
  ),
  resolvePersistedFirstShownAt: () => undefined,
}));

afterEach(cleanup);

const API = "https://api.example";
const PK = "rov_pub_paywall";

function envelope(body: unknown) {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sdk(body: unknown): Rovenue {
  return configure({
    apiKey: PK,
    apiUrl: API,
    storage: createMemoryStorage(),
    fetchImpl: (async () => envelope(body)) as unknown as typeof fetch,
  });
}

function renderWith(client: Rovenue) {
  return render(
    <RovenueProvider client={client}>
      <RovenuePaywall
        placement="onboarding"
        successUrl="https://app.example.com/ok"
        cancelUrl="https://app.example.com/no"
      />
    </RovenueProvider>,
  );
}

const PLAIN = {
  placement: { identifier: "onboarding", revision: 3 },
  paywall: {
    id: "pw_1",
    identifier: "main",
    builderConfig: { marker: "plain" },
    offering: null,
  },
  experiment: null,
};

describe("RovenuePaywall", () => {
  it("renders the placement's paywall", async () => {
    renderWith(sdk(PLAIN));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").textContent).toBe("plain"),
    );
  });

  it("renders nothing for a retired placement", async () => {
    const client = sdk({ placement: null, paywall: null, experiment: null });
    renderWith(client);
    // The API returns an empty envelope rather than a 404 precisely so a
    // shipped app does not break when a placement is retired.
    await waitFor(() => expect(screen.queryByTestId("rendered")).toBeNull());
  });

  it("renders nothing for a remote-config-only paywall", async () => {
    renderWith(
      sdk({
        placement: { identifier: "onboarding", revision: 1 },
        paywall: { id: "pw_2", identifier: "rc", offering: null },
        experiment: null,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("rendered")).toBeNull());
  });

  it("records paywall_view once, not once per render", async () => {
    const client = sdk(PLAIN);
    const track = vi.spyOn(client, "track");
    const { rerender } = renderWith(client);
    await waitFor(() => expect(track).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 4; i++) {
      rerender(
        <RovenueProvider client={client}>
          <RovenuePaywall
        placement="onboarding"
        successUrl="https://app.example.com/ok"
        cancelUrl="https://app.example.com/no"
      />
        </RovenueProvider>,
      );
    }
    // A view fired per paint would make the paywall funnel's denominator
    // meaningless.
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("attributes the view to the placement and paywall", async () => {
    const client = sdk(PLAIN);
    const track = vi.spyOn(client, "track");
    renderWith(client);
    await waitFor(() => expect(track).toHaveBeenCalled());
    expect(track.mock.calls[0]![0]).toMatchObject({
      eventType: "paywall_view",
      paywallContext: {
        paywallId: "pw_1",
        placementId: "onboarding",
        placementRevision: 3,
      },
    });
  });

  it("assigns an experiment variant deterministically", async () => {
    const withExperiment = {
      placement: { identifier: "onboarding", revision: 4 },
      paywall: null,
      experiment: {
        id: "exp_1",
        key: "pricing_test",
        variants: [
          {
            variantId: "a",
            weight: 0.5,
            paywall: {
              id: "pw_a",
              identifier: "a",
              builderConfig: { marker: "variant-a" },
              offering: null,
            },
          },
          {
            variantId: "b",
            weight: 0.5,
            paywall: {
              id: "pw_b",
              identifier: "b",
              builderConfig: { marker: "variant-b" },
              offering: null,
            },
          },
        ],
      },
    };

    const client = sdk(withExperiment);
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("rendered").textContent).toMatch(
        /^variant-[ab]$/,
      ),
    );
    const first = screen.getByTestId("rendered").textContent;

    // Same subscriber, same experiment key — the assignment is sticky, which
    // is the property that keeps a user in one variant across every fetch.
    cleanup();
    renderWith(client);
    await waitFor(() =>
      expect(screen.getByTestId("rendered").textContent).toBe(first),
    );
  });

  it("carries the variant into the view event's attribution", async () => {
    const client = sdk({
      placement: { identifier: "onboarding", revision: 4 },
      paywall: null,
      experiment: {
        id: "exp_1",
        key: "pricing_test",
        variants: [
          {
            variantId: "only",
            weight: 1,
            paywall: {
              id: "pw_only",
              identifier: "only",
              builderConfig: { marker: "only" },
              offering: null,
            },
          },
        ],
      },
    });
    const track = vi.spyOn(client, "track");
    renderWith(client);
    await waitFor(() => expect(track).toHaveBeenCalled());
    expect(track.mock.calls[0]![0].paywallContext).toMatchObject({
      variantId: "only",
      experimentKey: "pricing_test",
    });
  });
});

describe("purchase", () => {
  const WITH_OFFERING = {
    placement: { identifier: "onboarding", revision: 3 },
    paywall: {
      id: "pw_1",
      identifier: "main",
      builderConfig: { marker: "plain" },
      offering: { id: "off_1" },
    },
    experiment: null,
  };

  it("starts a checkout naming the package, never a price", async () => {
    const client = sdk(WITH_OFFERING);
    const checkout = vi
      .spyOn(client, "checkout")
      .mockResolvedValue({ sessionId: "cs_1", url: "https://checkout/x" });
    const assign = vi.fn();
    Object.defineProperty(globalThis, "location", {
      value: { assign },
      configurable: true,
    });

    renderWith(client);
    await waitFor(() => expect(screen.getByRole("button", { name: /buy/i })).toBeTruthy());
    screen.getByRole("button", { name: /buy/i }).click();

    await waitFor(() => expect(checkout).toHaveBeenCalled());
    const arg = checkout.mock.calls[0]![0];
    expect(arg).toMatchObject({
      offeringId: "off_1",
      packageIdentifier: "monthly",
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    expect(arg).not.toHaveProperty("price");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout/x"));
  });

  it("hands the tap to the host when it supplies onPurchase", async () => {
    const client = sdk(WITH_OFFERING);
    const checkout = vi.spyOn(client, "checkout");
    const onPurchase = vi.fn();

    render(
      <RovenueProvider client={client}>
        <RovenuePaywall
          placement="onboarding"
          successUrl="https://app.example.com/ok"
          cancelUrl="https://app.example.com/no"
          onPurchase={onPurchase}
        />
      </RovenueProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /buy/i })).toBeTruthy());
    screen.getByRole("button", { name: /buy/i }).click();

    await waitFor(() => expect(onPurchase).toHaveBeenCalledWith("monthly"));
    expect(checkout).not.toHaveBeenCalled();
  });

  it("does nothing when the paywall has no offering to buy from", async () => {
    const client = sdk(PLAIN);
    const checkout = vi.spyOn(client, "checkout");
    renderWith(client);
    await waitFor(() => expect(screen.getByRole("button", { name: /buy/i })).toBeTruthy());
    screen.getByRole("button", { name: /buy/i }).click();
    // A configuration gap must not throw inside a tap handler.
    await new Promise((r) => setTimeout(r, 10));
    expect(checkout).not.toHaveBeenCalled();
  });
});

describe("experiment exposure and close", () => {
  const WITH_EXPERIMENT = {
    placement: { identifier: "onboarding", revision: 4 },
    paywall: null,
    experiment: {
      id: "exp_1",
      key: "pricing_test",
      variants: [
        {
          variantId: "only",
          weight: 1,
          paywall: {
            id: "pw_only",
            identifier: "only",
            builderConfig: { marker: "only" },
            offering: null,
          },
        },
      ],
    },
  };

  it("records the exposure right after the draw", async () => {
    const client = sdk(WITH_EXPERIMENT);
    const exposure = vi.spyOn(client, "recordExposure").mockResolvedValue();
    renderWith(client);

    // A visitor bucketed into an arm but absent from exposure_events still
    // contributes revenue while missing from the denominator, which biases
    // every conversion rate and breaks the sample-ratio check.
    await waitFor(() => expect(exposure).toHaveBeenCalledTimes(1));
    expect(exposure.mock.calls[0]![0]).toMatchObject({
      experimentId: "exp_1",
      variantId: "only",
      placementId: "onboarding",
    });
  });

  it("does not record an exposure when there is no experiment", async () => {
    const client = sdk(PLAIN);
    const exposure = vi.spyOn(client, "recordExposure").mockResolvedValue();
    renderWith(client);
    await waitFor(() => expect(screen.getByTestId("rendered")).toBeTruthy());
    expect(exposure).not.toHaveBeenCalled();
  });

  it("emits paywall_close, which the funnel needs to compute dismissal", async () => {
    const client = sdk(PLAIN);
    const track = vi.spyOn(client, "track");
    render(
      <RovenueProvider client={client}>
        <RovenuePaywall
          placement="onboarding"
          successUrl="https://app.example.com/ok"
          cancelUrl="https://app.example.com/no"
        />
      </RovenueProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rendered")).toBeTruthy());

    track.mockClear();
    screen.getByRole("button", { name: /close/i }).click();

    await waitFor(() => expect(track).toHaveBeenCalled());
    expect(track.mock.calls[0]![0]).toMatchObject({
      eventType: "paywall_close",
      paywallContext: { paywallId: "pw_1", placementId: "onboarding" },
    });
  });
});

describe("event dedupe", () => {
  const WITH_EXPERIMENT = {
    placement: { identifier: "onboarding", revision: 4 },
    paywall: null,
    experiment: {
      id: "exp_1",
      key: "pricing_test",
      variants: [
        {
          variantId: "only",
          weight: 1,
          paywall: {
            id: "pw_only",
            identifier: "only",
            builderConfig: { marker: "only" },
            offering: null,
          },
        },
      ],
    },
  };

  it("records one close however many times the node is tapped", async () => {
    const client = sdk(PLAIN);
    const track = vi.spyOn(client, "track");
    renderWith(client);
    await waitFor(() => expect(screen.getByTestId("rendered")).toBeTruthy());
    track.mockClear();

    const close = screen.getByRole("button", { name: /close/i });
    close.click();
    close.click();
    close.click();

    await waitFor(() => expect(track).toHaveBeenCalled());
    // Nothing unmounts the paywall on close, so an undeduped handler would
    // give three closes against one view — a dismissal rate above 100%.
    expect(
      track.mock.calls.filter((c) => c[0].eventType === "paywall_close"),
    ).toHaveLength(1);
  });

  it("records one exposure across remounts", async () => {
    const client = sdk(WITH_EXPERIMENT);
    const exposure = vi.spyOn(client, "recordExposure").mockResolvedValue();
    const { rerender } = renderWith(client);
    await waitFor(() => expect(exposure).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 3; i++) {
      rerender(
        <RovenueProvider client={client}>
          <RovenuePaywall
            placement="onboarding"
            successUrl="https://app.example.com/ok"
            cancelUrl="https://app.example.com/no"
          />
        </RovenueProvider>,
      );
    }
    // uniq(subscriberId) keeps SRM honest, but uniqExact(eventId) counts
    // every row — repeated exposures drift the per-user ratio for web only.
    expect(exposure).toHaveBeenCalledTimes(1);
  });
});
