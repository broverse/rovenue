import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("stripe-billing client", () => {
  const original = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("getPlatformStripe returns a Stripe instance when HOST_MODE=cloud and secret set", async () => {
    process.env.HOST_MODE = "cloud";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake_123";
    const mod = await import("../src/lib/stripe-billing");
    const stripe = mod.getPlatformStripe();
    expect(stripe).toBeDefined();
    expect(typeof stripe!.customers.create).toBe("function");
  });

  it("getPlatformStripe returns null when HOST_MODE=self", async () => {
    process.env.HOST_MODE = "self";
    const mod = await import("../src/lib/stripe-billing");
    expect(mod.getPlatformStripe()).toBeNull();
  });

  it("isBillingEnabled mirrors HOST_MODE", async () => {
    process.env.HOST_MODE = "cloud";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    const mod = await import("../src/lib/host-mode");
    expect(mod.isBillingEnabled()).toBe(true);
  });
});
