import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// registerApplePayDomain (unit)
// =============================================================
//
// The contract this pins is narrow but load-bearing:
//
//  1. It registers the CONFIGURED funnel-serving host on the CONNECTED
//     account (the `Stripe-Account` header must be present — an unscoped
//     call would register the domain on Rovenue's own account and Apple
//     Pay would never appear for the customer).
//  2. It records what Stripe says about Apple Pay, not that a call was
//     made. `apple_pay.status: "inactive"` — the shape Stripe returns
//     when domain verification has not succeeded — must be stored as
//     `inactive`, because on that account the wallet will NOT be offered.
//  3. It never throws. It is called from the middle of the OAuth
//     callback, where a throw would strand a live Stripe authorization.
//  4. No connection (and no configured domain) => no Stripe call at all.
//  5. An already-listed domain is not created a second time.
// =============================================================

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {} as unknown,
    stripeConnectionRepo: {
      findActiveByProject: vi.fn(),
      updateApplePayDomainStatus: vi.fn(async () => undefined),
    },
  },
}));

const { envMock, listMock, createMock, getConnectPlatformStripe } = vi.hoisted(() => {
  const listMock = vi.fn();
  const createMock = vi.fn();
  return {
    envMock: { NODE_ENV: "test", FUNNEL_PAYMENT_DOMAIN: "funnels.example.com" } as {
      NODE_ENV: string;
      FUNNEL_PAYMENT_DOMAIN: string | undefined;
    },
    listMock,
    createMock,
    getConnectPlatformStripe: vi.fn(() => ({
      paymentMethodDomains: { list: listMock, create: createMock },
    })),
  };
});

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));
vi.mock("../../lib/env", () => ({ env: envMock }));
vi.mock("../../lib/stripe-platform", () => ({ getConnectPlatformStripe }));

// Imported AFTER the mocks — `env` is read at module scope by the logger.
const { registerApplePayDomain } = await import("./apple-pay-domain");

const CONNECTION = {
  id: "conn_1",
  projectId: "prj_1",
  stripeAccountId: "acct_customer",
  livemode: true,
};

function pmd(overrides: Record<string, unknown> = {}) {
  return {
    id: "pmd_1",
    domain_name: "funnels.example.com",
    enabled: true,
    apple_pay: { status: "active" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.FUNNEL_PAYMENT_DOMAIN = "funnels.example.com";
  drizzleMock.stripeConnectionRepo.findActiveByProject.mockResolvedValue(CONNECTION);
  drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus.mockResolvedValue(undefined);
  listMock.mockResolvedValue({ data: [] });
  createMock.mockResolvedValue(pmd());
  getConnectPlatformStripe.mockReturnValue({
    paymentMethodDomains: { list: listMock, create: createMock },
  });
});

describe("registerApplePayDomain", () => {
  test("registers the configured domain on the connected account and records active", async () => {
    const result = await registerApplePayDomain("prj_1");

    expect(result).toBe("active");
    expect(createMock).toHaveBeenCalledTimes(1);
    // The domain must be the configured funnel host...
    expect(createMock.mock.calls[0]?.[0]).toEqual({
      domain_name: "funnels.example.com",
    });
    // ...and the call must carry the connected-account header. Without it
    // the domain lands on Rovenue's own Stripe account.
    expect(createMock.mock.calls[0]?.[1]).toMatchObject({
      stripeAccount: "acct_customer",
    });
    expect(drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus).toHaveBeenCalledWith(
      drizzleMock.db,
      "conn_1",
      "active",
    );
  });

  test("records inactive — not registered — when Stripe reports Apple Pay inactive", async () => {
    createMock.mockResolvedValue(
      pmd({
        apple_pay: {
          status: "inactive",
          status_details: { error_message: "Domain not verified" },
        },
      }),
    );

    const result = await registerApplePayDomain("prj_1");

    expect(result).toBe("inactive");
    expect(drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus).toHaveBeenCalledWith(
      drizzleMock.db,
      "conn_1",
      "inactive",
    );
  });

  test("records inactive when the domain object is disabled, whatever apple_pay says", async () => {
    createMock.mockResolvedValue(pmd({ enabled: false }));

    await expect(registerApplePayDomain("prj_1")).resolves.toBe("inactive");
  });

  test("records failed and does not throw when Stripe rejects", async () => {
    createMock.mockRejectedValue(new Error("domain_invalid"));

    const result = await registerApplePayDomain("prj_1");

    expect(result).toBe("failed");
    expect(drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus).toHaveBeenCalledWith(
      drizzleMock.db,
      "conn_1",
      "failed",
    );
  });

  test("returns failed rather than throwing when the status write itself fails", async () => {
    createMock.mockRejectedValue(new Error("network"));
    drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus.mockRejectedValue(
      new Error("db down"),
    );

    await expect(registerApplePayDomain("prj_1")).resolves.toBe("failed");
  });

  test("skips with no Stripe call when the project has no connection", async () => {
    drizzleMock.stripeConnectionRepo.findActiveByProject.mockResolvedValue(null);

    const result = await registerApplePayDomain("prj_1");

    expect(result).toBe("skipped");
    expect(getConnectPlatformStripe).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(drizzleMock.stripeConnectionRepo.updateApplePayDomainStatus).not.toHaveBeenCalled();
  });

  test("skips with no Stripe call and no DB read when no domain is configured", async () => {
    envMock.FUNNEL_PAYMENT_DOMAIN = undefined;

    const result = await registerApplePayDomain("prj_1");

    expect(result).toBe("skipped");
    expect(drizzleMock.stripeConnectionRepo.findActiveByProject).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test("does not re-register a domain already listed, and reports its live status", async () => {
    listMock.mockResolvedValue({
      data: [
        pmd({
          apple_pay: { status: "inactive" },
        }),
      ],
    });

    const result = await registerApplePayDomain("prj_1");

    expect(createMock).not.toHaveBeenCalled();
    expect(listMock.mock.calls[0]?.[0]).toMatchObject({
      domain_name: "funnels.example.com",
    });
    expect(listMock.mock.calls[0]?.[1]).toMatchObject({
      stripeAccount: "acct_customer",
    });
    // The stored status still follows Stripe, so a domain that was
    // registered months ago and never verified does not read as working.
    expect(result).toBe("inactive");
  });

  test("ignores a listed domain whose name is a different host", async () => {
    listMock.mockResolvedValue({ data: [pmd({ domain_name: "other.example" })] });

    await registerApplePayDomain("prj_1");

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test("skips when the connection's platform key is unset", async () => {
    getConnectPlatformStripe.mockReturnValue(null as never);

    await expect(registerApplePayDomain("prj_1")).resolves.toBe("skipped");
    expect(createMock).not.toHaveBeenCalled();
  });
});
