import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// createBillingPortalSession (unit)
// =============================================================
//
// This is the service behind the SDK-facing billing-portal endpoint, an
// auth surface: the URL it returns grants access to a customer's payment
// data. The properties pinned here are the ones a regression could break
// silently:
//
//   1. The Stripe customer is resolved from `subscriberId` ONLY — the
//      function signature has no field a caller-supplied customer id
//      could ride in on.
//   2. `returnUrl` is checked against the project's verified custom
//      domains; an unlisted host (or a non-https scheme) is rejected
//      before any Stripe call is made.
//   3. The session is created on the CONNECTED account returned by
//      `requireConnectedStripe` — never the platform account.
//   4. No Stripe customer on record for the subscriber is a distinct,
//      typed failure, not a 500 and not an empty session.

const findLatestStripeCustomerIdForSubscriberMock = vi.fn();
const listByProjectMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    funnelPurchaseRepo: {
      findLatestStripeCustomerIdForSubscriber: (...args: unknown[]) =>
        findLatestStripeCustomerIdForSubscriberMock(...args),
    },
    customDomainRepo: {
      listByProject: (...args: unknown[]) => listByProjectMock(...args),
    },
  },
}));

const requireConnectedStripeMock = vi.fn();

vi.mock("../../lib/stripe-platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/stripe-platform")>()),
  requireConnectedStripe: (...args: unknown[]) =>
    requireConnectedStripeMock(...args),
}));

const {
  createBillingPortalSession,
  NoStripeCustomerError,
  ReturnUrlNotAllowedError,
} = await import("./billing-portal");
const { StripeNotConnectedError } = await import("../../lib/stripe-platform");

const PROJECT_ID = "prj_1";
const SUBSCRIBER_ID = "sub_1";
const STRIPE_CUSTOMER_ID = "cus_real_owner";
const VERIFIED_DOMAIN = { hostname: "app.example.com", verifiedAt: new Date() };
const UNVERIFIED_DOMAIN = { hostname: "pending.example.com", verifiedAt: null };

function db() {
  return {} as never;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    db: db(),
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    returnUrl: "https://app.example.com/account/billing",
    ...overrides,
  };
}

let sessionsCreateMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findLatestStripeCustomerIdForSubscriberMock.mockReset();
  listByProjectMock.mockReset();
  requireConnectedStripeMock.mockReset();

  findLatestStripeCustomerIdForSubscriberMock.mockResolvedValue(
    STRIPE_CUSTOMER_ID,
  );
  listByProjectMock.mockResolvedValue([VERIFIED_DOMAIN, UNVERIFIED_DOMAIN]);
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

describe("createBillingPortalSession", () => {
  it("resolves the customer from subscriberId server-side and opens a session on the connected account", async () => {
    const result = await createBillingPortalSession(baseInput());

    expect(findLatestStripeCustomerIdForSubscriberMock).toHaveBeenCalledWith(
      expect.anything(),
      SUBSCRIBER_ID,
    );
    expect(requireConnectedStripeMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(sessionsCreateMock).toHaveBeenCalledWith({
      customer: STRIPE_CUSTOMER_ID,
      return_url: "https://app.example.com/account/billing",
    });
    expect(result).toEqual({ url: "https://billing.stripe.com/session/bps_1" });
  });

  // The function's own input type has no `customerId` field — this test
  // pins that the customer used is ALWAYS the one resolved from
  // subscriberId, regardless of anything else present on a caller's raw
  // (pre-validation) object, so a future signature change cannot quietly
  // reopen the hole.
  it("ignores an extraneous customer id smuggled onto the input object", async () => {
    const input = baseInput() as Record<string, unknown>;
    input.customerId = "cus_attacker_supplied";

    await createBillingPortalSession(input as never);

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: STRIPE_CUSTOMER_ID }),
    );
    expect(sessionsCreateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_attacker_supplied" }),
    );
  });

  it("rejects a return URL whose host is not a verified project domain", async () => {
    await expect(
      createBillingPortalSession(
        baseInput({ returnUrl: "https://evil.example.com/steal" }),
      ),
    ).rejects.toBeInstanceOf(ReturnUrlNotAllowedError);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a return URL on a domain that exists for the project but is not verified", async () => {
    await expect(
      createBillingPortalSession(
        baseInput({ returnUrl: "https://pending.example.com/return" }),
      ),
    ).rejects.toBeInstanceOf(ReturnUrlNotAllowedError);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a non-https return URL even on a verified host", async () => {
    await expect(
      createBillingPortalSession(
        baseInput({ returnUrl: "http://app.example.com/return" }),
      ),
    ).rejects.toBeInstanceOf(ReturnUrlNotAllowedError);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed return URL", async () => {
    await expect(
      createBillingPortalSession(baseInput({ returnUrl: "not-a-url" })),
    ).rejects.toBeInstanceOf(ReturnUrlNotAllowedError);
  });

  it("throws a typed NoStripeCustomerError when the subscriber has no Stripe customer on record", async () => {
    findLatestStripeCustomerIdForSubscriberMock.mockResolvedValue(null);

    await expect(createBillingPortalSession(baseInput())).rejects.toBeInstanceOf(
      NoStripeCustomerError,
    );
    expect(requireConnectedStripeMock).not.toHaveBeenCalled();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it("propagates StripeNotConnectedError when the project has no active Stripe connection", async () => {
    requireConnectedStripeMock.mockRejectedValue(
      new StripeNotConnectedError(PROJECT_ID),
    );

    await expect(createBillingPortalSession(baseInput())).rejects.toBeInstanceOf(
      StripeNotConnectedError,
    );
  });
});
