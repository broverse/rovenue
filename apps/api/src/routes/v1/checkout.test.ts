// =============================================================
// POST /v1/checkout — SDK-facing Stripe Checkout Session (unit)
// =============================================================
//
// This route starts a charge, so the tests that matter are the negative
// ones. Each asserts one property the design depends on:
//
//   1. A body carrying a price, amount or customer is refused BEFORE the
//      handler runs — the `.strict()` schema is what makes "the browser
//      cannot decide what it pays" true rather than merely intended.
//   2. The amount comes from the offering, never the request.
//   3. The subscriber comes from the authenticated header, never the body,
//      and rides into Stripe's metadata so the webhook can attribute it.
//   4. Both redirect URLs are checked against the project's verified
//      domains — the cancel URL is followed by a real browser too.
//   5. A package outside the project's offering is refused.
//
// `apiKeyAuth` and `appUserContext` run for real (only `@rovenue/db` and
// Stripe's connected-account resolution are mocked) so the actual identity
// path is exercised rather than a stand-in for it.

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error";

const PROJECT_ID = "proj_checkout_1";
const PUBLIC_KEY = "rov_pub_checkout_key_abc";
const APP_USER_ID = "device-checkout-1";
const SUBSCRIBER_ID = "sub_checkout_1";
const OFFERING_ID = "off_1";
const PACKAGE_IDENTIFIER = "monthly";
const PRODUCT_ID = "prod_1";
const RESOLVED_PRICE_ID = "price_from_offering";
const SUCCESS_URL = "https://app.example.com/done";
const CANCEL_URL = "https://app.example.com/cancelled";

const findApiKeyByPublicMock = vi.fn();
const resolveSubscriberByRovenueIdMock = vi.fn();
const listByProjectMock = vi.fn();
const findOfferingByIdMock = vi.fn();
const findProductsByIdsMock = vi.fn();
const findLatestStripeCustomerIdMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    apiKeyRepo: {
      findApiKeyByPublic: (...args: unknown[]) =>
        findApiKeyByPublicMock(...args),
      findApiKeyById: vi.fn(async () => null),
      updateApiKeyLastUsed: vi.fn(async () => undefined),
    },
    subscriberRepo: {
      resolveSubscriberByRovenueId: (...args: unknown[]) =>
        resolveSubscriberByRovenueIdMock(...args),
      findSubscriberByRovenueId: vi.fn(async () => null),
      upsertSubscriber: vi.fn(),
    },
    customDomainRepo: {
      listByProject: (...args: unknown[]) => listByProjectMock(...args),
    },
    offeringRepo: {
      findOfferingById: (...args: unknown[]) => findOfferingByIdMock(...args),
      findProductsByIds: (...args: unknown[]) => findProductsByIdsMock(...args),
    },
    funnelPurchaseRepo: {
      findLatestStripeCustomerIdForSubscriber: (...args: unknown[]) =>
        findLatestStripeCustomerIdMock(...args),
    },
  },
}));

const requireConnectedStripeMock = vi.fn();

vi.mock("../../lib/stripe-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/stripe-platform")>()),
  requireConnectedStripe: (...args: unknown[]) =>
    requireConnectedStripeMock(...args),
}));

const { checkoutRoute } = await import("./checkout");
const { ROVENUE_SUBSCRIBER_METADATA_KEY } = await import(
  "../../services/stripe/checkout-session"
);
const { apiKeyAuth } = await import("../../middleware/api-key-auth");

function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/checkout", checkoutRoute);
  app.onError(errorHandler);
  return app;
}

function authedHeaders() {
  return {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    "x-rovenue-app-user-id": APP_USER_ID,
    "Content-Type": "application/json",
  };
}

function validBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    offeringId: OFFERING_ID,
    packageIdentifier: PACKAGE_IDENTIFIER,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
    ...extra,
  });
}

let sessionsCreateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findApiKeyByPublicMock.mockReset();
  resolveSubscriberByRovenueIdMock.mockReset();
  listByProjectMock.mockReset();
  findOfferingByIdMock.mockReset();
  findProductsByIdsMock.mockReset();
  findLatestStripeCustomerIdMock.mockReset();
  requireConnectedStripeMock.mockReset();

  findApiKeyByPublicMock.mockResolvedValue({
    id: "ak_checkout_1",
    revokedAt: null,
    expiresAt: null,
    project: { id: PROJECT_ID, name: "Checkout project" },
  });
  resolveSubscriberByRovenueIdMock.mockResolvedValue({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: APP_USER_ID,
    appUserId: null,
    attributes: {},
  });
  listByProjectMock.mockResolvedValue([
    { hostname: "app.example.com", verifiedAt: new Date() },
  ]);
  findOfferingByIdMock.mockResolvedValue({
    id: OFFERING_ID,
    packages: [{ identifier: PACKAGE_IDENTIFIER, productId: PRODUCT_ID }],
  });
  findProductsByIdsMock.mockResolvedValue([
    { id: PRODUCT_ID, storeIds: { stripe: RESOLVED_PRICE_ID } },
  ]);
  findLatestStripeCustomerIdMock.mockResolvedValue(null);
  sessionsCreateMock = vi.fn(async () => ({
    id: "cs_1",
    url: "https://checkout.stripe.com/c/pay/cs_1",
  }));
  requireConnectedStripeMock.mockResolvedValue({
    accountId: "acct_connected",
    livemode: true,
    account: { checkout: { sessions: { create: sessionsCreateMock } } },
  });
});

describe("POST /v1/checkout", () => {
  it("derives the price from the offering, never from the request", async () => {
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });

    expect(res.status).toBe(200);
    const session = sessionsCreateMock.mock.calls[0]?.[0] as {
      line_items: Array<{ price: string }>;
    };
    expect(session.line_items[0]?.price).toBe(RESOLVED_PRICE_ID);
  });

  it.each(["price", "amount", "customer", "priceId", "unitAmount", "quantity"])(
    "400s when the body carries %s",
    async (field) => {
      const res = await buildApp().request("/v1/checkout", {
        method: "POST",
        headers: authedHeaders(),
        body: validBody({ [field]: "anything" }),
      });
      expect(res.status).toBe(400);
      // Refused before the handler ran: Stripe was never called at all.
      expect(sessionsCreateMock).not.toHaveBeenCalled();
    },
  );

  it("takes the subscriber from the header and carries it into metadata", async () => {
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });

    expect(res.status).toBe(200);
    const session = sessionsCreateMock.mock.calls[0]?.[0] as {
      metadata: Record<string, string>;
      subscription_data: { metadata: Record<string, string> };
    };
    expect(session.metadata[ROVENUE_SUBSCRIBER_METADATA_KEY]).toBe(
      SUBSCRIBER_ID,
    );
    // On the subscription too: customer.subscription.* webhooks see the
    // subscription's metadata, not the session's.
    expect(
      session.subscription_data.metadata[ROVENUE_SUBSCRIBER_METADATA_KEY],
    ).toBe(SUBSCRIBER_ID);
  });

  it.each([
    ["successUrl", { successUrl: "https://evil.example/done" }],
    // The cancel URL is followed by a real browser too.
    ["cancelUrl", { cancelUrl: "https://evil.example/cancelled" }],
  ])("400s when %s is not a verified domain", async (_field, override) => {
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(override),
    });
    expect(res.status).toBe(400);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("400s for a non-https redirect even on a verified host", async () => {
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody({ successUrl: "http://app.example.com/done" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when the package is not in the project's offering", async () => {
    findOfferingByIdMock.mockResolvedValue({
      id: OFFERING_ID,
      packages: [{ identifier: "something-else", productId: PRODUCT_ID }],
    });
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });
    expect(res.status).toBe(400);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("400s when the offering belongs to another project", async () => {
    findOfferingByIdMock.mockResolvedValue(null);
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });
    expect(res.status).toBe(400);
  });

  it("400s when the package has no Stripe price configured", async () => {
    findProductsByIdsMock.mockResolvedValue([
      { id: PRODUCT_ID, storeIds: {} },
    ]);
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });
    expect(res.status).toBe(400);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Customer reuse and idempotency
  // ---------------------------------------------------------------
  //
  // Stripe creates the Customer when a subscription-mode session COMPLETES,
  // not when it is created, so two concurrent sessions cannot mint two
  // customers on their own — serialising session creation would prevent
  // nothing while looking like it did. The duplicate that IS reachable is a
  // subscriber who already has a customer (from a funnel purchase, say)
  // starting a web checkout: without reuse Stripe makes a second one, and the
  // billing portal, which resolves the latest, then shows them only one.

  it("reuses the subscriber's existing Stripe customer", async () => {
    findLatestStripeCustomerIdMock.mockResolvedValue("cus_existing");
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });

    expect(res.status).toBe(200);
    const session = sessionsCreateMock.mock.calls[0]?.[0] as {
      customer?: string;
    };
    expect(session.customer).toBe("cus_existing");
  });

  it("lets Stripe create the customer for a first-time buyer", async () => {
    findLatestStripeCustomerIdMock.mockResolvedValue(null);
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });

    expect(res.status).toBe(200);
    const session = sessionsCreateMock.mock.calls[0]?.[0] as {
      customer?: string;
    };
    // Absent, not null — Stripe rejects an explicit null for this field.
    expect(session.customer).toBeUndefined();
  });

  it("looks the customer up for the AUTHENTICATED subscriber", async () => {
    findLatestStripeCustomerIdMock.mockResolvedValue("cus_existing");
    await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });
    expect(findLatestStripeCustomerIdMock).toHaveBeenCalledWith(
      expect.anything(),
      SUBSCRIBER_ID,
    );
  });

  it("passes an Idempotency-Key through to Stripe", async () => {
    const key = "idem_abc_123";
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: { ...authedHeaders(), "Idempotency-Key": key },
      body: validBody(),
    });

    expect(res.status).toBe(200);
    // Stripe's own idempotency is authoritative and survives our process
    // restarting; a second scheme here would only be a worse copy of it.
    const options = sessionsCreateMock.mock.calls[0]?.[1] as
      | { idempotencyKey?: string }
      | undefined;
    expect(options?.idempotencyKey).toBe(key);
  });

  it("omits the idempotency option when the client sends no key", async () => {
    await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: authedHeaders(),
      body: validBody(),
    });
    const options = sessionsCreateMock.mock.calls[0]?.[1] as
      | { idempotencyKey?: string }
      | undefined;
    expect(options?.idempotencyKey).toBeUndefined();
  });

  it("401s without a Bearer key", async () => {
    const res = await buildApp().request("/v1/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(),
    });
    expect(res.status).toBe(401);
  });
});
