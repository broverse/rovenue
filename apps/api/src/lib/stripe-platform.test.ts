import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  STRIPE_CONNECT_CLIENT_ID: undefined as string | undefined,
  STRIPE_CONNECT_CLIENT_ID_TEST: undefined as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY: undefined as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY_TEST: undefined as string | undefined,
}));

vi.mock("./env", () => ({ env: envMock }));

import {
  _resetPlatformStripeForTests,
  connectClientId,
  getPlatformStripe,
  isConnectConfigured,
} from "./stripe-platform";

beforeEach(() => {
  envMock.STRIPE_CONNECT_CLIENT_ID = undefined;
  envMock.STRIPE_CONNECT_CLIENT_ID_TEST = undefined;
  envMock.STRIPE_PLATFORM_SECRET_KEY = undefined;
  envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = undefined;
  _resetPlatformStripeForTests();
});

afterEach(() => {
  _resetPlatformStripeForTests();
});

describe("isConnectConfigured", () => {
  it("is false when the client id is missing", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(isConnectConfigured()).toBe(false);
  });

  it("is false when the platform secret key is missing", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    expect(isConnectConfigured()).toBe(false);
  });

  it("is true when both are present", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(isConnectConfigured()).toBe(true);
  });
});

describe("connectClientId", () => {
  it("returns the live client id for live mode", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_CONNECT_CLIENT_ID_TEST = "ca_test";
    expect(connectClientId("live")).toBe("ca_live");
  });

  it("returns the test client id for test mode", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_CONNECT_CLIENT_ID_TEST = "ca_test";
    expect(connectClientId("test")).toBe("ca_test");
  });

  it("returns null when the requested mode has no client id", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    expect(connectClientId("test")).toBeNull();
  });
});

describe("getPlatformStripe", () => {
  it("returns null when the key for that mode is unset", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(getPlatformStripe(false)).toBeNull();
  });

  it("returns a client for live mode and memoises it", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    const first = getPlatformStripe(true);
    expect(first).not.toBeNull();
    expect(getPlatformStripe(true)).toBe(first);
  });

  it("keeps live and test clients separate", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = "sk_test_x";
    expect(getPlatformStripe(true)).not.toBe(getPlatformStripe(false));
  });
});
