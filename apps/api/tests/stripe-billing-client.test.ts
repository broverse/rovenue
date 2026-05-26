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

  it("getPlatformStripe returns a Stripe instance when BILLING_ENABLED and secret set", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake_123";
    const mod = await import("../src/lib/stripe-billing");
    const stripe = mod.getPlatformStripe();
    expect(stripe).toBeDefined();
    expect(typeof stripe!.customers.create).toBe("function");
  });

  it("getPlatformStripe returns null when BILLING_ENABLED=false", async () => {
    process.env.BILLING_ENABLED = "false";
    const mod = await import("../src/lib/stripe-billing");
    expect(mod.getPlatformStripe()).toBeNull();
  });

  it("isBillingEnabled mirrors env", async () => {
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    const mod = await import("../src/lib/billing-flags");
    expect(mod.isBillingEnabled()).toBe(true);
  });
});
