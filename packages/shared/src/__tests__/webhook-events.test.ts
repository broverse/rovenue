import { describe, it, expect } from "vitest";
import {
  WEBHOOK_EVENT_CATEGORIES,
  toWebhookEventCategory,
} from "../webhook-events";

describe("toWebhookEventCategory", () => {
  it("maps Apple notification types", () => {
    expect(toWebhookEventCategory("SUBSCRIBED")).toBe("purchase");
    expect(toWebhookEventCategory("DID_RENEW")).toBe("renewal");
    expect(toWebhookEventCategory("DID_CHANGE_RENEWAL_STATUS")).toBe("cancellation");
    expect(toWebhookEventCategory("REFUND")).toBe("refund");
    expect(toWebhookEventCategory("DID_FAIL_TO_RENEW")).toBe("billing_issue");
    expect(toWebhookEventCategory("EXPIRED")).toBe("expiration");
    expect(toWebhookEventCategory("PRICE_INCREASE")).toBe("product_change");
  });

  it("maps Google notification types", () => {
    expect(toWebhookEventCategory("SUBSCRIPTION_PURCHASED")).toBe("purchase");
    expect(toWebhookEventCategory("SUBSCRIPTION_RENEWED")).toBe("renewal");
    expect(toWebhookEventCategory("SUBSCRIPTION_CANCELED")).toBe("cancellation");
    expect(toWebhookEventCategory("SUBSCRIPTION_ON_HOLD")).toBe("billing_issue");
    expect(toWebhookEventCategory("SUBSCRIPTION_EXPIRED")).toBe("expiration");
    expect(toWebhookEventCategory("SUBSCRIPTION_PRICE_CHANGE_CONFIRMED")).toBe("product_change");
  });

  it("maps Stripe event types", () => {
    expect(toWebhookEventCategory("customer.subscription.created")).toBe("purchase");
    expect(toWebhookEventCategory("invoice.payment_succeeded")).toBe("renewal");
    expect(toWebhookEventCategory("customer.subscription.deleted")).toBe("cancellation");
    expect(toWebhookEventCategory("charge.refunded")).toBe("refund");
    expect(toWebhookEventCategory("invoice.payment_failed")).toBe("billing_issue");
    expect(toWebhookEventCategory("customer.subscription.updated")).toBe("product_change");
  });

  it("returns null for unmapped / consumption events", () => {
    expect(toWebhookEventCategory("CONSUMPTION_REQUEST")).toBeNull();
    expect(toWebhookEventCategory("unknown")).toBeNull();
    expect(toWebhookEventCategory("")).toBeNull();
  });

  it("exposes exactly 7 categories", () => {
    expect(WEBHOOK_EVENT_CATEGORIES).toHaveLength(7);
  });
});
