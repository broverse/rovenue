import { beforeEach, describe, expect, test, vi } from "vitest";
import type Stripe from "stripe";

// =============================================================
// processStripeEvent — funnel session backstop (unit)
// =============================================================
//
// The buyer who pays on a funnel page and closes the tab never reaches
// `/funnel-sessions/:id/confirm`. The Connect webhook is their only
// remaining path to a claim token, so these tests pin two halves:
//
//   1. an event that proves payment DOES complete the session, on the
//      recurring path, the trial path and the one-time path;
//   2. an event that proves nothing does NOT — above all
//      `customer.subscription.created`, which the funnel's
//      `default_incomplete` + trial combination fires the instant a
//      visitor reaches the paywall, before any card exists.
//
// The suite runs in-process: no Postgres, no Stripe.

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(async () => ({
        outcome: "claimed" as const,
        row: { id: "whe_1" },
      })),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    funnelPurchaseRepo: {
      findBySession: vi.fn(async () => null as unknown),
      findByStripeSubscriptionId: vi.fn(async () => null as unknown),
    },
    // Touched by the domain sync that runs after the backstop; stubbed
    // so these tests exercise the backstop alone.
    subscriberRepo: {
      // Resolve-then-create: the webhook must never write onto a
      // subscriber a funnel claim already retired (see
      // stripe-webhook.merged-anchor.test.ts). No merged row here.
      resolveSubscriberByRovenueId: vi.fn(async () => null),
      upsertSubscriber: vi.fn(async () => ({ id: "sub_row_1" })),
    },
    purchaseExtRepo: {
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(async () => ({ id: "pur_1", expiresDate: null })),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchaseByStoreTransaction: vi.fn(async () => undefined),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(async () => ({ id: "prod_1", accessIds: [] })),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

const { completeFunnelPurchase } = vi.hoisted(() => ({
  completeFunnelPurchase: vi.fn(async () => ({
    alreadyIssued: false as const,
    token: "claim_plaintext",
  })),
}));
vi.mock("../funnel/complete-purchase", () => ({ completeFunnelPurchase }));

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));
vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: vi.fn(async () => ({ apply: true, from: null })),
}));

// Wrapped, not stubbed. The trial cases below must run the REAL rule,
// and the wrapper is what proves the backstop reaches for the shared
// function rather than keeping its own copy — the copy /confirm used to
// keep is precisely how a trial with no card came to count as paid on
// one side and not the other.
const settledPredicate = vi.hoisted(() => vi.fn());
vi.mock("./payment-settled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./payment-settled")>();
  return {
    ...actual,
    hasPaidOrAttachedACard: settledPredicate.mockImplementation(
      actual.hasPaidOrAttachedACard,
    ),
  };
});

import { processStripeEvent } from "./stripe-webhook";

const PROJECT_ID = "prj_1";

/** The pending row the payment-intent endpoint left behind. */
const PENDING_PURCHASE = {
  id: "fp_1",
  sessionId: "sess_1",
  projectId: PROJECT_ID,
  status: "pending",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  stripePaymentIntentId: null,
};

function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated",
  subscription: Record<string, unknown>,
): Stripe.Event {
  return {
    id: `evt_${type}_${Math.random()}`,
    type,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_1" } }] },
        ...subscription,
      },
    },
  } as unknown as Stripe.Event;
}

// The account-scoped Stripe facade. Only the setup-intent path calls it,
// and its calls ARE the assertions there: `subscriptions.update` is the
// durable write, and every "ignore this intent" case is proved by that
// mock never being reached.
const subscriptionsRetrieve = vi.fn(
  async (): Promise<{
    id: string;
    status: string;
    default_payment_method: string | null;
  }> => ({
    id: "sub_1",
    status: "trialing",
    default_payment_method: null,
  }),
);
const subscriptionsUpdate = vi.fn(async () => ({ id: "sub_1" }));
const account = {
  subscriptions: {
    retrieve: subscriptionsRetrieve,
    update: subscriptionsUpdate,
  },
} as unknown as Parameters<typeof processStripeEvent>[0]["account"];

function run(event: Stripe.Event) {
  return processStripeEvent({
    projectId: PROJECT_ID,
    event,
    account,
  });
}

/**
 * A `setup_intent.succeeded` for a funnel trial's card, carrying the
 * metadata the payment endpoint stamped onto the intent at subscription
 * -create time.
 */
function setupIntentEvent(metadata: Record<string, string>): Stripe.Event {
  return {
    id: `evt_seti_${Math.random()}`,
    type: "setup_intent.succeeded",
    data: {
      object: {
        id: "seti_1",
        customer: "cus_1",
        status: "succeeded",
        payment_method: "pm_1",
        metadata,
      },
    },
  } as unknown as Stripe.Event;
}

const STAMPED = {
  rovenue_funnel_session_id: "sess_1",
  rovenue_funnel_subscription_id: "sub_1",
};

describe("processStripeEvent — funnel session backstop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "claimed" as const,
      row: { id: "whe_1" },
    });
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue(
      PENDING_PURCHASE,
    );
    drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId.mockResolvedValue(
      PENDING_PURCHASE,
    );
    completeFunnelPurchase.mockResolvedValue({
      alreadyIssued: false as const,
      token: "claim_plaintext",
    });
  });

  // ---------------------------------------------------------------
  // Completes
  // ---------------------------------------------------------------

  test("completes the session from a paid invoice, resolved via the subscription", async () => {
    const event = {
      id: "evt_invoice_paid_1",
      type: "invoice.paid",
      data: {
        object: { id: "in_1", subscription: "sub_1", amount_paid: 4900 },
      },
    } as unknown as Stripe.Event;

    await run(event);

    // Stripe copies subscription metadata onto neither the invoice nor
    // its PaymentIntent, so the session id comes from the row that
    // already records this subscription — no Stripe round-trip.
    expect(
      drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId,
    ).toHaveBeenCalledWith(expect.anything(), "sub_1");
    expect(completeFunnelPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_1" }),
    );
  });

  test("completes the session once the subscription is active", async () => {
    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).toHaveBeenCalledWith({
      sessionId: "sess_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripePaymentIntentId: null,
    });
  });

  test("completes a trial once the card is actually attached", async () => {
    await run(subscriptionEvent("customer.subscription.updated", {
      status: "trialing",
      default_payment_method: "pm_1",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_1" }),
    );
  });

  test("completes the one-time path from payment_intent.succeeded", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_1",
    });

    const event = {
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          customer: "cus_1",
          metadata: { rovenue_funnel_session_id: "sess_1" },
        },
      },
    } as unknown as Stripe.Event;

    const result = await run(event);

    expect(result.status).toBe("processed");
    expect(completeFunnelPurchase).toHaveBeenCalledWith({
      sessionId: "sess_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_1",
    });
  });

  // ---------------------------------------------------------------
  // Does not complete
  // ---------------------------------------------------------------

  // THE trap. `default_incomplete` + a trial puts the subscription into
  // `trialing` immediately, so this event fires while the visitor is
  // still looking at the card form. Completing here would grant
  // entitlements to someone who merely reached the paywall.
  test("does NOT complete a trialing subscription with no payment method", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: "seti_1",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("does NOT complete an incomplete subscription awaiting its first payment", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "incomplete",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // A trial's opening invoice is for 0 and is marked paid at once — the
  // same "before the card" moment, arriving as invoice.paid.
  test("does NOT complete on a zero-amount trial-start invoice", async () => {
    await run({
      id: "evt_invoice_zero",
      type: "invoice.paid",
      data: { object: { id: "in_0", subscription: "sub_1", amount_paid: 0 } },
    } as unknown as Stripe.Event);

    expect(
      drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId,
    ).not.toHaveBeenCalled();
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("ignores an event with no funnel session id", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "active",
      metadata: {},
    }));

    expect(drizzleMock.funnelPurchaseRepo.findBySession).not.toHaveBeenCalled();
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("ignores a session id belonging to another project", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      projectId: "prj_other",
    });

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // The visitor changed package: `upsertPending` replaced the row's ids,
  // and a late event from the superseded subscription must not complete
  // the session against the package they abandoned.
  test("ignores an event from a superseded stripe object", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      stripeSubscriptionId: "sub_current",
    });

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // The mirror of the assertion in tests/funnel-confirm.test.ts: both
  // ends of the completion ask ONE function whether the buyer paid.
  test("asks the shared settlement predicate, not a local copy", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "trialing",
      default_payment_method: null,
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(settledPredicate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "trialing" }),
    );
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Containment
  // ---------------------------------------------------------------

  // The backstop runs before the domain sync so a sync failure cannot
  // swallow it. That ordering must not buy the buyer's safety net with
  // the account owner's billing state: a funnel-side throw is logged and
  // the switch below still runs.
  test("a failing backstop does not fail the event or skip the domain sync", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockRejectedValue(
      new Error("funnel_sessions partition unavailable"),
    );

    const result = await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.upsertPurchase).toHaveBeenCalled();
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });

  // The mirror image, and the reason containment is conditional. There is
  // no domain sync for `payment_intent.succeeded` — the backstop IS the
  // work — so swallowing a failure here would mark the event PROCESSED,
  // and a PROCESSED row makes `claimWebhookEvent` answer `duplicate`:
  // Stripe's redelivery AND BullMQ's retry both consumed by one
  // transient blip, permanently stranding a buyer who paid and closed the
  // tab. There is no subscription and no later event to save them.
  test("a failing backstop leaves a one-time payment event retryable", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockRejectedValue(
      new Error("funnel_sessions partition unavailable"),
    );

    const event = {
      id: "evt_pi_fail",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          customer: "cus_1",
          metadata: { rovenue_funnel_session_id: "sess_1" },
        },
      },
    } as unknown as Stripe.Event;

    await expect(run(event)).rejects.toThrow(
      "funnel_sessions partition unavailable",
    );

    // FAILED, not PROCESSED: the row a retry must be allowed to reclaim.
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "FAILED" }),
    );
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).not.toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });

  // Every renewal invoice for the life of a funnel-sold subscription
  // arrives here. `completeFunnelPurchase` would open a transaction and
  // re-read the partitioned funnel_sessions table only to discover the
  // row is already paid — the row in hand says so for free.
  test("does not re-enter the completion service for an already-paid row", async () => {
    drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId.mockResolvedValue({
      ...PENDING_PURCHASE,
      status: "paid",
    });

    await run({
      id: "evt_invoice_renewal",
      type: "invoice.paid",
      data: {
        object: { id: "in_2", subscription: "sub_1", amount_paid: 4900 },
      },
    } as unknown as Stripe.Event);

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Racing the browser's confirm
  // ---------------------------------------------------------------

  // `confirm` got there first: the winner's return value held the only
  // plaintext copy, so this caller is told so and carries no token. The
  // event is still fully processed — losing that race is routine, not a
  // failure.
  test("is a no-op when confirm already completed the session", async () => {
    completeFunnelPurchase.mockResolvedValue({ alreadyIssued: true } as never);

    await expect(
      run(subscriptionEvent("customer.subscription.updated", {
        status: "active",
        metadata: { rovenue_funnel_session_id: "sess_1" },
      })),
    ).resolves.toMatchObject({ status: "processed" });
  });

  test("does not run the backstop at all for a duplicate event", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "duplicate" as const,
    } as never);

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });
});

// =============================================================
// setup_intent.succeeded — the trial card, made durable
// =============================================================
//
// Stripe clears `pending_setup_intent` the moment it succeeds. If it
// clears before `default_payment_method` is written, `/confirm` sees
// neither settlement signal and refuses a buyer who really did attach a
// card. These tests pin the write that closes that window, and — the
// larger half — everything it must refuse to touch: a SetupIntent is a
// thing account owners create for their own flows, and this endpoint
// receives all of them.
describe("processStripeEvent — setup_intent.succeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "claimed" as const,
      row: { id: "whe_1" },
    });
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue(
      PENDING_PURCHASE,
    );
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
    });
  });

  test("writes the confirmed card onto the funnel subscription", async () => {
    const result = await run(setupIntentEvent(STAMPED));

    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_1", {
      default_payment_method: "pm_1",
    });
    expect(result.status).toBe("processed");
    // It repairs a signal; it does not mint anything. The
    // `customer.subscription.updated` this write produces is what
    // reaches the backstop, through the same shared predicate.
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // The whole containment rule for this handler, and the reason it is a
  // metadata match rather than a customer lookup: an account owner's own
  // SetupIntent must not have its payment method written onto anything.
  test("ignores a setup intent that is not a funnel one", async () => {
    await run(setupIntentEvent({}));

    expect(drizzleMock.funnelPurchaseRepo.findBySession).not.toHaveBeenCalled();
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // Stamped with a session but no subscription: there is no way to know
  // which subscription to write to, and guessing is the intrusion.
  test("ignores a stamped intent with no subscription id", async () => {
    await run(setupIntentEvent({ rovenue_funnel_session_id: "sess_1" }));

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  test("ignores a session id belonging to another project", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      projectId: "prj_other",
    });

    await run(setupIntentEvent(STAMPED));

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // The visitor changed package. The superseded attempt's setup intent
  // must not put its card on the subscription they actually chose.
  test("ignores a setup intent from a superseded attempt", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      stripeSubscriptionId: "sub_current",
    });

    await run(setupIntentEvent(STAMPED));

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // Redelivery. Stripe retries this event for days, and by then the
  // customer may be on a different card — replaying an old intent must
  // not roll that back.
  test("does not overwrite a default payment method that already exists", async () => {
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: "pm_newer",
    });

    await run(setupIntentEvent(STAMPED));

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  test("does not write to a cancelled subscription", async () => {
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "canceled",
      default_payment_method: null,
    });

    await run(setupIntentEvent(STAMPED));

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // The event type is Stripe's claim; the object's status is the fact.
  // This handler is registered by type in one table and reads the object
  // in another file, so nothing but this check stops it writing a card
  // off an intent that was never confirmed.
  test("does not write the card of an intent that has not succeeded", async () => {
    const event = setupIntentEvent(STAMPED);
    (event.data.object as unknown as { status: string }).status =
      "requires_action";

    await run(event);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // Metadata is a string map on the connected account's own object. The
  // customer is the one link Stripe itself maintains between the intent
  // and the purchase this row records, so a mismatch means the card
  // being written belongs to somebody else.
  test("ignores an intent whose customer is not the purchase's", async () => {
    const event = setupIntentEvent(STAMPED);
    (event.data.object as unknown as { customer: string }).customer =
      "cus_someone_else";

    await run(event);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  // The event must stay retryable. This handler is the whole work of the
  // event, so a swallowed failure marks the row PROCESSED —
  // `claimWebhookEvent` then answers `duplicate` on Stripe's redelivery
  // and the write is lost for good. Everything that would make the write
  // WRONG is checked before it and returns early, so what reaches the
  // write is retryable by construction.
  test("a failing write leaves the event retryable rather than PROCESSED", async () => {
    subscriptionsUpdate.mockRejectedValue(
      new Error("subscription is in an invalid state") as never,
    );

    await expect(run(setupIntentEvent(STAMPED))).rejects.toThrow(
      "subscription is in an invalid state",
    );

    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "FAILED", incrementRetryCount: true }),
    );
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).not.toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });

  test("a failing purchase lookup leaves the event retryable", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockRejectedValue(
      new Error("funnel_purchases unavailable"),
    );

    await expect(run(setupIntentEvent(STAMPED))).rejects.toThrow(
      "funnel_purchases unavailable",
    );

    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "FAILED" }),
    );
  });
});
