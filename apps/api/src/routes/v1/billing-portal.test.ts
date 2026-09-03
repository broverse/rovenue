// =============================================================
// POST /v1/billing-portal — SDK-facing billing-portal session (unit)
// =============================================================
//
// This route returns a URL granting access to a customer's payment data,
// so it gets treated like an auth surface rather than a convenience
// route. The tests that matter are the negative ones:
//
//   1. An unauthenticated call fails (real `apiKeyAuth`, no Bearer token).
//   2. A body-supplied customer id does not change whose portal opens —
//      the body schema is `.strict()`, so an unknown key 400s before the
//      handler ever runs, and the session is proven to open for the
//      AUTHENTICATED subscriber's own Stripe customer, never a supplied
//      one.
//   3. An unlisted return URL is rejected.
//
// `apiKeyAuth` and `appUserContext` run for real here (only `@rovenue/db`
// and Stripe's connected-account resolution are mocked) so these tests
// exercise the actual auth/identity code path, not a hand-rolled stand-in
// for it.

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/error";

const PROJECT_ID = "proj_test_1";
const API_KEY_ID = "ak_test_1";
const PUBLIC_KEY = "rov_pub_test_key_abc123";
const APP_USER_ID = "device-1";
const SUBSCRIBER_ID = "sub_1";
const STRIPE_CUSTOMER_ID = "cus_real_owner";
const VERIFIED_RETURN_URL = "https://app.example.com/account/billing";

const findApiKeyByPublicMock = vi.fn();
const resolveSubscriberByRovenueIdMock = vi.fn();
const listByProjectMock = vi.fn();
const findLatestStripeCustomerIdForSubscriberMock = vi.fn();

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
    funnelPurchaseRepo: {
      findLatestStripeCustomerIdForSubscriber: (...args: unknown[]) =>
        findLatestStripeCustomerIdForSubscriberMock(...args),
    },
  },
}));

const requireConnectedStripeMock = vi.fn();

vi.mock("../../lib/stripe-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/stripe-platform")>()),
  requireConnectedStripe: (...args: unknown[]) =>
    requireConnectedStripeMock(...args),
}));

const { billingPortalRoute } = await import("./billing-portal");
const { apiKeyAuth } = await import("../../middleware/api-key-auth");

async function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/billing-portal", billingPortalRoute);
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

let sessionsCreateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findApiKeyByPublicMock.mockReset();
  resolveSubscriberByRovenueIdMock.mockReset();
  listByProjectMock.mockReset();
  findLatestStripeCustomerIdForSubscriberMock.mockReset();
  requireConnectedStripeMock.mockReset();

  findApiKeyByPublicMock.mockResolvedValue({
    id: API_KEY_ID,
    revokedAt: null,
    expiresAt: null,
    project: { id: PROJECT_ID, name: "Test project" },
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
  findLatestStripeCustomerIdForSubscriberMock.mockResolvedValue(
    STRIPE_CUSTOMER_ID,
  );
  sessionsCreateMock = vi.fn(async () => ({
    id: "bps_1",
    url: "https://billing.stripe.com/session/bps_1",
  }));
  requireConnectedStripeMock.mockResolvedValue({
    accountId: "acct_connected",
    livemode: true,
    account: { billingPortal: { sessions: { create: sessionsCreateMock } } },
  });
});

describe("POST /v1/billing-portal", () => {
  it("opens a portal session for the authenticated subscriber's own Stripe customer", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ returnUrl: VERIFIED_RETURN_URL }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: { url: "https://billing.stripe.com/session/bps_1" },
    });
    expect(sessionsCreateMock).toHaveBeenCalledWith({
      customer: STRIPE_CUSTOMER_ID,
      return_url: VERIFIED_RETURN_URL,
    });
  });

  // --- Negative test 1: unauthenticated call fails --------------------
  it("fails an unauthenticated call before any subscriber or Stripe lookup runs", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnUrl: VERIFIED_RETURN_URL }),
    });

    expect(res.status).toBe(401);
    expect(findApiKeyByPublicMock).not.toHaveBeenCalled();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  // --- Negative test 2: a body-supplied customer id changes nothing ---
  it("rejects a body carrying a customer id instead of letting it choose whose portal opens", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        returnUrl: VERIFIED_RETURN_URL,
        // A plausible attacker guess at a body-supplied identity override.
        customerId: "cus_attacker_supplied",
      }),
    });

    expect(res.status).toBe(400);
    // The service is never even reached with the attacker's id — the
    // strict body schema rejects the unknown key up front.
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(findLatestStripeCustomerIdForSubscriberMock).not.toHaveBeenCalled();
  });

  it("still opens only the authenticated subscriber's own customer even when other subscribers exist", async () => {
    // A second, different subscriber's customer id must never surface
    // here — findLatestStripeCustomerIdForSubscriber is called with the
    // AUTHENTICATED subscriber's id, not anything client-controlled.
    const app = await buildApp();
    await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ returnUrl: VERIFIED_RETURN_URL }),
    });

    expect(findLatestStripeCustomerIdForSubscriberMock).toHaveBeenCalledWith(
      expect.anything(),
      SUBSCRIBER_ID,
    );
  });

  // --- Negative test 3: an unlisted return URL is rejected ------------
  it("rejects a return URL that is not one of the project's verified domains", async () => {
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ returnUrl: "https://evil.example.com/steal" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("RETURN_URL_NOT_ALLOWED");
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("returns a typed 404 when the subscriber has no Stripe customer on record", async () => {
    findLatestStripeCustomerIdForSubscriberMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ returnUrl: VERIFIED_RETURN_URL }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("STRIPE_CUSTOMER_NOT_FOUND");
  });

  it("returns a typed 503 when the project has no active Stripe connection", async () => {
    const { StripeNotConnectedError } = await import(
      "../../lib/stripe-platform"
    );
    requireConnectedStripeMock.mockRejectedValue(
      new StripeNotConnectedError(PROJECT_ID),
    );
    const app = await buildApp();
    const res = await app.request("/v1/billing-portal", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ returnUrl: VERIFIED_RETURN_URL }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("STRIPE_NOT_CONNECTED");
  });
});
