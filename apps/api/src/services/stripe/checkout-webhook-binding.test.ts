// =============================================================
// Checkout → webhook binding
// =============================================================
//
// A completed Stripe Checkout arrives as `customer.subscription.created` on
// the connected account, and the webhook has to decide WHOSE subscription it
// is. That decision rests on one metadata key: /v1/checkout writes it,
// `resolveSubscriber` reads it.
//
// The failure this file exists to prevent is silent. When the key does not
// match, nothing errors — `resolveSubscriber` falls back to the
// `stripe:<customerId>` anchor, creates a SYNTHETIC subscriber, and grants
// the entitlement there. The buyer's real subscriber never receives it, the
// webhook returns 200, and the first sign of trouble is a support ticket.
//
// So this drives the real `processStripeEvent` with a subscription shaped
// like one Checkout produces, and asserts which rovenueId the resolver was
// asked for. Asserting that a constant equals a string would pass while the
// two ends disagreed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "proj_bind_1";
const SUBSCRIBER_ROVENUE_ID = "rov_wire_id";
const SUBSCRIBER_DB_ID = "sub_db_id";
const STRIPE_CUSTOMER_ID = "cus_checkout_1";
const SUBSCRIPTION_ID = "sub_stripe_1";

const claimWebhookEventMock = vi.fn();
const resolveSubscriberByRovenueIdMock = vi.fn();
const findSubscriberByRovenueIdMock = vi.fn();
const markProcessedMock = vi.fn();

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
    db: {
      // syncSubscription opens a transaction before it writes; the resolver
      // runs before that, which is all this test needs to observe.
      transaction: vi.fn(async () => {
        throw new Error("STOP_AFTER_RESOLVE");
      }),
    },
    webhookEventRepo: {
      claimWebhookEvent: (...args: unknown[]) => claimWebhookEventMock(...args),
      markProcessed: (...args: unknown[]) => markProcessedMock(...args),
      markFailed: vi.fn(async () => undefined),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    subscriberRepo: {
      resolveSubscriberByRovenueId: (...args: unknown[]) =>
        resolveSubscriberByRovenueIdMock(...args),
      findSubscriberByRovenueId: (...args: unknown[]) =>
        findSubscriberByRovenueIdMock(...args),
      upsertSubscriber: vi.fn(),
    },
    },
  };
});

const { processStripeEvent } = await import("./stripe-webhook");
const { SUBSCRIBER_METADATA_KEY } = await import("./stripe-types");

function subscriptionCreatedEvent(metadata: Record<string, string>) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: "customer.subscription.created",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: SUBSCRIPTION_ID,
        customer: STRIPE_CUSTOMER_ID,
        status: "active",
        metadata,
        items: { data: [] },
      },
    },
  } as never;
}

async function run(metadata: Record<string, string>) {
  try {
    await processStripeEvent({
      projectId: PROJECT_ID,
      event: subscriptionCreatedEvent(metadata),
      account: {} as never,
    });
  } catch (err) {
    // The mocked transaction throws once the resolver has run; anything else
    // is a real failure and should surface.
    if (!(err instanceof Error) || err.message !== "STOP_AFTER_RESOLVE") throw err;
  }
}

beforeEach(() => {
  claimWebhookEventMock.mockReset();
  resolveSubscriberByRovenueIdMock.mockReset();
  findSubscriberByRovenueIdMock.mockReset();
  markProcessedMock.mockReset();

  claimWebhookEventMock.mockResolvedValue({
    outcome: "claimed",
    row: { id: "whe_1" },
  });
  resolveSubscriberByRovenueIdMock.mockResolvedValue({
    id: SUBSCRIBER_DB_ID,
    projectId: PROJECT_ID,
    rovenueId: SUBSCRIBER_ROVENUE_ID,
  });
  findSubscriberByRovenueIdMock.mockResolvedValue(null);
  markProcessedMock.mockResolvedValue(undefined);
});

describe("checkout → webhook binding", () => {
  it("resolves the buyer named in the subscription metadata", async () => {
    await run({ [SUBSCRIBER_METADATA_KEY]: SUBSCRIBER_ROVENUE_ID });

    expect(resolveSubscriberByRovenueIdMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: PROJECT_ID,
        rovenueId: SUBSCRIBER_ROVENUE_ID,
      }),
    );
  });

  it("does NOT fall back to the synthetic customer anchor when bound", async () => {
    await run({ [SUBSCRIBER_METADATA_KEY]: SUBSCRIBER_ROVENUE_ID });

    // This is the whole point. `stripe:<customerId>` is the anchor an
    // unattributed subscription lands on, and access granted there goes to a
    // subscriber the buyer's app has never heard of.
    const askedFor = resolveSubscriberByRovenueIdMock.mock.calls.map(
      (c) => (c[1] as { rovenueId: string }).rovenueId,
    );
    expect(askedFor).not.toContain(`stripe:${STRIPE_CUSTOMER_ID}`);
  });

  it("falls back to the customer anchor when the metadata is absent", async () => {
    // The pre-existing behaviour for subscriptions Rovenue did not start,
    // kept intact: a subscription created directly in the merchant's Stripe
    // dashboard still resolves somewhere rather than being dropped.
    await run({});

    expect(resolveSubscriberByRovenueIdMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rovenueId: `stripe:${STRIPE_CUSTOMER_ID}` }),
    );
  });
});
