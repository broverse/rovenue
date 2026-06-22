import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

describe("POST /billing/stripe/webhook", () => {
  const original = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  function signEvent(
    payload: string,
    secret: string,
    timestamp: number,
  ): string {
    return Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp,
    });
  }

  it("returns 404 when HOST_MODE=self (billing disabled)", async () => {
    process.env.HOST_MODE = "self";
    const app = await buildApp();
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "x" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the Stripe signature is invalid", async () => {
    process.env.HOST_MODE = "cloud";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_test_secret";
    const app = await buildApp();
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with received:true for a valid signed event", async () => {
    process.env.HOST_MODE = "cloud";
    process.env.STRIPE_BILLING_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_test_secret";
    const app = await buildApp();
    const payload = JSON.stringify({
      id: "evt_test_1",
      type: "invoice.paid",
      data: { object: { id: "in_test" } },
      api_version: "2024-12-18.acacia",
      created: Math.floor(Date.now() / 1000),
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signEvent(payload, "whsec_test_secret", ts);
    const res = await app.request("/billing/stripe/webhook", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": sig, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; result: string };
    expect(json.received).toBe(true);
    // Phase 2 dispatcher returns a status code rather than echoing the
    // event type. `invoice.paid` is not a handled type → "ignored";
    // the test fixture also lacks a Stripe `customer` field so the
    // project-resolution branch would otherwise route to
    // "project_not_found", but the ignored check happens first.
    expect(json.result).toBe("ignored");
  });
});
