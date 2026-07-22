import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  STRIPE_CONNECT_CLIENT_ID: "ca_live" as string | undefined,
  STRIPE_CONNECT_CLIENT_ID_TEST: "ca_test" as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY: "sk_live_x" as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY_TEST: "sk_test_x" as string | undefined,
}));
const findActiveByProject = vi.hoisted(() => vi.fn());

vi.mock("./env", () => ({ env: envMock }));
vi.mock("@rovenue/db", () => ({
  drizzle: { db: {}, stripeConnectionRepo: { findActiveByProject } },
}));

import {
  _resetConnectPlatformStripeForTests,
  chargesEnabled,
  getConnectedStripe,
  requireConnectedStripe,
} from "./stripe-platform";

beforeEach(() => {
  findActiveByProject.mockReset();
  _resetConnectPlatformStripeForTests();
});

describe("getConnectedStripe", () => {
  it("returns null when the project has no connection", async () => {
    findActiveByProject.mockResolvedValue(null);
    expect(await getConnectedStripe("p1")).toBeNull();
  });

  it("returns the account id and a live client for a live connection", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
    });
    const result = await getConnectedStripe("p1");
    expect(result?.accountId).toBe("acct_1");
    expect(result?.livemode).toBe(true);
    expect(result?.account).toBeDefined();
  });

  it("picks the platform client by the connection's livemode", async () => {
    // Comparing the two facades would prove nothing — withAccount returns
    // a fresh object every call. What actually pins mode dispatch is that
    // removing ONE mode's key breaks only that mode.
    envMock.STRIPE_PLATFORM_SECRET_KEY = undefined;
    _resetConnectPlatformStripeForTests();

    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_t",
      livemode: false,
    });
    expect(await getConnectedStripe("p1")).not.toBeNull();

    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_l",
      livemode: true,
    });
    expect(await getConnectedStripe("p1")).toBeNull();

    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
  });

  it("returns null when the platform key for that mode is unset", async () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = undefined;
    _resetConnectPlatformStripeForTests();
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_t",
      livemode: false,
    });
    expect(await getConnectedStripe("p1")).toBeNull();
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = "sk_test_x";
  });
});

describe("requireConnectedStripe", () => {
  it("throws an error naming the project when unconnected", async () => {
    findActiveByProject.mockResolvedValue(null);
    await expect(requireConnectedStripe("proj_42")).rejects.toThrow(/proj_42/);
  });

  it("resolves to the ConnectedStripe value when an active connection exists", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
    });
    const result = await requireConnectedStripe("proj_42");
    expect(result.accountId).toBe("acct_1");
    expect(result.account).toBeDefined();
  });
});

describe("chargesEnabled", () => {
  it("is false without a connection", async () => {
    findActiveByProject.mockResolvedValue(null);
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is false when Stripe has charges disabled", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: false,
      capabilities: { card_payments: "active" },
    });
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is false when card_payments is not active", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: true,
      capabilities: { card_payments: "pending" },
    });
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is true when both are satisfied", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: true,
      capabilities: { card_payments: "active" },
    });
    expect(await chargesEnabled("p1")).toBe(true);
  });
});
